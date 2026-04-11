import base64
import hashlib
import hmac
import json
import time
from typing import Optional


def build_oauth_state(cognito_sub: str, signing_secret: str, ttl_seconds: int = 600) -> str:
    payload = {"sub": cognito_sub, "exp": int(time.time()) + ttl_seconds}
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    b64 = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    sig = hmac.new(signing_secret.encode("utf-8"), b64.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{b64}.{sig}"


def verify_oauth_state(state: str, signing_secret: str) -> Optional[str]:
    if not state or "." not in state:
        return None
    b64, sig = state.rsplit(".", 1)
    if not b64 or not sig or len(sig) != 64:
        return None
    expected = hmac.new(signing_secret.encode("utf-8"), b64.encode("ascii"), hashlib.sha256).hexdigest()
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
    if int(data.get("exp") or 0) < int(time.time()):
        return None
    sub = data.get("sub")
    if isinstance(sub, str) and sub.strip():
        return sub.strip()
    return None
