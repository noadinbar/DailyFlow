import json
import os
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from functools import lru_cache
from hashlib import sha1
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

import boto3
from boto3.dynamodb.conditions import Key

try:
    from .busy_blocks_model import BusyBlock, build_busy_block
except ImportError:
    from busy_blocks_model import BusyBlock, build_busy_block

GOOGLE_CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList"
GOOGLE_CALENDAR_EVENTS_URL_TEMPLATE = "https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_RECONNECT_MESSAGE = "Google connection expired, reconnect required"

SYNC_WINDOW_DAYS = 30

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


def _dynamodb_table(table_env_var: str):
    region = os.getenv("AWS_REGION")
    table_name = os.getenv(table_env_var)
    if not table_name:
        raise ValueError(f"Missing {table_env_var} env var.")
    dynamodb = boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")
    return dynamodb.Table(table_name)


def _extract_google_connection(item: Dict[str, Any]) -> Dict[str, Any]:
    if not item:
        return {}
    if isinstance(item.get("google"), dict):
        return item.get("google") or {}
    return item


def _fetch_google_connection(user_id: str) -> Optional[Tuple[Dict[str, Any], Dict[str, Any]]]:
    table = _dynamodb_table("INTEGRATIONS_TABLE")
    response = table.get_item(Key={"user_id": user_id})
    item = response.get("Item")
    if not item:
        return None
    connection = _extract_google_connection(item)
    access_token = connection.get("access_token") or connection.get("accessToken")
    if access_token:
        return item, connection
    return None


def _update_connection_tokens(user_id: str, connection: Dict[str, Any], new_tokens: Dict[str, Any]) -> None:
    access_token = new_tokens.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        return

    expires_in = int(new_tokens.get("expires_in") or 3600)
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat()

    table = _dynamodb_table("INTEGRATIONS_TABLE")
    table.update_item(
        Key={"user_id": user_id},
        UpdateExpression=(
            "SET access_token = :access_token, accessToken = :access_token, "
            "token_expires_at = :token_expires_at"
        ),
        ExpressionAttributeValues={
            ":access_token": access_token,
            ":token_expires_at": expires_at,
        },
    )
    connection["access_token"] = access_token
    connection["accessToken"] = access_token
    connection["token_expires_at"] = expires_at


def _update_last_busy_sync_at(user_id: str, synced_at: str) -> None:
    table = _dynamodb_table("INTEGRATIONS_TABLE")
    table.update_item(
        Key={"user_id": user_id},
        UpdateExpression="SET last_busy_sync_at = :last_busy_sync_at, updated_at = :updated_at",
        ExpressionAttributeValues={
            ":last_busy_sync_at": synced_at,
            ":updated_at": synced_at,
        },
        ConditionExpression="attribute_exists(user_id)",
    )


def _google_get_json(url: str, access_token: str) -> Dict[str, Any]:
    request = Request(
        url,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
        },
        method="GET",
    )
    with urlopen(request, timeout=20) as response:
        raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}


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


def _google_get_json_with_refresh(
    *,
    user_id: str,
    connection: Dict[str, Any],
    url: str,
) -> Dict[str, Any]:
    access_token = connection.get("access_token") or connection.get("accessToken")
    refresh_token = connection.get("refresh_token") or connection.get("refreshToken")

    if not isinstance(access_token, str) or not access_token:
        raise ValueError("Google connection missing access token.")

    try:
        return _google_get_json(url, access_token)
    except HTTPError as err:
        if err.code != 401:
            raise
        if not isinstance(refresh_token, str) or not refresh_token.strip():
            raise PermissionError(GOOGLE_RECONNECT_MESSAGE)
        new_tokens = _refresh_access_token(refresh_token.strip())
        if not new_tokens or not isinstance(new_tokens.get("access_token"), str):
            raise PermissionError(GOOGLE_RECONNECT_MESSAGE)
        _update_connection_tokens(user_id, connection, new_tokens)
        refreshed_access_token = connection.get("access_token") or connection.get("accessToken")
        if not isinstance(refreshed_access_token, str) or not refreshed_access_token:
            raise PermissionError(GOOGLE_RECONNECT_MESSAGE)
        return _google_get_json(url, refreshed_access_token)


def _build_events_url(calendar_id: str, time_min: str, time_max: str, page_token: Optional[str]) -> str:
    encoded_calendar_id = quote(calendar_id, safe="")
    params = {
        "singleEvents": "true",
        "orderBy": "startTime",
        "timeMin": time_min,
        "timeMax": time_max,
        "fields": "items(id,recurringEventId,status,transparency,start,end),nextPageToken",
    }
    if page_token:
        params["pageToken"] = page_token
    return f"{GOOGLE_CALENDAR_EVENTS_URL_TEMPLATE.format(calendar_id=encoded_calendar_id)}?{urlencode(params)}"


def _calendar_color_map_from_list(payload: Dict[str, Any]) -> Dict[str, str]:
    items = payload.get("items") if isinstance(payload, dict) else []
    if not isinstance(items, list):
        return {}
    color_by_calendar: Dict[str, str] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        calendar_id = item.get("id")
        if not isinstance(calendar_id, str) or not calendar_id.strip():
            continue
        color = item.get("backgroundColor")
        color_by_calendar[calendar_id.strip()] = color.strip() if isinstance(color, str) else ""
    return color_by_calendar


def _parse_google_event_datetime(event_time: Dict[str, Any]) -> datetime:
    if not isinstance(event_time, dict):
        raise ValueError("Google event time is missing.")
    if isinstance(event_time.get("dateTime"), str) and event_time.get("dateTime", "").strip():
        value = event_time.get("dateTime", "").strip()
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    if isinstance(event_time.get("date"), str) and event_time.get("date", "").strip():
        value = date.fromisoformat(event_time.get("date", "").strip())
        return datetime.combine(value, time(0, 0, 0), tzinfo=timezone.utc)
    raise ValueError("Google event time has no date/dateTime.")


def _daily_segments(start_utc: datetime, end_utc: datetime) -> Iterable[Tuple[datetime, datetime]]:
    if end_utc <= start_utc:
        return []

    current_start = start_utc
    while current_start.date() < end_utc.date():
        next_midnight = datetime.combine(
            current_start.date() + timedelta(days=1),
            time(0, 0, 0),
            tzinfo=timezone.utc,
        )
        end_of_day = next_midnight - timedelta(seconds=1)
        yield current_start, end_of_day
        current_start = next_midnight

    if end_utc > current_start:
        yield current_start, end_utc


def _safe_id_fragment(value: str) -> str:
    return sha1(value.encode("utf-8")).hexdigest()[:20]


def _busy_block_id(block: BusyBlock) -> str:
    material = "|".join(
        [
            block.user_id,
            block.source_calendar_id,
            block.source_event_id,
            block.date,
            block.start_time,
            block.end_time,
        ]
    )
    return f"bb_{_safe_id_fragment(material)}"


@lru_cache(maxsize=1)
def _busyblocks_key_schema() -> List[str]:
    region = os.getenv("AWS_REGION")
    table_name = os.getenv("BUSY_BLOCKS_TABLE")
    if not table_name:
        raise ValueError("Missing BUSY_BLOCKS_TABLE env var.")
    client = boto3.client("dynamodb", region_name=region) if region else boto3.client("dynamodb")
    response = client.describe_table(TableName=table_name)
    key_schema = response.get("Table", {}).get("KeySchema", [])
    return [entry.get("AttributeName") for entry in key_schema if entry.get("AttributeName")]


@lru_cache(maxsize=1)
def _busyblocks_partition_key_name() -> Optional[str]:
    region = os.getenv("AWS_REGION")
    table_name = os.getenv("BUSY_BLOCKS_TABLE")
    if not table_name:
        raise ValueError("Missing BUSY_BLOCKS_TABLE env var.")
    client = boto3.client("dynamodb", region_name=region) if region else boto3.client("dynamodb")
    response = client.describe_table(TableName=table_name)
    key_schema = response.get("Table", {}).get("KeySchema", [])
    for entry in key_schema:
        if entry.get("KeyType") == "HASH":
            name = entry.get("AttributeName")
            if isinstance(name, str) and name:
                return name
    return None


def _assert_supported_busyblocks_schema() -> None:
    partition_key = _busyblocks_partition_key_name()
    if partition_key != "user_id":
        raise ValueError(
            "BusyBlocks table schema is unsupported for sync reconciliation. "
            "Required partition key: user_id."
        )
    key_attrs = _busyblocks_key_schema()
    if "block_key" not in key_attrs:
        raise ValueError(
            "BusyBlocks table schema is unsupported for sync upsert. "
            "Required key attribute: block_key (sort key)."
        )


def _dynamodb_value(value: Any) -> Any:
    if isinstance(value, float):
        return Decimal(str(value))
    return value


def _key_value_for_attr(attr_name: str, block: BusyBlock, busy_block_id: str) -> str:
    if attr_name == "user_id":
        return block.user_id
    if attr_name == "block_key":
        return busy_block_id
    if attr_name == "source_event_id":
        return block.source_event_id
    if attr_name == "date":
        return block.date
    if attr_name == "start_time":
        return block.start_time
    if attr_name == "source_calendar_id":
        return block.source_calendar_id
    raise ValueError(f"Unsupported BusyBlocks key attribute '{attr_name}' for sync upsert.")


def _item_key_for_schema(item: Dict[str, Any], key_attrs: List[str]) -> Dict[str, Any]:
    key: Dict[str, Any] = {}
    for attr in key_attrs:
        if attr not in item:
            raise ValueError(f"BusyBlocks item is missing key attribute '{attr}'.")
        key[attr] = item[attr]
    return key


def _upsert_busy_block(block: BusyBlock) -> None:
    table = _dynamodb_table("BUSY_BLOCKS_TABLE")
    key_attrs = _busyblocks_key_schema()
    block_id = _busy_block_id(block)
    item = block.to_item()
    item["block_key"] = block_id

    key: Dict[str, str] = {}
    for attr in key_attrs:
        key[attr] = _key_value_for_attr(attr, block, block_id)

    update_parts: List[str] = []
    expression_values: Dict[str, Any] = {}
    expression_names: Dict[str, str] = {}

    for field_name, value in item.items():
        if field_name in key:
            continue
        name_token = f"#f_{field_name}"
        value_token = f":v_{field_name}"
        expression_names[name_token] = field_name
        expression_values[value_token] = _dynamodb_value(value)
        update_parts.append(f"{name_token} = {value_token}")

    if not update_parts:
        return

    table.update_item(
        Key=key,
        UpdateExpression="SET " + ", ".join(update_parts),
        ExpressionAttributeNames=expression_names,
        ExpressionAttributeValues=expression_values,
    )


def _list_existing_google_busy_blocks_for_user(user_id: str) -> List[Dict[str, Any]]:
    table = _dynamodb_table("BUSY_BLOCKS_TABLE")
    items: List[Dict[str, Any]] = []
    last_evaluated_key: Optional[Dict[str, Any]] = None

    while True:
        query_args: Dict[str, Any] = {
            "KeyConditionExpression": Key("user_id").eq(user_id),
        }
        if last_evaluated_key:
            query_args["ExclusiveStartKey"] = last_evaluated_key
        response = table.query(**query_args)
        batch = response.get("Items") or []
        for item in batch:
            if isinstance(item, dict):
                items.append(item)
        last_evaluated_key = response.get("LastEvaluatedKey")
        if not last_evaluated_key:
            break
    return items


def _delete_busy_blocks_not_in_desired_set(
    *,
    user_id: str,
    desired_block_keys: Set[str],
    window_start_date: str,
    window_end_date: str,
) -> int:
    table = _dynamodb_table("BUSY_BLOCKS_TABLE")
    key_attrs = _busyblocks_key_schema()
    existing_items = _list_existing_google_busy_blocks_for_user(user_id)
    deleted_count = 0

    for item in existing_items:
        if not isinstance(item, dict):
            continue
        date_value = item.get("date")
        if not isinstance(date_value, str) or not date_value.strip():
            continue
        if date_value < window_start_date or date_value > window_end_date:
            continue
        if not isinstance(item.get("source_calendar_id"), str) or not item.get("source_calendar_id", "").strip():
            continue
        block_key = item.get("block_key")
        if not isinstance(block_key, str) or not block_key.strip():
            continue
        if block_key in desired_block_keys:
            continue
        key = _item_key_for_schema(item, key_attrs)
        table.delete_item(Key=key)
        deleted_count += 1

    return deleted_count


def _list_busy_blocks_from_selected_calendars(
    *,
    user_id: str,
    connection: Dict[str, Any],
    selected_calendar_ids: List[str],
    now_utc: datetime,
) -> List[BusyBlock]:
    one_month_later = now_utc + timedelta(days=SYNC_WINDOW_DAYS)
    time_min = now_utc.isoformat().replace("+00:00", "Z")
    time_max = one_month_later.isoformat().replace("+00:00", "Z")
    now_iso = now_utc.isoformat().replace("+00:00", "Z")

    calendar_list_payload = _google_get_json_with_refresh(
        user_id=user_id,
        connection=connection,
        url=GOOGLE_CALENDAR_LIST_URL,
    )
    color_map = _calendar_color_map_from_list(calendar_list_payload)

    blocks: List[BusyBlock] = []
    seen_block_ids: Set[str] = set()

    for calendar_id in selected_calendar_ids:
        page_token: Optional[str] = None
        while True:
            events_url = _build_events_url(calendar_id, time_min, time_max, page_token)
            payload = _google_get_json_with_refresh(
                user_id=user_id,
                connection=connection,
                url=events_url,
            )
            events = payload.get("items") if isinstance(payload, dict) else []
            if not isinstance(events, list):
                events = []

            for event in events:
                if not isinstance(event, dict):
                    continue
                if event.get("status") == "cancelled":
                    continue
                if event.get("transparency") == "transparent":
                    continue
                event_id = event.get("id")
                if not isinstance(event_id, str) or not event_id.strip():
                    continue
                start_raw = event.get("start")
                end_raw = event.get("end")
                if not isinstance(start_raw, dict) or not isinstance(end_raw, dict):
                    continue

                try:
                    event_start = _parse_google_event_datetime(start_raw)
                    event_end = _parse_google_event_datetime(end_raw)
                except Exception:
                    continue

                if event_end <= event_start:
                    continue

                segment_index = 0
                for segment_start, segment_end in _daily_segments(event_start, event_end):
                    if segment_end <= segment_start:
                        continue
                    segment_source_event_id = (
                        f"{event_id}#{segment_start.date().isoformat()}#{segment_index}"
                    )
                    segment_index += 1
                    block = build_busy_block(
                        user_id=user_id,
                        source_event_id=segment_source_event_id,
                        source_calendar_id=calendar_id,
                        source_calendar_color=color_map.get(calendar_id, ""),
                        google_event_start_iso=segment_start.isoformat().replace("+00:00", "Z"),
                        google_event_end_iso=segment_end.isoformat().replace("+00:00", "Z"),
                        updated_at_iso=now_iso,
                    )
                    unique_id = _busy_block_id(block)
                    if unique_id in seen_block_ids:
                        continue
                    seen_block_ids.add(unique_id)
                    blocks.append(block)

            page_token = payload.get("nextPageToken") if isinstance(payload, dict) else None
            if not isinstance(page_token, str) or not page_token.strip():
                break

    return blocks


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    request_context = event.get("requestContext") or {}
    http = request_context.get("http") or {}
    method = (http.get("method") or event.get("httpMethod") or "").upper()
    if method == "OPTIONS":
        return {
            "statusCode": 200,
            "headers": dict(_CORS_HEADERS),
            "body": "",
        }
    if method != "POST":
        return _json_response(405, {"message": "Method not allowed."})

    user_id = _extract_cognito_sub(event)
    if not user_id:
        return _json_response(401, {"message": "Missing Cognito user id (sub) in request."})

    try:
        stored = _fetch_google_connection(user_id)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})

    if not stored:
        return _json_response(404, {"message": "Google Calendar is not connected for this user."})

    item, connection = stored

    selected_ids_raw = connection.get("selected_calendar_ids")
    if not isinstance(selected_ids_raw, list):
        selected_ids_raw = item.get("selected_calendar_ids") if isinstance(item, dict) else None
    selected_calendar_ids = [
        value.strip()
        for value in (selected_ids_raw or [])
        if isinstance(value, str) and value.strip()
    ]

    if not selected_calendar_ids:
        _assert_supported_busyblocks_schema()
        now_utc = datetime.now(timezone.utc)
        window_start_date = now_utc.date().isoformat()
        window_end_date = (now_utc + timedelta(days=SYNC_WINDOW_DAYS)).date().isoformat()
        deleted_count = _delete_busy_blocks_not_in_desired_set(
            user_id=user_id,
            desired_block_keys=set(),
            window_start_date=window_start_date,
            window_end_date=window_end_date,
        )
        sync_now = _iso_utc_now()
        _update_last_busy_sync_at(user_id, sync_now)
        return _json_response(
            200,
            {
                "synced_busy_blocks_count": 0,
                "deleted_busy_blocks_count": deleted_count,
                "selected_calendar_ids_count": 0,
                "sync_window_days": SYNC_WINDOW_DAYS,
                "last_busy_sync_at": sync_now,
            },
        )

    try:
        _assert_supported_busyblocks_schema()
        now_utc = datetime.now(timezone.utc)
        window_start_date = now_utc.date().isoformat()
        window_end_date = (now_utc + timedelta(days=SYNC_WINDOW_DAYS)).date().isoformat()
        busy_blocks = _list_busy_blocks_from_selected_calendars(
            user_id=user_id,
            connection=connection,
            selected_calendar_ids=selected_calendar_ids,
            now_utc=now_utc,
        )
        desired_ids: Set[str] = set()
        for block in busy_blocks:
            desired_ids.add(_busy_block_id(block))
            _upsert_busy_block(block)
        deleted_count = _delete_busy_blocks_not_in_desired_set(
            user_id=user_id,
            desired_block_keys=desired_ids,
            window_start_date=window_start_date,
            window_end_date=window_end_date,
        )
        sync_now = _iso_utc_now()
        _update_last_busy_sync_at(user_id, sync_now)
        return _json_response(
            200,
            {
                "synced_busy_blocks_count": len(busy_blocks),
                "deleted_busy_blocks_count": deleted_count,
                "selected_calendar_ids_count": len(selected_calendar_ids),
                "sync_window_days": SYNC_WINDOW_DAYS,
                "last_busy_sync_at": sync_now,
            },
        )
    except PermissionError as err:
        return _json_response(403, {"message": str(err)})
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
        return _json_response(500, {"message": "Unexpected error while syncing busy blocks."})
