import base64
import hashlib
import hmac
import json
import time
from typing import Any, Dict, Optional
from urllib.parse import parse_qsl


def parse_lambda_query_params(event: Dict[str, Any]) -> Dict[str, str]:
    """
    Normalize query params for API Gateway HTTP API (v2) and REST proxy integrations.

    Prefer rawQueryString + parse_qsl so Google OAuth `code` / `state` match the exact
    bytes Google sent (avoids list-shaped queryStringParameters or partial maps).
    """
    raw = event.get("rawQueryString")
    if isinstance(raw, str) and raw.strip():
        out: Dict[str, str] = {}
        for key, value in parse_qsl(raw.strip(), keep_blank_values=False, strict_parsing=False):
            if value is None or value == "":
                continue
            out[str(key)] = value
        if out:
            return out

    out = {}
    qs = event.get("queryStringParameters") or {}
    if not isinstance(qs, dict):
        return out
    for key, value in qs.items():
        if value is None:
            continue
        if isinstance(value, list):
            if len(value) == 0:
                continue
            out[str(key)] = str(value[0])
        elif isinstance(value, str):
            out[str(key)] = value
    return out


def build_oauth_state(cognito_sub: str, signing_secret: str, ttl_seconds: int = 7200) -> str:
    secret = (signing_secret or "").strip()
    if not secret:
        raise ValueError("Missing signing secret for OAuth state.")
    payload = {"sub": cognito_sub, "exp": int(time.time()) + ttl_seconds}
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    b64 = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    sig = hmac.new(secret.encode("utf-8"), b64.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{b64}.{sig}"


def verify_oauth_state(state: str, signing_secret: str) -> Optional[str]:
    secret = (signing_secret or "").strip()
    if not secret:
        return None
    if not state or "." not in state:
        return None
    b64, sig = state.rsplit(".", 1)
    if not b64 or not sig or len(sig) != 64:
        return None
    expected = hmac.new(secret.encode("utf-8"), b64.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        return None
    pad = "=" * (-len(b64) % 4)
    try:
        raw = base64.urlsafe_b64decode(b64 + pad)
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    exp = int(data.get("exp") or 0)
    now = int(time.time())
    # Small grace for clock skew between services / long consent screens.
    if now > exp + 300:
        return None
    sub = data.get("sub")
    if isinstance(sub, str) and sub.strip():
        return sub.strip()
    return None
