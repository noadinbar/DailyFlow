import json
import os
import secrets
import time
from typing import Any, Dict
from urllib.parse import urlencode


GOOGLE_AUTH_BASE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    client_id = os.getenv("GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET", "").strip()
    redirect_uri = os.getenv("GOOGLE_REDIRECT_URI", "").strip()

    # Client secret is not sent in the start URL, but must exist for the next OAuth step.
    if not client_id or not client_secret or not redirect_uri:
        return {
            "statusCode": 500,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps(
                {
                    "message": (
                        "Missing required Google OAuth env vars. "
                        "Expected GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI."
                    )
                }
            ),
        }

    state = f"{int(time.time())}.{secrets.token_urlsafe(24)}"
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

    return {
        "statusCode": 302,
        "headers": {
            "Location": authorization_url,
            "Cache-Control": "no-store",
        },
        "body": "",
    }
