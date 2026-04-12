import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import boto3


GOOGLE_CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_RECONNECT_MESSAGE = "Google connection expired, reconnect required"

_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://main.dnp9vhzk0bw8l.amplifyapp.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST",
}


def _json_response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": dict(_CORS_HEADERS),
        "body": json.dumps(body),
    }


def _json_google_reconnect_required() -> Dict[str, Any]:
    return _json_response(403, {"message": GOOGLE_RECONNECT_MESSAGE})


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


def _dynamodb_table():
    region = os.getenv("AWS_REGION")
    table_name = os.getenv("INTEGRATIONS_TABLE")
    if not table_name:
        raise ValueError("Missing INTEGRATIONS_TABLE env var.")
    dynamodb = boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")
    return dynamodb.Table(table_name)


def _extract_google_connection(item: Dict[str, Any]) -> Dict[str, Any]:
    if not item:
        return {}
    if isinstance(item.get("google"), dict):
        return item.get("google") or {}
    return item


def _fetch_google_connection(user_id: str) -> Optional[Tuple[Dict[str, Any], Dict[str, Any]]]:
    table = _dynamodb_table()

    candidate_keys = [
        {"user_id": user_id, "provider": "google"},
        {"user_id": user_id, "integration_type": "google"},
        {"user_id": user_id},
    ]

    for key in candidate_keys:
        try:
            response = table.get_item(Key=key)
        except Exception:
            continue
        item = response.get("Item")
        if not item:
            continue
        connection = _extract_google_connection(item)
        access_token = connection.get("access_token") or connection.get("accessToken")
        if access_token:
            return item, connection

    return None


def _calendar_list_request(access_token: str) -> Tuple[int, Dict[str, Any]]:
    request = Request(
        GOOGLE_CALENDAR_LIST_URL,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
        },
        method="GET",
    )
    with urlopen(request, timeout=15) as response:
        status = response.getcode() or 200
        raw = response.read().decode("utf-8")
        payload = json.loads(raw) if raw else {}
        return status, payload


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


def _update_connection_tokens(user_id: str, connection: Dict[str, Any], new_tokens: Dict[str, Any]) -> None:
    access_token = new_tokens.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        return

    expires_in = int(new_tokens.get("expires_in") or 3600)
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat()

    table = _dynamodb_table()
    candidate_keys = [
        {"user_id": user_id, "provider": "google"},
        {"user_id": user_id, "integration_type": "google"},
        {"user_id": user_id},
    ]

    for key in candidate_keys:
        try:
            table.update_item(
                Key=key,
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
            return
        except Exception:
            continue


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

    user_id = _extract_cognito_sub(event)
    if not user_id:
        return _json_response(401, {"message": "Missing Cognito user id (sub) in request."})

    try:
        stored = _fetch_google_connection(user_id)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})

    if not stored:
        return _json_response(404, {"message": "Google Calendar is not connected for this user."})

    _, connection = stored
    access_token = connection.get("access_token") or connection.get("accessToken")
    refresh_token = connection.get("refresh_token") or connection.get("refreshToken")
    has_refresh = bool(isinstance(refresh_token, str) and refresh_token.strip())

    if not access_token:
        return _json_response(404, {"message": "Google Calendar is not connected for this user."})

    try:
        _, payload = _calendar_list_request(access_token)
    except HTTPError as err:
        if err.code != 401:
            return _json_response(
                502,
                {"message": f"Google Calendar API request failed with status {err.code}."},
            )

        if not has_refresh:
            return _json_google_reconnect_required()

        try:
            new_tokens = _refresh_access_token(refresh_token)
        except Exception:
            return _json_google_reconnect_required()

        if not new_tokens or not isinstance(new_tokens.get("access_token"), str) or not new_tokens.get("access_token"):
            return _json_response(500, {"message": "Missing Google OAuth client configuration."})

        _update_connection_tokens(user_id, connection, new_tokens)
        refreshed_access_token = connection.get("access_token") or connection.get("accessToken") or ""
        try:
            _, payload = _calendar_list_request(refreshed_access_token)
        except HTTPError as err2:
            if err2.code == 401:
                return _json_google_reconnect_required()
            return _json_response(
                502,
                {"message": f"Google Calendar API request failed with status {err2.code}."},
            )
    except (URLError, TimeoutError):
        return _json_response(502, {"message": "Failed to reach Google Calendar API."})
    except Exception:
        return _json_response(500, {"message": "Unexpected error while fetching calendars."})

    items = payload.get("items") if isinstance(payload, dict) else []
    if not isinstance(items, list):
        items = []

    calendars = []
    for item in items:
        if not isinstance(item, dict):
            continue
        calendars.append(
            {
                "id": item.get("id"),
                "summary": item.get("summary"),
                "primary": bool(item.get("primary")),
                "selected": bool(item.get("selected", True)),
                "backgroundColor": item.get("backgroundColor"),
            }
        )

    return _json_response(200, {"calendars": calendars})