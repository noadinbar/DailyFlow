"""
GET /stress/activities — load persisted Timed + Flexible library and favorites.
PATCH /stress/activities — mutate library state (currently: toggle_favorite).

Meals-style: favorites are an action on the library resource, not a dedicated
favorites-only Lambda/route.

Uses StressBreaksLibrary only (no Users dependency).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, Optional

_STRESS_DIR = str(Path(__file__).resolve().parent)
if _STRESS_DIR not in sys.path:
    sys.path.insert(0, _STRESS_DIR)

from activity_model import (  # noqa: E402
    favorite_key_from_item,
    iso_utc_now,
    json_safe,
    library_table,
    load_library_item,
    normalize_activity_list,
    normalize_favorite_activity,
    normalize_favorites,
    to_dynamodb_safe,
)

_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://main.dnp9vhzk0bw8l.amplifyapp.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,GET,PATCH",
}


def _json_response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {"statusCode": status_code, "headers": dict(_CORS_HEADERS), "body": json.dumps(json_safe(body))}


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


def _handle_get(user_id: str) -> Dict[str, Any]:
    try:
        item = load_library_item(user_id)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception as err:
        print(f"[stress-activities] load failed: {err}")
        return _json_response(503, {"message": "Could not load Stress & Breaks library. Try again shortly."})

    timed = normalize_activity_list(item.get("timed_activities"), kind="timed")
    flexible = normalize_activity_list(item.get("flexible_activities"), kind="flexible")
    favorites = normalize_favorites(item.get("favorite_activities"))
    generated_at = item.get("generated_at")
    updated_at = item.get("updated_at")

    return _json_response(
        200,
        {
            "timed_activities": timed,
            "flexible_activities": flexible,
            "favorite_activities": favorites,
            "has_library": bool(timed or flexible),
            "generated_at": generated_at if isinstance(generated_at, str) else None,
            "updated_at": updated_at if isinstance(updated_at, str) else None,
        },
    )


def _handle_toggle_favorite(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    activity = payload.get("activity")
    if not isinstance(activity, dict):
        return _json_response(400, {"message": "activity object is required."})

    normalized = normalize_favorite_activity(activity)
    if not normalized:
        return _json_response(400, {"message": "Invalid activity payload for favorite toggle."})

    try:
        existing = load_library_item(user_id)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception as err:
        print(f"[stress-activities] favorites load failed: {err}")
        return _json_response(503, {"message": "Could not update favorites. Try again shortly."})

    favorites = normalize_favorites(existing.get("favorite_activities"))
    favorite_key = str(normalized.get("favorite_key", "")).strip() or favorite_key_from_item(normalized)
    normalized["favorite_key"] = favorite_key

    existing_keys = {str(item.get("favorite_key", "")).strip(): item for item in favorites}
    if favorite_key in existing_keys:
        favorites = [item for item in favorites if str(item.get("favorite_key", "")).strip() != favorite_key]
        is_favorite = False
    else:
        favorites.append(normalized)
        is_favorite = True

    updated_at = iso_utc_now()
    try:
        library_table().update_item(
            Key={"user_id": user_id},
            UpdateExpression="SET favorite_activities = :favorites, updated_at = :updated_at",
            ExpressionAttributeValues=to_dynamodb_safe(
                {
                    ":favorites": favorites,
                    ":updated_at": updated_at,
                }
            ),
        )
    except Exception as err:
        print(f"[stress-activities] favorites save failed: {err}")
        return _json_response(503, {"message": "Could not update favorites. Try again shortly."})

    return _json_response(
        200,
        {
            "favorite_activities": favorites,
            "toggled_favorite_key": favorite_key,
            "is_favorite": is_favorite,
            "updated_at": updated_at,
        },
    )


def _handle_patch(user_id: str, event: Dict[str, Any]) -> Dict[str, Any]:
    try:
        payload = _parse_body(event)
    except json.JSONDecodeError:
        return _json_response(400, {"message": "Request body must be valid JSON."})

    action = str(payload.get("action") or "").strip()
    if action == "toggle_favorite":
        return _handle_toggle_favorite(user_id, payload)
    return _json_response(400, {"message": "Unknown action. Use toggle_favorite."})


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    request_context = event.get("requestContext") or {}
    http = request_context.get("http") or {}
    method = (http.get("method") or event.get("httpMethod") or "").upper()

    if method == "OPTIONS":
        return {"statusCode": 200, "headers": dict(_CORS_HEADERS), "body": ""}

    user_id = _extract_cognito_sub(event)
    if not user_id:
        return _json_response(401, {"message": "Missing Cognito user id (sub) in request."})

    if method == "GET":
        return _handle_get(user_id)
    if method == "PATCH":
        return _handle_patch(user_id, event)
    return _json_response(405, {"message": "Method not allowed."})
