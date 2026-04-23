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
DEFAULT_TIMEZONE_LABEL = "Asia/Jerusalem"
MIN_FREE_WINDOW_MINUTES = 20
MAX_SUGGESTIONS = 8
WORKOUT_LIBRARY_BUCKETS: List[Tuple[str, int, int]] = [
    ("10_20", 10, 20),
    ("20_40", 20, 40),
    ("40_60", 40, 60),
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


def _dynamodb_table(table_env_var: str):
    region = os.getenv("AWS_REGION")
    table_name = os.getenv(table_env_var)
    if not table_name:
        raise ValueError(f"Missing {table_env_var} env var.")
    dynamodb = boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")
    return dynamodb.Table(table_name)


def _busyblocks_table_has_expected_schema() -> bool:
    region = os.getenv("AWS_REGION")
    table_name = os.getenv("BUSY_BLOCKS_TABLE")
    if not table_name:
        raise ValueError("Missing BUSY_BLOCKS_TABLE env var.")
    client = boto3.client("dynamodb", region_name=region) if region else boto3.client("dynamodb")
    response = client.describe_table(TableName=table_name)
    key_schema = response.get("Table", {}).get("KeySchema", [])
    hash_key = ""
    range_key = ""
    for entry in key_schema:
        if entry.get("KeyType") == "HASH":
            hash_key = str(entry.get("AttributeName") or "")
        if entry.get("KeyType") == "RANGE":
            range_key = str(entry.get("AttributeName") or "")
    return hash_key == "user_id" and range_key == "block_key"


def _safe_string_list(value: Any) -> List[str]:
    if isinstance(value, list):
        return [x.strip() for x in value if isinstance(x, str) and x.strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _to_int(value: Any, default: int) -> int:
    if isinstance(value, Decimal):
        try:
            return int(value)
        except Exception:
            return default
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if value.is_integer():
            return int(value)
        return default
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return default
        try:
            return int(float(raw))
        except Exception:
            return default
    return default


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


def _query_busy_blocks(user_id: str, start_date: str, end_date: str) -> List[Dict[str, Any]]:
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
            if not block_date:
                continue
            if block_date < start_date or block_date > end_date:
                continue
            start_time = str(item.get("start_time", "")).strip()
            end_time = str(item.get("end_time", "")).strip()
            if not _parse_hh_mm(start_time) or not _parse_hh_mm(end_time):
                continue
            items.append(
                {
                    "date": block_date,
                    "start_time": start_time,
                    "end_time": end_time,
                }
            )
        last_evaluated_key = response.get("LastEvaluatedKey")
        if not last_evaluated_key:
            break

    items.sort(key=lambda b: (b["date"], b["start_time"], b["end_time"]))
    return items


def _minutes_between(start_t: time, end_t: time) -> int:
    start_m = start_t.hour * 60 + start_t.minute
    end_m = end_t.hour * 60 + end_t.minute
    return max(0, end_m - start_m)


def _format_slot_label(start_t: time, end_t: time) -> str:
    return f"{start_t.strftime('%H:%M')}-{end_t.strftime('%H:%M')}"


def _time_label_for(start_t: time) -> str:
    h = start_t.hour
    if 5 <= h < 12:
        return "Morning"
    if 12 <= h < 16:
        return "Noon"
    if 15 <= h < 18:
        return "Afternoon"
    if 18 <= h < 22:
        return "Evening"
    return "Morning"


def _derive_free_windows(
    *,
    start_date_value: date,
    end_date_value: date,
    busy_blocks: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    by_day: Dict[str, List[Tuple[time, time]]] = {}
    for block in busy_blocks:
        block_date = block["date"]
        start_t = _parse_hh_mm(block["start_time"])
        end_t = _parse_hh_mm(block["end_time"])
        if not start_t or not end_t:
            continue
        if _minutes_between(start_t, end_t) <= 0:
            continue
        by_day.setdefault(block_date, []).append((start_t, end_t))

    all_windows: List[Dict[str, Any]] = []
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

        day_windows: List[Tuple[time, time]] = []
        day_start = time(6, 0)
        day_end = time(22, 0)
        current = day_start

        for busy_start, busy_end in merged:
            if busy_start > current:
                day_windows.append((current, busy_start))
            if busy_end > current:
                current = busy_end
        if current < day_end:
            day_windows.append((current, day_end))

        for start_t, end_t in day_windows:
            duration = _minutes_between(start_t, end_t)
            if duration < MIN_FREE_WINDOW_MINUTES:
                continue
            all_windows.append(
                {
                    "date": day_key,
                    "start_time": start_t.strftime("%H:%M"),
                    "end_time": end_t.strftime("%H:%M"),
                    "duration_minutes": duration,
                    "time_label": _time_label_for(start_t),
                    "slot_label": _format_slot_label(start_t, end_t),
                }
            )

        day_cursor = day_cursor + timedelta(days=1)

    return all_windows


def _intersect_time_ranges(
    left_start: time, left_end: time, right_start: time, right_end: time
) -> Optional[Tuple[time, time]]:
    start_minutes = max(left_start.hour * 60 + left_start.minute, right_start.hour * 60 + right_start.minute)
    end_minutes = min(left_end.hour * 60 + left_end.minute, right_end.hour * 60 + right_end.minute)
    if end_minutes <= start_minutes:
        return None
    start = time(start_minutes // 60, start_minutes % 60)
    end = time(end_minutes // 60, end_minutes % 60)
    return start, end


def _allowed_preference_keys(preferred_workout_times: List[str]) -> List[str]:
    keys = [k for k in preferred_workout_times if k in PREFERRED_TIME_RANGES]
    if not keys:
        return ["any_time"]
    if "any_time" in keys:
        return ["any_time"]
    # preserve stable order by configured range order
    ordered: List[str] = []
    for key in ["morning", "noon", "afternoon", "evening"]:
        if key in keys:
            ordered.append(key)
    return ordered or ["any_time"]


def _derive_eligible_windows(
    free_windows: List[Dict[str, Any]], preferred_workout_times: List[str]
) -> List[Dict[str, Any]]:
    preferred_keys = _allowed_preference_keys(preferred_workout_times)
    eligible: List[Dict[str, Any]] = []
    for window in free_windows:
        free_start = _parse_hh_mm(str(window.get("start_time", "")))
        free_end = _parse_hh_mm(str(window.get("end_time", "")))
        if not free_start or not free_end:
            continue
        for pref_key in preferred_keys:
            pref_start, pref_end = PREFERRED_TIME_RANGES[pref_key]
            intersection = _intersect_time_ranges(free_start, free_end, pref_start, pref_end)
            if not intersection:
                continue
            slot_start, slot_end = intersection
            duration = _minutes_between(slot_start, slot_end)
            if duration < MIN_FREE_WINDOW_MINUTES:
                continue
            label = _time_label_for(slot_start) if pref_key == "any_time" else pref_key.replace("_", " ").title()
            eligible.append(
                {
                    "date": window["date"],
                    "start_time": slot_start.strftime("%H:%M"),
                    "end_time": slot_end.strftime("%H:%M"),
                    "duration_minutes": duration,
                    "time_label": label,
                    "slot_label": _format_slot_label(slot_start, slot_end),
                }
            )
    return eligible


def _parse_period(payload: Dict[str, Any]) -> Tuple[Optional[date], Optional[date], Optional[str]]:
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


def _build_openai_prompt(
    *,
    period: Dict[str, str],
    preferences: Dict[str, Any],
    free_windows: List[Dict[str, Any]],
) -> str:
    compact = {
        "period": period,
        "preferences": preferences,
        "free_windows": free_windows[:80],
        "rules": {
            "max_suggestions": MAX_SUGGESTIONS,
            "use_only_available_windows": True,
            "no_calendar_scheduling": True,
            "output_language": "English",
            "must_fit_within_preferred_time_ranges": True,
        },
    }
    return (
        "Generate workout suggestions for one user.\n"
        "Return JSON only, no markdown.\n"
        "Schema:\n"
        "{\n"
        '  "weekly_plan_suggestions":[{\n'
        '    "id":"workout_1",\n'
        '    "title":"...",\n'
        '    "workout_type":"walking|gym|strength|yoga|pilates|running|stretching|home_workouts",\n'
        '    "duration_minutes":30,\n'
        '    "intensity":"light|moderate|high",\n'
        '    "recommended_day":"YYYY-MM-DD",\n'
        '    "recommended_start_time":"HH:MM",\n'
        '    "recommended_end_time":"HH:MM",\n'
        '    "recommended_time_label":"Morning|Noon|Evening|Night",\n'
        '    "reason_short":"short reason"\n'
        "  }]\n"
        "}\n"
        "Input:\n"
        f"{json.dumps(compact, separators=(',', ':'))}"
    )


def _extract_response_text(payload: Dict[str, Any]) -> str:
    output = payload.get("output")
    if not isinstance(output, list):
        return ""
    parts: List[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            text = block.get("text")
            if isinstance(text, str) and text.strip():
                parts.append(text.strip())
    return "\n".join(parts).strip()


def _fallback_weekly_plan_suggestions(
    *,
    eligible_windows: List[Dict[str, Any]],
    preferred_types: List[str],
    workouts_per_week: int,
) -> List[Dict[str, Any]]:
    fallback_type = preferred_types[0] if preferred_types else "walking"
    weekly_plan_suggestions: List[Dict[str, Any]] = []
    limit = max(1, min(workouts_per_week, MAX_SUGGESTIONS))
    for idx, window in enumerate(eligible_windows[:limit], start=1):
        max_duration = int(window["duration_minutes"])
        duration = min(45, max(20, max_duration))
        start_t = _parse_hh_mm(window["start_time"])
        if not start_t:
            continue
        end_minutes = start_t.hour * 60 + start_t.minute + duration
        end_t = time(end_minutes // 60, end_minutes % 60)
        suggestions.append(
            {
                "id": f"workout_{idx}",
                "title": f"{window['time_label']} {fallback_type.replace('_', ' ')} session",
                "workout_type": fallback_type,
                "duration_minutes": duration,
                "intensity": "light",
                "recommended_day": window["date"],
                "recommended_start_time": window["start_time"],
                "recommended_end_time": end_t.strftime("%H:%M"),
                "recommended_time_label": window["time_label"],
                "reason_short": "Matches your available free-time window.",
            }
        )
    return suggestions


def _normalize_weekly_plan_suggestions(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    normalized: List[Dict[str, Any]] = []
    for idx, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            continue
        title = str(item.get("title", "")).strip()
        workout_type = str(item.get("workout_type", "")).strip()
        recommended_day = str(item.get("recommended_day", "")).strip()
        recommended_start_time = str(item.get("recommended_start_time", "")).strip()
        recommended_end_time = str(item.get("recommended_end_time", "")).strip()
        recommended_time_label = str(item.get("recommended_time_label", "")).strip()
        reason_short = str(item.get("reason_short", "")).strip()
        intensity = str(item.get("intensity", "")).strip().lower()
        duration = _to_int(item.get("duration_minutes"), 0)

        if not title or not workout_type or not recommended_day:
            continue
        start_t = _parse_hh_mm(recommended_start_time)
        end_t = _parse_hh_mm(recommended_end_time)
        if not start_t or not end_t:
            continue
        if _minutes_between(start_t, end_t) <= 0:
            continue
        if not recommended_time_label:
            recommended_time_label = "Evening"
        if intensity not in {"light", "moderate", "high"}:
            intensity = "moderate"
        if duration <= 0:
            duration = 30
        if not reason_short:
            reason_short = "Matches your goals and available free time."

        normalized.append(
            {
                "id": f"workout_{idx}",
                "title": title,
                "workout_type": workout_type,
                "duration_minutes": duration,
                "intensity": intensity,
                "recommended_day": recommended_day,
                "recommended_start_time": recommended_start_time,
                "recommended_end_time": recommended_end_time,
                "recommended_time_label": recommended_time_label,
                "reason_short": reason_short,
            }
        )
        if len(normalized) >= MAX_SUGGESTIONS:
            break
    return normalized


def _call_openai_for_weekly_plan(
    *,
    period: Dict[str, str],
    preferences: Dict[str, Any],
    free_windows: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], str]:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise ValueError("Missing OPENAI_API_KEY env var.")

    prompt = _build_openai_prompt(period=period, preferences=preferences, free_windows=free_windows)
    client = OpenAI(api_key=api_key)
    response = client.responses.create(
        model=OPENAI_MODEL,
        input=prompt,
        text={"format": {"type": "json_object"}},
    )
    text_out = getattr(response, "output_text", "")
    if not isinstance(text_out, str) or not text_out.strip():
        model_payload = response.model_dump() if hasattr(response, "model_dump") else {}
        text_out = _extract_response_text(model_payload if isinstance(model_payload, dict) else {})
    if not text_out:
        return [], "Model returned empty output."
    try:
        parsed = json.loads(text_out)
    except json.JSONDecodeError:
        return [], "Model returned malformed JSON."
    if not isinstance(parsed, dict):
        return [], "Model returned an unexpected JSON shape."
    raw = parsed.get("weekly_plan_suggestions")
    if raw is None:
        raw = parsed.get("suggestions")
    return _normalize_weekly_plan_suggestions(raw), ""


def _fits_any_eligible_window(
    *,
    suggestion: Dict[str, Any],
    eligible_windows: List[Dict[str, Any]],
) -> bool:
    s_day = suggestion["recommended_day"]
    s_start = _parse_hh_mm(suggestion["recommended_start_time"])
    s_end = _parse_hh_mm(suggestion["recommended_end_time"])
    if not s_start or not s_end:
        return False

    for window in eligible_windows:
        if window["date"] != s_day:
            continue
        w_start = _parse_hh_mm(window["start_time"])
        w_end = _parse_hh_mm(window["end_time"])
        if not w_start or not w_end:
            continue
        if s_start >= w_start and s_end <= w_end:
            return True
    return False


def _fits_time_label_window(suggestion: Dict[str, Any]) -> bool:
    label_raw = str(suggestion.get("recommended_time_label", "")).strip().lower().replace(" ", "_")
    s_start = _parse_hh_mm(suggestion["recommended_start_time"])
    s_end = _parse_hh_mm(suggestion["recommended_end_time"])
    if not s_start or not s_end:
        return False
    if label_raw not in PREFERRED_TIME_RANGES:
        return True
    pref_start, pref_end = PREFERRED_TIME_RANGES[label_raw]
    return s_start >= pref_start and s_end <= pref_end


def _validate_weekly_plan_suggestions(
    *, suggestions: List[Dict[str, Any]], eligible_windows: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    valid: List[Dict[str, Any]] = []
    for suggestion in suggestions:
        if not _fits_time_label_window(suggestion):
            continue
        if not _fits_any_eligible_window(suggestion=suggestion, eligible_windows=eligible_windows):
            continue
        valid.append(suggestion)
    return valid


def _workout_type_intensity(workout_type: str) -> str:
    low = {"walking", "stretching", "yoga", "pilates"}
    high = {"running", "gym", "strength"}
    if workout_type in low:
        return "light"
    if workout_type in high:
        return "moderate"
    return "moderate"


def _build_workout_library(preferred_types: List[str]) -> List[Dict[str, Any]]:
    allowed_types = [w for w in preferred_types if isinstance(w, str) and w.strip()]
    library: List[Dict[str, Any]] = []
    for workout_type in allowed_types:
        clean_type = workout_type.strip()
        intensity = _workout_type_intensity(clean_type)
        for bucket, min_m, max_m in WORKOUT_LIBRARY_BUCKETS:
            type_title = clean_type.replace("_", " ")
            library.append(
                {
                    "id": f"library_{clean_type}_{bucket}",
                    "workout_type": clean_type,
                    "duration_bucket": bucket,
                    "duration_min_minutes": min_m,
                    "duration_max_minutes": max_m,
                    "title": f"{type_title.title()} workout ({min_m}-{max_m} min)",
                    "intensity": intensity,
                    "summary_short": f"A {type_title} option in the {min_m}-{max_m} minute range.",
                }
            )
    return library


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

    try:
        payload = _parse_body(event)
    except json.JSONDecodeError:
        return _json_response(400, {"message": "Request body must be valid JSON."})

    start_date_value, end_date_value, period_error = _parse_period(payload)
    if period_error:
        return _json_response(400, {"message": period_error})
    assert start_date_value is not None and end_date_value is not None

    period = {
        "start_date": start_date_value.isoformat(),
        "end_date": end_date_value.isoformat(),
    }

    try:
        if not _busyblocks_table_has_expected_schema():
            return _json_response(
                500,
                {"message": "BusyBlocks table schema mismatch. Required keys: PK user_id, SK block_key."},
            )
        preferences = _read_user_preferences(user_id)
        busy_blocks = _query_busy_blocks(user_id, period["start_date"], period["end_date"])
        free_windows = _derive_free_windows(
            start_date_value=start_date_value,
            end_date_value=end_date_value,
            busy_blocks=busy_blocks,
        )
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception:
        return _json_response(500, {"message": "Unexpected error while preparing workout inputs."})

    eligible_windows = _derive_eligible_windows(
        free_windows=free_windows,
        preferred_workout_times=preferences.get("preferred_workout_times") or [],
    )

    if not eligible_windows:
        return _json_response(
            200,
            {
                "period": period,
                "weekly_plan_suggestions": [],
                "workout_library": _build_workout_library(preferences.get("preferred_workout_types") or []),
                "metadata": {
                    "generated_at": _iso_utc_now(),
                    "source": "openai_gpt_4_1_mini",
                    "timezone": DEFAULT_TIMEZONE_LABEL,
                    "free_windows_count": 0,
                },
            },
        )

    try:
        weekly_plan_suggestions, openai_warning = _call_openai_for_weekly_plan(
            period=period,
            preferences=preferences,
            free_windows=eligible_windows,
        )
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except (APIConnectionError, APITimeoutError):
        return _json_response(502, {"message": "Failed to reach OpenAI API."})
    except APIError as err:
        return _json_response(502, {"message": f"OpenAI request failed: {str(err)}"})
    except Exception:
        return _json_response(500, {"message": "Unexpected error while generating workout suggestions."})

    weekly_plan_suggestions = _validate_weekly_plan_suggestions(
        suggestions=weekly_plan_suggestions, eligible_windows=eligible_windows
    )

    if not weekly_plan_suggestions:
        weekly_plan_suggestions = _fallback_weekly_plan_suggestions(
            eligible_windows=eligible_windows,
            preferred_types=preferences.get("preferred_workout_types") or [],
            workouts_per_week=preferences.get("workouts_per_week") or 3,
        )
        if not openai_warning:
            openai_warning = "Model returned no valid suggestions."

    return _json_response(
        200,
        {
            "period": period,
            "weekly_plan_suggestions": weekly_plan_suggestions,
            "workout_library": _build_workout_library(preferences.get("preferred_workout_types") or []),
            "metadata": {
                "generated_at": _iso_utc_now(),
                "source": "openai_gpt_4_1_mini",
                "timezone": DEFAULT_TIMEZONE_LABEL,
                "free_windows_count": len(free_windows),
                "generation_warning": openai_warning,
            },
        },
    )
