import json
import os
from typing import Any, Dict, Optional
from urllib.parse import urlencode

from .google_oauth_state import build_oauth_state

GOOGLE_AUTH_BASE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"

_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://main.dnp9vhzk0bw8l.amplifyapp.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST",
}


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

    client_id = os.getenv("GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET", "").strip()
    redirect_uri = os.getenv("GOOGLE_REDIRECT_URI", "").strip()

    if not client_id or not client_secret or not redirect_uri:
        return {
            "statusCode": 500,
            "headers": dict(_CORS_HEADERS),
            "body": json.dumps(
                {
                    "message": (
                        "Missing required Google OAuth env vars. "
                        "Expected GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI."
                    )
                }
            ),
        }

    user_id = _extract_cognito_sub(event)
    if not user_id:
        return {
            "statusCode": 401,
            "headers": dict(_CORS_HEADERS),
            "body": json.dumps({"message": "Missing Cognito user id (sub) in request."}),
        }

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

    # JSON response so the browser can send Authorization (full-page navigation cannot).
    return {
        "statusCode": 200,
        "headers": {**_CORS_HEADERS, "Cache-Control": "no-store"},
        "body": json.dumps({"authorizationUrl": authorization_url}),
    }
