import json
import os
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

import boto3
from boto3.dynamodb.conditions import Key
from openai import APIConnectionError, APIError, APITimeoutError, OpenAI

OPENAI_MODEL = "gpt-4.1-mini"
MAX_PERIOD_DAYS = 14
MIN_FREE_WINDOW_MINUTES = 20
DEFAULT_TIMEZONE_LABEL = "Asia/Jerusalem"
WORKOUT_LIBRARY_DEFAULT_TABLE_NAME = "WorkoutLibrary"
DURATION_BUCKETS: List[Tuple[str, int, int]] = [
    ("10_20", 10, 20),
    ("20_40", 21, 40),
    ("40_60", 41, 60),
]
PREFERRED_TIME_RANGES: Dict[str, Tuple[time, time]] = {
    "morning": (time(6, 0), time(11, 0)),
    "noon": (time(11, 0), time(15, 0)),
    "afternoon": (time(15, 0), time(18, 0)),
    "evening": (time(18, 0), time(22, 0)),
    "any_time": (time(6, 0), time(22, 0)),
}

_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://main.dnp9vhzk0bw8l.amplifyapp.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
}


def _json_response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": dict(_CORS_HEADERS),
        "body": json.dumps(body),
    }


def _iso_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _extract_cognito_sub(event: Dict[str, Any]) -> Optional[str]:
    request_context = event.get("requestContext") or {}
    authorizer = request_context.get("authorizer") or {}

    claims = authorizer.get("claims") or {}
    sub = claims.get("sub") or claims.get("cognito:sub")
    if isinstance(sub, str) and sub.strip():
        return sub.strip()

    jwt = authorizer.get("jwt") or {}
    jwt_claims = jwt.get("claims") or {}
    sub = jwt_claims.get("sub") or jwt_claims.get("cognito:sub")
    if isinstance(sub, str) and sub.strip():
        return sub.strip()
    return None


def _parse_body(event: Dict[str, Any]) -> Dict[str, Any]:
    body = event.get("body")
    if body is None:
        return {}
    if isinstance(body, dict):
        return body
    if isinstance(body, str):
        raw = body.strip()
        if not raw:
            return {}
        return json.loads(raw)
    return {}


def _parse_period_payload(payload: Dict[str, Any]) -> Tuple[Optional[date], Optional[date], Optional[str]]:
    start_raw = payload.get("start_date")
    end_raw = payload.get("end_date")
    if not isinstance(start_raw, str) or not isinstance(end_raw, str):
        return None, None, "start_date and end_date are required (YYYY-MM-DD)."
    try:
        start_date_value = date.fromisoformat(start_raw.strip())
        end_date_value = date.fromisoformat(end_raw.strip())
    except Exception:
        return None, None, "start_date and end_date must be valid ISO dates (YYYY-MM-DD)."
    if end_date_value < start_date_value:
        return None, None, "end_date must be on or after start_date."
    span_days = (end_date_value - start_date_value).days + 1
    if span_days > MAX_PERIOD_DAYS:
        return None, None, f"Requested period is too long (max {MAX_PERIOD_DAYS} days)."
    return start_date_value, end_date_value, None


def _period_from_body(event: Dict[str, Any]) -> Tuple[Optional[date], Optional[date], Optional[str], Dict[str, Any]]:
    payload: Dict[str, Any] = {}
    try:
        payload = _parse_body(event)
    except json.JSONDecodeError:
        return None, None, "Request body must be valid JSON.", {}
    start_date_value, end_date_value, err = _parse_period_payload(payload)
    return start_date_value, end_date_value, err, payload


def _dynamodb_resource():
    region = os.getenv("AWS_REGION")
    return boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")


def _dynamodb_client():
    region = os.getenv("AWS_REGION")
    return boto3.client("dynamodb", region_name=region) if region else boto3.client("dynamodb")


def _dynamodb_table_from_name(table_name: str):
    return _dynamodb_resource().Table(table_name)


def _dynamodb_table(table_env_var: str):
    table_name = os.getenv(table_env_var)
    if not table_name:
        raise ValueError(f"Missing {table_env_var} env var.")
    return _dynamodb_table_from_name(table_name)


def _workout_library_table():
    table_name = (os.getenv("WORKOUT_LIBRARY_TABLE") or WORKOUT_LIBRARY_DEFAULT_TABLE_NAME).strip()
    if not table_name:
        raise ValueError("WorkoutLibrary table name is missing.")
    return _dynamodb_table_from_name(table_name)


def _validate_table_schema(
    *, table_name: str, required_hash_key: str, required_range_key: Optional[str]
) -> bool:
    response = _dynamodb_client().describe_table(TableName=table_name)
    key_schema = response.get("Table", {}).get("KeySchema", [])
    hash_key = ""
    range_key = None
    for entry in key_schema:
        if entry.get("KeyType") == "HASH":
            hash_key = str(entry.get("AttributeName") or "")
        if entry.get("KeyType") == "RANGE":
            range_key = str(entry.get("AttributeName") or "")
    return hash_key == required_hash_key and range_key == required_range_key


def _busyblocks_schema_ok() -> bool:
    table_name = os.getenv("BUSY_BLOCKS_TABLE")
    if not table_name:
        raise ValueError("Missing BUSY_BLOCKS_TABLE env var.")
    return _validate_table_schema(
        table_name=table_name, required_hash_key="user_id", required_range_key="block_key"
    )


def _workout_library_schema_ok() -> bool:
    table_name = (os.getenv("WORKOUT_LIBRARY_TABLE") or WORKOUT_LIBRARY_DEFAULT_TABLE_NAME).strip()
    return _validate_table_schema(table_name=table_name, required_hash_key="user_id", required_range_key=None)


def _safe_string_list(value: Any) -> List[str]:
    if isinstance(value, list):
        return [x.strip() for x in value if isinstance(x, str) and x.strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _openai_prompt_for_library(preferences: Dict[str, Any]) -> str:
    compact = {
        "preferences": preferences,
        "rules": {
            "return_unique_workouts_only": True,
            "no_duplicates_by_type_duration_title": True,
            "generate_compact_workout_flow_steps": True,
            "language": "English",
        },
    }
    return (
        "Generate a workout library JSON only.\n"
        "No markdown.\n"
        "Schema:\n"
        "{\n"
        '  "workout_library":[{\n'
        '    "id":"lib_1",\n'
        '    "title":"Upper body workout",\n'
        '    "workout_type":"Strength",\n'
        '    "duration_minutes":25,\n'
        '    "intensity":"Moderate",\n'
        '    "location":"Gym|Home|Outside",\n'
        '    "summary_short":"...",\n'
        '    "workout_flow":{\n'
        '      "summary":"...",\n'
        '      "warmup_steps":["..."],\n'
        '      "main_steps":["..."],\n'
        '      "cooldown_steps":["..."],\n'
        '      "notes":["..."]\n'
        "    }\n"
        "  }]\n"
        "}\n"
        f"Input: {json.dumps(compact, separators=(',', ':'))}"
    )


def _to_int(value: Any, default: int) -> int:
    try:
        if isinstance(value, Decimal):
            return int(value)
        if isinstance(value, bool):
            return default
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value) if value.is_integer() else default
        if isinstance(value, str):
            raw = value.strip()
            if not raw:
                return default
            return int(float(raw))
    except Exception:
        return default
    return default


def _normalize_generated_library(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    seen = set()
    cleaned: List[Dict[str, Any]] = []
    for index, entry in enumerate(raw, start=1):
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("title", "")).strip()
        workout_type = str(entry.get("workout_type", "")).strip()
        duration = _to_int(entry.get("duration_minutes"), 0)
        if not title or not workout_type or duration <= 0:
            continue
        dedupe_key = f"{workout_type.lower()}|{duration}|{title.lower()}"
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        intensity = str(entry.get("intensity", "")).strip() or "Moderate"
        location = str(entry.get("location", "")).strip() or "Home"
        summary_short = str(entry.get("summary_short", "")).strip() or f"{title} workout."
        workout_flow = entry.get("workout_flow")
        if not isinstance(workout_flow, dict):
            workout_flow = {
                "summary": summary_short,
                "warmup_steps": [],
                "main_steps": [],
                "cooldown_steps": [],
                "notes": [],
            }
        cleaned.append(
            {
                "id": f"lib_{index}",
                "title": title,
                "workout_type": workout_type,
                "duration_minutes": duration,
                "intensity": intensity,
                "location": location,
                "summary_short": summary_short,
                "workout_flow": workout_flow,
            }
        )
    return cleaned


def _normalize_type_key(value: str) -> str:
    return value.strip().lower().replace(" ", "_")


def _type_display_name(type_key: str) -> str:
    return type_key.replace("_", " ").title()


def _variant_templates_for_type(type_key: str) -> List[Tuple[str, int, str, str]]:
    templates: Dict[str, List[Tuple[str, int, str, str]]] = {
        "strength": [
            ("Strength activation", 20, "Light", "Gym"),
            ("Upper body workout", 35, "Moderate", "Gym"),
            ("Lower body strength", 50, "Moderate", "Gym"),
        ],
        "walking": [
            ("Stress-relief walk", 20, "Light", "Outside"),
            ("Brisk outdoor walk", 35, "Light", "Outside"),
            ("Interval walk", 45, "Moderate", "Outside"),
        ],
        "pilates": [
            ("Mobility pilates", 20, "Light", "Home"),
            ("Core pilates session", 30, "Moderate", "Home"),
            ("Morning pilates flow", 45, "Moderate", "Home"),
        ],
        "yoga": [
            ("Quick yoga reset", 15, "Light", "Home"),
            ("Recovery yoga session", 30, "Light", "Home"),
            ("Power yoga practice", 50, "Moderate", "Home"),
        ],
        "running": [
            ("Easy recovery jog", 20, "Light", "Outside"),
            ("Steady outdoor run", 35, "Moderate", "Outside"),
            ("Interval run", 45, "High", "Outside"),
        ],
        "gym": [
            ("Gym warmup circuit", 20, "Light", "Gym"),
            ("Functional gym workout", 35, "Moderate", "Gym"),
            ("Strength machine session", 50, "Moderate", "Gym"),
        ],
        "home_workouts": [
            ("Quick home conditioning", 20, "Moderate", "Home"),
            ("Bodyweight circuit", 30, "Moderate", "Home"),
            ("Full body home workout", 45, "Moderate", "Home"),
        ],
        "stretching": [
            ("Desk-reset stretching", 15, "Light", "Home"),
            ("Evening stretch flow", 25, "Light", "Home"),
            ("Full body stretching", 45, "Light", "Home"),
        ],
    }
    if type_key in templates:
        return templates[type_key]
    display = _type_display_name(type_key)
    return [
        (f"{display} session", 20, "Moderate", "Home"),
        (f"{display} flow", 30, "Moderate", "Home"),
        (f"{display} training", 45, "Moderate", "Home"),
    ]


def _make_library_item(
    *,
    item_id: str,
    title: str,
    workout_type_key: str,
    duration_minutes: int,
    intensity: str,
    location: str,
) -> Dict[str, Any]:
    display_type = _type_display_name(workout_type_key)
    summary_short = f"{title} in {duration_minutes} minutes."
    return {
        "id": item_id,
        "title": title,
        "workout_type": display_type,
        "duration_minutes": duration_minutes,
        "intensity": intensity,
        "location": location,
        "summary_short": summary_short,
        "workout_flow": {
            "summary": f"{title} flow.",
            "warmup_steps": ["Light warm-up 3-5 minutes"],
            "main_steps": [f"Main {display_type.lower()} sequence"],
            "cooldown_steps": ["Cooldown and stretch"],
            "notes": ["Adjust pace to fitness level"],
        },
    }


def _reindex_library_ids(library: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    reindexed: List[Dict[str, Any]] = []
    for idx, item in enumerate(library, start=1):
        copied = dict(item)
        copied["id"] = f"lib_{idx}"
        reindexed.append(copied)
    return reindexed


def _ensure_library_coverage(preferences: Dict[str, Any], library: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    preferred_types_raw = preferences.get("preferred_workout_types") or []
    preferred_type_keys: List[str] = []
    for t in preferred_types_raw:
        if isinstance(t, str) and t.strip():
            key = _normalize_type_key(t)
            if key not in preferred_type_keys:
                preferred_type_keys.append(key)
    if not preferred_type_keys:
        preferred_type_keys = ["walking", "strength", "yoga"]

    by_type: Dict[str, List[Dict[str, Any]]] = {}
    used_signatures = set()

    for item in library:
        item_type_key = _normalize_type_key(str(item.get("workout_type", "")))
        if not item_type_key:
            continue
        title = str(item.get("title", "")).strip()
        duration = _to_int(item.get("duration_minutes"), 0)
        if not title or duration <= 0:
            continue
        signature = f"{item_type_key}|{duration}|{title.lower()}"
        if signature in used_signatures:
            continue
        used_signatures.add(signature)
        by_type.setdefault(item_type_key, []).append(item)

    def duration_bucket(duration_minutes: int) -> str:
        for bucket, min_m, max_m in DURATION_BUCKETS:
            if min_m <= duration_minutes <= max_m:
                return bucket
        if duration_minutes <= 20:
            return "10_20"
        if duration_minutes <= 40:
            return "20_40"
        return "40_60"

    # ensure each selected type exists and has multiple variants
    for type_key in preferred_type_keys:
        existing = by_type.get(type_key, [])
        needed = max(0, 3 - len(existing))
        if needed <= 0:
            continue
        templates = _variant_templates_for_type(type_key)
        for title, duration, intensity, location in templates:
            if needed <= 0:
                break
            signature = f"{type_key}|{duration}|{title.lower()}"
            if signature in used_signatures:
                continue
            used_signatures.add(signature)
            by_type.setdefault(type_key, []).append(
                _make_library_item(
                    item_id="",
                    title=title,
                    workout_type_key=type_key,
                    duration_minutes=duration,
                    intensity=intensity,
                    location=location,
                )
            )
            needed -= 1

        # ensure duration-bucket diversity for each selected type
        existing_items = by_type.get(type_key, [])
        covered_buckets = {
            duration_bucket(_to_int(item.get("duration_minutes"), 0))
            for item in existing_items
            if _to_int(item.get("duration_minutes"), 0) > 0
        }
        templates = _variant_templates_for_type(type_key)
        for bucket, min_m, max_m in DURATION_BUCKETS:
            if bucket in covered_buckets:
                continue
            picked = None
            for title, duration, intensity, location in templates:
                if min_m <= duration <= max_m:
                    picked = (title, duration, intensity, location)
                    break
            if not picked:
                midpoint = (min_m + max_m) // 2
                picked = (f"{_type_display_name(type_key)} workout", midpoint, "Moderate", "Home")
            title, duration, intensity, location = picked
            signature = f"{type_key}|{duration}|{title.lower()}"
            if signature in used_signatures:
                continue
            used_signatures.add(signature)
            by_type.setdefault(type_key, []).append(
                _make_library_item(
                    item_id="",
                    title=title,
                    workout_type_key=type_key,
                    duration_minutes=duration,
                    intensity=intensity,
                    location=location,
                )
            )

    merged: List[Dict[str, Any]] = []
    for type_key in preferred_type_keys:
        merged.extend(by_type.get(type_key, []))
    # keep additional non-preferred types from model after preferred set
    for type_key, items in by_type.items():
        if type_key not in preferred_type_keys:
            merged.extend(items)

    return _reindex_library_ids(merged)


def _generate_library_from_openai(preferences: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], str]:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise ValueError("Missing OPENAI_API_KEY env var.")
    client = OpenAI(api_key=api_key)
    response = client.responses.create(
        model=OPENAI_MODEL,
        input=_openai_prompt_for_library(preferences),
        text={"format": {"type": "json_object"}},
    )
    text_out = getattr(response, "output_text", "")
    if not isinstance(text_out, str) or not text_out.strip():
        return [], "Model returned empty output."
    try:
        parsed = json.loads(text_out)
    except json.JSONDecodeError:
        return [], "Model returned malformed JSON."
    if not isinstance(parsed, dict):
        return [], "Model returned an unexpected JSON shape."
    return _normalize_generated_library(parsed.get("workout_library")), ""


def _read_user_preferences(user_id: str) -> Dict[str, Any]:
    table = _dynamodb_table("USERS_TABLE")
    response = table.get_item(Key={"user_id": user_id})
    item = response.get("Item") if isinstance(response, dict) else {}
    if not isinstance(item, dict):
        item = {}
    workouts_per_week = max(1, min(7, _to_int(item.get("workouts_per_week"), 3)))
    return {
        "workouts_per_week": workouts_per_week,
        "fitness_level": (str(item.get("fitness_level", "")).strip() or "beginner"),
        "main_goal": _safe_string_list(item.get("main_goal")),
        "status_daily_routine": _safe_string_list(item.get("status_daily_routine")),
        "activity_considerations": _safe_string_list(item.get("activity_considerations")),
        "preferred_workout_times": _safe_string_list(item.get("preferred_workout_times")),
        "preferred_workout_types": _safe_string_list(item.get("preferred_workout_types")),
    }


def _save_library(user_id: str, workout_library: List[Dict[str, Any]], generated_at: str) -> None:
    table = _workout_library_table()
    table.put_item(
        Item={
            "user_id": user_id,
            "generated_at": generated_at,
            "workout_library": workout_library,
            "updated_at": _iso_utc_now(),
        }
    )


def _parse_hh_mm(value: str) -> Optional[time]:
    if not isinstance(value, str):
        return None
    raw = value.strip()
    if len(raw) < 5:
        return None
    try:
        hour = int(raw[0:2])
        minute = int(raw[3:5])
        if hour < 0 or hour > 23 or minute < 0 or minute > 59:
            return None
        return time(hour, minute)
    except Exception:
        return None


def _minutes_between(start_t: time, end_t: time) -> int:
    return max(0, (end_t.hour * 60 + end_t.minute) - (start_t.hour * 60 + start_t.minute))


def _time_label_for(start_t: time) -> str:
    h = start_t.hour
    if 6 <= h < 11:
        return "Morning"
    if 11 <= h < 15:
        return "Noon"
    if 15 <= h < 18:
        return "Afternoon"
    return "Evening"


def _query_busy_blocks(user_id: str, start_date_iso: str, end_date_iso: str) -> List[Dict[str, Any]]:
    table = _dynamodb_table("BUSY_BLOCKS_TABLE")
    items: List[Dict[str, Any]] = []
    last_evaluated_key: Optional[Dict[str, Any]] = None
    while True:
        query_args: Dict[str, Any] = {"KeyConditionExpression": Key("user_id").eq(user_id)}
        if last_evaluated_key:
            query_args["ExclusiveStartKey"] = last_evaluated_key
        response = table.query(**query_args)
        batch = response.get("Items") or []
        for item in batch:
            if not isinstance(item, dict):
                continue
            block_date = str(item.get("date", "")).strip()
            if not block_date or block_date < start_date_iso or block_date > end_date_iso:
                continue
            start_time = str(item.get("start_time", "")).strip()
            end_time = str(item.get("end_time", "")).strip()
            if not _parse_hh_mm(start_time) or not _parse_hh_mm(end_time):
                continue
            items.append({"date": block_date, "start_time": start_time, "end_time": end_time})
        last_evaluated_key = response.get("LastEvaluatedKey")
        if not last_evaluated_key:
            break
    items.sort(key=lambda b: (b["date"], b["start_time"], b["end_time"]))
    return items


def _derive_free_windows(
    *, start_date_value: date, end_date_value: date, busy_blocks: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    by_day: Dict[str, List[Tuple[time, time]]] = {}
    for block in busy_blocks:
        block_date = block["date"]
        start_t = _parse_hh_mm(block["start_time"])
        end_t = _parse_hh_mm(block["end_time"])
        if not start_t or not end_t or _minutes_between(start_t, end_t) <= 0:
            continue
        by_day.setdefault(block_date, []).append((start_t, end_t))

    windows: List[Dict[str, Any]] = []
    day_cursor = start_date_value
    while day_cursor <= end_date_value:
        day_key = day_cursor.isoformat()
        day_busy = sorted(by_day.get(day_key, []), key=lambda x: (x[0].hour, x[0].minute))
        merged: List[Tuple[time, time]] = []
        for start_t, end_t in day_busy:
            if not merged:
                merged.append((start_t, end_t))
                continue
            prev_start, prev_end = merged[-1]
            if start_t <= prev_end:
                if end_t > prev_end:
                    merged[-1] = (prev_start, end_t)
            else:
                merged.append((start_t, end_t))
        current = time(6, 0)
        for busy_start, busy_end in merged:
            if busy_start > current:
                duration = _minutes_between(current, busy_start)
                if duration >= MIN_FREE_WINDOW_MINUTES:
                    windows.append(
                        {
                            "date": day_key,
                            "start_time": current.strftime("%H:%M"),
                            "end_time": busy_start.strftime("%H:%M"),
                            "duration_minutes": duration,
                        }
                    )
            if busy_end > current:
                current = busy_end
        day_end = time(22, 0)
        if current < day_end:
            duration = _minutes_between(current, day_end)
            if duration >= MIN_FREE_WINDOW_MINUTES:
                windows.append(
                    {
                        "date": day_key,
                        "start_time": current.strftime("%H:%M"),
                        "end_time": day_end.strftime("%H:%M"),
                        "duration_minutes": duration,
                    }
                )
        day_cursor = day_cursor + timedelta(days=1)
    return windows


def _allowed_preference_windows(preferred_times: List[str]) -> List[Tuple[time, time]]:
    keys = [k for k in preferred_times if k in PREFERRED_TIME_RANGES]
    if not keys or "any_time" in keys:
        return [PREFERRED_TIME_RANGES["any_time"]]
    ordered: List[Tuple[time, time]] = []
    for key in ["morning", "noon", "afternoon", "evening"]:
        if key in keys:
            ordered.append(PREFERRED_TIME_RANGES[key])
    return ordered or [PREFERRED_TIME_RANGES["any_time"]]


def _intersect_time_ranges(
    left_start: time, left_end: time, right_start: time, right_end: time
) -> Optional[Tuple[time, time]]:
    start_minutes = max(left_start.hour * 60 + left_start.minute, right_start.hour * 60 + right_start.minute)
    end_minutes = min(left_end.hour * 60 + left_end.minute, right_end.hour * 60 + right_end.minute)
    if end_minutes <= start_minutes:
        return None
    return time(start_minutes // 60, start_minutes % 60), time(end_minutes // 60, end_minutes % 60)


def _derive_eligible_windows(free_windows: List[Dict[str, Any]], preferred_times: List[str]) -> List[Dict[str, Any]]:
    ranges = _allowed_preference_windows(preferred_times)
    eligible: List[Dict[str, Any]] = []
    for window in free_windows:
        free_start = _parse_hh_mm(window["start_time"])
        free_end = _parse_hh_mm(window["end_time"])
        if not free_start or not free_end:
            continue
        for pref_start, pref_end in ranges:
            overlap = _intersect_time_ranges(free_start, free_end, pref_start, pref_end)
            if not overlap:
                continue
            slot_start, slot_end = overlap
            duration = _minutes_between(slot_start, slot_end)
            if duration < MIN_FREE_WINDOW_MINUTES:
                continue
            eligible.append(
                {
                    "date": window["date"],
                    "start_time": slot_start.strftime("%H:%M"),
                    "end_time": slot_end.strftime("%H:%M"),
                    "duration_minutes": duration,
                    "time_label": _time_label_for(slot_start),
                }
            )
    eligible.sort(key=lambda x: (x["date"], x["start_time"]))
    return eligible


def _derive_weekly_plan(
    *,
    workout_library: List[Dict[str, Any]],
    eligible_windows: List[Dict[str, Any]],
    workouts_per_week: int,
) -> List[Dict[str, Any]]:
    if not workout_library or not eligible_windows:
        return []
    max_items = max(1, min(workouts_per_week, len(workout_library), len(eligible_windows)))
    remaining_windows = eligible_windows.copy()
    plan: List[Dict[str, Any]] = []
    used_library_ids = set()
    day_usage: Dict[str, int] = {}
    time_label_usage: Dict[str, int] = {}
    available_days_sorted = sorted({window["date"] for window in eligible_windows})
    day_position = {day: idx for idx, day in enumerate(available_days_sorted)}

    def target_day_position(planned_count: int) -> int:
        day_count = len(available_days_sorted)
        if day_count <= 1:
            return 0
        if max_items <= 1:
            return day_count // 2
        ratio = planned_count / max(1, max_items - 1)
        return int(round(ratio * (day_count - 1)))

    def choose_varied_start(window: Dict[str, Any], duration: int) -> Tuple[str, str]:
        start_t = _parse_hh_mm(window["start_time"])
        end_t = _parse_hh_mm(window["end_time"])
        if not start_t or not end_t:
            return window["start_time"], window["end_time"]
        start_minutes = start_t.hour * 60 + start_t.minute
        latest_start_minutes = (end_t.hour * 60 + end_t.minute) - duration
        if latest_start_minutes <= start_minutes:
            final_start = start_minutes
        else:
            span = latest_start_minutes - start_minutes
            label = window["time_label"]
            slot_index = time_label_usage.get(label, 0) % 3
            fractions = [0.2, 0.5, 0.75]
            offset = int(span * fractions[slot_index])
            final_start = start_minutes + offset
            final_start = int(round(final_start / 5) * 5)
            final_start = max(start_minutes, min(final_start, latest_start_minutes))
        final_end = final_start + duration
        return f"{final_start // 60:02d}:{final_start % 60:02d}", f"{final_end // 60:02d}:{final_end % 60:02d}"

    def pick_window(duration: int, require_new_day: bool) -> int:
        used_days = {entry["recommended_day"] for entry in plan}
        target_pos = target_day_position(len(plan))
        candidates: List[Tuple[int, int, int, int]] = []
        for idx, window in enumerate(remaining_windows):
            if int(window["duration_minutes"]) < duration:
                continue
            day = window["date"]
            if require_new_day and day in used_days:
                continue
            label = window["time_label"]
            s = _parse_hh_mm(window["start_time"])
            start_hour = s.hour if s else 0
            pos = day_position.get(day, 0)
            # Soft spread target across the week to avoid always filling earliest days first.
            spread_penalty = abs(pos - target_pos) * (40 if require_new_day else 18)
            score = (
                spread_penalty
                + day_usage.get(day, 0) * 100
                + time_label_usage.get(label, 0) * 20
                + start_hour
            )
            candidates.append((score, idx, day_usage.get(day, 0), time_label_usage.get(label, 0)))
        if not candidates:
            return -1
        candidates.sort(key=lambda x: (x[0], x[2], x[3], x[1]))
        return candidates[0][1]

    for library_item in workout_library:
        if len(plan) >= max_items:
            break
        lib_id = str(library_item.get("id", "")).strip()
        duration = _to_int(library_item.get("duration_minutes"), 0)
        if not lib_id or duration <= 0 or lib_id in used_library_ids:
            continue
        chosen_idx = pick_window(duration, True)
        if chosen_idx < 0:
            continue
        window = remaining_windows.pop(chosen_idx)
        rec_start, rec_end = choose_varied_start(window, duration)
        used_library_ids.add(lib_id)
        day_usage[window["date"]] = day_usage.get(window["date"], 0) + 1
        label = window["time_label"]
        time_label_usage[label] = time_label_usage.get(label, 0) + 1
        plan.append(
            {
                "id": f"plan_{len(plan)+1}",
                "library_workout_id": lib_id,
                "recommended_day": window["date"],
                "recommended_start_time": rec_start,
                "recommended_end_time": rec_end,
                "recommended_time_label": window["time_label"],
                "reason_short": "Matches your saved workout library and current free time.",
            }
        )

    # Second pass: allow same-day placements only if needed.
    if len(plan) < max_items:
        for library_item in workout_library:
            if len(plan) >= max_items:
                break
            lib_id = str(library_item.get("id", "")).strip()
            duration = _to_int(library_item.get("duration_minutes"), 0)
            if not lib_id or duration <= 0 or lib_id in used_library_ids:
                continue
            chosen_idx = pick_window(duration, False)
            if chosen_idx < 0:
                continue
            window = remaining_windows.pop(chosen_idx)
            rec_start, rec_end = choose_varied_start(window, duration)
            used_library_ids.add(lib_id)
            day_usage[window["date"]] = day_usage.get(window["date"], 0) + 1
            label = window["time_label"]
            time_label_usage[label] = time_label_usage.get(label, 0) + 1
            plan.append(
                {
                    "id": f"plan_{len(plan)+1}",
                    "library_workout_id": lib_id,
                    "recommended_day": window["date"],
                    "recommended_start_time": rec_start,
                    "recommended_end_time": rec_end,
                    "recommended_time_label": window["time_label"],
                    "reason_short": "Matches your saved workout library and current free time.",
                }
            )
    return plan


def _response_payload(
    *,
    period: Dict[str, str],
    workout_library: List[Dict[str, Any]],
    weekly_plan_suggestions: List[Dict[str, Any]],
    generated_at: str,
    library_source: str,
) -> Dict[str, Any]:
    return {
        "period": period,
        "workout_library": workout_library,
        "weekly_plan_suggestions": weekly_plan_suggestions,
        "metadata": {
            "generated_at": generated_at or _iso_utc_now(),
            "library_source": library_source,
            "weekly_plan_source": "derived_from_library_and_busyblocks",
            "timezone": DEFAULT_TIMEZONE_LABEL,
        },
    }


def _handle_common_weekly_derivation(
    *,
    user_id: str,
    start_date_value: date,
    end_date_value: date,
    workout_library: List[Dict[str, Any]],
    generated_at: str,
    library_source: str,
) -> Dict[str, Any]:
    period = {"start_date": start_date_value.isoformat(), "end_date": end_date_value.isoformat()}
    preferences = _read_user_preferences(user_id)
    busy_blocks = _query_busy_blocks(user_id, period["start_date"], period["end_date"])
    free_windows = _derive_free_windows(
        start_date_value=start_date_value, end_date_value=end_date_value, busy_blocks=busy_blocks
    )
    eligible_windows = _derive_eligible_windows(
        free_windows=free_windows, preferred_times=preferences.get("preferred_workout_times") or []
    )
    weekly_plan = _derive_weekly_plan(
        workout_library=workout_library,
        eligible_windows=eligible_windows,
        workouts_per_week=preferences.get("workouts_per_week") or 3,
    )
    return _response_payload(
        period=period,
        workout_library=workout_library,
        weekly_plan_suggestions=weekly_plan,
        generated_at=generated_at,
        library_source=library_source,
    )


def _fallback_library(preferences: Dict[str, Any]) -> List[Dict[str, Any]]:
    preferred_types = preferences.get("preferred_workout_types") or []
    if not isinstance(preferred_types, list) or not preferred_types:
        preferred_types = ["walking", "strength", "yoga"]
    durations = [20, 30, 40]
    library: List[Dict[str, Any]] = []
    counter = 1
    for workout_type in preferred_types:
        if not isinstance(workout_type, str) or not workout_type.strip():
            continue
        for duration in durations:
            if counter > 9:
                break
            clean_type = workout_type.strip().replace("_", " ")
            title = f"{clean_type.title()} workout"
            library.append(
                {
                    "id": f"lib_{counter}",
                    "title": title,
                    "workout_type": clean_type.title(),
                    "duration_minutes": duration,
                    "intensity": "Moderate",
                    "location": "Home",
                    "summary_short": f"{clean_type.title()} in {duration} minutes.",
                    "workout_flow": {
                        "summary": f"{title} flow.",
                        "warmup_steps": ["Light warm-up 3-5 minutes"],
                        "main_steps": [f"Main {clean_type} sequence"],
                        "cooldown_steps": ["Cooldown and stretch"],
                        "notes": ["Adjust pace to fitness level"],
                    },
                }
            )
            counter += 1
    return _ensure_library_coverage(preferences, library)


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    request_context = event.get("requestContext") or {}
    http = request_context.get("http") or {}
    method = (http.get("method") or event.get("httpMethod") or "").upper()
    if method == "OPTIONS":
        return {"statusCode": 200, "headers": dict(_CORS_HEADERS), "body": ""}
    if method != "POST":
        return _json_response(405, {"message": "Method not allowed."})

    user_id = _extract_cognito_sub(event)
    if not user_id:
        return _json_response(401, {"message": "Missing Cognito user id (sub) in request."})

    start_date_value, end_date_value, period_error, _ = _period_from_body(event)
    if period_error:
        return _json_response(400, {"message": period_error})
    assert start_date_value is not None and end_date_value is not None

    try:
        if not _busyblocks_schema_ok():
            return _json_response(500, {"message": "BusyBlocks schema mismatch. Expected PK user_id, SK block_key."})
        if not _workout_library_schema_ok():
            return _json_response(500, {"message": "WorkoutLibrary schema mismatch. Expected PK user_id only."})
        preferences = _read_user_preferences(user_id)
        workout_library, generation_warning = _generate_library_from_openai(preferences)
        if not workout_library:
            workout_library = _fallback_library(preferences)
        else:
            workout_library = _ensure_library_coverage(preferences, workout_library)
        generated_at = _iso_utc_now()
        _save_library(user_id, workout_library, generated_at)
        payload = _handle_common_weekly_derivation(
            user_id=user_id,
            start_date_value=start_date_value,
            end_date_value=end_date_value,
            workout_library=workout_library,
            generated_at=generated_at,
            library_source="generated",
        )
        if generation_warning:
            payload["metadata"]["generation_warning"] = generation_warning
        return _json_response(200, payload)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except (APIConnectionError, APITimeoutError):
        return _json_response(502, {"message": "Failed to reach OpenAI API."})
    except APIError as err:
        return _json_response(502, {"message": f"OpenAI request failed: {str(err)}"})
    except Exception:
        return _json_response(500, {"message": "Unexpected error while generating workout library."})
