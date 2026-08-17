"""
GET /overview — read-only current-week Summary data.
PATCH /overview — persist Overview-only workout completion for the current week.

Week bounds are Sunday–Saturday, computed from the current date in the
DailyFlow app timezone (Asia/Jerusalem), matching Google Calendar event times.
Overview never mutates Workouts, Meals, Stress, or Google Calendar state.
Completion is stored on the Users item, not on WorkoutLibrary plan items.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import boto3
from boto3.dynamodb.conditions import Key

_HERE = Path(__file__).resolve().parent
for candidate in (_HERE, _HERE.parent / "stress"):
    path = str(candidate)
    if path not in sys.path:
        sys.path.insert(0, path)

from stressful_periods import build_stressful_periods_insights  # noqa: E402

APP_TIMEZONE_ID = "Asia/Jerusalem"
WORKOUT_LIBRARY_DEFAULT_TABLE = "WorkoutLibrary"
STRESS_BREAKS_LIBRARY_DEFAULT_TABLE = "StressBreaksLibrary"
DAY_NAMES = (
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
)

_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://main.dnp9vhzk0bw8l.amplifyapp.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,GET,PATCH",
}


def _json_safe(value: Any) -> Any:
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, Decimal):
        as_float = float(value)
        return int(as_float) if as_float.is_integer() else as_float
    return value


def _json_response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": dict(_CORS_HEADERS),
        "body": json.dumps(_json_safe(body)),
    }


def _iso_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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


def _dynamodb_resource():
    region = os.getenv("AWS_REGION")
    return boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")


def _table(env_name: str, default_name: str = "") -> Any:
    table_name = (os.getenv(env_name) or default_name).strip()
    if not table_name:
        raise ValueError(f"Missing {env_name} env var.")
    return _dynamodb_resource().Table(table_name)


def _current_date_in_app_timezone() -> date:
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo(APP_TIMEZONE_ID)).date()
    except Exception:
        return datetime.now(timezone.utc).date()


def current_week_bounds(today: Optional[date] = None) -> Tuple[str, str]:
    """Sunday–Saturday ISO dates for the week containing `today` in Asia/Jerusalem."""
    now_d = today or _current_date_in_app_timezone()
    week_start = now_d - timedelta(days=(now_d.weekday() + 1) % 7)
    week_end = week_start + timedelta(days=6)
    return week_start.isoformat(), week_end.isoformat()


def _legacy_utc_week_start_iso() -> str:
    """Previous Meals week key used UTC Sunday. Read-only fallback for in-week meals."""
    now_utc = datetime.now(timezone.utc).date()
    return (now_utc - timedelta(days=(now_utc.weekday() + 1) % 7)).isoformat()


def _to_int(value: Any, default: int) -> int:
    if isinstance(value, Decimal):
        try:
            return int(value)
        except Exception:
            return default
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else default
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return default
        try:
            return int(raw)
        except Exception:
            return default
    return default


def _safe_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _hh_mm(value: Any) -> str:
    raw = _safe_string(value)
    if len(raw) >= 5 and raw[2] == ":":
        return raw[:5]
    return raw


def _in_week(day_iso: str, week_start: str, week_end: str) -> bool:
    return bool(day_iso) and week_start <= day_iso <= week_end


def _has_google_event(item: Dict[str, Any]) -> bool:
    return bool(_safe_string(item.get("google_event_id")))


def _day_label(iso_day: str) -> str:
    try:
        return DAY_NAMES[date.fromisoformat(iso_day).weekday()]
    except Exception:
        return iso_day


def _users_item(user_id: str) -> Dict[str, Any]:
    item = _table("USERS_TABLE").get_item(Key={"user_id": user_id}, ConsistentRead=True).get("Item") or {}
    return item if isinstance(item, dict) else {}


def _weekly_goal_from_users(item: Dict[str, Any]) -> int:
    # Same clamp Workouts uses when reading Users.workouts_per_week.
    return max(1, min(7, _to_int(item.get("workouts_per_week"), 3)))


def _completed_ids_for_week(users_item: Dict[str, Any], week_start: str) -> List[str]:
    raw = users_item.get("overview_completed_workouts")
    if not isinstance(raw, dict):
        return []
    if _safe_string(raw.get("week_start")) != week_start:
        return []
    ids = raw.get("completed_ids")
    if not isinstance(ids, list):
        return []
    out: List[str] = []
    for value in ids:
        cleaned = _safe_string(value)
        if cleaned and cleaned not in out:
            out.append(cleaned)
    return out


def _apply_completed_flags(scheduled: List[Dict[str, Any]], completed_ids: List[str]) -> List[Dict[str, Any]]:
    completed_set = set(completed_ids)
    for item in scheduled:
        item["completed"] = _safe_string(item.get("id")) in completed_set
    return scheduled


def _stress_preferences_from_users(item: Dict[str, Any]) -> Dict[str, Any]:
    def _list(attr: str) -> List[str]:
        raw = item.get(attr)
        if not isinstance(raw, list):
            return []
        out: List[str] = []
        for value in raw:
            if isinstance(value, str) and value.strip() and value.strip() not in out:
                out.append(value.strip())
        return out

    return {
        "questionnaire_completed": item.get("stress_breaks_questionnaire_completed") is True,
        "busiest_times": _list("stress_breaks_busiest_times"),
        "busiest_days": _list("stress_breaks_busiest_days"),
        "busy_day_factors": _list("stress_breaks_busy_day_factors"),
        "preferred_activities": _list("stress_breaks_preferred_activities"),
        "durations": _list("stress_breaks_durations"),
    }


def _parse_hh_mm_time(value: str) -> Optional[time]:
    raw = str(value or "").strip()
    if len(raw) < 5:
        return None
    try:
        hour = int(raw[0:2])
        minute = int(raw[3:5])
        if hour < 0 or hour > 23 or minute < 0 or minute > 59:
            return None
        return time(hour, minute)
    except Exception:
        return None


def _query_busy_blocks(user_id: str, week_start: str, week_end: str) -> List[Dict[str, Any]]:
    table = _table("BUSY_BLOCKS_TABLE")
    items: List[Dict[str, Any]] = []
    last_evaluated_key: Optional[Dict[str, Any]] = None
    while True:
        query_args: Dict[str, Any] = {"KeyConditionExpression": Key("user_id").eq(user_id)}
        if last_evaluated_key:
            query_args["ExclusiveStartKey"] = last_evaluated_key
        response = table.query(**query_args)
        for item in response.get("Items") or []:
            if not isinstance(item, dict):
                continue
            block_date = _safe_string(item.get("date"))
            if not _in_week(block_date, week_start, week_end):
                continue
            start_time = _safe_string(item.get("start_time"))
            end_time = _safe_string(item.get("end_time"))
            if not _parse_hh_mm_time(start_time) or not _parse_hh_mm_time(end_time):
                continue
            items.append({"date": block_date, "start_time": start_time, "end_time": end_time})
        last_evaluated_key = response.get("LastEvaluatedKey")
        if not last_evaluated_key:
            break
    items.sort(key=lambda row: (row["date"], row["start_time"], row["end_time"]))
    return items


def _library_categories(item: Dict[str, Any]) -> List[str]:
    cats: List[str] = []
    for raw in list(item.get("timed_activities") or []) + list(item.get("flexible_activities") or []):
        if not isinstance(raw, dict):
            continue
        category = _safe_string(raw.get("category"))
        if category and category not in cats:
            cats.append(category)
    return cats


def _scheduled_workouts(user_id: str, week_start: str, week_end: str) -> List[Dict[str, Any]]:
    item = (
        _table("WORKOUT_LIBRARY_TABLE", WORKOUT_LIBRARY_DEFAULT_TABLE)
        .get_item(Key={"user_id": user_id})
        .get("Item")
        or {}
    )
    if not isinstance(item, dict):
        return []
    saved_start = _safe_string(item.get("current_week_plan_week_start"))
    saved_end = _safe_string(item.get("current_week_plan_week_end"))
    if saved_start != week_start or saved_end != week_end:
        return []

    library_by_id: Dict[str, Dict[str, Any]] = {}
    for raw in item.get("workout_library") or []:
        if not isinstance(raw, dict):
            continue
        lib_id = _safe_string(raw.get("id"))
        if lib_id:
            library_by_id[lib_id] = raw

    scheduled: List[Dict[str, Any]] = []
    for raw in item.get("current_week_plan") or []:
        if not isinstance(raw, dict) or not _has_google_event(raw):
            continue
        plan_id = _safe_string(raw.get("id"))
        rec_day = _safe_string(raw.get("recommended_day"))
        start_time = _hh_mm(raw.get("recommended_start_time"))
        if not plan_id or not _in_week(rec_day, week_start, week_end) or not start_time:
            continue
        lib = library_by_id.get(_safe_string(raw.get("library_workout_id"))) or {}
        title = _safe_string(lib.get("title")) or "Workout"
        scheduled.append(
            {
                "id": plan_id,
                "title": title,
                "date": rec_day,
                "start_time": start_time,
            }
        )
    scheduled.sort(key=lambda row: (row["date"], row["start_time"], row["id"]))
    return scheduled


def _scheduled_meals_count(user_id: str, week_start: str, week_end: str) -> int:
    week_keys = [f"WEEK#{week_start}"]
    legacy_start = _legacy_utc_week_start_iso()
    if legacy_start != week_start:
        week_keys.append(f"WEEK#{legacy_start}")
    seen_ids = set()
    count = 0
    meals_table = _table("MEALS_TABLE")
    for week_key in week_keys:
        week_item = meals_table.get_item(Key={"user_id": user_id, "record_key": week_key}).get("Item") or {}
        if not isinstance(week_item, dict):
            continue
        for raw in week_item.get("saved_meals_this_week") or []:
            if not isinstance(raw, dict) or not _has_google_event(raw):
                continue
            meal_id = _safe_string(raw.get("id"))
            meal_date = _safe_string(raw.get("date"))
            if meal_id and meal_id in seen_ids:
                continue
            if not _in_week(meal_date, week_start, week_end):
                continue
            if meal_id:
                seen_ids.add(meal_id)
            count += 1
    return count


def _scheduled_breaks_count(item: Dict[str, Any], week_start: str, week_end: str) -> int:
    saved_start = _safe_string(item.get("current_week_plan_week_start"))
    saved_end = _safe_string(item.get("current_week_plan_week_end"))
    if saved_start != week_start or saved_end != week_end:
        return 0
    count = 0
    for raw in item.get("current_week_plan") or []:
        if not isinstance(raw, dict) or not _has_google_event(raw):
            continue
        rec_day = _safe_string(raw.get("recommended_day"))
        if _in_week(rec_day, week_start, week_end):
            count += 1
    return count


def _busy_days(
    *,
    user_id: str,
    week_start: str,
    week_end: str,
    library_item: Dict[str, Any],
    preferences: Dict[str, Any],
) -> List[Dict[str, str]]:
    try:
        busy_blocks = _query_busy_blocks(user_id, week_start, week_end)
    except Exception as err:
        print(f"[overview] busyblocks query failed: {err}")
        busy_blocks = []
    payload = build_stressful_periods_insights(
        week_start=week_start,
        week_end=week_end,
        busy_blocks=busy_blocks,
        preferences=preferences,
        library_categories=_library_categories(library_item),
    )
    seen: Dict[str, str] = {}
    for insight in payload.get("insights") or []:
        if not isinstance(insight, dict):
            continue
        iso_day = _safe_string(insight.get("day"))
        if not _in_week(iso_day, week_start, week_end) or iso_day in seen:
            continue
        label = _safe_string(insight.get("day_label")) or _day_label(iso_day)
        seen[iso_day] = label
    return [{"date": iso_day, "day_label": seen[iso_day]} for iso_day in sorted(seen)]


def _handle_get(user_id: str) -> Dict[str, Any]:
    week_start, week_end = current_week_bounds()
    try:
        users_item = _users_item(user_id)
        weekly_goal = _weekly_goal_from_users(users_item)
        scheduled_workouts = _apply_completed_flags(
            _scheduled_workouts(user_id, week_start, week_end),
            _completed_ids_for_week(users_item, week_start),
        )
        meals_count = _scheduled_meals_count(user_id, week_start, week_end)
        stress_item = (
            _table("STRESS_BREAKS_LIBRARY_TABLE", STRESS_BREAKS_LIBRARY_DEFAULT_TABLE)
            .get_item(Key={"user_id": user_id})
            .get("Item")
            or {}
        )
        if not isinstance(stress_item, dict):
            stress_item = {}
        breaks_count = _scheduled_breaks_count(stress_item, week_start, week_end)
        busy_days = _busy_days(
            user_id=user_id,
            week_start=week_start,
            week_end=week_end,
            library_item=stress_item,
            preferences=_stress_preferences_from_users(users_item),
        )
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception:
        return _json_response(500, {"message": "Unexpected error while loading overview."})

    return _json_response(
        200,
        {
            "week_start": week_start,
            "week_end": week_end,
            "workouts": {
                "weekly_goal": weekly_goal,
                "scheduled_count": len(scheduled_workouts),
                "scheduled_items": scheduled_workouts,
            },
            "meals": {
                "scheduled_count": meals_count,
            },
            "stress_breaks": {
                "scheduled_count": breaks_count,
                "busy_days": busy_days,
            },
        },
    )


def _handle_patch_completion(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    workout_id = _safe_string(payload.get("workout_id"))
    completed = payload.get("completed")
    if not workout_id:
        return _json_response(400, {"message": "workout_id is required."})
    if not isinstance(completed, bool):
        return _json_response(400, {"message": "completed must be a boolean."})

    week_start, week_end = current_week_bounds()
    try:
        scheduled = _scheduled_workouts(user_id, week_start, week_end)
        allowed_ids = {_safe_string(item.get("id")) for item in scheduled}
        if workout_id not in allowed_ids:
            return _json_response(
                400,
                {"message": "Workout is not a current-week calendar-linked workout."},
            )
        users_item = _users_item(user_id)
        completed_ids = _completed_ids_for_week(users_item, week_start)
        if completed and workout_id not in completed_ids:
            completed_ids.append(workout_id)
        if not completed:
            completed_ids = [item_id for item_id in completed_ids if item_id != workout_id]
        _table("USERS_TABLE").update_item(
            Key={"user_id": user_id},
            UpdateExpression="SET overview_completed_workouts = :value, updated_at = :updated_at",
            ExpressionAttributeValues={
                ":value": {"week_start": week_start, "completed_ids": completed_ids},
                ":updated_at": _iso_utc_now(),
            },
        )
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception:
        return _json_response(500, {"message": "Unexpected error while saving overview completion."})

    return _json_response(
        200,
        {
            "week_start": week_start,
            "workout_id": workout_id,
            "completed": completed,
        },
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
    if method != "PATCH":
        return _json_response(405, {"message": "Method not allowed."})

    try:
        payload = _parse_body(event)
    except json.JSONDecodeError:
        return _json_response(400, {"message": "Request body must be valid JSON."})
    return _handle_patch_completion(user_id, payload)
