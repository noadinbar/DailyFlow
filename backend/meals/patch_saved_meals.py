"""
PATCH /meals/saved — persist favorites, week plan, grocery checks, calendar scheduling.
"""
import json
import math
import os
import traceback
import uuid
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

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


def _meals_table():
    table_name = os.getenv("MEALS_TABLE")
    if not table_name:
        raise ValueError("Missing MEALS_TABLE env var.")
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


def _to_dynamodb_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return Decimal("0")
        return Decimal(str(value))
    if isinstance(value, int):
        return value
    if isinstance(value, Decimal):
        return value
    if isinstance(value, dict):
        return {k: _to_dynamodb_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_to_dynamodb_safe(v) for v in value]
    if isinstance(value, tuple):
        return [_to_dynamodb_safe(v) for v in value]
    return value


def _to_json_safe(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    if isinstance(value, list):
        return [_to_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(k): _to_json_safe(v) for k, v in value.items()}
    return value


def _to_int(value: Any, default: int = 0) -> int:
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


def _to_float(value: Any, default: float = 0.0) -> float:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return default
        try:
            return float(raw)
        except Exception:
            return default
    return default


def _normalize_time_hh_mm(value: str) -> str:
    """Accept HH:MM or HH:MM:SS (e.g. HTML time input) and return HH:MM for Google + slot checks."""
    raw = (value or "").strip()
    if not raw:
        return ""
    parts = raw.split(":")
    if len(parts) >= 2:
        try:
            hour = int(parts[0])
            minute = int(parts[1])
            if 0 <= hour <= 23 and 0 <= minute <= 59:
                return f"{hour:02d}:{minute:02d}"
        except ValueError:
            pass
    return raw[:5] if len(raw) >= 5 else raw


def _parse_hh_mm(value: str) -> Optional[time]:
    if not isinstance(value, str):
        return None
    raw = _normalize_time_hh_mm(value.strip())
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


def _safe_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _safe_string_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    out: List[str] = []
    for item in value:
        if isinstance(item, str):
            cleaned = item.strip()
            if cleaned:
                out.append(cleaned)
    return out


def _app_today() -> date:
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo(APP_TIMEZONE_ID)).date()
    except Exception:
        return datetime.now(timezone.utc).date()


def _start_of_week_from_date(d: date) -> date:
    days_back = (d.weekday() + 1) % 7
    return d - timedelta(days=days_back)


def _current_week_bounds() -> Tuple[str, str]:
    """Sunday–Saturday in Asia/Jerusalem. Same definition as GET /meals and Overview."""
    ws = _start_of_week_from_date(_app_today())
    we = ws + timedelta(days=6)
    return ws.isoformat(), we.isoformat()


def _week_key_for_date_iso(date_iso: str) -> str:
    d = date.fromisoformat(date_iso.strip())
    return f"WEEK#{_start_of_week_from_date(d).isoformat()}"


def _extract_google_connection(item: Dict[str, Any]) -> Dict[str, Any]:
    if not item:
        return {}
    if isinstance(item.get("google"), dict):
        return item.get("google") or {}
    return item


def _fetch_google_connection(user_id: str) -> Optional[Tuple[Dict[str, Any], Dict[str, Any]]]:
    try:
        response = _integrations_table().get_item(Key={"user_id": user_id})
    except ClientError as err:
        print(f"[meals-saved] Integrations get_item ClientError: {err}")
        traceback.print_exc()
        return None
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
) -> Dict[str, Any]:
    access_token = connection.get("access_token") or connection.get("accessToken")
    refresh_token = connection.get("refresh_token") or connection.get("refreshToken")
    if not isinstance(access_token, str) or not access_token.strip():
        raise PermissionError("Google connection missing access token.")
    try:
        return _google_request_json(method, url, access_token.strip(), body)
    except HTTPError as err:
        if err.code != 401:
            raise
        if not isinstance(refresh_token, str) or not refresh_token.strip():
            raise PermissionError("Google connection expired, reconnect required")
        new_tokens = _refresh_access_token(refresh_token.strip())
        if not new_tokens or not isinstance(new_tokens.get("access_token"), str):
            raise PermissionError("Google connection expired, reconnect required")
        _update_connection_access_token(user_id, connection, new_tokens)
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
) -> None:
    access_token = connection.get("access_token") or connection.get("accessToken")
    refresh_token = connection.get("refresh_token") or connection.get("refreshToken")
    if not isinstance(access_token, str) or not access_token.strip():
        raise PermissionError("Google connection missing access token.")
    try:
        _google_request_no_content(method, url, access_token.strip())
        return
    except HTTPError as err:
        if err.code != 401:
            raise
        if not isinstance(refresh_token, str) or not refresh_token.strip():
            raise PermissionError("Google connection expired, reconnect required")
        new_tokens = _refresh_access_token(refresh_token.strip())
        if not new_tokens or not isinstance(new_tokens.get("access_token"), str):
            raise PermissionError("Google connection expired, reconnect required")
        _update_connection_access_token(user_id, connection, new_tokens)
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


def _ensure_dailyflow_calendar(user_id: str, item: Dict[str, Any], connection: Dict[str, Any]) -> str:
    selected_calendar_ids = _selected_calendar_ids_from_sources(item, connection)
    calendar_list_payload = _google_request_json_with_refresh(
        user_id=user_id,
        connection=connection,
        method="GET",
        url=GOOGLE_CALENDAR_LIST_URL,
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
    try:
        table = _busy_blocks_table()
    except ValueError as err:
        print(f"[meals-saved] busy blocks table config error: {err}")
        raise
    items: List[Dict[str, Any]] = []
    last_evaluated_key: Optional[Dict[str, Any]] = None
    while True:
        query_args: Dict[str, Any] = {"KeyConditionExpression": Key("user_id").eq(user_id)}
        if last_evaluated_key:
            query_args["ExclusiveStartKey"] = last_evaluated_key
        try:
            response = table.query(**query_args)
        except ClientError as err:
            print(f"[meals-saved] BusyBlocks query ClientError: {err}")
            traceback.print_exc()
            raise
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


def _slot_is_valid(
    *,
    week_start: str,
    week_end: str,
    recommended_day: str,
    recommended_start_time: str,
    duration_minutes: int,
    busy_blocks: List[Dict[str, Any]],
) -> Tuple[bool, str, str]:
    if recommended_day < week_start or recommended_day > week_end:
        return False, "", "Selected day must be inside the current week."
    start_t = _parse_hh_mm(recommended_start_time)
    if not start_t:
        return False, "", "start_time must be HH:MM."
    start_m = start_t.hour * 60 + start_t.minute
    end_m = start_m + duration_minutes
    if start_m < DAY_START_MINUTES or end_m > DAY_END_MINUTES:
        return False, "", "Selected time is outside allowed hours (06:00-22:00)."
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
            return False, "", "This time overlaps a busy block on your calendar."
    return True, f"{end_m // 60:02d}:{end_m % 60:02d}", ""


def _format_google_event_datetime(date_iso: str, hhmm: str) -> str:
    """RFC3339 local time; hhmm must be HH:MM only (seconds added once)."""
    norm = _normalize_time_hh_mm(hhmm)
    if len(norm) < 5:
        norm = "09:00"
    return f"{date_iso}T{norm}:00"


def _normalize_ingredients(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, Any]] = []
    for ing in raw:
        if not isinstance(ing, dict):
            continue
        name = _safe_string(ing.get("name"))
        if not name:
            continue
        qty = _to_float(ing.get("quantity"), 1.0)
        if qty <= 0:
            qty = 1.0
        unit = _safe_string(ing.get("unit")).lower() or "unit"
        category = _safe_string(ing.get("category")) or "Pantry"
        rounding = _safe_string(ing.get("rounding")).lower() or "none"
        if rounding not in {"none", "ceil"}:
            rounding = "none"
        out.append(
            {
                "name": name,
                "quantity": round(qty, 2),
                "unit": unit,
                "category": category,
                "rounding": rounding,
            }
        )
    return out


def _normalize_instructions(raw: Any) -> List[str]:
    if not isinstance(raw, list):
        return []
    return [s for s in (_safe_string(x) for x in raw) if s]


def _find_library_meal(meal_library: List[Dict[str, Any]], meal_id: str) -> Optional[Dict[str, Any]]:
    for m in meal_library:
        if isinstance(m, dict) and str(m.get("id", "")).strip() == meal_id:
            return m
    return None


def _aggregate_grocery(saved_meals: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    acc: Dict[str, Dict[str, Any]] = {}
    for meal in saved_meals:
        if not isinstance(meal, dict):
            continue
        ingredients = meal.get("ingredients")
        if not isinstance(ingredients, list):
            continue
        servings = _to_float(meal.get("servings"), 1.0)
        base = _to_float(meal.get("base_servings"), 1.0)
        scale = servings / max(1.0, base)
        for ing in ingredients:
            if not isinstance(ing, dict):
                continue
            name = str(ing.get("name", "")).strip()
            if not name:
                continue
            unit = str(ing.get("unit", "unit")).lower()
            category = str(ing.get("category", "Pantry")).strip() or "Pantry"
            qty = _to_float(ing.get("quantity"), 0.0)
            rounding = str(ing.get("rounding", "none")).lower()
            if rounding not in {"none", "ceil"}:
                rounding = "none"
            key = f"{category}::{name.lower()}::{unit}"
            scaled = qty * scale
            if key not in acc:
                acc[key] = {
                    "key": key,
                    "name": name,
                    "unit": unit,
                    "category": category,
                    "quantity": 0.0,
                    "rounding": rounding,
                }
            acc[key]["quantity"] += scaled
    result: List[Dict[str, Any]] = []
    for g in acc.values():
        q = float(g["quantity"])
        if g.get("rounding") == "ceil":
            q = float(math.ceil(q))
        else:
            q = round(q, 2)
        result.append(
            {
                "key": g["key"],
                "name": g["name"],
                "unit": g["unit"],
                "category": g["category"],
                "quantity": q,
            }
        )
    result.sort(key=lambda x: (x["category"], x["name"]))
    return result


def _build_meal_event_payload(
    *,
    date_iso: str,
    start_hhmm: str,
    end_hhmm: str,
    library_meal: Dict[str, Any],
    meal_name: str,
) -> Dict[str, Any]:
    title = _safe_string(library_meal.get("title")) or meal_name or "Meal"
    meal_type = _safe_string(library_meal.get("meal_type"))
    summary_short = _safe_string(library_meal.get("summary_short"))
    lines: List[str] = []
    if meal_type:
        lines.append(f"Type: {meal_type}")
    if summary_short:
        lines.append(summary_short)
    ingredients = library_meal.get("ingredients")
    if isinstance(ingredients, list) and ingredients:
        lines.append("")
        lines.append("Ingredients:")
        for ing in ingredients:
            if not isinstance(ing, dict):
                continue
            nm = _safe_string(ing.get("name"))
            if not nm:
                continue
            q = _to_float(ing.get("quantity"), 0)
            u = _safe_string(ing.get("unit")) or "unit"
            lines.append(f"- {nm}: {q} {u}")
    instructions = library_meal.get("instructions")
    inst_list = _normalize_instructions(instructions)
    if inst_list:
        lines.append("")
        lines.append("Steps:")
        for idx, step in enumerate(inst_list, start=1):
            lines.append(f"{idx}. {step}")
    description = "\n".join(lines) if lines else "Planned in DailyFlow."
    return {
        "summary": f"Meal: {title}",
        "description": description,
        "start": {
            "dateTime": _format_google_event_datetime(date_iso, start_hhmm),
            "timeZone": APP_TIMEZONE_ID,
        },
        "end": {
            "dateTime": _format_google_event_datetime(date_iso, end_hhmm),
            "timeZone": APP_TIMEZONE_ID,
        },
    }


def _persist_meal_dailyflow_event_row(
    *,
    user_id: str,
    saved_meal_id: str,
    meal_id: str,
    day_iso: str,
    dailyflow_calendar_id: str,
    google_event_id: str,
) -> None:
    try:
        _dailyflow_events_table().put_item(
            Item={
                "user_id": user_id,
                "plan_id": saved_meal_id,
                "library_workout_id": meal_id,
                "recommended_day": day_iso,
                "dailyflow_calendar_id": dailyflow_calendar_id,
                "google_event_id": google_event_id,
                "updated_at": _iso_utc_now(),
            }
        )
    except Exception:
        return


def _load_week_item(user_id: str, week_key: str) -> Dict[str, Any]:
    return _meals_table().get_item(Key={"user_id": user_id, "record_key": week_key}).get("Item") or {}


def _normalize_saved_meal_entry(raw: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    mid = _safe_string(raw.get("meal_id"))
    if not mid:
        return None
    sid = _safe_string(raw.get("id"))
    if not sid:
        return None
    mname = _safe_string(raw.get("meal_name"))
    date_iso = _safe_string(raw.get("date"))
    st = _safe_string(raw.get("start_time"))
    et = _safe_string(raw.get("end_time"))
    if not date_iso or not st or not et:
        return None
    prep = _to_int(raw.get("prep_time_minutes"), 0)
    if prep <= 0:
        return None
    ingredients = _normalize_ingredients(raw.get("ingredients"))
    if not ingredients:
        return None
    return {
        "id": sid,
        "meal_id": mid,
        "meal_name": mname or "Meal",
        "prep_time_minutes": prep,
        "date": date_iso,
        "start_time": st,
        "end_time": et,
        "servings": max(1, _to_int(raw.get("servings"), 1)),
        "base_servings": max(1, _to_int(raw.get("base_servings"), 1)),
        "ingredients": ingredients,
        "google_event_id": _safe_string(raw.get("google_event_id")),
        "dailyflow_calendar_id": _safe_string(raw.get("dailyflow_calendar_id")),
    }


def _normalize_saved_meals_list(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        norm = _normalize_saved_meal_entry(item)
        if norm:
            out.append(norm)
    return out


def _save_week_bundle(
    user_id: str,
    week_key: str,
    saved_meals: List[Dict[str, Any]],
    checked_keys: List[str],
    grocery: List[Dict[str, Any]],
) -> str:
    updated_at = _iso_utc_now()
    item = {
        "user_id": user_id,
        "record_key": week_key,
        "saved_meals_this_week": saved_meals,
        "grocery_list": grocery,
        "checked_grocery_items": checked_keys,
        "updated_at": updated_at,
    }
    _meals_table().put_item(Item=_to_dynamodb_safe(item))
    return updated_at


def _handle_toggle_favorite(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    meal_id = _safe_string(payload.get("meal_id"))
    if not meal_id:
        return _json_response(400, {"message": "meal_id is required."})
    table = _meals_table()
    lib = table.get_item(Key={"user_id": user_id, "record_key": "LIBRARY#current"}).get("Item") or {}
    meal_library = lib.get("meal_library")
    if not isinstance(meal_library, list) or not meal_library:
        return _json_response(400, {"message": "Meal library is empty. Generate meals first."})
    if not _find_library_meal(meal_library, meal_id):
        return _json_response(404, {"message": "Meal not found in library."})
    favorites = _safe_string_list(lib.get("favorite_meals"))
    if meal_id in favorites:
        favorites = [x for x in favorites if x != meal_id]
    else:
        favorites = [*favorites, meal_id]
    updated_at = _iso_utc_now()
    put_item = {
        "user_id": user_id,
        "record_key": "LIBRARY#current",
        "meal_library": meal_library,
        "favorite_meals": favorites,
        "generated_at": lib.get("generated_at") or updated_at,
        "updated_at": updated_at,
    }
    table.put_item(Item=_to_dynamodb_safe(put_item))
    return _json_response(200, {"favorite_meals": favorites, "updated_at": updated_at})


def _handle_toggle_grocery(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    key = _safe_string(payload.get("grocery_key"))
    if not key:
        return _json_response(400, {"message": "grocery_key is required."})
    week_key = _safe_string(payload.get("week_record_key"))
    if not week_key.startswith("WEEK#"):
        week_start, _ = _current_week_bounds()
        week_key = f"WEEK#{week_start}"
    week = _load_week_item(user_id, week_key)
    saved = _normalize_saved_meals_list(week.get("saved_meals_this_week"))
    checked = _safe_string_list(week.get("checked_grocery_items"))
    if key in checked:
        checked = [x for x in checked if x != key]
    else:
        checked = [*checked, key]
    grocery = _aggregate_grocery(saved)
    updated_at = _save_week_bundle(user_id, week_key, saved, checked, grocery)
    return _json_response(
        200,
        {
            "checked_grocery_items": checked,
            "grocery_list": _to_json_safe(grocery),
            "saved_meals_this_week": _to_json_safe(saved),
            "updated_at": updated_at,
        },
    )


def _handle_clear_checked(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    week_key = _safe_string(payload.get("week_record_key"))
    if not week_key.startswith("WEEK#"):
        week_start, _ = _current_week_bounds()
        week_key = f"WEEK#{week_start}"
    week = _load_week_item(user_id, week_key)
    saved = _normalize_saved_meals_list(week.get("saved_meals_this_week"))
    grocery = _aggregate_grocery(saved)
    updated_at = _save_week_bundle(user_id, week_key, saved, [], grocery)
    return _json_response(
        200,
        {
            "checked_grocery_items": [],
            "grocery_list": _to_json_safe(grocery),
            "saved_meals_this_week": _to_json_safe(saved),
            "updated_at": updated_at,
        },
    )


def _handle_update_servings(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    saved_meal_id = _safe_string(payload.get("saved_meal_id"))
    servings = _to_int(payload.get("servings"), 1)
    if not saved_meal_id:
        return _json_response(400, {"message": "saved_meal_id is required."})
    if servings < 1:
        return _json_response(400, {"message": "servings must be at least 1."})
    week_key = _safe_string(payload.get("week_record_key"))
    if not week_key.startswith("WEEK#"):
        week_start, _ = _current_week_bounds()
        week_key = f"WEEK#{week_start}"
    week = _load_week_item(user_id, week_key)
    saved = _normalize_saved_meals_list(week.get("saved_meals_this_week"))
    found = False
    next_saved: List[Dict[str, Any]] = []
    for m in saved:
        if m["id"] == saved_meal_id:
            found = True
            nm = dict(m)
            nm["servings"] = servings
            next_saved.append(nm)
        else:
            next_saved.append(m)
    if not found:
        return _json_response(404, {"message": "Saved meal not found."})
    checked = _safe_string_list(week.get("checked_grocery_items"))
    grocery = _aggregate_grocery(next_saved)
    updated_at = _save_week_bundle(user_id, week_key, next_saved, checked, grocery)
    return _json_response(
        200,
        {
            "saved_meals_this_week": _to_json_safe(next_saved),
            "grocery_list": _to_json_safe(grocery),
            "checked_grocery_items": checked,
            "updated_at": updated_at,
        },
    )


def _handle_remove_saved_meal(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    saved_meal_id = _safe_string(payload.get("saved_meal_id"))
    if not saved_meal_id:
        return _json_response(400, {"message": "saved_meal_id is required."})
    week_key = _safe_string(payload.get("week_record_key"))
    if not week_key.startswith("WEEK#"):
        week_start, _ = _current_week_bounds()
        week_key = f"WEEK#{week_start}"
    week = _load_week_item(user_id, week_key)
    saved = _normalize_saved_meals_list(week.get("saved_meals_this_week"))
    removed: Optional[Dict[str, Any]] = None
    next_saved: List[Dict[str, Any]] = []
    for m in saved:
        if m["id"] == saved_meal_id:
            removed = m
        else:
            next_saved.append(m)
    if removed is None:
        return _json_response(404, {"message": "Saved meal not found."})
    g_eid = _safe_string(removed.get("google_event_id"))
    g_cal = _safe_string(removed.get("dailyflow_calendar_id"))
    if g_eid and g_cal:
        stored = _fetch_google_connection(user_id)
        if stored:
            _, connection = stored
            delete_url = (
                f"{GOOGLE_CALENDAR_EVENTS_URL_TEMPLATE.format(calendar_id=quote(g_cal, safe=''))}"
                f"/{quote(g_eid, safe='')}"
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
                return _json_response(500, {"message": "Unexpected error while deleting calendar event."})
    _delete_dailyflow_event_row(user_id=user_id, plan_id=saved_meal_id)
    checked = _safe_string_list(week.get("checked_grocery_items"))
    grocery = _aggregate_grocery(next_saved)
    updated_at = _save_week_bundle(user_id, week_key, next_saved, checked, grocery)
    _mark_busy_blocks_stale(user_id)
    return _json_response(
        200,
        {
            "saved_meals_this_week": _to_json_safe(next_saved),
            "grocery_list": _to_json_safe(grocery),
            "checked_grocery_items": checked,
            "updated_at": updated_at,
        },
    )


def _handle_add_to_calendar(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    meal_id = _safe_string(payload.get("meal_id"))
    date_iso = _safe_string(payload.get("date"))
    start_time = _normalize_time_hh_mm(_safe_string(payload.get("start_time")))
    if not meal_id or not date_iso or not start_time:
        return _json_response(400, {"message": "meal_id, date, and start_time are required."})
    week_start, week_end = _current_week_bounds()
    if date_iso < week_start or date_iso > week_end:
        return _json_response(400, {"message": "Date must be within the current week."})
    try:
        table = _meals_table()
        lib = table.get_item(Key={"user_id": user_id, "record_key": "LIBRARY#current"}).get("Item") or {}
    except ClientError as err:
        print(f"[meals-saved] Meals table read ClientError (library): {err}")
        traceback.print_exc()
        return _json_response(503, {"message": "Could not load meal library. Try again shortly."})
    meal_library = lib.get("meal_library")
    if not isinstance(meal_library, list):
        return _json_response(400, {"message": "Meal library is missing."})
    library_meal = _find_library_meal(meal_library, meal_id)
    if not library_meal:
        return _json_response(404, {"message": "Meal not found in library."})
    prep = _to_int(library_meal.get("prep_time_minutes"), 0)
    if prep <= 0:
        return _json_response(400, {"message": "Invalid prep time for meal."})
    try:
        busy = _query_busy_blocks(user_id, week_start, week_end)
    except ClientError:
        return _json_response(
            503,
            {
                "message": "Could not load busy blocks for conflict checking. "
                "Ensure the meals Lambda can read BUSY_BLOCKS_TABLE (DynamoDB Query).",
            },
        )
    ok, end_hhmm, err_msg = _slot_is_valid(
        week_start=week_start,
        week_end=week_end,
        recommended_day=date_iso,
        recommended_start_time=start_time,
        duration_minutes=prep,
        busy_blocks=busy,
    )
    if not ok:
        return _json_response(409, {"message": err_msg or "Time slot not available."})

    try:
        integ_resp = _integrations_table().get_item(Key={"user_id": user_id})
    except ClientError as err:
        print(f"[meals-saved] Integrations get_item ClientError (add meal): {err}")
        traceback.print_exc()
        code = err.response.get("Error", {}).get("Code", "")
        return _json_response(
            503,
            {"message": f"Could not verify Google Calendar connection ({code}). Try again or reconnect Google."},
        )
    item = integ_resp.get("Item")
    if not isinstance(item, dict):
        return _json_response(
            404,
            {
                "message": "Google Calendar is not connected. Open Calendar in DailyFlow, connect Google, then try again.",
            },
        )
    connection = _extract_google_connection(item)
    access_token = connection.get("access_token") or connection.get("accessToken")
    if not isinstance(access_token, str) or not access_token.strip():
        return _json_response(
            404,
            {
                "message": "Google Calendar is not connected or the session expired. Reconnect Google from Calendar, then try again.",
            },
        )

    meal_name = _safe_string(library_meal.get("title")) or "Meal"
    print(f"[meals-saved] add_to_calendar: before Google (user={user_id[:8]}…, meal={meal_id})")
    try:
        dailyflow_calendar_id = _ensure_dailyflow_calendar(user_id, item, connection)
        create_event_url = GOOGLE_CALENDAR_EVENTS_URL_TEMPLATE.format(
            calendar_id=quote(dailyflow_calendar_id, safe="")
        )
        event_body = _build_meal_event_payload(
            date_iso=date_iso,
            start_hhmm=start_time,
            end_hhmm=end_hhmm,
            library_meal=library_meal,
            meal_name=meal_name,
        )
        created_event = _google_request_json_with_refresh(
            user_id=user_id,
            connection=connection,
            method="POST",
            url=create_event_url,
            body=event_body,
        )
        created_event_id = str(created_event.get("id", "")).strip()
        if not created_event_id:
            print("[meals-saved] Google create event returned no id", created_event)
            return _json_response(502, {"message": "Google Calendar event creation failed (no event id)."})
        print(f"[meals-saved] add_to_calendar: Google event created id={created_event_id[:16]}…")
    except PermissionError as err:
        print(f"[meals-saved] Google PermissionError: {err}")
        return _json_response(403, {"message": str(err)})
    except HTTPError as err:
        print(f"[meals-saved] Google HTTPError: {err}")
        traceback.print_exc()
        return _json_response(502, {"message": f"Google Calendar API request failed with status {err.code}."})
    except (URLError, TimeoutError) as err:
        print(f"[meals-saved] Google network error: {err}")
        traceback.print_exc()
        return _json_response(502, {"message": "Failed to reach Google Calendar API."})
    except (json.JSONDecodeError, ValueError) as err:
        print(f"[meals-saved] Google parse/ValueError: {err}")
        traceback.print_exc()
        return _json_response(502, {"message": "Unexpected response from Google Calendar. Try again."})
    except Exception:
        print("[meals-saved] add_to_calendar: unexpected error in Google phase")
        traceback.print_exc()
        return _json_response(502, {"message": "Unexpected error while creating the calendar event."})

    saved_meal_id = f"meal_saved_{uuid.uuid4().hex[:12]}"
    ingredients = _normalize_ingredients(library_meal.get("ingredients"))
    if not ingredients:
        return _json_response(400, {"message": "Meal has no ingredients."})
    base_servings = max(1, _to_int(library_meal.get("base_servings"), 1))
    new_entry = {
        "id": saved_meal_id,
        "meal_id": meal_id,
        "meal_name": meal_name,
        "prep_time_minutes": prep,
        "date": date_iso,
        "start_time": start_time,
        "end_time": end_hhmm,
        "servings": 1,
        "base_servings": base_servings,
        "ingredients": ingredients,
        "google_event_id": created_event_id,
        "dailyflow_calendar_id": dailyflow_calendar_id,
    }
    week_key = _week_key_for_date_iso(date_iso)
    try:
        week = _load_week_item(user_id, week_key)
        existing = _normalize_saved_meals_list(week.get("saved_meals_this_week"))
        next_saved = [*existing, new_entry]
        checked = _safe_string_list(week.get("checked_grocery_items"))
        grocery = _aggregate_grocery(next_saved)
        print(f"[meals-saved] add_to_calendar: before DynamoDB week save key={week_key}")
        updated_at = _save_week_bundle(user_id, week_key, next_saved, checked, grocery)
        print("[meals-saved] add_to_calendar: after DynamoDB week save")
    except ClientError as err:
        print(f"[meals-saved] DynamoDB save week ClientError: {err}")
        traceback.print_exc()
        code = err.response.get("Error", {}).get("Code", "")
        return _json_response(
            502,
            {
                "message": f"Calendar event was created but saving your week failed ({code}). "
                "Try removing the event from Google Calendar or contact support.",
            },
        )

    _persist_meal_dailyflow_event_row(
        user_id=user_id,
        saved_meal_id=saved_meal_id,
        meal_id=meal_id,
        day_iso=date_iso,
        dailyflow_calendar_id=dailyflow_calendar_id,
        google_event_id=created_event_id,
    )
    _mark_busy_blocks_stale(user_id)
    return _json_response(
        200,
        {
            "saved_meal": _to_json_safe(new_entry),
            "saved_meals_this_week": _to_json_safe(next_saved),
            "grocery_list": _to_json_safe(grocery),
            "checked_grocery_items": checked,
            "google_event_id": created_event_id,
            "dailyflow_calendar_id": dailyflow_calendar_id,
            "updated_at": updated_at,
            "week_record_key": week_key,
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

    action = _safe_string(payload.get("action"))
    handlers = {
        "toggle_favorite": _handle_toggle_favorite,
        "toggle_grocery_item": _handle_toggle_grocery,
        "clear_checked": _handle_clear_checked,
        "update_servings": _handle_update_servings,
        "remove_saved_meal": _handle_remove_saved_meal,
        "add_to_calendar": _handle_add_to_calendar,
    }
    fn = handlers.get(action)
    if not fn:
        return _json_response(
            400,
            {"message": "Unknown action. Use toggle_favorite, add_to_calendar, remove_saved_meal, update_servings, toggle_grocery_item, or clear_checked."},
        )
    try:
        return fn(user_id, payload)
    except ValueError as err:
        print(f"[meals-saved] ValueError: {err}")
        traceback.print_exc()
        return _json_response(500, {"message": str(err)})
    except ClientError as err:
        print(f"[meals-saved] ClientError: {err}")
        traceback.print_exc()
        code = err.response.get("Error", {}).get("Code", "")
        return _json_response(502, {"message": f"Database error ({code}). Try again."})
    except Exception:
        print("[meals-saved] Unexpected error in action handler")
        traceback.print_exc()
        return _json_response(500, {"message": "Unexpected error while updating meals."})
