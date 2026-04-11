import os
from typing import Any, Dict, Optional
from urllib.parse import urlencode

import boto3

try:
    from .google_oauth_state import build_oauth_state
except ImportError:
    from google_oauth_state import build_oauth_state

GOOGLE_AUTH_BASE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"


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


def _parse_query(event: Dict[str, Any]) -> Dict[str, str]:
    qs = event.get("queryStringParameters") or {}
    if not isinstance(qs, dict):
        return {}
    out: Dict[str, str] = {}
    for key, value in qs.items():
        if value is None:
            continue
        if isinstance(value, str):
            out[str(key)] = value
    return out


def _cognito_sub_from_access_token(access_token: str) -> Optional[str]:
    try:
        client = boto3.client("cognito-idp")
        resp = client.get_user(AccessToken=access_token)
        for attr in resp.get("UserAttributes") or []:
            if attr.get("Name") == "sub" and attr.get("Value"):
                value = str(attr["Value"]).strip()
                if value:
                    return value
    except Exception:
        return None
    return None


def _redirect(status_code: int, location: str) -> Dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {
            "Location": location,
            "Cache-Control": "no-store",
        },
        "body": "",
    }


def _frontend_calendar_url_with_query(query: str) -> str:
    base = os.getenv("FRONTEND_APP_URL", "").strip().rstrip("/")
    if not base:
        return f"/calendar{query}"
    return f"{base}/calendar{query}"


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    client_id = os.getenv("GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET", "").strip()
    redirect_uri = os.getenv("GOOGLE_REDIRECT_URI", "").strip()

    if not client_id or not client_secret or not redirect_uri:
        return _redirect(
            302,
            _frontend_calendar_url_with_query("?google_oauth_error=start_config"),
        )

    qs = _parse_query(event)
    access_token = (qs.get("access_token") or "").strip()

    user_id = _extract_cognito_sub(event)
    if not user_id and access_token:
        user_id = _cognito_sub_from_access_token(access_token)

    if not user_id:
        return _redirect(
            302,
            _frontend_calendar_url_with_query("?google_oauth_error=start_auth"),
        )

    state = build_oauth_state(user_id, client_secret)
    query = urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": GOOGLE_CALENDAR_SCOPE,
            "access_type": "offline",
            "include_granted_scopes": "true",
            "state": state,
        }
    )
    authorization_url = f"{GOOGLE_AUTH_BASE_URL}?{query}"

    return _redirect(302, authorization_url)
