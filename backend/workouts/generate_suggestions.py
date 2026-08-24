import json
import os
import random
import traceback
from hashlib import sha1
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


def _generation_seed_int(user_id: str) -> int:
    material = f"{user_id}|{_iso_utc_now()}".encode("utf-8")
    return int.from_bytes(sha1(material).digest()[:8], "big", signed=False)


def _workout_dedupe_signature(item: Dict[str, Any]) -> str:
    title = str(item.get("title", "")).strip()
    duration = _to_int(item.get("duration_minutes"), 0)
    type_key = _normalize_type_key(str(item.get("workout_type", "")))
    return f"{type_key}|{duration}|{title.lower()}"


def _library_summary_rows(library: List[Dict[str, Any]], limit: int = 10) -> List[str]:
    rows: List[str] = []
    for item in library[:limit]:
        title = str(item.get("title", "")).strip()
        workout_type = str(item.get("workout_type", "")).strip()
        duration = _to_int(item.get("duration_minutes"), 0)
        if not title:
            continue
        rows.append(f"{title}|{workout_type}|{duration}")
    return rows


def _relevant_type_keys(preferences: Dict[str, Any], library: Optional[List[Dict[str, Any]]] = None) -> List[str]:
    preferred_types_raw = preferences.get("preferred_workout_types") or []
    relevant: List[str] = []
    for t in preferred_types_raw:
        if isinstance(t, str) and t.strip():
            key = _normalize_type_key(t)
            if key not in relevant:
                relevant.append(key)
    if relevant:
        return relevant
    if library:
        for item in library:
            key = _normalize_type_key(str(item.get("workout_type", "")))
            if key and key not in relevant:
                relevant.append(key)
    return relevant or ["walking", "strength", "yoga"]


def _library_type_counts(library: List[Dict[str, Any]]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for item in library:
        key = _normalize_type_key(str(item.get("workout_type", "")))
        if not key:
            continue
        counts[key] = counts.get(key, 0) + 1
    return counts


def _today_iso_utc() -> str:
    return datetime.now(timezone.utc).date().isoformat()


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


def _lambda_client():
    region = os.getenv("AWS_REGION")
    return boto3.client("lambda", region_name=region) if region else boto3.client("lambda")


def _scheduled_keep_plan_ids(weekly_plan: List[Dict[str, Any]]) -> List[str]:
    keep: List[str] = []
    for item in weekly_plan:
        if not isinstance(item, dict):
            continue
        plan_id = str(item.get("id", "")).strip()
        if plan_id and str(item.get("google_event_id", "")).strip():
            keep.append(plan_id)
    return keep


def _invoke_workout_image_cleanup(*, user_id: str, keep_plan_ids: List[str]) -> None:
    function_name = os.getenv("WORKOUT_IMAGE_GENERATOR_LAMBDA", "").strip()
    if not function_name:
        print("[workouts-generate-debug] skip image cleanup invoke: missing WORKOUT_IMAGE_GENERATOR_LAMBDA")
        return
    payload = json.dumps(
        {"action": "cleanup", "user_id": user_id, "keep_plan_ids": keep_plan_ids}
    ).encode("utf-8")
    try:
        _lambda_client().invoke(
            FunctionName=function_name,
            InvocationType="Event",
            Payload=payload,
        )
        print(f"[workouts-generate-debug] image cleanup queued keep_count={len(keep_plan_ids)}")
    except Exception as err:
        print(f"[workouts-generate-debug] image cleanup invoke failed: {err}")


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


def _openai_prompt_for_library(
    preferences: Dict[str, Any],
    avoid_workouts: List[Dict[str, Any]],
    diversity_nonce: str,
) -> str:
    compact = {
        "preferences": preferences,
        "avoid_repeating_workouts": avoid_workouts[:40],
        "generation_hint": diversity_nonce,
        "rules": {
            "return_unique_workouts_only": True,
            "no_duplicates_by_type_duration_title": True,
            "generate_compact_workout_flow_steps": True,
            "language": "English",
            "fresh_alternatives": True,
        },
    }
    return (
        "Generate a workout library JSON only.\n"
        "No markdown.\n"
        "Do not repeat workouts from avoid_repeating_workouts (same title case-insensitive + same workout_type + "
        "same duration_minutes). Favorites may reappear only if the client merges them; your output should be new "
        "candidates. Use generation_hint to vary movement patterns, emphasis, and session structure—not the same "
        "titles as before.\n"
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


def _duration_bucket(duration_minutes: int) -> str:
    if duration_minutes <= 20:
        return "10_20"
    if duration_minutes <= 40:
        return "20_40"
    return "40_60"


def _favorite_key_from_item(item: Dict[str, Any]) -> str:
    material = "|".join(
        [
            str(item.get("title", "")).strip().lower(),
            _normalize_type_key(item.get("workout_type")),
            str(_to_int(item.get("duration_minutes"), 0)),
            str(item.get("intensity", "")).strip().lower(),
            str(item.get("location", "")).strip().lower(),
        ]
    )
    return sha1(material.encode("utf-8")).hexdigest()


def _normalize_saved_favorites(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    cleaned: List[Dict[str, Any]] = []
    seen = set()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("title", "")).strip()
        workout_type = str(entry.get("workout_type", "")).strip()
        duration_minutes = _to_int(entry.get("duration_minutes"), 0)
        if not title or not workout_type or duration_minutes <= 0:
            continue
        intensity = str(entry.get("intensity", "")).strip() or "Moderate"
        location = str(entry.get("location", "")).strip() or "Home"
        normalized = {
            "favorite_key": str(entry.get("favorite_key", "")).strip(),
            "id": str(entry.get("id", "")).strip() or "",
            "title": title,
            "workout_type": workout_type,
            "duration_minutes": duration_minutes,
            "duration_bucket": str(entry.get("duration_bucket", "")).strip() or _duration_bucket(duration_minutes),
            "intensity": intensity,
            "location": location,
            "summary_short": str(entry.get("summary_short", "")).strip() or f"{title} workout.",
            "workout_flow": entry.get("workout_flow") if isinstance(entry.get("workout_flow"), dict) else {},
        }
        favorite_key = normalized["favorite_key"] or _favorite_key_from_item(normalized)
        if favorite_key in seen:
            continue
        normalized["favorite_key"] = favorite_key
        seen.add(favorite_key)
        cleaned.append(normalized)
    return cleaned


def _normalize_saved_weekly_plan(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    cleaned: List[Dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        lib_id = str(item.get("library_workout_id", "")).strip()
        rec_day = str(item.get("recommended_day", "")).strip()
        rec_start = str(item.get("recommended_start_time", "")).strip()
        rec_end = str(item.get("recommended_end_time", "")).strip()
        if not lib_id or not rec_day or not rec_start or not rec_end:
            continue
        normalized: Dict[str, Any] = {
            "id": str(item.get("id", "")).strip() or f"plan_{len(cleaned)+1}",
            "library_workout_id": lib_id,
            "recommended_day": rec_day,
            "recommended_start_time": rec_start,
            "recommended_end_time": rec_end,
            "recommended_time_label": str(item.get("recommended_time_label", "")).strip() or "Evening",
            "reason_short": str(item.get("reason_short", "")).strip()
            or "Matches your saved workout library and current free time.",
            "google_event_id": str(item.get("google_event_id", "")).strip(),
            "dailyflow_calendar_id": str(item.get("dailyflow_calendar_id", "")).strip(),
        }
        image_key = str(item.get("workout_image_key", "")).strip()
        if image_key and str(item.get("google_event_id", "")).strip():
            normalized["workout_image_key"] = image_key
        cleaned.append(normalized)
    return cleaned


def _is_locked_plan_item(item: Dict[str, Any]) -> bool:
    return bool(str(item.get("google_event_id", "")).strip() or str(item.get("dailyflow_calendar_id", "")).strip())


def _next_plan_id(current_plan: List[Dict[str, Any]]) -> str:
    max_idx = 0
    for item in current_plan:
        plan_id = str(item.get("id", "")).strip()
        if plan_id.startswith("plan_") and plan_id[5:].isdigit():
            max_idx = max(max_idx, int(plan_id[5:]))
    return f"plan_{max_idx + 1}"


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
        dedupe_key = _workout_dedupe_signature(
            {"title": title, "workout_type": workout_type, "duration_minutes": duration}
        )
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        intensity = str(entry.get("intensity", "")).strip() or "Moderate"
        location = str(entry.get("location", "")).strip() or "Home"
        summary_short = str(entry.get("summary_short", "")).strip() or f"{title} workout."
        workout_flow = entry.get("workout_flow")
        if _needs_flow_enrichment(workout_flow):
            workout_flow = _build_concrete_workout_flow(
                title=title,
                workout_type_key=workout_type,
                duration_minutes=duration,
                intensity=intensity,
            )
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


def _is_actionable_line(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text:
        return False
    lowered = text.lower()
    generic_tokens = [
        "main sequence",
        "main walking sequence",
        "main pilates sequence",
        "cooldown and stretch",
        "light warm-up",
        "adjust pace to fitness level",
        " flow.",
    ]
    if any(token in lowered for token in generic_tokens):
        return False
    detail_markers = ["min", "minutes", "sec", "seconds", "reps", "sets", "rest", "repeat", " x "]
    return any(marker in lowered for marker in detail_markers) or len(text) >= 28


def _needs_flow_enrichment(workout_flow: Any) -> bool:
    if not isinstance(workout_flow, dict):
        return True
    for key in ["warmup_steps", "main_steps", "cooldown_steps"]:
        steps = workout_flow.get(key)
        if not isinstance(steps, list) or not steps:
            return True
        if sum(1 for step in steps if _is_actionable_line(step)) == 0:
            return True
    return False


def _walking_style_flow(
    *, title: str, duration_minutes: int, intensity: str, workout_type_key: str
) -> Dict[str, Any]:
    is_running = workout_type_key == "running"
    movement = "jog" if is_running else "walk"
    easy = "easy jog" if is_running else "easy walk"
    hard = "steady run pace" if is_running else "brisk walk pace"

    warmup_minutes = 5 if duration_minutes >= 25 else 4
    cooldown_minutes = 5 if duration_minutes >= 25 else 4
    main_minutes = max(8, duration_minutes - warmup_minutes - cooldown_minutes)
    harder = "high" in intensity.lower() or is_running
    block_hard = 3 if harder and main_minutes >= 12 else 2
    block_recovery = 1
    repeats = max(2, main_minutes // (block_hard + block_recovery))
    used_main = repeats * (block_hard + block_recovery)
    leftover = max(0, main_minutes - used_main)

    main_steps = [f"Repeat {repeats} rounds: {block_hard} min {hard}, {block_recovery} min recovery {easy}."]
    if leftover > 0:
        main_steps.append(f"Finish with {leftover} min at comfortable {movement} pace.")
    main_steps.append("Keep posture tall, relax shoulders, and maintain steady breathing.")

    return {
        "summary": f"{title}: beginner-friendly paced {movement} workout with clear intervals.",
        "warmup_steps": [
            f"{warmup_minutes} min {easy}.",
            "Add 20-30 sec each of shoulder rolls and ankle circles during warmup.",
        ],
        "main_steps": main_steps,
        "cooldown_steps": [
            f"{cooldown_minutes} min very easy {movement} pace.",
            "30 sec calf stretch and 30 sec quad stretch per side.",
        ],
        "notes": [
            "Use the talk test: you should be able to say short sentences.",
            "If pain appears, slow down and switch to an easy walk.",
        ],
    }


def _movement_style_flow(
    *, title: str, duration_minutes: int, intensity: str, workout_type_key: str
) -> Dict[str, Any]:
    intensity_lower = intensity.lower()
    is_light = "light" in intensity_lower
    is_high = "high" in intensity_lower

    if workout_type_key in ["strength", "gym", "home_workouts"]:
        rounds = 2 if duration_minutes <= 25 else 3
        if is_high and duration_minutes >= 35:
            rounds = 4
        return {
            "summary": f"{title}: full-body beginner strength with clear sets, reps, and rest.",
            "warmup_steps": [
                "2 min marching in place with arm circles.",
                "8 bodyweight squats, 8 hip hinges, 6 incline push-ups.",
            ],
            "main_steps": [
                f"Do {rounds} rounds: 10 squats, 8 incline push-ups, 10 glute bridges, 8 reverse lunges per leg.",
                "Rest 45-60 sec between rounds.",
                "Finish with plank hold 20-30 sec x 2 sets, rest 30 sec.",
            ],
            "cooldown_steps": [
                "30 sec hamstring stretch and 30 sec chest stretch per side.",
                "1 min lying breathing: inhale 4 sec, exhale 6 sec.",
            ],
            "notes": [
                "Move slowly and keep form clean over speed.",
                "If needed, reduce each exercise by 2-3 reps.",
            ],
        }

    if workout_type_key in ["pilates", "mobility", "stretching", "yoga"]:
        holds = 30 if is_light else 40
        rounds = 2 if duration_minutes <= 25 else 3
        return {
            "summary": f"{title}: guided low-impact flow for control, mobility, and posture.",
            "warmup_steps": [
                "1 min diaphragmatic breathing in seated position.",
                "6 cat-cow reps and 6 thread-the-needle reps per side.",
            ],
            "main_steps": [
                f"Complete {rounds} rounds: dead bug 8 reps/side, glute bridge 10 reps, bird-dog 8 reps/side.",
                f"Then hold low lunge stretch {holds} sec per side and downward dog {holds} sec.",
                "Rest 30 sec between rounds.",
            ],
            "cooldown_steps": [
                "Figure-4 stretch 30 sec per side, then child's pose 60 sec.",
                "Finish with 1 min slow nasal breathing while lying down.",
            ],
            "notes": [
                "Work in pain-free range and focus on controlled movement.",
                "Use a wall/chair for balance support when needed.",
            ],
        }

    return {
        "summary": f"{title}: simple guided session with clear step-by-step structure.",
        "warmup_steps": ["3 min easy warmup movement (march in place or easy walk)."],
        "main_steps": [
            "3 rounds: 40 sec effort + 20 sec rest for squats, wall push-ups, and hip hinges.",
            "Rest 60 sec between rounds.",
        ],
        "cooldown_steps": ["3-5 min easy cooldown and gentle full-body stretching."],
        "notes": ["Keep effort moderate and stop if you feel pain."],
    }


def _build_concrete_workout_flow(
    *, title: str, workout_type_key: str, duration_minutes: int, intensity: str
) -> Dict[str, Any]:
    key = _normalize_type_key(workout_type_key)
    if key in ["walking", "running"]:
        return _walking_style_flow(
            title=title,
            duration_minutes=duration_minutes,
            intensity=intensity,
            workout_type_key=key,
        )
    return _movement_style_flow(
        title=title,
        duration_minutes=duration_minutes,
        intensity=intensity,
        workout_type_key=key,
    )


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
        "workout_flow": _build_concrete_workout_flow(
            title=title,
            workout_type_key=display_type,
            duration_minutes=duration_minutes,
            intensity=intensity,
        ),
    }


def _reindex_library_ids(library: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    reindexed: List[Dict[str, Any]] = []
    for idx, item in enumerate(library, start=1):
        copied = dict(item)
        copied["id"] = f"lib_{idx}"
        reindexed.append(copied)
    return reindexed


def _ensure_library_coverage(
    preferences: Dict[str, Any],
    library: List[Dict[str, Any]],
    *,
    avoid_signatures: Optional[set] = None,
) -> List[Dict[str, Any]]:
    avoid = avoid_signatures or set()
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
        signature = _workout_dedupe_signature(item)
        if signature in used_signatures or signature in avoid:
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
            temp_item = _make_library_item(
                item_id="",
                title=title,
                workout_type_key=type_key,
                duration_minutes=duration,
                intensity=intensity,
                location=location,
            )
            signature = _workout_dedupe_signature(temp_item)
            if signature in used_signatures or signature in avoid:
                continue
            used_signatures.add(signature)
            by_type.setdefault(type_key, []).append(temp_item)
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
            temp_item = _make_library_item(
                item_id="",
                title=title,
                workout_type_key=type_key,
                duration_minutes=duration,
                intensity=intensity,
                location=location,
            )
            signature = _workout_dedupe_signature(temp_item)
            if signature in used_signatures or signature in avoid:
                continue
            used_signatures.add(signature)
            by_type.setdefault(type_key, []).append(temp_item)

    merged: List[Dict[str, Any]] = []
    for type_key in preferred_type_keys:
        merged.extend(by_type.get(type_key, []))
    # keep additional non-preferred types from model after preferred set
    for type_key, items in by_type.items():
        if type_key not in preferred_type_keys:
            merged.extend(items)

    return _reindex_library_ids(merged)


def _generate_library_from_openai(
    preferences: Dict[str, Any],
    *,
    avoid_workouts: Optional[List[Dict[str, Any]]] = None,
    avoid_signatures: Optional[set] = None,
    diversity_key: str = "",
) -> Tuple[List[Dict[str, Any]], str]:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise ValueError("Missing OPENAI_API_KEY env var.")
    client = OpenAI(api_key=api_key)
    avoid_list = avoid_workouts or []
    prompt = _openai_prompt_for_library(preferences, avoid_list, diversity_key)
    print(f"[workouts-generate-debug] openai_prompt_length={len(prompt)} avoid_signatures_count={len(avoid_signatures or set())}")
    response = client.responses.create(
        model=OPENAI_MODEL,
        input=prompt,
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
    raw_library = parsed.get("workout_library")
    raw_count = len(raw_library) if isinstance(raw_library, list) else 0
    normalized = _normalize_generated_library(raw_library)
    print(
        f"[workouts-generate-debug] openai_result raw_count={raw_count} "
        f"normalized_count={len(normalized)} sample={_library_summary_rows(normalized, 10)}"
    )
    if avoid_signatures:
        filtered: List[Dict[str, Any]] = []
        skipped_due_to_avoid = 0
        for item in normalized:
            if _workout_dedupe_signature(item) in avoid_signatures:
                skipped_due_to_avoid += 1
                continue
            filtered.append(item)
        normalized = filtered
        print(
            f"[workouts-generate-debug] openai_filtered_by_avoid skipped={skipped_due_to_avoid} "
            f"remaining={len(normalized)}"
        )
    return normalized, ""


def _read_user_preferences(user_id: str) -> Dict[str, Any]:
    table = _dynamodb_table("USERS_TABLE")
    response = table.get_item(Key={"user_id": user_id}, ConsistentRead=True)
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


def _load_saved_workouts_item(user_id: str) -> Dict[str, Any]:
    table = _workout_library_table()
    response = table.get_item(Key={"user_id": user_id})
    item = response.get("Item") if isinstance(response, dict) else None
    if not isinstance(item, dict):
        return {}
    return item


def _normalize_saved_library(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    cleaned: List[Dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        item_id = str(entry.get("id", "")).strip()
        title = str(entry.get("title", "")).strip()
        workout_type = str(entry.get("workout_type", "")).strip()
        duration_minutes = _to_int(entry.get("duration_minutes"), 0)
        if not item_id or not title or not workout_type or duration_minutes <= 0:
            continue
        intensity = str(entry.get("intensity", "")).strip() or "Moderate"
        location = str(entry.get("location", "")).strip() or "Home"
        summary_short = str(entry.get("summary_short", "")).strip() or f"{title} workout."
        workout_flow = entry.get("workout_flow") if isinstance(entry.get("workout_flow"), dict) else {}
        cleaned.append(
            {
                "id": item_id,
                "title": title,
                "workout_type": workout_type,
                "duration_minutes": duration_minutes,
                "intensity": intensity,
                "location": location,
                "summary_short": summary_short,
                "workout_flow": workout_flow,
            }
        )
    return cleaned


def _next_library_id(existing_ids: set[str]) -> str:
    max_idx = 0
    for item_id in existing_ids:
        if item_id.startswith("lib_") and item_id[4:].isdigit():
            max_idx = max(max_idx, int(item_id[4:]))
    next_idx = max_idx + 1
    while f"lib_{next_idx}" in existing_ids:
        next_idx += 1
    return f"lib_{next_idx}"


def _merge_generated_library_with_preserved_refs(
    *,
    existing_item: Dict[str, Any],
    saved_weekly_plan: List[Dict[str, Any]],
    favorite_workouts: List[Dict[str, Any]],
    generated_library: List[Dict[str, Any]],
    debug_stats: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    referenced_ids = {
        str(item.get("library_workout_id", "")).strip()
        for item in saved_weekly_plan
        if str(item.get("library_workout_id", "")).strip()
    }
    favorite_key_set: set = set()
    for fav in favorite_workouts:
        fk = str(fav.get("favorite_key", "")).strip()
        if fk:
            favorite_key_set.add(fk)
        else:
            favorite_key_set.add(_favorite_key_from_item(fav))

    if not referenced_ids and not favorite_key_set:
        if debug_stats is not None:
            debug_stats["preserved_referenced_count"] = 0
            debug_stats["preserved_favorite_count"] = 0
            debug_stats["skipped_generated_duplicate_count"] = 0
            debug_stats["merged_final_count"] = len(generated_library)
        return generated_library

    old_library = _normalize_saved_library(existing_item.get("workout_library"))
    preserved_items: List[Dict[str, Any]] = []
    preserved_sigs: set = set()
    used_ids: set = set()

    for item in old_library:
        iid = str(item.get("id", "")).strip()
        fk = _favorite_key_from_item(item)
        if iid in referenced_ids or fk in favorite_key_set:
            preserved_items.append(dict(item))
            if iid:
                used_ids.add(iid)
            preserved_sigs.add(_workout_dedupe_signature(item))

    merged = list(preserved_items)
    skipped_generated_duplicate_count = 0
    for item in generated_library:
        sig = _workout_dedupe_signature(item)
        if sig in preserved_sigs:
            skipped_generated_duplicate_count += 1
            continue
        next_item = dict(item)
        item_id = str(next_item.get("id", "")).strip()
        if not item_id or item_id in used_ids:
            item_id = _next_library_id(used_ids)
            next_item["id"] = item_id
        used_ids.add(item_id)
        preserved_sigs.add(sig)
        merged.append(next_item)
    if debug_stats is not None:
        preserved_ref_count = 0
        preserved_fav_count = 0
        for item in preserved_items:
            iid = str(item.get("id", "")).strip()
            fk = _favorite_key_from_item(item)
            if iid in referenced_ids:
                preserved_ref_count += 1
            if fk in favorite_key_set:
                preserved_fav_count += 1
        debug_stats["preserved_referenced_count"] = preserved_ref_count
        debug_stats["preserved_favorite_count"] = preserved_fav_count
        debug_stats["skipped_generated_duplicate_count"] = skipped_generated_duplicate_count
        debug_stats["merged_final_count"] = len(merged)
    return merged


def _ensure_min_library_coverage_after_merge(
    *,
    preferences: Dict[str, Any],
    library: List[Dict[str, Any]],
    min_per_type: int = 3,
) -> Tuple[List[Dict[str, Any]], Dict[str, int], Dict[str, int]]:
    relevant_keys = _relevant_type_keys(preferences, library)
    before_counts = _library_type_counts(library)
    missing_before = {
        key: max(0, min_per_type - before_counts.get(key, 0))
        for key in relevant_keys
        if before_counts.get(key, 0) < min_per_type
    }
    if not missing_before:
        return library, missing_before, {}

    merged = list(library)
    used_ids = {str(item.get("id", "")).strip() for item in merged if str(item.get("id", "")).strip()}
    used_signatures = {_workout_dedupe_signature(item) for item in merged}
    current_counts = dict(before_counts)

    labels = ["Fresh", "Tempo", "Power", "Balanced", "Mobility", "Endurance", "Focus", "Skill"]
    for type_key in relevant_keys:
        while current_counts.get(type_key, 0) < min_per_type:
            added = False
            templates = list(_variant_templates_for_type(type_key))
            for idx, (title, duration, intensity, location) in enumerate(templates):
                candidate = _make_library_item(
                    item_id="",
                    title=title,
                    workout_type_key=type_key,
                    duration_minutes=duration,
                    intensity=intensity,
                    location=location,
                )
                sig = _workout_dedupe_signature(candidate)
                if sig in used_signatures:
                    alt_title = f"{labels[(current_counts.get(type_key, 0) + idx) % len(labels)]} {title}"
                    candidate = _make_library_item(
                        item_id="",
                        title=alt_title,
                        workout_type_key=type_key,
                        duration_minutes=duration,
                        intensity=intensity,
                        location=location,
                    )
                    sig = _workout_dedupe_signature(candidate)
                if sig in used_signatures:
                    continue
                candidate["id"] = _next_library_id(used_ids)
                used_ids.add(candidate["id"])
                used_signatures.add(sig)
                merged.append(candidate)
                current_counts[type_key] = current_counts.get(type_key, 0) + 1
                added = True
                break
            if not added:
                break

    after_counts = _library_type_counts(merged)
    missing_after = {
        key: max(0, min_per_type - after_counts.get(key, 0))
        for key in relevant_keys
        if after_counts.get(key, 0) < min_per_type
    }
    return merged, missing_before, missing_after


def _save_library(
    user_id: str,
    workout_library: List[Dict[str, Any]],
    generated_at: str,
    favorite_workouts: Optional[List[Dict[str, Any]]] = None,
) -> None:
    table = _workout_library_table()
    table.put_item(
        Item={
            "user_id": user_id,
            "generated_at": generated_at,
            "workout_library": workout_library,
            "favorite_workouts": favorite_workouts or [],
            "updated_at": _iso_utc_now(),
        }
    )


def _save_library_with_current_week_plan(
    *,
    user_id: str,
    generated_at: str,
    workout_library: List[Dict[str, Any]],
    week_start: str,
    week_end: str,
    weekly_plan: List[Dict[str, Any]],
    favorite_workouts: List[Dict[str, Any]],
    busyblocks_signature: str,
    library_signature: str,
) -> str:
    updated_at = _iso_utc_now()
    table = _workout_library_table()
    table.put_item(
        Item={
            "user_id": user_id,
            "generated_at": generated_at,
            "workout_library": workout_library,
            "favorite_workouts": favorite_workouts,
            "current_week_plan_week_start": week_start,
            "current_week_plan_week_end": week_end,
            "current_week_plan": weekly_plan,
            "current_week_plan_busyblocks_signature": busyblocks_signature,
            "current_week_plan_library_signature": library_signature,
            "current_week_plan_updated_at": updated_at,
            "updated_at": updated_at,
        }
    )
    return updated_at


def _library_signature(workout_library: List[Dict[str, Any]]) -> str:
    normalized = []
    for item in workout_library:
        normalized.append(
            {
                "id": str(item.get("id", "")).strip(),
                "title": str(item.get("title", "")).strip(),
                "workout_type": str(item.get("workout_type", "")).strip(),
                "duration_minutes": _to_int(item.get("duration_minutes"), 0),
                "intensity": str(item.get("intensity", "")).strip(),
                "location": str(item.get("location", "")).strip(),
            }
        )
    normalized.sort(
        key=lambda x: (x["id"], x["title"], x["workout_type"], x["duration_minutes"], x["intensity"], x["location"])
    )
    payload = json.dumps(normalized, sort_keys=True, separators=(",", ":"))
    return sha1(payload.encode("utf-8")).hexdigest()


def _busyblocks_signature(busy_blocks: List[Dict[str, Any]]) -> str:
    normalized = []
    for block in busy_blocks:
        normalized.append(
            {
                "date": str(block.get("date", "")).strip(),
                "start_time": str(block.get("start_time", "")).strip(),
                "end_time": str(block.get("end_time", "")).strip(),
            }
        )
    normalized.sort(key=lambda x: (x["date"], x["start_time"], x["end_time"]))
    payload = json.dumps(normalized, sort_keys=True, separators=(",", ":"))
    return sha1(payload.encode("utf-8")).hexdigest()


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
    used_days_seed: Optional[set[str]] = None,
    debug_stats: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    today_iso = _today_iso_utc()
    eligible_windows = [window for window in eligible_windows if str(window.get("date", "")).strip() >= today_iso]
    if not workout_library or not eligible_windows:
        return []
    max_items = max(1, min(workouts_per_week, len(workout_library), len(eligible_windows)))
    remaining_windows = eligible_windows.copy()
    plan: List[Dict[str, Any]] = []
    used_library_ids = set()
    used_days_global = {day for day in (used_days_seed or set()) if isinstance(day, str) and day.strip()}
    adjacent_day_fallback_used = False
    duplicate_day_fallback_used = False
    non_adjacent_pass_count = 0
    available_days_sorted = sorted({window["date"] for window in eligible_windows})

    def choose_varied_start(window: Dict[str, Any], duration: int, slot_index_seed: int) -> Tuple[str, str]:
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
            slot_index = slot_index_seed % 3
            fractions = [0.2, 0.5, 0.75]
            offset = int(span * fractions[slot_index])
            final_start = start_minutes + offset
            final_start = int(round(final_start / 5) * 5)
            final_start = max(start_minutes, min(final_start, latest_start_minutes))
        final_end = final_start + duration
        return f"{final_start // 60:02d}:{final_start % 60:02d}", f"{final_end // 60:02d}:{final_end % 60:02d}"

    def try_place_on_day(day: str) -> bool:
        nonlocal adjacent_day_fallback_used, duplicate_day_fallback_used, non_adjacent_pass_count
        existing_days = set(used_days_global)
        is_duplicate_day = day in existing_days
        is_adjacent = False
        for existing_day in existing_days:
            try:
                delta = abs((date.fromisoformat(day) - date.fromisoformat(existing_day)).days)
                if delta == 1:
                    is_adjacent = True
                    break
            except Exception:
                continue
        for library_item in workout_library:
            lib_id = str(library_item.get("id", "")).strip()
            duration = _to_int(library_item.get("duration_minutes"), 0)
            if not lib_id or duration <= 0 or lib_id in used_library_ids:
                continue
            for idx, window in enumerate(remaining_windows):
                if str(window.get("date", "")).strip() != day:
                    continue
                if int(window.get("duration_minutes") or 0) < duration:
                    continue
                chosen_window = remaining_windows.pop(idx)
                rec_start, rec_end = choose_varied_start(chosen_window, duration, len(plan))
                used_library_ids.add(lib_id)
                used_days_global.add(day)
                if is_adjacent:
                    adjacent_day_fallback_used = True
                else:
                    non_adjacent_pass_count += 1
                if is_duplicate_day:
                    duplicate_day_fallback_used = True
                plan.append(
                    {
                        "id": f"plan_{len(plan)+1}",
                        "library_workout_id": lib_id,
                        "recommended_day": day,
                        "recommended_start_time": rec_start,
                        "recommended_end_time": rec_end,
                        "recommended_time_label": chosen_window["time_label"],
                        "reason_short": "Matches your saved workout library and current free time.",
                    }
                )
                return True
        return False

    def _is_non_adjacent_to_used(day: str) -> bool:
        for existing_day in used_days_global:
            try:
                if abs((date.fromisoformat(day) - date.fromisoformat(existing_day)).days) == 1:
                    return False
            except Exception:
                continue
        return True

    # Pass 1: unused + non-adjacent days first (best spread).
    all_days = sorted({str(window.get("date", "")).strip() for window in remaining_windows if str(window.get("date", "")).strip()})
    unused_non_adjacent_days = [day for day in all_days if day not in used_days_global and _is_non_adjacent_to_used(day)]
    for day in unused_non_adjacent_days:
        if len(plan) >= max_items:
            break
        try_place_on_day(day)

    # Pass 2: still missing -> unused days even if adjacent.
    updated_all_days = sorted({str(window.get("date", "")).strip() for window in remaining_windows if str(window.get("date", "")).strip()})
    unused_days_sorted = [day for day in updated_all_days if day not in used_days_global]
    for day in unused_days_sorted:
        if len(plan) >= max_items:
            break
        try_place_on_day(day)

    # Pass 3: still missing -> allow used days, prefer non-adjacent first, then adjacent fallback.
    while len(plan) < max_items:
        progress = False
        remaining_days = {
            str(window.get("date", "")).strip()
            for window in remaining_windows
            if str(window.get("date", "")).strip()
        }
        candidate_non_adjacent = sorted(day for day in remaining_days if _is_non_adjacent_to_used(day))
        for day in candidate_non_adjacent:
            if len(plan) >= max_items:
                break
            if try_place_on_day(day):
                progress = True
                break
        if len(plan) >= max_items:
            break
        if progress:
            continue
        used_or_any_days = sorted({str(window.get("date", "")).strip() for window in remaining_windows if str(window.get("date", "")).strip()})
        for day in used_or_any_days:
            if len(plan) >= max_items:
                break
            if try_place_on_day(day):
                progress = True
                break
        if not progress:
            break

    print(
        "weekly_plan_day_debug "
        f"eligible_days={available_days_sorted} "
        f"seed_used_days={sorted({day for day in (used_days_seed or set()) if isinstance(day, str) and day.strip()})} "
        f"generated_days={[item.get('recommended_day') for item in plan]}"
    )
    if debug_stats is not None:
        debug_stats["adjacent_day_fallback_used"] = adjacent_day_fallback_used
        debug_stats["duplicate_day_fallback_used"] = duplicate_day_fallback_used
        debug_stats["non_adjacent_pass_count"] = non_adjacent_pass_count
        debug_stats["generated_new_days"] = sorted(
            {str(item.get("recommended_day", "")).strip() for item in plan if str(item.get("recommended_day", "")).strip()}
        )
    return plan


def _response_payload(
    *,
    period: Dict[str, str],
    workout_library: List[Dict[str, Any]],
    favorite_workouts: List[Dict[str, Any]],
    weekly_plan_suggestions: List[Dict[str, Any]],
    generated_at: str,
    library_source: str,
) -> Dict[str, Any]:
    return {
        "period": period,
        "workout_library": workout_library,
        "favorite_workouts": favorite_workouts,
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
    favorite_workouts: List[Dict[str, Any]],
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
        favorite_workouts=favorite_workouts,
        weekly_plan_suggestions=weekly_plan,
        generated_at=generated_at,
        library_source=library_source,
    )


def _derive_weekly_plan_and_signatures(
    *,
    user_id: str,
    start_date_value: date,
    end_date_value: date,
    workout_library: List[Dict[str, Any]],
    workouts_per_week: int,
    preserved_weekly_plan: Optional[List[Dict[str, Any]]] = None,
    debug_stats: Optional[Dict[str, Any]] = None,
) -> Tuple[List[Dict[str, Any]], str, str]:
    period = {"start_date": start_date_value.isoformat(), "end_date": end_date_value.isoformat()}
    preferences = _read_user_preferences(user_id)
    busy_blocks = _query_busy_blocks(user_id, period["start_date"], period["end_date"])
    free_windows = _derive_free_windows(
        start_date_value=start_date_value, end_date_value=end_date_value, busy_blocks=busy_blocks
    )
    eligible_windows = _derive_eligible_windows(
        free_windows=free_windows, preferred_times=preferences.get("preferred_workout_times") or []
    )
    keep_plan = preserved_weekly_plan or []
    if keep_plan:
        keep_plan = [
            item
            for item in keep_plan
            if str(item.get("recommended_day", "")).strip() >= start_date_value.isoformat()
            and str(item.get("recommended_day", "")).strip() <= end_date_value.isoformat()
        ]
    if keep_plan and len(keep_plan) >= workouts_per_week:
        weekly_plan = sorted(
            keep_plan,
            key=lambda x: (
                str(x.get("recommended_day", "")),
                str(x.get("recommended_start_time", "")),
                str(x.get("recommended_end_time", "")),
                str(x.get("id", "")),
            ),
        )
    elif keep_plan:
        used_library_ids = {
            str(item.get("library_workout_id", "")).strip()
            for item in keep_plan
            if str(item.get("library_workout_id", "")).strip()
        }
        remaining_library = [
            item
            for item in workout_library
            if str(item.get("id", "")).strip() not in used_library_ids
        ]

        def _window_overlaps_kept(window: Dict[str, Any]) -> bool:
            window_day = str(window.get("date", "")).strip()
            window_start = _parse_hh_mm(str(window.get("start_time", "")).strip())
            window_end = _parse_hh_mm(str(window.get("end_time", "")).strip())
            if not window_day or not window_start or not window_end:
                return True
            ws = window_start.hour * 60 + window_start.minute
            we = window_end.hour * 60 + window_end.minute
            for kept in keep_plan:
                if str(kept.get("recommended_day", "")).strip() != window_day:
                    continue
                ks = _parse_hh_mm(str(kept.get("recommended_start_time", "")).strip())
                ke = _parse_hh_mm(str(kept.get("recommended_end_time", "")).strip())
                if not ks or not ke:
                    continue
                ks_m = ks.hour * 60 + ks.minute
                ke_m = ke.hour * 60 + ke.minute
                if max(ws, ks_m) < min(we, ke_m):
                    return True
            return False

        free_windows = [window for window in eligible_windows if not _window_overlaps_kept(window)]
        local_plan_debug: Dict[str, Any] = {}
        additional = _derive_weekly_plan(
            workout_library=remaining_library,
            eligible_windows=free_windows,
            workouts_per_week=max(0, workouts_per_week - len(keep_plan)),
            used_days_seed={
                str(item.get("recommended_day", "")).strip()
                for item in keep_plan
                if str(item.get("recommended_day", "")).strip()
            },
            debug_stats=local_plan_debug,
        )
        merged = list(keep_plan)
        for item in additional:
            next_item = dict(item)
            next_item["id"] = _next_plan_id(merged)
            merged.append(next_item)
        weekly_plan = sorted(
            merged,
            key=lambda x: (
                str(x.get("recommended_day", "")),
                str(x.get("recommended_start_time", "")),
                str(x.get("recommended_end_time", "")),
                str(x.get("id", "")),
            ),
        )
        if debug_stats is not None:
            debug_stats["adjacent_day_fallback_used"] = bool(local_plan_debug.get("adjacent_day_fallback_used", False))
            debug_stats["duplicate_day_fallback_used"] = bool(local_plan_debug.get("duplicate_day_fallback_used", False))
            debug_stats["non_adjacent_pass_count"] = int(local_plan_debug.get("non_adjacent_pass_count", 0))
            debug_stats["generated_new_days"] = list(local_plan_debug.get("generated_new_days", []))
    else:
        local_plan_debug = {}
        weekly_plan = _derive_weekly_plan(
            workout_library=workout_library,
            eligible_windows=eligible_windows,
            workouts_per_week=workouts_per_week,
            debug_stats=local_plan_debug,
        )
        if debug_stats is not None:
            debug_stats["adjacent_day_fallback_used"] = bool(local_plan_debug.get("adjacent_day_fallback_used", False))
            debug_stats["duplicate_day_fallback_used"] = bool(local_plan_debug.get("duplicate_day_fallback_used", False))
            debug_stats["non_adjacent_pass_count"] = int(local_plan_debug.get("non_adjacent_pass_count", 0))
            debug_stats["generated_new_days"] = list(local_plan_debug.get("generated_new_days", []))
    if debug_stats is not None:
        debug_stats["preserved_plan_count"] = len(keep_plan)
        debug_stats["final_current_week_plan_count"] = len(weekly_plan)
        debug_stats["final_current_week_plan_days"] = sorted(
            {
                str(item.get("recommended_day", "")).strip()
                for item in weekly_plan
                if str(item.get("recommended_day", "")).strip()
            }
        )
    return weekly_plan, _busyblocks_signature(busy_blocks), _library_signature(workout_library)


def _fallback_library(
    preferences: Dict[str, Any],
    *,
    seed: int = 0,
    avoid_signatures: Optional[set] = None,
) -> List[Dict[str, Any]]:
    rng = random.Random(seed)
    avoid = set(avoid_signatures or [])
    preferred_types = preferences.get("preferred_workout_types") or []
    if not isinstance(preferred_types, list) or not preferred_types:
        preferred_types = ["walking", "strength", "yoga"]

    labels = [
        "Fresh",
        "Quick",
        "Power",
        "Steady",
        "Skill",
        "Tempo",
        "Balanced",
        "Endurance",
        "Mobility",
        "Core",
    ]
    library: List[Dict[str, Any]] = []
    used_local = set(avoid)

    for workout_type in preferred_types:
        if not isinstance(workout_type, str) or not workout_type.strip():
            continue
        if len(library) >= 9:
            break
        clean_type = workout_type.strip().replace("_", " ")
        type_key = _normalize_type_key(clean_type)
        templates = list(_variant_templates_for_type(type_key))
        rng.shuffle(templates)
        durations = [20, 30, 40]
        for i, duration in enumerate(durations):
            if len(library) >= 9:
                break
            title_base, _tmpl_dur, intensity, location = templates[i % len(templates)]
            label = labels[(seed + len(library) * 7 + i * 3) % len(labels)]
            title = f"{label} {title_base}"
            attempt = 0
            sig = ""
            while attempt < 14:
                sig = _workout_dedupe_signature(
                    {"title": title, "workout_type": _type_display_name(type_key), "duration_minutes": duration}
                )
                if sig not in used_local:
                    break
                attempt += 1
                title = f"{label} {title_base} — v{attempt + rng.randint(1, 99)}"
            if not sig or sig in used_local:
                continue
            used_local.add(sig)
            library.append(
                _make_library_item(
                    item_id=f"lib_{len(library)+1}",
                    title=title,
                    workout_type_key=type_key,
                    duration_minutes=duration,
                    intensity=intensity,
                    location=location,
                )
            )
    return _ensure_library_coverage(preferences, library, avoid_signatures=used_local)


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    request_context = event.get("requestContext") or {}
    http = request_context.get("http") or {}
    method = (http.get("method") or event.get("httpMethod") or "").upper()
    if method == "OPTIONS":
        return {"statusCode": 200, "headers": dict(_CORS_HEADERS), "body": ""}
    if method != "POST":
        return _json_response(405, {"message": "Method not allowed."})
    print("[workouts-generate-debug] request received")

    user_id = _extract_cognito_sub(event)
    print(f"[workouts-generate-debug] user_id_present={bool(user_id)}")
    if not user_id:
        return _json_response(401, {"message": "Missing Cognito user id (sub) in request."})

    start_date_value, end_date_value, period_error, _ = _period_from_body(event)
    if period_error:
        return _json_response(400, {"message": period_error})
    assert start_date_value is not None and end_date_value is not None
    print(
        f"[workouts-generate-debug] requested_period start={start_date_value.isoformat()} "
        f"end={end_date_value.isoformat()}"
    )

    try:
        if not _busyblocks_schema_ok():
            return _json_response(500, {"message": "BusyBlocks schema mismatch. Expected PK user_id, SK block_key."})
        if not _workout_library_schema_ok():
            return _json_response(500, {"message": "WorkoutLibrary schema mismatch. Expected PK user_id only."})
        existing_item = _load_saved_workouts_item(user_id)
        favorite_workouts = _normalize_saved_favorites(existing_item.get("favorite_workouts"))
        preferences = _read_user_preferences(user_id)
        workouts_per_week = preferences.get("workouts_per_week") or 3
        saved_weekly_plan: List[Dict[str, Any]] = []
        if (
            str(existing_item.get("current_week_plan_week_start", "")).strip()
            == start_date_value.isoformat()
            and str(existing_item.get("current_week_plan_week_end", "")).strip()
            == end_date_value.isoformat()
        ):
            saved_weekly_plan = _normalize_saved_weekly_plan(existing_item.get("current_week_plan"))
        locked_plan_items = [item for item in saved_weekly_plan if _is_locked_plan_item(item)]
        replaceable_plan_items = [item for item in saved_weekly_plan if not _is_locked_plan_item(item)]
        old_library = _normalize_saved_library(existing_item.get("workout_library"))
        print(
            f"[workouts-generate-debug] pre_generation workouts_per_week={workouts_per_week} "
            f"saved_weekly_plan_count={len(saved_weekly_plan)} favorite_workouts_count={len(favorite_workouts)} "
            f"old_library_count={len(old_library)}"
        )
        remaining_needed = max(0, workouts_per_week - len(locked_plan_items))
        locked_days = sorted(
            {
                str(item.get("recommended_day", "")).strip()
                for item in locked_plan_items
                if str(item.get("recommended_day", "")).strip()
            }
        )
        print(
            f"[workouts-generate-debug] locked_plan_count={len(locked_plan_items)} "
            f"replaceable_plan_count={len(replaceable_plan_items)} remaining_needed={remaining_needed} "
            f"locked_days={locked_days}"
        )
        avoid_for_prompt = [
            {
                "title": str(m.get("title", "")).strip(),
                "workout_type": str(m.get("workout_type", "")).strip(),
                "duration_minutes": _to_int(m.get("duration_minutes"), 0),
            }
            for m in old_library
            if str(m.get("title", "")).strip()
            and str(m.get("workout_type", "")).strip()
            and _to_int(m.get("duration_minutes"), 0) > 0
        ][:40]
        avoid_sig = {_workout_dedupe_signature(m) for m in old_library}
        print(
            f"[workouts-generate-debug] source_attempt=openai avoid_signatures_count={len(avoid_sig)} "
            f"avoid_sample={list(avoid_sig)[:5]} prompt_avoid_items={len(avoid_for_prompt)}"
        )
        seed = _generation_seed_int(user_id)
        workout_library, generation_warning = _generate_library_from_openai(
            preferences,
            avoid_workouts=avoid_for_prompt,
            avoid_signatures=avoid_sig,
            diversity_key=str(seed),
        )
        if not workout_library:
            print(f"[workouts-generate-debug] openai_failed reason={generation_warning}")
            print("[workouts-generate-debug] source_attempt=fallback")
            workout_library = _fallback_library(preferences, seed=seed, avoid_signatures=avoid_sig)
            print(
                f"[workouts-generate-debug] fallback_result count={len(workout_library)} "
                f"sample={_library_summary_rows(workout_library, 10)}"
            )
        else:
            print(
                f"[workouts-generate-debug] openai_succeeded generated_count={len(workout_library)} "
                f"sample={_library_summary_rows(workout_library, 10)}"
            )
            workout_library = _ensure_library_coverage(preferences, workout_library, avoid_signatures=avoid_sig)
            print(
                f"[workouts-generate-debug] post_coverage_count={len(workout_library)} "
                f"sample={_library_summary_rows(workout_library, 10)}"
            )
        merge_stats: Dict[str, Any] = {}
        workout_library = _merge_generated_library_with_preserved_refs(
            existing_item=existing_item,
            saved_weekly_plan=locked_plan_items,
            favorite_workouts=favorite_workouts,
            generated_library=workout_library,
            debug_stats=merge_stats,
        )
        print(
            f"[workouts-generate-debug] merge preserved_referenced_count={merge_stats.get('preserved_referenced_count', 0)} "
            f"preserved_favorite_count={merge_stats.get('preserved_favorite_count', 0)} "
            f"skipped_generated_duplicate_count={merge_stats.get('skipped_generated_duplicate_count', 0)} "
            f"final_library_count={len(workout_library)} "
            f"final_sample={_library_summary_rows(workout_library, 10)}"
        )
        relevant_types = _relevant_type_keys(preferences, workout_library)
        min_required_library_count = 3 * len(relevant_types)
        workout_library, missing_before_topup, missing_after_topup = _ensure_min_library_coverage_after_merge(
            preferences=preferences,
            library=workout_library,
            min_per_type=3,
        )
        per_type_counts = _library_type_counts(workout_library)
        print(
            f"[workouts-generate-debug] relevant_workout_types={relevant_types} "
            f"min_required_library_count={min_required_library_count} final_library_count={len(workout_library)} "
            f"per_type_library_counts={per_type_counts} "
            f"missing_type_coverage_before_topup={missing_before_topup} "
            f"missing_type_coverage_after_topup={missing_after_topup}"
        )
        generated_at = _iso_utc_now()
        plan_debug: Dict[str, Any] = {}
        weekly_plan, busy_sig, lib_sig = _derive_weekly_plan_and_signatures(
            user_id=user_id,
            start_date_value=start_date_value,
            end_date_value=end_date_value,
            workout_library=workout_library,
            workouts_per_week=workouts_per_week,
            preserved_weekly_plan=locked_plan_items,
            debug_stats=plan_debug,
        )
        weekly_days = sorted(
            {
                str(item.get("recommended_day", "")).strip()
                for item in weekly_plan
                if str(item.get("recommended_day", "")).strip()
            }
        )
        print(
            f"[workouts-generate-debug] weekly_plan generated_count={len(weekly_plan)} "
            f"generated_days={weekly_days} preserved_plan_count={len(locked_plan_items)} "
            f"final_current_week_plan_count={len(weekly_plan)}"
        )
        print(
            f"[workouts-generate-debug] generated_new_days={plan_debug.get('generated_new_days', [])} "
            f"final_current_week_plan_days={plan_debug.get('final_current_week_plan_days', weekly_days)} "
            f"adjacent_day_fallback_used={bool(plan_debug.get('adjacent_day_fallback_used', False))} "
            f"duplicate_day_fallback_used={bool(plan_debug.get('duplicate_day_fallback_used', False))} "
            f"non_adjacent_pass_count={int(plan_debug.get('non_adjacent_pass_count', 0))}"
        )
        plan_updated_at = _save_library_with_current_week_plan(
            user_id=user_id,
            generated_at=generated_at,
            workout_library=workout_library,
            week_start=start_date_value.isoformat(),
            week_end=end_date_value.isoformat(),
            weekly_plan=weekly_plan,
            favorite_workouts=favorite_workouts,
            busyblocks_signature=busy_sig,
            library_signature=lib_sig,
        )
        _invoke_workout_image_cleanup(
            user_id=user_id,
            keep_plan_ids=_scheduled_keep_plan_ids(weekly_plan),
        )
        payload = _response_payload(
            period={"start_date": start_date_value.isoformat(), "end_date": end_date_value.isoformat()},
            workout_library=workout_library,
            favorite_workouts=favorite_workouts,
            weekly_plan_suggestions=weekly_plan,
            generated_at=generated_at or plan_updated_at,
            library_source="generated",
        )
        payload["metadata"]["weekly_plan_source"] = "generated_and_saved_current_week_plan"
        if generation_warning:
            payload["metadata"]["generation_warning"] = generation_warning
        print(
            f"[workouts-generate-debug] response workout_library_count={len(workout_library)} "
            f"current_week_plan_count={len(weekly_plan)} metadata_library_source={payload.get('metadata', {}).get('library_source')}"
        )
        print("[workouts-generate-debug] completed")
        return _json_response(200, payload)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except (APIConnectionError, APITimeoutError):
        return _json_response(502, {"message": "Failed to reach OpenAI API."})
    except APIError as err:
        return _json_response(502, {"message": f"OpenAI request failed: {str(err)}"})
    except Exception as err:
        print(f"generate_suggestions unexpected error: {repr(err)}")
        traceback.print_exc()
        return _json_response(500, {"message": "Unexpected error while generating workout library."})
