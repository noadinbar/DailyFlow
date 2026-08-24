import json
import os
from hashlib import sha1
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

import boto3
from boto3.dynamodb.conditions import Key

MAX_PERIOD_DAYS = 14
MIN_FREE_WINDOW_MINUTES = 20
DEFAULT_TIMEZONE_LABEL = "Asia/Jerusalem"
WORKOUT_LIBRARY_DEFAULT_TABLE_NAME = "WorkoutLibrary"
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
    "Access-Control-Allow-Methods": "OPTIONS,GET",
}


def _json_response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": dict(_CORS_HEADERS),
        "body": json.dumps(body),
    }


def _iso_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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


def _dynamodb_resource():
    region = os.getenv("AWS_REGION")
    return boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")


def _dynamodb_client():
    region = os.getenv("AWS_REGION")
    return boto3.client("dynamodb", region_name=region) if region else boto3.client("dynamodb")


def _lambda_client():
    region = os.getenv("AWS_REGION")
    return boto3.client("lambda", region_name=region) if region else boto3.client("lambda")


def _s3_client():
    region = os.getenv("AWS_REGION")
    return boto3.client("s3", region_name=region) if region else boto3.client("s3")


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
        print("[workouts-suggestions-debug] skip image cleanup invoke: missing WORKOUT_IMAGE_GENERATOR_LAMBDA")
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
        print(f"[workouts-suggestions-debug] image cleanup queued keep_count={len(keep_plan_ids)}")
    except Exception as err:
        print(f"[workouts-suggestions-debug] image cleanup invoke failed: {err}")


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


def _normalize_type_key(value: Any) -> str:
    return str(value or "").strip().lower().replace(" ", "_")


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


def _period_from_get_event(event: Dict[str, Any]) -> Tuple[Optional[date], Optional[date], Optional[str]]:
    params = event.get("queryStringParameters") or {}
    payload = {
        "start_date": params.get("start_date") if isinstance(params, dict) else None,
        "end_date": params.get("end_date") if isinstance(params, dict) else None,
    }
    return _parse_period_payload(payload)


def _period_from_body(event: Dict[str, Any]) -> Tuple[Optional[date], Optional[date], Optional[str], Dict[str, Any]]:
    payload: Dict[str, Any] = {}
    try:
        payload = _parse_body(event)
    except json.JSONDecodeError:
        return None, None, "Request body must be valid JSON.", {}
    start_date_value, end_date_value, err = _parse_period_payload(payload)
    return start_date_value, end_date_value, err, payload


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


def _load_saved_library(user_id: str) -> Tuple[List[Dict[str, Any]], str]:
    table = _workout_library_table()
    response = table.get_item(Key={"user_id": user_id})
    item = response.get("Item") if isinstance(response, dict) else None
    if not isinstance(item, dict):
        return [], ""
    generated_at = str(item.get("generated_at", "")).strip()
    raw_library = item.get("workout_library")
    if not isinstance(raw_library, list):
        return [], generated_at
    cleaned: List[Dict[str, Any]] = []
    for entry in raw_library:
        if not isinstance(entry, dict):
            continue
        item_id = str(entry.get("id", "")).strip()
        title = str(entry.get("title", "")).strip()
        workout_type = str(entry.get("workout_type", "")).strip()
        duration_minutes = _to_int(entry.get("duration_minutes"), 0)
        intensity = str(entry.get("intensity", "")).strip() or "Moderate"
        location = str(entry.get("location", "")).strip() or "Home"
        summary_short = str(entry.get("summary_short", "")).strip()
        workout_flow = entry.get("workout_flow")
        if not item_id or not title or not workout_type or duration_minutes <= 0:
            continue
        if not isinstance(workout_flow, dict):
            workout_flow = {
                "summary": summary_short or f"{title} flow.",
                "warmup_steps": [],
                "main_steps": [],
                "cooldown_steps": [],
                "notes": [],
            }
        cleaned.append(
            {
                "id": item_id,
                "title": title,
                "workout_type": workout_type,
                "duration_minutes": duration_minutes,
                "intensity": intensity,
                "location": location,
                "summary_short": summary_short or f"{title} workout.",
                "workout_flow": workout_flow,
            }
        )
    return cleaned, generated_at


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
        summary_short = str(entry.get("summary_short", "")).strip() or f"{title} workout."
        workout_flow = entry.get("workout_flow") if isinstance(entry.get("workout_flow"), dict) else {}
        normalized = {
            "favorite_key": str(entry.get("favorite_key", "")).strip(),
            "id": str(entry.get("id", "")).strip() or "",
            "title": title,
            "workout_type": workout_type,
            "duration_minutes": duration_minutes,
            "duration_bucket": str(entry.get("duration_bucket", "")).strip() or _duration_bucket(duration_minutes),
            "intensity": intensity,
            "location": location,
            "summary_short": summary_short,
            "workout_flow": workout_flow,
        }
        favorite_key = normalized["favorite_key"] or _favorite_key_from_item(normalized)
        if favorite_key in seen:
            continue
        normalized["favorite_key"] = favorite_key
        seen.add(favorite_key)
        cleaned.append(normalized)
    return cleaned


def _load_saved_workouts_item(user_id: str) -> Dict[str, Any]:
    table = _workout_library_table()
    response = table.get_item(Key={"user_id": user_id})
    item = response.get("Item") if isinstance(response, dict) else None
    if not isinstance(item, dict):
        return {}
    return item


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
        rec_label = str(item.get("recommended_time_label", "")).strip()
        reason = str(item.get("reason_short", "")).strip()
        if not lib_id or not rec_day or not rec_start or not rec_end:
            continue
        normalized: Dict[str, Any] = {
            "id": str(item.get("id", "")).strip() or f"plan_{len(cleaned)+1}",
            "library_workout_id": lib_id,
            "recommended_day": rec_day,
            "recommended_start_time": rec_start,
            "recommended_end_time": rec_end,
            "recommended_time_label": rec_label or "Evening",
            "reason_short": reason or "Matches your saved workout library and current free time.",
            "google_event_id": str(item.get("google_event_id", "")).strip(),
            "dailyflow_calendar_id": str(item.get("dailyflow_calendar_id", "")).strip(),
        }
        image_key = str(item.get("workout_image_key", "")).strip()
        if image_key and str(item.get("google_event_id", "")).strip():
            normalized["workout_image_key"] = image_key
        cleaned.append(normalized)
    return cleaned


def _workout_image_presigned_url(*, user_id: str, object_key: str) -> str:
    bucket = os.getenv("WORKOUT_IMAGES_BUCKET", "").strip()
    if not bucket:
        raise ValueError("Missing WORKOUT_IMAGES_BUCKET env var.")
    expected_prefix = f"users/{user_id}/workout-image/"
    if not object_key.startswith(expected_prefix) or ".." in object_key:
        raise ValueError("workout_image_key is outside the user workout-image prefix.")
    return _s3_client().generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": object_key},
        ExpiresIn=3600,
    )


def _attach_workout_image_urls(user_id: str, weekly_plan: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    attached: List[Dict[str, Any]] = []
    for item in weekly_plan:
        next_item = dict(item)
        image_key = str(next_item.get("workout_image_key", "")).strip()
        if image_key:
            try:
                next_item["workout_image_url"] = _workout_image_presigned_url(
                    user_id=user_id, object_key=image_key
                )
            except Exception as err:
                plan_id = str(next_item.get("id", "")).strip() or "-"
                print(f"[workouts-suggestions-debug] workout image url failed plan_id={plan_id}: {err}")
        attached.append(next_item)
    return attached


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


def _save_current_week_plan_fields(
    *,
    user_id: str,
    week_start: str,
    week_end: str,
    weekly_plan: List[Dict[str, Any]],
    busyblocks_signature: str,
    library_signature: str,
) -> str:
    updated_at = _iso_utc_now()
    table = _workout_library_table()
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
            ":week_start": week_start,
            ":week_end": week_end,
            ":weekly_plan": weekly_plan,
            ":busy_sig": busyblocks_signature,
            ":lib_sig": library_signature,
            ":plan_updated_at": updated_at,
            ":updated_at": updated_at,
        },
    )
    return updated_at


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


def _derive_weekly_plan(
    *,
    workout_library: List[Dict[str, Any]],
    eligible_windows: List[Dict[str, Any]],
    workouts_per_week: int,
    used_days_seed: Optional[set[str]] = None,
) -> List[Dict[str, Any]]:
    today_iso = _today_iso_utc()
    eligible_windows = [window for window in eligible_windows if str(window.get("date", "")).strip() >= today_iso]
    if not workout_library or not eligible_windows:
        return []
    max_items = max(1, min(workouts_per_week, len(workout_library), len(eligible_windows)))
    remaining_windows = eligible_windows.copy()
    plan: List[Dict[str, Any]] = []
    used_library_ids = set()
    seed_used_days = {day for day in (used_days_seed or set()) if isinstance(day, str) and day.strip()}
    used_days_global = set(seed_used_days)
    available_days_sorted = sorted({window["date"] for window in eligible_windows})
    week_start = available_days_sorted[0] if available_days_sorted else ""
    week_end = available_days_sorted[-1] if available_days_sorted else ""

    def choose_deterministic_start(window: Dict[str, Any], duration: int, library_id: str) -> Tuple[str, str]:
        start_t = _parse_hh_mm(window["start_time"])
        end_t = _parse_hh_mm(window["end_time"])
        if not start_t or not end_t:
            return window["start_time"], window["end_time"]
        start_minutes = start_t.hour * 60 + start_t.minute
        latest_start_minutes = (end_t.hour * 60 + end_t.minute) - duration
        if latest_start_minutes <= start_minutes:
            final_start = start_minutes
        else:
            material = "|".join(
                [
                    library_id,
                    window["date"],
                    week_start,
                    week_end,
                    window["start_time"],
                    window["end_time"],
                ]
            )
            hash_num = int(sha1(material.encode("utf-8")).hexdigest()[:8], 16)
            slot_count = max(1, ((latest_start_minutes - start_minutes) // 5) + 1)
            chosen_slot = hash_num % slot_count
            final_start = start_minutes + chosen_slot * 5
        final_end = final_start + duration
        return f"{final_start // 60:02d}:{final_start % 60:02d}", f"{final_end // 60:02d}:{final_end % 60:02d}"

    def try_place_on_day(day: str) -> bool:
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
                rec_start, rec_end = choose_deterministic_start(chosen_window, duration, lib_id)
                used_library_ids.add(lib_id)
                used_days_global.add(day)
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

    # Pass 1 (hard day-first): at most one new workout per unused day in date order.
    unused_days_sorted = sorted(
        {str(window.get("date", "")).strip() for window in remaining_windows if str(window.get("date", "")).strip()}
        - used_days_global
    )
    for day in unused_days_sorted:
        if len(plan) >= max_items:
            break
        try_place_on_day(day)

    # Pass 2: still missing -> prefer remaining unused days first, then allow used days.
    while len(plan) < max_items:
        progress = False
        remaining_days = {
            str(window.get("date", "")).strip()
            for window in remaining_windows
            if str(window.get("date", "")).strip()
        }
        unused_remaining_days = sorted(day for day in remaining_days if day not in used_days_global)
        for day in unused_remaining_days:
            if len(plan) >= max_items:
                break
            if try_place_on_day(day):
                progress = True
                break
        if len(plan) >= max_items:
            break
        if progress:
            continue
        used_or_any_days = sorted(
            {
                str(window.get("date", "")).strip()
                for window in remaining_windows
                if str(window.get("date", "")).strip()
            }
        )
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
        f"seed_used_days={sorted(seed_used_days)} "
        f"generated_days={[item.get('recommended_day') for item in plan]}"
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
    user_id: str = "",
) -> Dict[str, Any]:
    weekly = (
        _attach_workout_image_urls(user_id, weekly_plan_suggestions)
        if user_id
        else list(weekly_plan_suggestions)
    )
    return {
        "period": period,
        "workout_library": workout_library,
        "favorite_workouts": favorite_workouts,
        "weekly_plan_suggestions": weekly,
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
    favorite_workouts: List[Dict[str, Any]],
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
        user_id=user_id,
    )


def handle_get(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    request_context = event.get("requestContext") or {}
    http = request_context.get("http") or {}
    method = (http.get("method") or event.get("httpMethod") or "").upper()
    if method == "OPTIONS":
        return {"statusCode": 200, "headers": dict(_CORS_HEADERS), "body": ""}
    if method != "GET":
        return _json_response(405, {"message": "Method not allowed."})

    user_id = _extract_cognito_sub(event)
    if not user_id:
        return _json_response(401, {"message": "Missing Cognito user id (sub) in request."})

    start_date_value, end_date_value, period_error = _period_from_get_event(event)
    if period_error:
        return _json_response(400, {"message": period_error})
    assert start_date_value is not None and end_date_value is not None

    try:
        if not _busyblocks_schema_ok():
            return _json_response(500, {"message": "BusyBlocks schema mismatch. Expected PK user_id, SK block_key."})
        if not _workout_library_schema_ok():
            return _json_response(500, {"message": "WorkoutLibrary schema mismatch. Expected PK user_id only."})
        period = {"start_date": start_date_value.isoformat(), "end_date": end_date_value.isoformat()}
        saved_item = _load_saved_workouts_item(user_id)
        workout_library, generated_at = _load_saved_library(user_id)
        favorite_workouts = _normalize_saved_favorites(saved_item.get("favorite_workouts"))

        if not workout_library:
            payload = _response_payload(
                period=period,
                workout_library=[],
                favorite_workouts=favorite_workouts,
                weekly_plan_suggestions=[],
                generated_at=generated_at,
                library_source="saved",
                user_id=user_id,
            )
            return _json_response(200, payload)

        preferences = _read_user_preferences(user_id)
        busy_blocks = _query_busy_blocks(user_id, period["start_date"], period["end_date"])
        free_windows = _derive_free_windows(
            start_date_value=start_date_value, end_date_value=end_date_value, busy_blocks=busy_blocks
        )
        eligible_windows = _derive_eligible_windows(
            free_windows=free_windows, preferred_times=preferences.get("preferred_workout_times") or []
        )

        current_busy_sig = _busyblocks_signature(busy_blocks)
        current_lib_sig = _library_signature(workout_library)
        saved_week_start = str(saved_item.get("current_week_plan_week_start", "")).strip()
        saved_week_end = str(saved_item.get("current_week_plan_week_end", "")).strip()
        saved_busy_sig = str(saved_item.get("current_week_plan_busyblocks_signature", "")).strip()
        saved_lib_sig = str(saved_item.get("current_week_plan_library_signature", "")).strip()
        saved_weekly_plan = _normalize_saved_weekly_plan(saved_item.get("current_week_plan"))

        is_saved_plan_valid = (
            saved_week_start == period["start_date"]
            and saved_week_end == period["end_date"]
            and len(saved_weekly_plan) > 0
        )

        if is_saved_plan_valid:
            payload = _response_payload(
                period=period,
                workout_library=workout_library,
                favorite_workouts=favorite_workouts,
                weekly_plan_suggestions=saved_weekly_plan,
                generated_at=generated_at,
                library_source="saved",
                user_id=user_id,
            )
            payload["metadata"]["weekly_plan_source"] = "saved_current_week_plan"
            return _json_response(200, payload)

        weekly_plan = _derive_weekly_plan(
            workout_library=workout_library,
            eligible_windows=eligible_windows,
            workouts_per_week=preferences.get("workouts_per_week") or 3,
        )
        plan_updated_at = _save_current_week_plan_fields(
            user_id=user_id,
            week_start=period["start_date"],
            week_end=period["end_date"],
            weekly_plan=weekly_plan,
            busyblocks_signature=current_busy_sig,
            library_signature=current_lib_sig,
        )
        _invoke_workout_image_cleanup(
            user_id=user_id,
            keep_plan_ids=_scheduled_keep_plan_ids(weekly_plan),
        )
        payload = _response_payload(
            period=period,
            workout_library=workout_library,
            favorite_workouts=favorite_workouts,
            weekly_plan_suggestions=weekly_plan,
            generated_at=generated_at or plan_updated_at,
            library_source="saved",
            user_id=user_id,
        )
        payload["metadata"]["weekly_plan_source"] = "derived_and_saved_current_week_plan"
        return _json_response(200, payload)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception:
        return _json_response(500, {"message": "Unexpected error while loading workouts suggestions."})


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    # Backward-compatible default handler for GET /workouts/suggestions.
    return handle_get(event, context)
