import json
import os
import sys
from datetime import datetime, time, timezone
from decimal import Decimal
from hashlib import sha1
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

import boto3
from boto3.dynamodb.conditions import Key

_HERE = Path(__file__).resolve().parent
for candidate in (_HERE, _HERE.parent / "scheduling"):
    path = str(candidate)
    if path not in sys.path:
        sys.path.insert(0, path)

from conflicts import OVERLAP_ERROR_MESSAGE, occupied_slots_for_week  # noqa: E402

WORKOUT_LIBRARY_DEFAULT_TABLE_NAME = "WorkoutLibrary"
DAILYFLOW_CALENDAR_SUMMARY = "DailyFlow"
APP_TIMEZONE_ID = "Asia/Jerusalem"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList"
GOOGLE_CALENDAR_URL_TEMPLATE = "https://www.googleapis.com/calendar/v3/calendars/{calendar_id}"
GOOGLE_CALENDAR_CREATE_URL = "https://www.googleapis.com/calendar/v3/calendars"
GOOGLE_CALENDAR_EVENTS_URL_TEMPLATE = "https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events"
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


def _reconnect_required_response() -> Dict[str, Any]:
    return _json_response(
        403,
        {
            "message": "Google Calendar connection expired. Please reconnect.",
            "reconnect_required": True,
        },
    )


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


def _integrations_table():
    table_name = os.getenv("INTEGRATIONS_TABLE")
    if not table_name:
        raise ValueError("Missing INTEGRATIONS_TABLE env var.")
    return _dynamodb_resource().Table(table_name)


def _dailyflow_events_table():
    table_name = (os.getenv("DAILYFLOW_EVENTS_TABLE") or "DailyFlowEvents").strip()
    if not table_name:
        raise ValueError("Missing DAILYFLOW_EVENTS_TABLE env var.")
    return _dynamodb_resource().Table(table_name)


def _lambda_client():
    region = os.getenv("AWS_REGION")
    return boto3.client("lambda", region_name=region) if region else boto3.client("lambda")


def _invoke_workout_image_worker(payload: Dict[str, Any]) -> None:
    function_name = os.getenv("WORKOUT_IMAGE_GENERATOR_LAMBDA", "").strip()
    if not function_name:
        print("[workouts-weekly-plan-debug] skip image invoke: missing WORKOUT_IMAGE_GENERATOR_LAMBDA")
        return
    action = str(payload.get("action", "")).strip() or "generate"
    plan_id = str(payload.get("plan_id", "")).strip()
    try:
        _lambda_client().invoke(
            FunctionName=function_name,
            InvocationType="Event",
            Payload=json.dumps(payload).encode("utf-8"),
        )
        print(f"[workouts-weekly-plan-debug] image invoke queued action={action} plan_id={plan_id or '-'}")
    except Exception as err:
        print(f"[workouts-weekly-plan-debug] image invoke failed action={action} plan_id={plan_id or '-'}: {err}")


def _invoke_workout_image_generator(*, user_id: str, plan_id: str) -> None:
    _invoke_workout_image_worker({"user_id": user_id, "plan_id": plan_id})


def _invoke_workout_image_delete(*, user_id: str, plan_id: str) -> None:
    _invoke_workout_image_worker({"action": "delete", "user_id": user_id, "plan_id": plan_id})


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


def _extract_google_connection(item: Dict[str, Any]) -> Dict[str, Any]:
    if not item:
        return {}
    if isinstance(item.get("google"), dict):
        return item.get("google") or {}
    return item


def _fetch_google_connection(user_id: str) -> Optional[Tuple[Dict[str, Any], Dict[str, Any]]]:
    response = _integrations_table().get_item(Key={"user_id": user_id})
    item = response.get("Item")
    if not isinstance(item, dict):
        return None
    connection = _extract_google_connection(item)
    access_token = connection.get("access_token") or connection.get("accessToken")
    if isinstance(access_token, str) and access_token.strip():
        return item, connection
    return None


def _refresh_access_token(refresh_token: str) -> Optional[Dict[str, Any]]:
    client_id = os.getenv("GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        return None
    body = urlencode(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        }
    ).encode("utf-8")
    request = Request(
        GOOGLE_TOKEN_URL,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urlopen(request, timeout=15) as response:
        raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def _update_connection_access_token(user_id: str, connection: Dict[str, Any], new_tokens: Dict[str, Any]) -> None:
    access_token = new_tokens.get("access_token")
    if not isinstance(access_token, str) or not access_token.strip():
        return
    expires_in = int(new_tokens.get("expires_in") or 3600)
    expires_iso = datetime.fromtimestamp(
        datetime.now(timezone.utc).timestamp() + expires_in,
        tz=timezone.utc,
    ).isoformat()
    _integrations_table().update_item(
        Key={"user_id": user_id},
        UpdateExpression=(
            "SET access_token = :access_token, accessToken = :access_token, "
            "token_expires_at = :token_expires_at"
        ),
        ExpressionAttributeValues={
            ":access_token": access_token.strip(),
            ":token_expires_at": expires_iso,
        },
    )
    connection["access_token"] = access_token.strip()
    connection["accessToken"] = access_token.strip()
    connection["token_expires_at"] = expires_iso


def _google_request_json(method: str, url: str, access_token: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = None
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
    }
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = Request(url, data=payload, headers=headers, method=method)
    with urlopen(request, timeout=20) as response:
        raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def _google_request_no_content(method: str, url: str, access_token: str) -> None:
    request = Request(
        url,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
        },
        method=method,
    )
    with urlopen(request, timeout=20):
        return


def _google_request_json_with_refresh(
    *,
    user_id: str,
    connection: Dict[str, Any],
    method: str,
    url: str,
    body: Optional[Dict[str, Any]] = None,
    debug_flags: Optional[Dict[str, bool]] = None,
) -> Dict[str, Any]:
    access_token = connection.get("access_token") or connection.get("accessToken")
    refresh_token = connection.get("refresh_token") or connection.get("refreshToken")
    if not isinstance(access_token, str) or not access_token.strip():
        raise PermissionError("Google connection missing access token.")
    try:
        return _google_request_json(method, url, access_token.strip(), body)
    except HTTPError as err:
        if err.code not in {401, 403}:
            raise
        if debug_flags is not None:
            debug_flags["access_token_refresh_attempted"] = True
            debug_flags["google_calendar_create_retry"] = True
        if not isinstance(refresh_token, str) or not refresh_token.strip():
            raise PermissionError("Google connection expired, reconnect required")
        new_tokens = _refresh_access_token(refresh_token.strip())
        if not new_tokens or not isinstance(new_tokens.get("access_token"), str):
            raise PermissionError("Google connection expired, reconnect required")
        _update_connection_access_token(user_id, connection, new_tokens)
        if debug_flags is not None:
            debug_flags["access_token_refresh_success"] = True
        refreshed_access_token = connection.get("access_token") or connection.get("accessToken")
        if not isinstance(refreshed_access_token, str) or not refreshed_access_token.strip():
            raise PermissionError("Google connection expired, reconnect required")
        return _google_request_json(method, url, refreshed_access_token.strip(), body)


def _google_request_no_content_with_refresh(
    *,
    user_id: str,
    connection: Dict[str, Any],
    method: str,
    url: str,
    debug_flags: Optional[Dict[str, bool]] = None,
) -> None:
    access_token = connection.get("access_token") or connection.get("accessToken")
    refresh_token = connection.get("refresh_token") or connection.get("refreshToken")
    if not isinstance(access_token, str) or not access_token.strip():
        raise PermissionError("Google connection missing access token.")
    try:
        _google_request_no_content(method, url, access_token.strip())
        return
    except HTTPError as err:
        if err.code not in {401, 403}:
            raise
        if debug_flags is not None:
            debug_flags["access_token_refresh_attempted"] = True
            debug_flags["google_calendar_create_retry"] = True
        if not isinstance(refresh_token, str) or not refresh_token.strip():
            raise PermissionError("Google connection expired, reconnect required")
        new_tokens = _refresh_access_token(refresh_token.strip())
        if not new_tokens or not isinstance(new_tokens.get("access_token"), str):
            raise PermissionError("Google connection expired, reconnect required")
        _update_connection_access_token(user_id, connection, new_tokens)
        if debug_flags is not None:
            debug_flags["access_token_refresh_success"] = True
        refreshed_access_token = connection.get("access_token") or connection.get("accessToken")
        if not isinstance(refreshed_access_token, str) or not refreshed_access_token.strip():
            raise PermissionError("Google connection expired, reconnect required")
        _google_request_no_content(method, url, refreshed_access_token.strip())


def _selected_calendar_ids_from_sources(item: Dict[str, Any], connection: Dict[str, Any]) -> List[str]:
    selected_raw = connection.get("selected_calendar_ids")
    if not isinstance(selected_raw, list):
        selected_raw = item.get("selected_calendar_ids") if isinstance(item, dict) else None
    selected_calendar_ids: List[str] = []
    for value in (selected_raw or []):
        if not isinstance(value, str):
            continue
        trimmed = value.strip()
        if trimmed and trimmed not in selected_calendar_ids:
            selected_calendar_ids.append(trimmed)
    return selected_calendar_ids


def _persist_dailyflow_calendar_id(
    user_id: str, calendar_id: str, selected_calendar_ids: List[str]
) -> None:
    selected_next = list(selected_calendar_ids)
    if calendar_id not in selected_next:
        selected_next.append(calendar_id)
    _integrations_table().update_item(
        Key={"user_id": user_id},
        UpdateExpression=(
            "SET dailyflow_calendar_id = :calendar_id, "
            "selected_calendar_ids = :selected_calendar_ids, "
            "updated_at = :updated_at"
        ),
        ExpressionAttributeValues={
            ":calendar_id": calendar_id,
            ":selected_calendar_ids": selected_next,
            ":updated_at": _iso_utc_now(),
        },
    )


def _dailyflow_calendar_id_from_list_payload(payload: Dict[str, Any]) -> str:
    items = payload.get("items") if isinstance(payload, dict) else []
    if not isinstance(items, list):
        return ""
    matching_ids: List[str] = []
    for entry in items:
        if not isinstance(entry, dict):
            continue
        calendar_id = entry.get("id")
        summary = entry.get("summary")
        if not isinstance(calendar_id, str) or not calendar_id.strip():
            continue
        if isinstance(summary, str) and summary.strip() == DAILYFLOW_CALENDAR_SUMMARY:
            matching_ids.append(calendar_id.strip())
    if not matching_ids:
        return ""
    matching_ids.sort()
    return matching_ids[0]


def _ensure_dailyflow_calendar(
    user_id: str, item: Dict[str, Any], connection: Dict[str, Any], debug_flags: Optional[Dict[str, bool]] = None
) -> str:
    selected_calendar_ids = _selected_calendar_ids_from_sources(item, connection)
    calendar_list_payload = _google_request_json_with_refresh(
        user_id=user_id,
        connection=connection,
        method="GET",
        url=GOOGLE_CALENDAR_LIST_URL,
        debug_flags=debug_flags,
    )
    stored_calendar_id = str(connection.get("dailyflow_calendar_id", "")).strip()
    if not stored_calendar_id:
        stored_calendar_id = str(connection.get("dailyflowCalendarId", "")).strip()
    if stored_calendar_id:
        check_url = GOOGLE_CALENDAR_URL_TEMPLATE.format(calendar_id=quote(stored_calendar_id, safe=""))
        try:
            _google_request_json_with_refresh(
                user_id=user_id,
                connection=connection,
                method="GET",
                url=check_url,
                debug_flags=debug_flags,
            )
            _persist_dailyflow_calendar_id(user_id, stored_calendar_id, selected_calendar_ids)
            connection["selected_calendar_ids"] = (
                selected_calendar_ids
                if stored_calendar_id in selected_calendar_ids
                else [*selected_calendar_ids, stored_calendar_id]
            )
            return stored_calendar_id
        except HTTPError as err:
            if err.code != 404:
                raise
    existing_id = _dailyflow_calendar_id_from_list_payload(calendar_list_payload)
    if existing_id:
        _persist_dailyflow_calendar_id(user_id, existing_id, selected_calendar_ids)
        connection["dailyflow_calendar_id"] = existing_id
        connection["dailyflowCalendarId"] = existing_id
        connection["selected_calendar_ids"] = (
            selected_calendar_ids
            if existing_id in selected_calendar_ids
            else [*selected_calendar_ids, existing_id]
        )
        return existing_id
    created = _google_request_json_with_refresh(
        user_id=user_id,
        connection=connection,
        method="POST",
        url=GOOGLE_CALENDAR_CREATE_URL,
        body={"summary": DAILYFLOW_CALENDAR_SUMMARY, "timeZone": APP_TIMEZONE_ID},
        debug_flags=debug_flags,
    )
    created_id = str(created.get("id", "")).strip()
    if not created_id:
        raise ValueError("Failed to create DailyFlow Google calendar.")
    _persist_dailyflow_calendar_id(user_id, created_id, selected_calendar_ids)
    connection["dailyflow_calendar_id"] = created_id
    connection["dailyflowCalendarId"] = created_id
    connection["selected_calendar_ids"] = (
        selected_calendar_ids
        if created_id in selected_calendar_ids
        else [*selected_calendar_ids, created_id]
    )
    return created_id


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
        normalized: Dict[str, Any] = {
            "id": str(item.get("id", "")).strip() or f"plan_{len(cleaned)+1}",
            "library_workout_id": lib_id,
            "recommended_day": rec_day,
            "recommended_start_time": rec_start,
            "recommended_end_time": rec_end,
            "recommended_time_label": str(item.get("recommended_time_label", "")).strip() or "Evening",
            "reason_short": str(item.get("reason_short", "")).strip() or "Matches your saved workout library and current free time.",
            "google_event_id": str(item.get("google_event_id", "")).strip(),
            "dailyflow_calendar_id": str(item.get("dailyflow_calendar_id", "")).strip(),
        }
        image_key = str(item.get("workout_image_key", "")).strip()
        if image_key and str(item.get("google_event_id", "")).strip():
            normalized["workout_image_key"] = image_key
        cleaned.append(normalized)
    return cleaned


def _today_iso_utc() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _mark_busy_blocks_stale(user_id: str) -> None:
    try:
        _integrations_table().update_item(
            Key={"user_id": user_id},
            UpdateExpression="SET last_busy_sync_at = :last_busy_sync_at, updated_at = :updated_at",
            ExpressionAttributeValues={
                ":last_busy_sync_at": "",
                ":updated_at": _iso_utc_now(),
            },
        )
    except Exception:
        return


def _delete_dailyflow_event_row(*, user_id: str, plan_id: str) -> None:
    try:
        _dailyflow_events_table().delete_item(Key={"user_id": user_id, "plan_id": plan_id})
    except Exception:
        return


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
            return False, "", OVERLAP_ERROR_MESSAGE
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
    if recommended_day < _today_iso_utc():
        return _json_response(400, {"message": "Cannot add new workouts to past dates."})

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
    occupied = occupied_slots_for_week(user_id, week_start, week_end, busy_blocks)
    slot_ok, recommended_end_time, err = _slot_is_valid(
        week_start=week_start,
        week_end=week_end,
        recommended_day=recommended_day,
        recommended_start_time=recommended_start_time,
        duration_minutes=duration_minutes,
        busy_blocks=occupied,
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
    plan_item = next((entry for entry in weekly_plan if str(entry.get("id", "")).strip() == plan_id), None)
    filtered = [entry for entry in weekly_plan if str(entry.get("id", "")).strip() != plan_id]
    if len(filtered) == len(weekly_plan):
        return _json_response(404, {"message": "Weekly plan item not found."})

    existing_event_id = str((plan_item or {}).get("google_event_id", "")).strip()
    existing_calendar_id = str((plan_item or {}).get("dailyflow_calendar_id", "")).strip()
    if existing_event_id and existing_calendar_id:
        stored_connection = _fetch_google_connection(user_id)
        if stored_connection:
            _, connection = stored_connection
            delete_url = (
                f"{GOOGLE_CALENDAR_EVENTS_URL_TEMPLATE.format(calendar_id=quote(existing_calendar_id, safe=''))}"
                f"/{quote(existing_event_id, safe='')}"
            )
            try:
                _google_request_no_content_with_refresh(
                    user_id=user_id,
                    connection=connection,
                    method="DELETE",
                    url=delete_url,
                )
            except HTTPError as err:
                if err.code != 404:
                    if err.code == 401:
                        return _json_response(403, {"message": "Google connection expired, reconnect required"})
                    return _json_response(
                        502,
                        {"message": f"Google Calendar API request failed with status {err.code}."},
                    )
            except PermissionError as err:
                return _json_response(403, {"message": str(err)})
            except (URLError, TimeoutError):
                return _json_response(502, {"message": "Failed to reach Google Calendar API."})
            except Exception:
                return _json_response(500, {"message": "Unexpected error while deleting workout calendar event."})

    busy_blocks = _query_busy_blocks(user_id, week_start, week_end)
    updated_at = _persist_weekly_plan(
        user_id=user_id,
        week_start=week_start,
        week_end=week_end,
        weekly_plan=filtered,
        workout_library=workout_library,
        busy_blocks=busy_blocks,
    )
    _delete_dailyflow_event_row(user_id=user_id, plan_id=plan_id)
    _mark_busy_blocks_stale(user_id)
    _invoke_workout_image_delete(user_id=user_id, plan_id=plan_id)
    return _json_response(200, {"weekly_plan_suggestions": filtered, "updated_at": updated_at})


def _format_google_event_datetime(date_iso: str, hhmm: str) -> str:
    return f"{date_iso}T{hhmm}:00"


def _workout_images_public_base_url() -> str:
    return os.getenv("WORKOUT_IMAGES_PUBLIC_BASE_URL", "").strip().rstrip("/")


def _workout_image_public_url(*, user_id: str, plan_id: str) -> str:
    base = _workout_images_public_base_url()
    if not base or not user_id or not plan_id:
        return ""
    if "/" in user_id or ".." in user_id or "/" in plan_id or ".." in plan_id:
        return ""
    return f"{base}/users/{user_id}/workout-image/{plan_id}.png"


def _build_workout_event_payload(
    plan_item: Dict[str, Any],
    library_item: Dict[str, Any],
    *,
    user_id: str,
) -> Dict[str, Any]:
    workout_title = str(library_item.get("title", "")).strip() or "Workout"
    workout_type = str(library_item.get("workout_type", "")).strip()
    intensity = str(library_item.get("intensity", "")).strip()
    location = str(library_item.get("location", "")).strip()
    summary_short = str(library_item.get("summary_short", "")).strip()
    details: List[str] = []
    if workout_type:
        details.append(f"Type: {workout_type}")
    if intensity:
        details.append(f"Intensity: {intensity}")
    if location:
        details.append(f"Location: {location}")
    if summary_short:
        details.append(summary_short)
    workout_flow = library_item.get("workout_flow")
    if isinstance(workout_flow, dict):
        flow_summary = str(workout_flow.get("summary", "")).strip()
        if flow_summary:
            details.append("")
            details.append(f"Overview: {flow_summary}")

        def append_steps(label: str, key: str) -> None:
            steps = workout_flow.get(key)
            if not isinstance(steps, list):
                return
            cleaned_steps = [
                str(step).strip() for step in steps if isinstance(step, str) and str(step).strip()
            ]
            if not cleaned_steps:
                return
            details.append(f"{label}:")
            for idx, step in enumerate(cleaned_steps, start=1):
                details.append(f"{idx}. {step}")

        append_steps("Warmup", "warmup_steps")
        append_steps("Main steps", "main_steps")
        append_steps("Cooldown", "cooldown_steps")
        append_steps("Notes", "notes")
    description = "\n".join(details) if details else "Planned in DailyFlow."
    image_url = _workout_image_public_url(
        user_id=user_id,
        plan_id=str(plan_item.get("id", "")).strip(),
    )
    if image_url:
        description = f"{description}\n\nWorkout visual guide:\n{image_url}"
    return {
        "summary": workout_title,
        "description": description,
        "start": {
            "dateTime": _format_google_event_datetime(
                str(plan_item.get("recommended_day", "")).strip(),
                str(plan_item.get("recommended_start_time", "")).strip(),
            ),
            "timeZone": APP_TIMEZONE_ID,
        },
        "end": {
            "dateTime": _format_google_event_datetime(
                str(plan_item.get("recommended_day", "")).strip(),
                str(plan_item.get("recommended_end_time", "")).strip(),
            ),
            "timeZone": APP_TIMEZONE_ID,
        },
    }


def _persist_dailyflow_event_row(
    *,
    user_id: str,
    plan_id: str,
    library_workout_id: str,
    recommended_day: str,
    dailyflow_calendar_id: str,
    google_event_id: str,
) -> None:
    try:
        _dailyflow_events_table().put_item(
            Item={
                "user_id": user_id,
                "plan_id": plan_id,
                "library_workout_id": library_workout_id,
                "recommended_day": recommended_day,
                "dailyflow_calendar_id": dailyflow_calendar_id,
                "google_event_id": google_event_id,
                "updated_at": _iso_utc_now(),
            }
        )
    except Exception:
        # Keep scheduling flow resilient if the optional mapping table isn't fully wired yet.
        return


def _handle_add_plan_item_to_calendar(*, user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
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
    plan_item = next((entry for entry in weekly_plan if str(entry.get("id", "")).strip() == plan_id), None)
    if not plan_item:
        return _json_response(404, {"message": "Weekly plan item not found."})
    if str(plan_item.get("recommended_day", "")).strip() < week_start or str(plan_item.get("recommended_day", "")).strip() > week_end:
        return _json_response(400, {"message": "Selected plan item is outside the visible week."})

    existing_event_id = str(plan_item.get("google_event_id", "")).strip()
    existing_calendar_id = str(plan_item.get("dailyflow_calendar_id", "")).strip()
    if existing_event_id and existing_calendar_id:
        return _json_response(
            200,
            {
                "weekly_plan_suggestions": weekly_plan,
                "already_scheduled": True,
                "google_event_id": existing_event_id,
                "dailyflow_calendar_id": existing_calendar_id,
                "message": "Workout already added to DailyFlow calendar.",
            },
        )

    library_workout_id = str(plan_item.get("library_workout_id", "")).strip()
    library_item = next(
        (
            lib
            for lib in workout_library
            if isinstance(lib, dict) and str(lib.get("id", "")).strip() == library_workout_id
        ),
        None,
    )
    if not isinstance(library_item, dict):
        return _json_response(400, {"message": "Selected workout library item does not exist."})

    duration_minutes = 0
    start_t = _parse_hh_mm(str(plan_item.get("recommended_start_time", "")).strip())
    end_t = _parse_hh_mm(str(plan_item.get("recommended_end_time", "")).strip())
    if start_t and end_t:
        duration_minutes = (end_t.hour * 60 + end_t.minute) - (start_t.hour * 60 + start_t.minute)
    if duration_minutes <= 0:
        duration_minutes = _to_int(library_item.get("duration_minutes"), 0)
    occupied = occupied_slots_for_week(
        user_id,
        week_start,
        week_end,
        _query_busy_blocks(user_id, week_start, week_end),
    )
    slot_ok, _, err = _slot_is_valid(
        week_start=week_start,
        week_end=week_end,
        recommended_day=str(plan_item.get("recommended_day", "")).strip(),
        recommended_start_time=str(plan_item.get("recommended_start_time", "")).strip(),
        duration_minutes=duration_minutes,
        busy_blocks=occupied,
    )
    if not slot_ok:
        return _json_response(400, {"message": err})

    stored_connection = _fetch_google_connection(user_id)
    debug_flags: Dict[str, bool] = {
        "google_integration_found": bool(stored_connection),
        "access_token_refresh_attempted": False,
        "access_token_refresh_success": False,
        "google_calendar_create_retry": False,
        "reconnect_required": False,
    }
    print(f"[workouts-weekly-plan-debug] google_integration_found={debug_flags['google_integration_found']}")
    if not stored_connection:
        return _json_response(404, {"message": "Google Calendar is not connected for this user."})
    _, connection = stored_connection

    try:
        dailyflow_calendar_id = _ensure_dailyflow_calendar(user_id, item, connection, debug_flags)
        create_event_url = GOOGLE_CALENDAR_EVENTS_URL_TEMPLATE.format(
            calendar_id=quote(dailyflow_calendar_id, safe="")
        )
        created_event = _google_request_json_with_refresh(
            user_id=user_id,
            connection=connection,
            method="POST",
            url=create_event_url,
            body=_build_workout_event_payload(plan_item, library_item, user_id=user_id),
            debug_flags=debug_flags,
        )
        created_event_id = str(created_event.get("id", "")).strip()
        if not created_event_id:
            return _json_response(502, {"message": "Google Calendar event creation failed."})
    except PermissionError as err:
        debug_flags["reconnect_required"] = True
        print(
            "[workouts-weekly-plan-debug] "
            f"access_token_refresh_attempted={debug_flags['access_token_refresh_attempted']} "
            f"access_token_refresh_success={debug_flags['access_token_refresh_success']} "
            f"google_calendar_create_retry={debug_flags['google_calendar_create_retry']} "
            f"reconnect_required={debug_flags['reconnect_required']}"
        )
        return _reconnect_required_response()
    except HTTPError as err:
        return _json_response(
            502,
            {"message": f"Google Calendar API request failed with status {err.code}."},
        )
    except (URLError, TimeoutError):
        return _json_response(502, {"message": "Failed to reach Google Calendar API."})
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception:
        return _json_response(500, {"message": "Unexpected error while creating workout calendar event."})
    print(
        "[workouts-weekly-plan-debug] "
        f"access_token_refresh_attempted={debug_flags['access_token_refresh_attempted']} "
        f"access_token_refresh_success={debug_flags['access_token_refresh_success']} "
        f"google_calendar_create_retry={debug_flags['google_calendar_create_retry']} "
        f"reconnect_required={debug_flags['reconnect_required']}"
    )

    updated_weekly_plan: List[Dict[str, Any]] = []
    for entry in weekly_plan:
        if str(entry.get("id", "")).strip() == plan_id:
            updated_entry = dict(entry)
            updated_entry["google_event_id"] = created_event_id
            updated_entry["dailyflow_calendar_id"] = dailyflow_calendar_id
            updated_weekly_plan.append(updated_entry)
        else:
            updated_weekly_plan.append(entry)

    busy_blocks = _query_busy_blocks(user_id, week_start, week_end)
    updated_at = _persist_weekly_plan(
        user_id=user_id,
        week_start=week_start,
        week_end=week_end,
        weekly_plan=updated_weekly_plan,
        workout_library=workout_library,
        busy_blocks=busy_blocks,
    )
    _persist_dailyflow_event_row(
        user_id=user_id,
        plan_id=plan_id,
        library_workout_id=library_workout_id,
        recommended_day=str(plan_item.get("recommended_day", "")).strip(),
        dailyflow_calendar_id=dailyflow_calendar_id,
        google_event_id=created_event_id,
    )
    _mark_busy_blocks_stale(user_id)
    scheduled_item = next(
        (entry for entry in updated_weekly_plan if str(entry.get("id", "")).strip() == plan_id),
        None,
    )
    if scheduled_item and not str(scheduled_item.get("workout_image_key", "")).strip():
        _invoke_workout_image_generator(user_id=user_id, plan_id=plan_id)
    return _json_response(
        200,
        {
            "weekly_plan_suggestions": updated_weekly_plan,
            "updated_at": updated_at,
            "already_scheduled": False,
            "google_event_id": created_event_id,
            "dailyflow_calendar_id": dailyflow_calendar_id,
        },
    )


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
    if action == "add_to_calendar":
        return _handle_add_plan_item_to_calendar(user_id=user_id, payload=payload)
    return _json_response(400, {"message": "Unsupported weekly-plan action."})
