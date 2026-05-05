import json
import os
from datetime import datetime, timezone
from hashlib import sha1
from typing import Any, Dict, List, Optional

import boto3

WORKOUT_LIBRARY_DEFAULT_TABLE_NAME = "WorkoutLibrary"

_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://main.dnp9vhzk0bw8l.amplifyapp.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
}


def _json_response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {"statusCode": status_code, "headers": dict(_CORS_HEADERS), "body": json.dumps(body)}


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


def _dynamodb_resource():
    region = os.getenv("AWS_REGION")
    return boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")


def _workout_library_table():
    table_name = (os.getenv("WORKOUT_LIBRARY_TABLE") or WORKOUT_LIBRARY_DEFAULT_TABLE_NAME).strip()
    if not table_name:
        raise ValueError("WorkoutLibrary table name is missing.")
    return _dynamodb_resource().Table(table_name)


def _to_int(value: Any, default: int) -> int:
    try:
        if isinstance(value, bool):
            return default
        return int(value)
    except Exception:
        return default


def _normalize_type_key(value: Any) -> str:
    return str(value or "").strip().lower().replace(" ", "_")


def _duration_bucket(duration_minutes: int) -> str:
    if duration_minutes <= 20:
        return "10_20"
    if duration_minutes <= 40:
        return "20_40"
    return "40_60"


def _favorite_key_from_item(item: Dict[str, Any]) -> str:
    material = "|".join(
        [
            str(item.get("title", "")).strip().lower(),
            _normalize_type_key(item.get("workout_type")),
            str(_to_int(item.get("duration_minutes"), 0)),
            str(item.get("intensity", "")).strip().lower(),
            str(item.get("location", "")).strip().lower(),
        ]
    )
    return sha1(material.encode("utf-8")).hexdigest()


def _normalize_favorite_workout(raw: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    title = str(raw.get("title", "")).strip()
    workout_type = str(raw.get("workout_type", "")).strip()
    duration_minutes = _to_int(raw.get("duration_minutes"), 0)
    if not title or not workout_type or duration_minutes <= 0:
        return None
    normalized = {
        "favorite_key": str(raw.get("favorite_key", "")).strip(),
        "id": str(raw.get("id", "")).strip() or "",
        "title": title,
        "workout_type": workout_type,
        "duration_minutes": duration_minutes,
        "duration_bucket": str(raw.get("duration_bucket", "")).strip() or _duration_bucket(duration_minutes),
        "intensity": str(raw.get("intensity", "")).strip() or "Moderate",
        "location": str(raw.get("location", "")).strip() or "Home",
        "summary_short": str(raw.get("summary_short", "")).strip() or f"{title} workout.",
        "workout_flow": raw.get("workout_flow") if isinstance(raw.get("workout_flow"), dict) else {},
    }
    normalized["favorite_key"] = normalized["favorite_key"] or _favorite_key_from_item(normalized)
    return normalized


def _normalize_saved_favorites(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    cleaned: List[Dict[str, Any]] = []
    seen = set()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        normalized = _normalize_favorite_workout(entry)
        if not normalized:
            continue
        favorite_key = normalized["favorite_key"]
        if favorite_key in seen:
            continue
        seen.add(favorite_key)
        cleaned.append(normalized)
    return cleaned


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    request_context = event.get("requestContext") or {}
    http = request_context.get("http") or {}
    method = (http.get("method") or event.get("httpMethod") or "").upper()
    if method == "OPTIONS":
        return {"statusCode": 200, "headers": dict(_CORS_HEADERS), "body": ""}
    if method != "POST":
        return _json_response(405, {"message": "Method not allowed."})

    user_id = _extract_cognito_sub(event)
    if not user_id:
        return _json_response(401, {"message": "Missing Cognito user id (sub) in request."})

    try:
        payload = _parse_body(event)
    except json.JSONDecodeError:
        return _json_response(400, {"message": "Request body must be valid JSON."})

    workout = payload.get("workout")
    if not isinstance(workout, dict):
        return _json_response(400, {"message": "workout object is required."})

    normalized = _normalize_favorite_workout(workout)
    if not normalized:
        return _json_response(400, {"message": "Invalid workout payload for favorite toggle."})

    table = _workout_library_table()
    existing = table.get_item(Key={"user_id": user_id}).get("Item") or {"user_id": user_id}
    favorite_workouts = _normalize_saved_favorites(existing.get("favorite_workouts"))
    favorite_key = normalized["favorite_key"]
    is_favorite = False

    existing_by_key = {str(item.get("favorite_key", "")).strip(): item for item in favorite_workouts}
    if favorite_key in existing_by_key:
        favorite_workouts = [item for item in favorite_workouts if item.get("favorite_key") != favorite_key]
        is_favorite = False
    else:
        favorite_workouts.append(normalized)
        is_favorite = True

    updated_at = _iso_utc_now()
    table.update_item(
        Key={"user_id": user_id},
        UpdateExpression="SET favorite_workouts = :favorites, updated_at = :updated_at",
        ExpressionAttributeValues={
            ":favorites": favorite_workouts,
            ":updated_at": updated_at,
        },
    )
    return _json_response(
        200,
        {
            "favorite_workouts": favorite_workouts,
            "toggled_favorite_key": favorite_key,
            "is_favorite": is_favorite,
            "updated_at": updated_at,
        },
    )
