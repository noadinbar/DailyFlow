"""
GET /stress/activities — load Timed + Flexible library, favorites, and weekly plan.
PATCH /stress/activities — mutate library/plan state:
  - toggle_favorite
  - add_library_activity
  - remove_plan_item

Uses StressBreaksLibrary only (no Users / BusyBlocks / Google in Phase 3A).
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

_STRESS_DIR = str(Path(__file__).resolve().parent)
if _STRESS_DIR not in sys.path:
    sys.path.insert(0, _STRESS_DIR)

from activity_model import (  # noqa: E402
    FLEXIBLE_PLAN_DURATIONS,
    add_minutes_hhmm,
    favorite_key_from_item,
    iso_utc_now,
    json_safe,
    library_table,
    load_library_item,
    next_plan_id,
    normalize_activity,
    normalize_activity_list,
    normalize_favorite_activity,
    normalize_favorites,
    normalize_weekly_break_plan,
    parse_hh_mm,
    to_dynamodb_safe,
    to_int,
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


def _today_iso_utc() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _library_payload(item: Dict[str, Any]) -> Dict[str, Any]:
    timed = normalize_activity_list(item.get("timed_activities"), kind="timed")
    flexible = normalize_activity_list(item.get("flexible_activities"), kind="flexible")
    favorites = normalize_favorites(item.get("favorite_activities"))
    weekly_plan = normalize_weekly_break_plan(item.get("current_week_plan"))
    generated_at = item.get("generated_at")
    updated_at = item.get("updated_at")
    week_start = item.get("current_week_plan_week_start")
    week_end = item.get("current_week_plan_week_end")
    return {
        "timed_activities": timed,
        "flexible_activities": flexible,
        "favorite_activities": favorites,
        "weekly_break_plan": weekly_plan,
        "has_library": bool(timed or flexible),
        "generated_at": generated_at if isinstance(generated_at, str) else None,
        "updated_at": updated_at if isinstance(updated_at, str) else None,
        "week_start": week_start if isinstance(week_start, str) else None,
        "week_end": week_end if isinstance(week_end, str) else None,
    }


def _find_library_activity(item: Dict[str, Any], activity_id: str) -> Optional[Dict[str, Any]]:
    for raw in list(item.get("timed_activities") or []) + list(item.get("flexible_activities") or []):
        normalized = normalize_activity(raw)
        if normalized and str(normalized.get("id", "")).strip() == activity_id:
            return normalized
    return None


def _persist_weekly_plan(
    *,
    user_id: str,
    week_start: str,
    week_end: str,
    weekly_plan: List[Dict[str, Any]],
) -> str:
    updated_at = iso_utc_now()
    library_table().update_item(
        Key={"user_id": user_id},
        UpdateExpression=(
            "SET current_week_plan = :plan, "
            "current_week_plan_week_start = :week_start, "
            "current_week_plan_week_end = :week_end, "
            "current_week_plan_updated_at = :plan_updated_at, "
            "updated_at = :updated_at"
        ),
        ExpressionAttributeValues=to_dynamodb_safe(
            {
                ":plan": weekly_plan,
                ":week_start": week_start,
                ":week_end": week_end,
                ":plan_updated_at": updated_at,
                ":updated_at": updated_at,
            }
        ),
    )
    return updated_at


def _handle_get(user_id: str) -> Dict[str, Any]:
    try:
        item = load_library_item(user_id)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception as err:
        print(f"[stress-activities] load failed: {err}")
        return _json_response(503, {"message": "Could not load Stress & Breaks library. Try again shortly."})
    return _json_response(200, _library_payload(item))


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


def _handle_add_library_activity(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    week_start = str(payload.get("week_start", "")).strip()
    week_end = str(payload.get("week_end", "")).strip()
    library_activity_id = str(payload.get("library_activity_id", "")).strip()
    recommended_day = str(payload.get("recommended_day", "")).strip()
    recommended_start_time = str(payload.get("recommended_start_time", "")).strip()
    if not week_start or not week_end or not library_activity_id or not recommended_day or not recommended_start_time:
        return _json_response(
            400,
            {
                "message": (
                    "week_start, week_end, library_activity_id, recommended_day and "
                    "recommended_start_time are required."
                )
            },
        )
    if recommended_day < _today_iso_utc():
        return _json_response(400, {"message": "Cannot add new activities to past dates."})
    if recommended_day < week_start or recommended_day > week_end:
        return _json_response(400, {"message": "Selected day must be inside the visible week."})
    if parse_hh_mm(recommended_start_time) is None:
        return _json_response(400, {"message": "recommended_start_time must be HH:mm (00:00 to 23:59)."})

    try:
        item = load_library_item(user_id)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception as err:
        print(f"[stress-activities] add load failed: {err}")
        return _json_response(503, {"message": "Could not update weekly break plan. Try again shortly."})

    library_item = _find_library_activity(item, library_activity_id)
    if not library_item:
        return _json_response(400, {"message": "Selected library activity does not exist."})

    kind = str(library_item.get("kind", "")).strip().lower()
    if kind == "flexible":
        duration_minutes = to_int(payload.get("duration_minutes"), 0)
        if duration_minutes not in FLEXIBLE_PLAN_DURATIONS:
            return _json_response(
                400,
                {"message": "Flexible activities require duration_minutes of 5, 10, 15, 20, or 30."},
            )
    else:
        duration_minutes = to_int(library_item.get("duration_minutes"), 0)
        if duration_minutes <= 0:
            return _json_response(400, {"message": "Selected activity has invalid duration."})

    recommended_end_time = add_minutes_hhmm(recommended_start_time, duration_minutes)
    if not recommended_end_time or recommended_end_time == "24:00":
        # Keep end within the same calendar day for Phase 3A (no overnight breaks).
        return _json_response(400, {"message": "Activity must end before midnight. Choose an earlier start time."})

    weekly_plan = normalize_weekly_break_plan(item.get("current_week_plan"))
    weekly_plan.append(
        {
            "id": next_plan_id(weekly_plan),
            "library_activity_id": library_activity_id,
            "kind": kind if kind in {"timed", "flexible"} else "timed",
            "title": str(library_item.get("title", "")).strip(),
            "category": str(library_item.get("category", "")).strip(),
            "category_label": str(library_item.get("category_label", "")).strip(),
            "duration_minutes": duration_minutes,
            "recommended_day": recommended_day,
            "recommended_start_time": recommended_start_time,
            "recommended_end_time": recommended_end_time,
            "summary_short": str(library_item.get("summary_short", "")).strip(),
        }
    )
    weekly_plan = normalize_weekly_break_plan(weekly_plan)

    try:
        updated_at = _persist_weekly_plan(
            user_id=user_id,
            week_start=week_start,
            week_end=week_end,
            weekly_plan=weekly_plan,
        )
    except Exception as err:
        print(f"[stress-activities] add save failed: {err}")
        return _json_response(503, {"message": "Could not update weekly break plan. Try again shortly."})

    return _json_response(
        200,
        {
            "weekly_break_plan": weekly_plan,
            "week_start": week_start,
            "week_end": week_end,
            "updated_at": updated_at,
        },
    )


def _handle_remove_plan_item(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    week_start = str(payload.get("week_start", "")).strip()
    week_end = str(payload.get("week_end", "")).strip()
    plan_id = str(payload.get("plan_id", "")).strip()
    if not week_start or not week_end or not plan_id:
        return _json_response(400, {"message": "week_start, week_end and plan_id are required."})

    try:
        item = load_library_item(user_id)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception as err:
        print(f"[stress-activities] remove load failed: {err}")
        return _json_response(503, {"message": "Could not update weekly break plan. Try again shortly."})

    weekly_plan = normalize_weekly_break_plan(item.get("current_week_plan"))
    filtered = [entry for entry in weekly_plan if str(entry.get("id", "")).strip() != plan_id]
    if len(filtered) == len(weekly_plan):
        return _json_response(404, {"message": "Weekly plan item not found."})

    try:
        updated_at = _persist_weekly_plan(
            user_id=user_id,
            week_start=week_start,
            week_end=week_end,
            weekly_plan=filtered,
        )
    except Exception as err:
        print(f"[stress-activities] remove save failed: {err}")
        return _json_response(503, {"message": "Could not update weekly break plan. Try again shortly."})

    return _json_response(
        200,
        {
            "weekly_break_plan": filtered,
            "week_start": week_start,
            "week_end": week_end,
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
    if action == "add_library_activity":
        return _handle_add_library_activity(user_id, payload)
    if action == "remove_plan_item":
        return _handle_remove_plan_item(user_id, payload)
    return _json_response(
        400,
        {"message": "Unknown action. Use toggle_favorite, add_library_activity, or remove_plan_item."},
    )


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
