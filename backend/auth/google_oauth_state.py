import base64
import hashlib
import hmac
import json
import time
from typing import Any, Dict, Optional
from urllib.parse import parse_qsl


ALLOWED_RETURN_PATHS = frozenset(
    {
        "/calendar",
        "/meals",
        "/workouts",
        "/stress",
        "/overview",
    }
)
DEFAULT_RETURN_PATH = "/calendar"


def safe_return_to(value: Any) -> str:
    """
    Normalize a user-supplied `return_to` path to a known internal route.

    Returns DEFAULT_RETURN_PATH for missing, empty, malformed, or unknown
    values. Rejects anything that could trigger an open redirect:
    - full URLs with a scheme (`https://...`, `javascript:...`)
    - protocol-relative paths (`//evil.com`)
    - backslash-prefixed paths (`\\evil.com`)
    - values that do not start with `/`
    - values containing whitespace or control characters
    - paths outside the allow-list
    """
    if not isinstance(value, str):
        return DEFAULT_RETURN_PATH
    cleaned = value.strip()
    if not cleaned:
        return DEFAULT_RETURN_PATH
    if any(ch.isspace() or ord(ch) < 0x20 for ch in cleaned):
        return DEFAULT_RETURN_PATH
    if "://" in cleaned:
        return DEFAULT_RETURN_PATH
    if cleaned.startswith("//") or cleaned.startswith("\\"):
        return DEFAULT_RETURN_PATH
    if not cleaned.startswith("/"):
        return DEFAULT_RETURN_PATH
    path = cleaned.split("?", 1)[0].split("#", 1)[0]
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    if path not in ALLOWED_RETURN_PATHS:
        return DEFAULT_RETURN_PATH
    return path


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


def build_oauth_state(
    cognito_sub: str,
    signing_secret: str,
    ttl_seconds: int = 7200,
    return_to: Optional[str] = None,
) -> str:
    secret = (signing_secret or "").strip()
    if not secret:
        raise ValueError("Missing signing secret for OAuth state.")
    payload: Dict[str, Any] = {"sub": cognito_sub, "exp": int(time.time()) + ttl_seconds}
    # Only embed return_to when it resolves to a known internal path. Unknown
    # or malformed inputs fall back to DEFAULT_RETURN_PATH on the read side.
    if return_to is not None:
        payload["return_to"] = safe_return_to(return_to)
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    b64 = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    sig = hmac.new(secret.encode("utf-8"), b64.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{b64}.{sig}"


def verify_oauth_state(state: str, signing_secret: str) -> Optional[Dict[str, Any]]:
    """
    Verify a signed OAuth state token.

    Returns a dict with `sub` and `return_to` when the signature and expiry
    are valid; returns None otherwise. `return_to` is always re-sanitized via
    `safe_return_to`, so callers can use it directly without revalidating.
    Older in-flight states without `return_to` resolve to DEFAULT_RETURN_PATH.
    """
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
    if not isinstance(sub, str) or not sub.strip():
        return None
    return {
        "sub": sub.strip(),
        "return_to": safe_return_to(data.get("return_to")),
    }
