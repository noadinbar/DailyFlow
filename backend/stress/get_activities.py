"""
GET /stress/activities — load Timed + Flexible library, favorites, weekly plan,
and Potentially Stressful Periods insights for the requested week.
PATCH /stress/activities — mutate library/plan state:
  - toggle_favorite
  - add_library_activity (BusyBlocks conflict validation, Workouts-style)
  - remove_plan_item (also deletes Google event when stamped, Workouts-style)
  - add_to_calendar (Google Calendar insert, mirrors workouts/weekly_plan_update.py)

Uses StressBreaksLibrary. add_library_activity also reads BusyBlocks (same overlap
semantics as backend/workouts/weekly_plan_update.py _slot_is_valid).

Weekly Break Plan week scoping mirrors Workouts GET /workouts/suggestions:
a single current_week_plan is reused only when saved week_start/end match the
requested period; otherwise the plan is rolled to an empty plan for the new week.

Insights are guidance only — they never mutate Weekly Break Plan or Google Calendar.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime, time, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

import boto3
from boto3.dynamodb.conditions import Key

_STRESS_DIR = str(Path(__file__).resolve().parent)
if _STRESS_DIR not in sys.path:
    sys.path.insert(0, _STRESS_DIR)

from activity_model import (  # noqa: E402
    FLEXIBLE_PLAN_DURATIONS,
    favorite_key_from_item,
    iso_utc_now,
    json_safe,
    library_table,
    load_library_item,
    next_plan_id,
    normalize_activity,
    normalize_activity_list,
    normalize_favorite_activity,
    normalize_favorites,
    normalize_weekly_break_plan,
    parse_hh_mm,
    to_dynamodb_safe,
    to_int,
)
from stressful_periods import build_stressful_periods_insights  # noqa: E402

# Match Workouts weekly_plan_update.py slot window.
DAY_START_MINUTES = 6 * 60
DAY_END_MINUTES = 22 * 60

# Match Workouts Google Calendar constants (weekly_plan_update.py).
DAILYFLOW_CALENDAR_SUMMARY = "DailyFlow"
APP_TIMEZONE_ID = "Asia/Jerusalem"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList"
GOOGLE_CALENDAR_URL_TEMPLATE = "https://www.googleapis.com/calendar/v3/calendars/{calendar_id}"
GOOGLE_CALENDAR_CREATE_URL = "https://www.googleapis.com/calendar/v3/calendars"
GOOGLE_CALENDAR_EVENTS_URL_TEMPLATE = "https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events"

_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://main.dnp9vhzk0bw8l.amplifyapp.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,GET,PATCH",
}


def _json_response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {"statusCode": status_code, "headers": dict(_CORS_HEADERS), "body": json.dumps(json_safe(body))}


def _reconnect_required_response() -> Dict[str, Any]:
    return _json_response(
        403,
        {
            "message": "Google Calendar connection expired. Please reconnect.",
            "reconnect_required": True,
        },
    )


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


def _today_iso_utc() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _parse_period_query(event: Dict[str, Any]) -> Tuple[Optional[date], Optional[date], Optional[str]]:
    """Mirror workouts/suggestions.py _period_from_get_event / _parse_period_payload."""
    params = event.get("queryStringParameters") or {}
    if not isinstance(params, dict):
        params = {}
    start_raw = params.get("start_date")
    end_raw = params.get("end_date")
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
    if span_days > 14:
        return None, None, "Requested period is too long (max 14 days)."
    return start_date_value, end_date_value, None


def _filter_plan_to_week(plan: List[Dict[str, Any]], week_start: str, week_end: str) -> List[Dict[str, Any]]:
    return [
        entry
        for entry in plan
        if week_start <= str(entry.get("recommended_day", "")).strip() <= week_end
    ]


def _weekly_plan_for_requested_week(
    item: Dict[str, Any],
    week_start: str,
    week_end: str,
) -> List[Dict[str, Any]]:
    """
    Workouts stores one current_week_plan. Reuse it only when saved week bounds match
    the requested week; otherwise start empty (week rolled).
    Also drop any orphan items whose recommended_day falls outside the week.
    """
    saved_start = str(item.get("current_week_plan_week_start", "")).strip()
    saved_end = str(item.get("current_week_plan_week_end", "")).strip()
    if saved_start != week_start or saved_end != week_end:
        return []
    return _filter_plan_to_week(normalize_weekly_break_plan(item.get("current_week_plan")), week_start, week_end)


def _busy_blocks_table():
    table_name = os.getenv("BUSY_BLOCKS_TABLE", "").strip()
    if not table_name:
        raise ValueError("Missing BUSY_BLOCKS_TABLE env var.")
    region = os.getenv("AWS_REGION")
    dynamodb = boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")
    return dynamodb.Table(table_name)


def _parse_hh_mm_time(value: str) -> Optional[time]:
    """
    Mirror workouts/weekly_plan_update.py _parse_hh_mm exactly.

    BusyBlocks sync stores times via time.isoformat() (often HH:MM:SS).
    Workouts accepts that by reading hour/minute from the first 5 chars.
    Do NOT use activity_model.parse_hh_mm here — it requires exact HH:MM and
    drops every BusyBlock row that has seconds.
    """
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


def _query_busy_blocks(
    user_id: str,
    start_date_iso: str,
    end_date_iso: str,
    *,
    flow: str = "unknown",
) -> List[Dict[str, Any]]:
    """Mirror workouts/weekly_plan_update.py _query_busy_blocks (same Query + filters)."""
    print(
        "[stress-insights-debug] busyblocks_query_enter "
        f"flow={flow} "
        f"helper=_query_busy_blocks "
        f"helper_id={id(_query_busy_blocks)} "
        f"helper_qualname={_query_busy_blocks.__qualname__} "
        f"user_id={user_id} "
        f"week_start={start_date_iso!r} "
        f"week_end={end_date_iso!r} "
        f"arg_types=({type(user_id).__name__},{type(start_date_iso).__name__},{type(end_date_iso).__name__}) "
        f"arg_repr=({user_id!r},{start_date_iso!r},{end_date_iso!r})"
    )
    table = _busy_blocks_table()
    items: List[Dict[str, Any]] = []
    last_evaluated_key: Optional[Dict[str, Any]] = None
    scanned_rows = 0
    kept_rows = 0
    dropped_date = 0
    dropped_time = 0
    while True:
        query_args: Dict[str, Any] = {"KeyConditionExpression": Key("user_id").eq(user_id)}
        if last_evaluated_key:
            query_args["ExclusiveStartKey"] = last_evaluated_key
        response = table.query(**query_args)
        for item in response.get("Items") or []:
            if not isinstance(item, dict):
                continue
            scanned_rows += 1
            block_date = str(item.get("date", "")).strip()
            if not block_date or block_date < start_date_iso or block_date > end_date_iso:
                dropped_date += 1
                continue
            start_time = str(item.get("start_time", "")).strip()
            end_time = str(item.get("end_time", "")).strip()
            if not _parse_hh_mm_time(start_time) or not _parse_hh_mm_time(end_time):
                dropped_time += 1
                print(
                    "[stress-insights-debug] busyblocks_query_drop_time "
                    f"flow={flow} date={block_date!r} "
                    f"start_time={start_time!r} end_time={end_time!r}"
                )
                continue
            items.append({"date": block_date, "start_time": start_time, "end_time": end_time})
            kept_rows += 1
        last_evaluated_key = response.get("LastEvaluatedKey")
        if not last_evaluated_key:
            break
    items.sort(key=lambda x: (x["date"], x["start_time"], x["end_time"]))
    print(
        "[stress-insights-debug] busyblocks_query_exit "
        f"flow={flow} "
        f"helper=_query_busy_blocks "
        f"helper_id={id(_query_busy_blocks)} "
        f"user_id={user_id} "
        f"week_start={start_date_iso!r} "
        f"week_end={end_date_iso!r} "
        f"scanned_rows={scanned_rows} "
        f"dropped_date={dropped_date} "
        f"dropped_time={dropped_time} "
        f"returned_count={len(items)} kept_rows={kept_rows}"
    )
    for block in items:
        print(
            "[stress-insights-debug] busyblocks_query_row "
            f"flow={flow} "
            f"date={block.get('date')} "
            f"start_time={block.get('start_time')} "
            f"end_time={block.get('end_time')}"
        )
    return items


def _slot_is_valid(
    *,
    week_start: str,
    week_end: str,
    recommended_day: str,
    recommended_start_time: str,
    duration_minutes: int,
    busy_blocks: List[Dict[str, Any]],
) -> Tuple[bool, str, str]:
    """
    Mirror workouts/weekly_plan_update.py _slot_is_valid exactly:
    - day must be inside week
    - start must parse as HH:MM
    - slot must fit 06:00-22:00
    - overlap if max(start, block_start) < min(end, block_end)  (half-open)
    """
    if recommended_day < week_start or recommended_day > week_end:
        return False, "", "Selected day must be inside the visible week."
    start_t = _parse_hh_mm_time(recommended_start_time)
    if not start_t:
        return False, "", "recommended_start_time must be HH:MM."
    start_m = start_t.hour * 60 + start_t.minute
    end_m = start_m + duration_minutes
    if start_m < DAY_START_MINUTES or end_m > DAY_END_MINUTES:
        return False, "", "Selected time is outside allowed workout hours (06:00-22:00)."
    for block in busy_blocks:
        if block.get("date") != recommended_day:
            continue
        b_start = _parse_hh_mm_time(str(block.get("start_time", "")))
        b_end = _parse_hh_mm_time(str(block.get("end_time", "")))
        if not b_start or not b_end:
            continue
        b_start_m = b_start.hour * 60 + b_start.minute
        b_end_m = b_end.hour * 60 + b_end.minute
        if max(start_m, b_start_m) < min(end_m, b_end_m):
            return False, "", "Selected slot overlaps an existing busy block."
    return True, f"{end_m // 60:02d}:{end_m % 60:02d}", ""


def _dynamodb_resource():
    region = os.getenv("AWS_REGION")
    return boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")


def _integrations_table():
    table_name = os.getenv("INTEGRATIONS_TABLE", "").strip()
    if not table_name:
        raise ValueError("Missing INTEGRATIONS_TABLE env var.")
    return _dynamodb_resource().Table(table_name)


def _dailyflow_events_table():
    table_name = (os.getenv("DAILYFLOW_EVENTS_TABLE") or "DailyFlowEvents").strip()
    if not table_name:
        raise ValueError("Missing DAILYFLOW_EVENTS_TABLE env var.")
    return _dynamodb_resource().Table(table_name)


def _stress_events_plan_id(plan_id: str) -> str:
    """Namespace DailyFlowEvents plan_id so Stress does not collide with Workouts plan_N keys."""
    raw = str(plan_id or "").strip()
    if raw.startswith("stress_"):
        return raw
    return f"stress_{raw}"


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
    for value in selected_raw or []:
        if not isinstance(value, str):
            continue
        trimmed = value.strip()
        if trimmed and trimmed not in selected_calendar_ids:
            selected_calendar_ids.append(trimmed)
    return selected_calendar_ids


def _persist_dailyflow_calendar_id(user_id: str, calendar_id: str, selected_calendar_ids: List[str]) -> None:
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
            ":updated_at": iso_utc_now(),
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
            selected_calendar_ids if existing_id in selected_calendar_ids else [*selected_calendar_ids, existing_id]
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
        selected_calendar_ids if created_id in selected_calendar_ids else [*selected_calendar_ids, created_id]
    )
    return created_id


def _format_google_event_datetime(date_iso: str, hhmm: str) -> str:
    return f"{date_iso}T{hhmm}:00"


def _build_break_event_payload(plan_item: Dict[str, Any]) -> Dict[str, Any]:
    title = str(plan_item.get("title", "")).strip() or "Break"
    category_label = str(plan_item.get("category_label", "")).strip() or str(plan_item.get("category", "")).strip()
    kind = str(plan_item.get("kind", "")).strip()
    duration_minutes = to_int(plan_item.get("duration_minutes"), 0)
    summary_short = str(plan_item.get("summary_short", "")).strip()
    details: List[str] = []
    if category_label:
        details.append(f"Category: {category_label}")
    if kind:
        details.append(f"Type: {kind}")
    if duration_minutes > 0:
        details.append(f"Duration: {duration_minutes} min")
    if summary_short:
        details.append(summary_short)
    description = "\n".join(details) if details else "Planned in DailyFlow."
    return {
        "summary": title,
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
    library_activity_id: str,
    recommended_day: str,
    dailyflow_calendar_id: str,
    google_event_id: str,
) -> None:
    try:
        _dailyflow_events_table().put_item(
            Item={
                "user_id": user_id,
                "plan_id": _stress_events_plan_id(plan_id),
                "library_activity_id": library_activity_id,
                "recommended_day": recommended_day,
                "dailyflow_calendar_id": dailyflow_calendar_id,
                "google_event_id": google_event_id,
                "source": "stress_breaks",
                "updated_at": iso_utc_now(),
            }
        )
    except Exception:
        # Keep scheduling flow resilient if the optional mapping table isn't fully wired yet.
        return


def _delete_dailyflow_event_row(*, user_id: str, plan_id: str) -> None:
    try:
        _dailyflow_events_table().delete_item(Key={"user_id": user_id, "plan_id": _stress_events_plan_id(plan_id)})
    except Exception:
        return


def _mark_busy_blocks_stale(user_id: str) -> None:
    try:
        _integrations_table().update_item(
            Key={"user_id": user_id},
            UpdateExpression="SET last_busy_sync_at = :last_busy_sync_at, updated_at = :updated_at",
            ExpressionAttributeValues={
                ":last_busy_sync_at": "",
                ":updated_at": iso_utc_now(),
            },
        )
    except Exception:
        return


def _users_table():
    table_name = os.getenv("USERS_TABLE", "").strip()
    if not table_name:
        raise ValueError("Missing USERS_TABLE env var.")
    return _dynamodb_resource().Table(table_name)


def _read_stress_preferences(user_id: str) -> Dict[str, Any]:
    """Read Phase 1 Stress & Breaks prefs from Users (same attrs as profile/generate)."""
    item = _users_table().get_item(Key={"user_id": user_id}, ConsistentRead=True).get("Item") or {}
    if not isinstance(item, dict):
        item = {}

    def _list(attr: str) -> List[str]:
        raw = item.get(attr)
        if not isinstance(raw, list):
            return []
        out: List[str] = []
        for value in raw:
            if isinstance(value, str) and value.strip() and value.strip() not in out:
                out.append(value.strip())
        return out

    return {
        "questionnaire_completed": item.get("stress_breaks_questionnaire_completed") is True,
        "busiest_times": _list("stress_breaks_busiest_times"),
        "busiest_days": _list("stress_breaks_busiest_days"),
        "busy_day_factors": _list("stress_breaks_busy_day_factors"),
        "preferred_activities": _list("stress_breaks_preferred_activities"),
        "durations": _list("stress_breaks_durations"),
    }


def _library_categories(item: Dict[str, Any]) -> List[str]:
    cats: List[str] = []
    for raw in list(item.get("timed_activities") or []) + list(item.get("flexible_activities") or []):
        normalized = normalize_activity(raw)
        if not normalized:
            continue
        category = str(normalized.get("category", "")).strip()
        if category and category not in cats:
            cats.append(category)
    return cats


def _build_insights_payload(
    *,
    user_id: str,
    week_start: str,
    week_end: str,
    library_item: Dict[str, Any],
) -> Dict[str, Any]:
    print(
        "[stress-insights-debug] requested_period "
        f"user_id={user_id[:8]}… start_date={week_start} end_date={week_end}"
    )
    try:
        prefs = _read_stress_preferences(user_id)
    except Exception as err:
        print(f"[stress-activities] preferences read for insights failed: {err}")
        prefs = {
            "questionnaire_completed": False,
            "busiest_times": [],
            "busiest_days": [],
            "busy_day_factors": [],
            "preferred_activities": [],
            "durations": [],
        }
    try:
        print(
            "[stress-insights-debug] caller_before_query "
            f"flow=stress_insights "
            f"helper=_query_busy_blocks "
            f"helper_id={id(_query_busy_blocks)} "
            f"user_id={user_id} "
            f"week_start={week_start!r} "
            f"week_end={week_end!r}"
        )
        busy_blocks = _query_busy_blocks(user_id, week_start, week_end, flow="stress_insights")
    except Exception as err:
        print(f"[stress-activities] busyblocks query for insights failed: {err}")
        print(f"[stress-insights-debug] raw_busy_blocks count=0 query_error={err} flow=stress_insights")
        busy_blocks = []
    else:
        print(
            "[stress-insights-debug] caller_after_query "
            f"flow=stress_insights "
            f"returned_count={len(busy_blocks)}"
        )
        print(f"[stress-insights-debug] raw_busy_blocks count={len(busy_blocks)} flow=stress_insights")
        for block in busy_blocks:
            print(
                "[stress-insights-debug] raw_busy_block "
                f"flow=stress_insights "
                f"date={block.get('date')} start_time={block.get('start_time')} "
                f"end_time={block.get('end_time')}"
            )
    return build_stressful_periods_insights(
        week_start=week_start,
        week_end=week_end,
        busy_blocks=busy_blocks,
        preferences=prefs,
        library_categories=_library_categories(library_item),
    )


def _library_payload(
    item: Dict[str, Any],
    *,
    weekly_plan: Optional[List[Dict[str, Any]]] = None,
    week_start: Optional[str] = None,
    week_end: Optional[str] = None,
    stressful_periods: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    timed = normalize_activity_list(item.get("timed_activities"), kind="timed")
    flexible = normalize_activity_list(item.get("flexible_activities"), kind="flexible")
    favorites = normalize_favorites(item.get("favorite_activities"))
    if weekly_plan is None:
        weekly_plan = normalize_weekly_break_plan(item.get("current_week_plan"))
    generated_at = item.get("generated_at")
    updated_at = item.get("updated_at")
    if week_start is None:
        raw_start = item.get("current_week_plan_week_start")
        week_start = raw_start if isinstance(raw_start, str) else None
    if week_end is None:
        raw_end = item.get("current_week_plan_week_end")
        week_end = raw_end if isinstance(raw_end, str) else None
    payload: Dict[str, Any] = {
        "timed_activities": timed,
        "flexible_activities": flexible,
        "favorite_activities": favorites,
        "weekly_break_plan": weekly_plan,
        "has_library": bool(timed or flexible),
        "generated_at": generated_at if isinstance(generated_at, str) else None,
        "updated_at": updated_at if isinstance(updated_at, str) else None,
        "week_start": week_start,
        "week_end": week_end,
    }
    if stressful_periods is not None:
        payload["stressful_periods"] = stressful_periods
    return payload


def _find_library_activity(item: Dict[str, Any], activity_id: str) -> Optional[Dict[str, Any]]:
    for raw in list(item.get("timed_activities") or []) + list(item.get("flexible_activities") or []):
        normalized = normalize_activity(raw)
        if normalized and str(normalized.get("id", "")).strip() == activity_id:
            return normalized
    return None


def _persist_weekly_plan(
    *,
    user_id: str,
    week_start: str,
    week_end: str,
    weekly_plan: List[Dict[str, Any]],
) -> str:
    updated_at = iso_utc_now()
    library_table().update_item(
        Key={"user_id": user_id},
        UpdateExpression=(
            "SET current_week_plan = :plan, "
            "current_week_plan_week_start = :week_start, "
            "current_week_plan_week_end = :week_end, "
            "current_week_plan_updated_at = :plan_updated_at, "
            "updated_at = :updated_at"
        ),
        ExpressionAttributeValues=to_dynamodb_safe(
            {
                ":plan": weekly_plan,
                ":week_start": week_start,
                ":week_end": week_end,
                ":plan_updated_at": updated_at,
                ":updated_at": updated_at,
            }
        ),
    )
    return updated_at


def _handle_get(user_id: str, event: Dict[str, Any]) -> Dict[str, Any]:
    start_date_value, end_date_value, period_error = _parse_period_query(event)
    if period_error:
        return _json_response(400, {"message": period_error})
    assert start_date_value is not None and end_date_value is not None
    period_start = start_date_value.isoformat()
    period_end = end_date_value.isoformat()

    try:
        item = load_library_item(user_id)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception as err:
        print(f"[stress-activities] load failed: {err}")
        return _json_response(503, {"message": "Could not load Stress & Breaks library. Try again shortly."})

    saved_week_start = str(item.get("current_week_plan_week_start", "")).strip()
    saved_week_end = str(item.get("current_week_plan_week_end", "")).strip()
    saved_weekly_plan = normalize_weekly_break_plan(item.get("current_week_plan"))
    week_matches = saved_week_start == period_start and saved_week_end == period_end

    weekly_plan: List[Dict[str, Any]]
    if week_matches:
        # Same week as Workouts "saved_current_week_plan" path — reuse stored plan,
        # but drop orphans outside the week bounds (heals stale PATCH week-bound updates).
        weekly_plan = _filter_plan_to_week(saved_weekly_plan, period_start, period_end)
        if len(weekly_plan) != len(saved_weekly_plan):
            try:
                _persist_weekly_plan(
                    user_id=user_id,
                    week_start=period_start,
                    week_end=period_end,
                    weekly_plan=weekly_plan,
                )
            except Exception as err:
                print(f"[stress-activities] week-scope heal failed: {err}")
                return _json_response(503, {"message": "Could not load Stress & Breaks library. Try again shortly."})
    else:
        # Week rolled (Workouts would derive+overwrite current_week_plan). Stress has no
        # auto-scheduler — persist an empty plan for the requested week.
        weekly_plan = []
        try:
            _persist_weekly_plan(
                user_id=user_id,
                week_start=period_start,
                week_end=period_end,
                weekly_plan=weekly_plan,
            )
        except Exception as err:
            print(f"[stress-activities] week-roll persist failed: {err}")
            return _json_response(503, {"message": "Could not load Stress & Breaks library. Try again shortly."})

    stressful_periods = _build_insights_payload(
        user_id=user_id,
        week_start=period_start,
        week_end=period_end,
        library_item=item,
    )
    return _json_response(
        200,
        _library_payload(
            item,
            weekly_plan=weekly_plan,
            week_start=period_start,
            week_end=period_end,
            stressful_periods=stressful_periods,
        ),
    )


def _handle_toggle_favorite(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    activity = payload.get("activity")
    if not isinstance(activity, dict):
        return _json_response(400, {"message": "activity object is required."})

    normalized = normalize_favorite_activity(activity)
    if not normalized:
        return _json_response(400, {"message": "Invalid activity payload for favorite toggle."})

    try:
        existing = load_library_item(user_id)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception as err:
        print(f"[stress-activities] favorites load failed: {err}")
        return _json_response(503, {"message": "Could not update favorites. Try again shortly."})

    favorites = normalize_favorites(existing.get("favorite_activities"))
    favorite_key = str(normalized.get("favorite_key", "")).strip() or favorite_key_from_item(normalized)
    normalized["favorite_key"] = favorite_key

    existing_keys = {str(item.get("favorite_key", "")).strip(): item for item in favorites}
    if favorite_key in existing_keys:
        favorites = [item for item in favorites if str(item.get("favorite_key", "")).strip() != favorite_key]
        is_favorite = False
    else:
        favorites.append(normalized)
        is_favorite = True

    updated_at = iso_utc_now()
    try:
        library_table().update_item(
            Key={"user_id": user_id},
            UpdateExpression="SET favorite_activities = :favorites, updated_at = :updated_at",
            ExpressionAttributeValues=to_dynamodb_safe(
                {
                    ":favorites": favorites,
                    ":updated_at": updated_at,
                }
            ),
        )
    except Exception as err:
        print(f"[stress-activities] favorites save failed: {err}")
        return _json_response(503, {"message": "Could not update favorites. Try again shortly."})

    return _json_response(
        200,
        {
            "favorite_activities": favorites,
            "toggled_favorite_key": favorite_key,
            "is_favorite": is_favorite,
            "updated_at": updated_at,
        },
    )


def _handle_add_library_activity(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    week_start = str(payload.get("week_start", "")).strip()
    week_end = str(payload.get("week_end", "")).strip()
    library_activity_id = str(payload.get("library_activity_id", "")).strip()
    recommended_day = str(payload.get("recommended_day", "")).strip()
    recommended_start_time = str(payload.get("recommended_start_time", "")).strip()
    if not week_start or not week_end or not library_activity_id or not recommended_day or not recommended_start_time:
        return _json_response(
            400,
            {
                "message": (
                    "week_start, week_end, library_activity_id, recommended_day and "
                    "recommended_start_time are required."
                )
            },
        )
    if recommended_day < _today_iso_utc():
        return _json_response(400, {"message": "Cannot add new activities to past dates."})
    if recommended_day < week_start or recommended_day > week_end:
        return _json_response(400, {"message": "Selected day must be inside the visible week."})
    if parse_hh_mm(recommended_start_time) is None:
        return _json_response(400, {"message": "recommended_start_time must be HH:mm (00:00 to 23:59)."})

    try:
        item = load_library_item(user_id)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception as err:
        print(f"[stress-activities] add load failed: {err}")
        return _json_response(503, {"message": "Could not update weekly break plan. Try again shortly."})

    library_item = _find_library_activity(item, library_activity_id)
    if not library_item:
        return _json_response(400, {"message": "Selected library activity does not exist."})

    kind = str(library_item.get("kind", "")).strip().lower()
    if kind == "flexible":
        duration_minutes = to_int(payload.get("duration_minutes"), 0)
        if duration_minutes not in FLEXIBLE_PLAN_DURATIONS:
            return _json_response(
                400,
                {"message": "Flexible activities require duration_minutes of 5, 10, 15, 20, or 30."},
            )
    else:
        duration_minutes = to_int(library_item.get("duration_minutes"), 0)
        if duration_minutes <= 0:
            return _json_response(400, {"message": "Selected activity has invalid duration."})

    try:
        print(
            "[stress-insights-debug] caller_before_query "
            f"flow=conflict_validation "
            f"helper=_query_busy_blocks "
            f"helper_id={id(_query_busy_blocks)} "
            f"user_id={user_id} "
            f"week_start={week_start!r} "
            f"week_end={week_end!r}"
        )
        busy_blocks = _query_busy_blocks(user_id, week_start, week_end, flow="conflict_validation")
        print(
            "[stress-insights-debug] caller_after_query "
            f"flow=conflict_validation "
            f"returned_count={len(busy_blocks)}"
        )
        for block in busy_blocks:
            print(
                "[stress-insights-debug] conflict_validation_busy_block "
                f"date={block.get('date')} start_time={block.get('start_time')} "
                f"end_time={block.get('end_time')}"
            )
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception as err:
        print(f"[stress-activities] busyblocks query failed: {err}")
        print(
            "[stress-insights-debug] caller_after_query "
            f"flow=conflict_validation returned_count=0 query_error={err}"
        )
        return _json_response(503, {"message": "Could not validate calendar availability. Try again shortly."})

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

    weekly_plan = _weekly_plan_for_requested_week(item, week_start, week_end)
    weekly_plan.append(
        {
            "id": next_plan_id(weekly_plan),
            "library_activity_id": library_activity_id,
            "kind": kind if kind in {"timed", "flexible"} else "timed",
            "title": str(library_item.get("title", "")).strip(),
            "category": str(library_item.get("category", "")).strip(),
            "category_label": str(library_item.get("category_label", "")).strip(),
            "duration_minutes": duration_minutes,
            "recommended_day": recommended_day,
            "recommended_start_time": recommended_start_time,
            "recommended_end_time": recommended_end_time,
            "summary_short": str(library_item.get("summary_short", "")).strip(),
        }
    )
    weekly_plan = normalize_weekly_break_plan(weekly_plan)
    weekly_plan = _filter_plan_to_week(weekly_plan, week_start, week_end)

    try:
        updated_at = _persist_weekly_plan(
            user_id=user_id,
            week_start=week_start,
            week_end=week_end,
            weekly_plan=weekly_plan,
        )
    except Exception as err:
        print(f"[stress-activities] add save failed: {err}")
        return _json_response(503, {"message": "Could not update weekly break plan. Try again shortly."})

    return _json_response(
        200,
        {
            "weekly_break_plan": weekly_plan,
            "week_start": week_start,
            "week_end": week_end,
            "updated_at": updated_at,
        },
    )


def _handle_remove_plan_item(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    week_start = str(payload.get("week_start", "")).strip()
    week_end = str(payload.get("week_end", "")).strip()
    plan_id = str(payload.get("plan_id", "")).strip()
    if not week_start or not week_end or not plan_id:
        return _json_response(400, {"message": "week_start, week_end and plan_id are required."})

    try:
        item = load_library_item(user_id)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception as err:
        print(f"[stress-activities] remove load failed: {err}")
        return _json_response(503, {"message": "Could not update weekly break plan. Try again shortly."})

    weekly_plan = _weekly_plan_for_requested_week(item, week_start, week_end)
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
                return _json_response(500, {"message": "Unexpected error while deleting break calendar event."})

    try:
        updated_at = _persist_weekly_plan(
            user_id=user_id,
            week_start=week_start,
            week_end=week_end,
            weekly_plan=filtered,
        )
    except Exception as err:
        print(f"[stress-activities] remove save failed: {err}")
        return _json_response(503, {"message": "Could not update weekly break plan. Try again shortly."})

    _delete_dailyflow_event_row(user_id=user_id, plan_id=plan_id)
    _mark_busy_blocks_stale(user_id)
    return _json_response(
        200,
        {
            "weekly_break_plan": filtered,
            "week_start": week_start,
            "week_end": week_end,
            "updated_at": updated_at,
        },
    )


def _handle_add_to_calendar(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Mirror workouts/weekly_plan_update.py _handle_add_plan_item_to_calendar for break plan items."""
    week_start = str(payload.get("week_start", "")).strip()
    week_end = str(payload.get("week_end", "")).strip()
    plan_id = str(payload.get("plan_id", "")).strip()
    if not week_start or not week_end or not plan_id:
        return _json_response(400, {"message": "week_start, week_end and plan_id are required."})

    try:
        item = load_library_item(user_id)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception as err:
        print(f"[stress-activities] add_to_calendar load failed: {err}")
        return _json_response(503, {"message": "Could not update weekly break plan. Try again shortly."})

    weekly_plan = _weekly_plan_for_requested_week(item, week_start, week_end)
    plan_item = next((entry for entry in weekly_plan if str(entry.get("id", "")).strip() == plan_id), None)
    if not plan_item:
        return _json_response(404, {"message": "Weekly plan item not found."})
    recommended_day = str(plan_item.get("recommended_day", "")).strip()
    if recommended_day < week_start or recommended_day > week_end:
        return _json_response(400, {"message": "Selected plan item is outside the visible week."})

    existing_event_id = str(plan_item.get("google_event_id", "")).strip()
    existing_calendar_id = str(plan_item.get("dailyflow_calendar_id", "")).strip()
    if existing_event_id and existing_calendar_id:
        return _json_response(
            200,
            {
                "weekly_break_plan": weekly_plan,
                "already_scheduled": True,
                "google_event_id": existing_event_id,
                "dailyflow_calendar_id": existing_calendar_id,
                "message": "Activity already added to DailyFlow calendar.",
            },
        )

    stored_connection = _fetch_google_connection(user_id)
    debug_flags: Dict[str, bool] = {
        "google_integration_found": bool(stored_connection),
        "access_token_refresh_attempted": False,
        "access_token_refresh_success": False,
        "google_calendar_create_retry": False,
        "reconnect_required": False,
    }
    print(f"[stress-activities-debug] google_integration_found={debug_flags['google_integration_found']}")
    if not stored_connection:
        return _json_response(404, {"message": "Google Calendar is not connected for this user."})
    integrations_item, connection = stored_connection

    try:
        dailyflow_calendar_id = _ensure_dailyflow_calendar(user_id, integrations_item, connection, debug_flags)
        create_event_url = GOOGLE_CALENDAR_EVENTS_URL_TEMPLATE.format(
            calendar_id=quote(dailyflow_calendar_id, safe="")
        )
        created_event = _google_request_json_with_refresh(
            user_id=user_id,
            connection=connection,
            method="POST",
            url=create_event_url,
            body=_build_break_event_payload(plan_item),
            debug_flags=debug_flags,
        )
        created_event_id = str(created_event.get("id", "")).strip()
        if not created_event_id:
            return _json_response(502, {"message": "Google Calendar event creation failed."})
    except PermissionError:
        debug_flags["reconnect_required"] = True
        print(
            "[stress-activities-debug] "
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
        return _json_response(500, {"message": "Unexpected error while creating break calendar event."})

    print(
        "[stress-activities-debug] "
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

    try:
        updated_at = _persist_weekly_plan(
            user_id=user_id,
            week_start=week_start,
            week_end=week_end,
            weekly_plan=updated_weekly_plan,
        )
    except Exception as err:
        print(f"[stress-activities] add_to_calendar save failed: {err}")
        return _json_response(503, {"message": "Could not update weekly break plan. Try again shortly."})

    _persist_dailyflow_event_row(
        user_id=user_id,
        plan_id=plan_id,
        library_activity_id=str(plan_item.get("library_activity_id", "")).strip(),
        recommended_day=recommended_day,
        dailyflow_calendar_id=dailyflow_calendar_id,
        google_event_id=created_event_id,
    )
    _mark_busy_blocks_stale(user_id)
    return _json_response(
        200,
        {
            "weekly_break_plan": updated_weekly_plan,
            "week_start": week_start,
            "week_end": week_end,
            "updated_at": updated_at,
            "already_scheduled": False,
            "google_event_id": created_event_id,
            "dailyflow_calendar_id": dailyflow_calendar_id,
        },
    )


def _handle_patch(user_id: str, event: Dict[str, Any]) -> Dict[str, Any]:
    try:
        payload = _parse_body(event)
    except json.JSONDecodeError:
        return _json_response(400, {"message": "Request body must be valid JSON."})

    action = str(payload.get("action") or "").strip()
    if action == "toggle_favorite":
        return _handle_toggle_favorite(user_id, payload)
    if action == "add_library_activity":
        return _handle_add_library_activity(user_id, payload)
    if action == "remove_plan_item":
        return _handle_remove_plan_item(user_id, payload)
    if action == "add_to_calendar":
        return _handle_add_to_calendar(user_id, payload)
    return _json_response(
        400,
        {
            "message": (
                "Unknown action. Use toggle_favorite, add_library_activity, "
                "remove_plan_item, or add_to_calendar."
            )
        },
    )


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    request_context = event.get("requestContext") or {}
    http = request_context.get("http") or {}
    method = (http.get("method") or event.get("httpMethod") or "").upper()

    if method == "OPTIONS":
        return {"statusCode": 200, "headers": dict(_CORS_HEADERS), "body": ""}

    user_id = _extract_cognito_sub(event)
    if not user_id:
        return _json_response(401, {"message": "Missing Cognito user id (sub) in request."})

    if method == "GET":
        return _handle_get(user_id, event)
    if method == "PATCH":
        return _handle_patch(user_id, event)
    return _json_response(405, {"message": "Method not allowed."})
