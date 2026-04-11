import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, quote
from urllib.request import Request, urlopen

import boto3

from .google_oauth_state import verify_oauth_state

GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"


def _frontend_calendar_url() -> str:
    base = os.getenv("FRONTEND_APP_URL", "").strip().rstrip("/")
    if not base:
        return "/calendar"
    return f"{base}/calendar"


def _redirect(status_code: int, location: str) -> Dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {
            "Location": location,
            "Cache-Control": "no-store",
        },
        "body": "",
    }


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


def _iso_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _exchange_code_for_tokens(code: str, client_id: str, client_secret: str, redirect_uri: str) -> Dict[str, Any]:
    body = urlencode(
        {
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
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


def _put_google_tokens(user_id: str, token_payload: Dict[str, Any]) -> None:
    region = os.getenv("AWS_REGION")
    table_name = os.getenv("INTEGRATIONS_TABLE")
    if not table_name:
        raise ValueError("Missing INTEGRATIONS_TABLE env var.")

    access_token = token_payload.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        raise ValueError("Token response missing access_token.")

    refresh_token = token_payload.get("refresh_token")
    expires_in = int(token_payload.get("expires_in") or 3600)
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat()
    now_iso = _iso_utc_now()

    item: Dict[str, Any] = {
        "user_id": user_id,
        "provider": "google",
        "access_token": access_token,
        "accessToken": access_token,
        "token_expires_at": expires_at,
        "updated_at": now_iso,
    }
    if isinstance(refresh_token, str) and refresh_token:
        item["refresh_token"] = refresh_token
        item["refreshToken"] = refresh_token

    dynamodb = boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")
    table = dynamodb.Table(table_name)
    table.put_item(Item=item)


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    client_id = os.getenv("GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET", "").strip()
    redirect_uri = os.getenv("GOOGLE_REDIRECT_URI", "").strip()
    frontend = _frontend_calendar_url()

    if not client_id or not client_secret or not redirect_uri:
        target = f"{frontend}?google_oauth_error=config"
        return _redirect(302, target)

    params = _parse_query(event)
    if params.get("error"):
        target = f"{frontend}?google_oauth_error=access_denied"
        return _redirect(302, target)

    code = (params.get("code") or "").strip()
    state = (params.get("state") or "").strip()
    if not code or not state:
        target = f"{frontend}?google_oauth_error=missing_params"
        return _redirect(302, target)

    user_id = verify_oauth_state(state, client_secret)
    if not user_id:
        target = f"{frontend}?google_oauth_error=invalid_state"
        return _redirect(302, target)

    try:
        tokens = _exchange_code_for_tokens(code, client_id, client_secret, redirect_uri)
    except HTTPError as err:
        target = f"{frontend}?google_oauth_error=token_exchange&status={err.code}"
        return _redirect(302, target)
    except (URLError, TimeoutError, json.JSONDecodeError, ValueError):
        target = f"{frontend}?google_oauth_error=token_exchange"
        return _redirect(302, target)

    try:
        _put_google_tokens(user_id, tokens)
    except ValueError as err:
        target = f"{frontend}?google_oauth_error={quote(str(err))}"
        return _redirect(302, target)
    except Exception:
        target = f"{frontend}?google_oauth_error=storage"
        return _redirect(302, target)

    return _redirect(302, frontend)
