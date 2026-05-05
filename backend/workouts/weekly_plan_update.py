import json
import os
from datetime import datetime, time, timezone
from decimal import Decimal
from hashlib import sha1
from typing import Any, Dict, List, Optional, Tuple

import boto3
from boto3.dynamodb.conditions import Key

WORKOUT_LIBRARY_DEFAULT_TABLE_NAME = "WorkoutLibrary"
DAY_START_MINUTES = 6 * 60
DAY_END_MINUTES = 22 * 60

_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://main.dnp9vhzk0bw8l.amplifyapp.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,PATCH",
}


def _json_response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {"statusCode": status_code, "headers": dict(_CORS_HEADERS), "body": json.dumps(body)}


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


def _dynamodb_resource():
    region = os.getenv("AWS_REGION")
    return boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")


def _workout_library_table():
    table_name = (os.getenv("WORKOUT_LIBRARY_TABLE") or WORKOUT_LIBRARY_DEFAULT_TABLE_NAME).strip()
    if not table_name:
        raise ValueError("WorkoutLibrary table name is missing.")
    return _dynamodb_resource().Table(table_name)


def _busy_blocks_table():
    table_name = os.getenv("BUSY_BLOCKS_TABLE")
    if not table_name:
        raise ValueError("Missing BUSY_BLOCKS_TABLE env var.")
    return _dynamodb_resource().Table(table_name)


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


def _time_label_for(start_t: time) -> str:
    h = start_t.hour
    if 6 <= h < 11:
        return "Morning"
    if 11 <= h < 15:
        return "Noon"
    if 15 <= h < 18:
        return "Afternoon"
    return "Evening"


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
        cleaned.append(
            {
                "id": str(item.get("id", "")).strip() or f"plan_{len(cleaned)+1}",
                "library_workout_id": lib_id,
                "recommended_day": rec_day,
                "recommended_start_time": rec_start,
                "recommended_end_time": rec_end,
                "recommended_time_label": str(item.get("recommended_time_label", "")).strip() or "Evening",
                "reason_short": str(item.get("reason_short", "")).strip() or "Matches your saved workout library and current free time.",
            }
        )
    return cleaned


def _query_busy_blocks(user_id: str, start_date_iso: str, end_date_iso: str) -> List[Dict[str, Any]]:
    table = _busy_blocks_table()
    items: List[Dict[str, Any]] = []
    last_evaluated_key: Optional[Dict[str, Any]] = None
    while True:
        query_args: Dict[str, Any] = {"KeyConditionExpression": Key("user_id").eq(user_id)}
        if last_evaluated_key:
            query_args["ExclusiveStartKey"] = last_evaluated_key
        response = table.query(**query_args)
        for item in response.get("Items") or []:
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
    items.sort(key=lambda x: (x["date"], x["start_time"], x["end_time"]))
    return items


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
    return sha1(json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _busyblocks_signature(busy_blocks: List[Dict[str, Any]]) -> str:
    normalized = []
    for block in busy_blocks:
        normalized.append({"date": str(block.get("date", "")).strip(), "start_time": str(block.get("start_time", "")).strip(), "end_time": str(block.get("end_time", "")).strip()})
    normalized.sort(key=lambda x: (x["date"], x["start_time"], x["end_time"]))
    return sha1(json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _next_plan_id(current_plan: List[Dict[str, Any]]) -> str:
    max_idx = 0
    for item in current_plan:
        plan_id = str(item.get("id", "")).strip()
        if plan_id.startswith("plan_") and plan_id[5:].isdigit():
            max_idx = max(max_idx, int(plan_id[5:]))
    return f"plan_{max_idx + 1}"


def _slot_is_valid(*, week_start: str, week_end: str, recommended_day: str, recommended_start_time: str, duration_minutes: int, busy_blocks: List[Dict[str, Any]]) -> Tuple[bool, str, str]:
    if recommended_day < week_start or recommended_day > week_end:
        return False, "", "Selected day must be inside the visible week."
    start_t = _parse_hh_mm(recommended_start_time)
    if not start_t:
        return False, "", "recommended_start_time must be HH:MM."
    start_m = start_t.hour * 60 + start_t.minute
    end_m = start_m + duration_minutes
    if start_m < DAY_START_MINUTES or end_m > DAY_END_MINUTES:
        return False, "", "Selected time is outside allowed workout hours (06:00-22:00)."
    for block in busy_blocks:
        if block.get("date") != recommended_day:
            continue
        b_start = _parse_hh_mm(str(block.get("start_time", "")))
        b_end = _parse_hh_mm(str(block.get("end_time", "")))
        if not b_start or not b_end:
            continue
        b_start_m = b_start.hour * 60 + b_start.minute
        b_end_m = b_end.hour * 60 + b_end.minute
        if max(start_m, b_start_m) < min(end_m, b_end_m):
            return False, "", "Selected slot overlaps an existing busy block."
    return True, f"{end_m // 60:02d}:{end_m % 60:02d}", ""


def _persist_weekly_plan(*, user_id: str, week_start: str, week_end: str, weekly_plan: List[Dict[str, Any]], workout_library: List[Dict[str, Any]], busy_blocks: List[Dict[str, Any]]) -> str:
    updated_at = _iso_utc_now()
    _workout_library_table().update_item(
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
            ":week_start": week_start,
            ":week_end": week_end,
            ":weekly_plan": weekly_plan,
            ":busy_sig": _busyblocks_signature(busy_blocks),
            ":lib_sig": _library_signature(workout_library),
            ":plan_updated_at": updated_at,
            ":updated_at": updated_at,
        },
    )
    return updated_at


def _handle_add_library_workout(*, user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    week_start = str(payload.get("week_start", "")).strip()
    week_end = str(payload.get("week_end", "")).strip()
    library_workout_id = str(payload.get("library_workout_id", "")).strip()
    recommended_day = str(payload.get("recommended_day", "")).strip()
    recommended_start_time = str(payload.get("recommended_start_time", "")).strip()
    if not week_start or not week_end or not library_workout_id or not recommended_day or not recommended_start_time:
        return _json_response(400, {"message": "week_start, week_end, library_workout_id, recommended_day and recommended_start_time are required."})

    item = _workout_library_table().get_item(Key={"user_id": user_id}).get("Item")
    if not isinstance(item, dict):
        return _json_response(400, {"message": "Saved workout library is missing."})
    workout_library = item.get("workout_library")
    if not isinstance(workout_library, list):
        return _json_response(400, {"message": "Saved workout library is missing."})

    library_item = next((lib for lib in workout_library if isinstance(lib, dict) and str(lib.get("id", "")).strip() == library_workout_id), None)
    if not library_item:
        return _json_response(400, {"message": "Selected library workout does not exist."})

    duration_minutes = _to_int(library_item.get("duration_minutes"), 0)
    if duration_minutes <= 0:
        return _json_response(400, {"message": "Selected workout has invalid duration."})

    busy_blocks = _query_busy_blocks(user_id, week_start, week_end)
    slot_ok, recommended_end_time, err = _slot_is_valid(
        week_start=week_start,
        week_end=week_end,
        recommended_day=recommended_day,
        recommended_start_time=recommended_start_time,
        duration_minutes=duration_minutes,
        busy_blocks=busy_blocks,
    )
    if not slot_ok:
        return _json_response(400, {"message": err})

    weekly_plan = _normalize_saved_weekly_plan(item.get("current_week_plan"))
    start_t = _parse_hh_mm(recommended_start_time) or time(18, 0)
    weekly_plan.append(
        {
            "id": _next_plan_id(weekly_plan),
            "library_workout_id": library_workout_id,
            "recommended_day": recommended_day,
            "recommended_start_time": recommended_start_time,
            "recommended_end_time": recommended_end_time,
            "recommended_time_label": _time_label_for(start_t),
            "reason_short": "Added from your workout library.",
        }
    )
    weekly_plan.sort(key=lambda x: (x["recommended_day"], x["recommended_start_time"], x["recommended_end_time"], x["id"]))

    updated_at = _persist_weekly_plan(
        user_id=user_id,
        week_start=week_start,
        week_end=week_end,
        weekly_plan=weekly_plan,
        workout_library=workout_library,
        busy_blocks=busy_blocks,
    )
    return _json_response(200, {"weekly_plan_suggestions": weekly_plan, "updated_at": updated_at})


def _handle_remove_plan_item(*, user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    week_start = str(payload.get("week_start", "")).strip()
    week_end = str(payload.get("week_end", "")).strip()
    plan_id = str(payload.get("plan_id", "")).strip()
    if not week_start or not week_end or not plan_id:
        return _json_response(400, {"message": "week_start, week_end and plan_id are required."})

    item = _workout_library_table().get_item(Key={"user_id": user_id}).get("Item")
    if not isinstance(item, dict):
        return _json_response(400, {"message": "Saved weekly plan is missing."})
    workout_library = item.get("workout_library")
    if not isinstance(workout_library, list):
        return _json_response(400, {"message": "Saved workout library is missing."})

    weekly_plan = _normalize_saved_weekly_plan(item.get("current_week_plan"))
    filtered = [entry for entry in weekly_plan if str(entry.get("id", "")).strip() != plan_id]
    if len(filtered) == len(weekly_plan):
        return _json_response(404, {"message": "Weekly plan item not found."})

    busy_blocks = _query_busy_blocks(user_id, week_start, week_end)
    updated_at = _persist_weekly_plan(
        user_id=user_id,
        week_start=week_start,
        week_end=week_end,
        weekly_plan=filtered,
        workout_library=workout_library,
        busy_blocks=busy_blocks,
    )
    return _json_response(200, {"weekly_plan_suggestions": filtered, "updated_at": updated_at})


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    request_context = event.get("requestContext") or {}
    http = request_context.get("http") or {}
    method = (http.get("method") or event.get("httpMethod") or "").upper()
    if method == "OPTIONS":
        return {"statusCode": 200, "headers": dict(_CORS_HEADERS), "body": ""}
    if method != "PATCH":
        return _json_response(405, {"message": "Method not allowed."})

    user_id = _extract_cognito_sub(event)
    if not user_id:
        return _json_response(401, {"message": "Missing Cognito user id (sub) in request."})

    try:
        payload = _parse_body(event)
    except json.JSONDecodeError:
        return _json_response(400, {"message": "Request body must be valid JSON."})

    action = str(payload.get("action", "")).strip()
    if action == "add_library_workout":
        return _handle_add_library_workout(user_id=user_id, payload=payload)
    if action == "remove_plan_item":
        return _handle_remove_plan_item(user_id=user_id, payload=payload)
    return _json_response(400, {"message": "Unsupported weekly-plan action."})
