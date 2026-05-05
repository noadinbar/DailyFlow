import json
import os
from datetime import datetime, time, timezone
from decimal import Decimal
from hashlib import sha1
from typing import Any, Dict, List, Optional, Tuple

import boto3
from boto3.dynamodb.conditions import Key

WORKOUT_LIBRARY_DEFAULT_TABLE_NAME = "WorkoutLibrary"
MIN_FREE_WINDOW_MINUTES = 20
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
    return {"statusCode": status_code, "headers": dict(_CORS_HEADERS), "body": json.dumps(body)}


def _iso_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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
        return int(value) if value.is_integer() else default
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return default
        try:
            return int(float(raw))
        except Exception:
            return default
    return default


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


def _dynamodb_resource():
    region = os.getenv("AWS_REGION")
    return boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")


def _workout_library_table():
    table_name = (os.getenv("WORKOUT_LIBRARY_TABLE") or WORKOUT_LIBRARY_DEFAULT_TABLE_NAME).strip()
    if not table_name:
        raise ValueError("WorkoutLibrary table name is missing.")
    return _dynamodb_resource().Table(table_name)


def _dynamodb_table(table_env_var: str):
    table_name = os.getenv(table_env_var)
    if not table_name:
        raise ValueError(f"Missing {table_env_var} env var.")
    return _dynamodb_resource().Table(table_name)


def _safe_string_list(value: Any) -> List[str]:
    if isinstance(value, list):
        return [x.strip() for x in value if isinstance(x, str) and x.strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _read_user_preferences(user_id: str) -> Dict[str, Any]:
    table = _dynamodb_table("USERS_TABLE")
    response = table.get_item(Key={"user_id": user_id})
    item = response.get("Item") if isinstance(response, dict) else {}
    if not isinstance(item, dict):
        item = {}
    return {"preferred_workout_times": _safe_string_list(item.get("preferred_workout_times"))}


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


def _derive_free_windows(*, start_date_iso: str, end_date_iso: str, busy_blocks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    from datetime import date, timedelta

    by_day: Dict[str, List[Tuple[time, time]]] = {}
    for block in busy_blocks:
        block_date = block["date"]
        start_t = _parse_hh_mm(block["start_time"])
        end_t = _parse_hh_mm(block["end_time"])
        if not start_t or not end_t or _minutes_between(start_t, end_t) <= 0:
            continue
        by_day.setdefault(block_date, []).append((start_t, end_t))
    windows: List[Dict[str, Any]] = []
    start_date_value = date.fromisoformat(start_date_iso)
    end_date_value = date.fromisoformat(end_date_iso)
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
                        {"date": day_key, "start_time": current.strftime("%H:%M"), "end_time": busy_start.strftime("%H:%M")}
                    )
            if busy_end > current:
                current = busy_end
        day_end = time(22, 0)
        if current < day_end:
            duration = _minutes_between(current, day_end)
            if duration >= MIN_FREE_WINDOW_MINUTES:
                windows.append({"date": day_key, "start_time": current.strftime("%H:%M"), "end_time": day_end.strftime("%H:%M")})
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
    normalized.sort(key=lambda x: (x["id"], x["title"], x["workout_type"], x["duration_minutes"], x["intensity"], x["location"]))
    payload = json.dumps(normalized, sort_keys=True, separators=(",", ":"))
    return sha1(payload.encode("utf-8")).hexdigest()


def _busyblocks_signature(busy_blocks: List[Dict[str, Any]]) -> str:
    normalized = []
    for block in busy_blocks:
        normalized.append(
            {"date": str(block.get("date", "")).strip(), "start_time": str(block.get("start_time", "")).strip(), "end_time": str(block.get("end_time", "")).strip()}
        )
    normalized.sort(key=lambda x: (x["date"], x["start_time"], x["end_time"]))
    payload = json.dumps(normalized, sort_keys=True, separators=(",", ":"))
    return sha1(payload.encode("utf-8")).hexdigest()


def _time_ranges_intersect(a_start: str, a_end: str, b_start: str, b_end: str) -> bool:
    a_s = _parse_hh_mm(a_start)
    a_e = _parse_hh_mm(a_end)
    b_s = _parse_hh_mm(b_start)
    b_e = _parse_hh_mm(b_end)
    if not a_s or not a_e or not b_s or not b_e:
        return False
    return max(a_s, b_s) < min(a_e, b_e)


def _is_time_allowed(start_time: str, end_time: str, preferred_times: List[str]) -> bool:
    ranges = _allowed_preference_windows(preferred_times)
    for pref_start, pref_end in ranges:
        if _time_ranges_intersect(start_time, end_time, pref_start.strftime("%H:%M"), pref_end.strftime("%H:%M")):
            return True
    return False


def _normalize_weekly_plan(raw: Any, valid_library_ids: set, start_date: str, end_date: str, preferred_times: List[str]) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    cleaned: List[Dict[str, Any]] = []
    seen_ids = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        item_id = str(item.get("id", "")).strip()
        lib_id = str(item.get("library_workout_id", "")).strip()
        rec_day = str(item.get("recommended_day", "")).strip()
        rec_start = str(item.get("recommended_start_time", "")).strip()
        rec_end = str(item.get("recommended_end_time", "")).strip()
        if not item_id or not lib_id or not rec_day or not rec_start or not rec_end:
            continue
        if item_id in seen_ids:
            continue
        if lib_id not in valid_library_ids:
            continue
        if rec_day < start_date or rec_day > end_date:
            continue
        if not _parse_hh_mm(rec_start) or not _parse_hh_mm(rec_end):
            continue
        if not _is_time_allowed(rec_start, rec_end, preferred_times):
            continue
        cleaned.append(
            {
                "id": item_id,
                "library_workout_id": lib_id,
                "recommended_day": rec_day,
                "recommended_start_time": rec_start,
                "recommended_end_time": rec_end,
                "recommended_time_label": str(item.get("recommended_time_label", "")).strip() or "Evening",
                "reason_short": str(item.get("reason_short", "")).strip() or "Matches your saved workout library and current free time.",
            }
        )
        seen_ids.add(item_id)
    return cleaned


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

    start_date = str(payload.get("start_date", "")).strip()
    end_date = str(payload.get("end_date", "")).strip()
    weekly_plan_raw = payload.get("weekly_plan_suggestions")
    if not start_date or not end_date or not isinstance(weekly_plan_raw, list):
        return _json_response(400, {"message": "start_date, end_date and weekly_plan_suggestions are required."})

    table = _workout_library_table()
    item = table.get_item(Key={"user_id": user_id}).get("Item") or {}
    workout_library = item.get("workout_library")
    if not isinstance(workout_library, list):
        return _json_response(400, {"message": "Saved workout library is missing."})
    valid_library_ids = {str(w.get("id", "")).strip() for w in workout_library if isinstance(w, dict)}
    valid_library_ids = {x for x in valid_library_ids if x}

    preferences = _read_user_preferences(user_id)
    preferred_times = preferences.get("preferred_workout_times") or []
    cleaned_plan = _normalize_weekly_plan(weekly_plan_raw, valid_library_ids, start_date, end_date, preferred_times)

    busy_blocks = _query_busy_blocks(user_id, start_date, end_date)
    busy_sig = _busyblocks_signature(busy_blocks)
    lib_sig = _library_signature(workout_library)
    updated_at = _iso_utc_now()
    table.update_item(
        Key={"user_id": user_id},
        UpdateExpression=(
            "SET current_week_plan_week_start = :week_start, "
            "current_week_plan_week_end = :week_end, "
            "current_week_plan = :weekly_plan, "
            "current_week_plan_busyblocks_signature = :busy_sig, "
            "current_week_plan_library_signature = :lib_sig, "
            "current_week_plan_updated_at = :plan_updated_at, "
            "updated_at = :updated_at"
        ),
        ExpressionAttributeValues={
            ":week_start": start_date,
            ":week_end": end_date,
            ":weekly_plan": cleaned_plan,
            ":busy_sig": busy_sig,
            ":lib_sig": lib_sig,
            ":plan_updated_at": updated_at,
            ":updated_at": updated_at,
        },
    )
    return _json_response(200, {"weekly_plan_suggestions": cleaned_plan, "updated_at": updated_at})
