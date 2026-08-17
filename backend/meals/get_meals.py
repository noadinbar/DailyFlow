import json
import os
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

import boto3

APP_TIMEZONE_ID = "Asia/Jerusalem"

_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://main.dnp9vhzk0bw8l.amplifyapp.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,GET",
}


def _json_response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": dict(_CORS_HEADERS),
        "body": json.dumps(body),
    }


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


def _meals_table():
    table_name = os.getenv("MEALS_TABLE")
    if not table_name:
        raise ValueError("Missing MEALS_TABLE env var.")
    region = os.getenv("AWS_REGION")
    dynamodb = boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")
    return dynamodb.Table(table_name)


def _app_today() -> date:
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo(APP_TIMEZONE_ID)).date()
    except Exception:
        return datetime.now(timezone.utc).date()


def _start_of_week_from_date(d: date) -> date:
    return d - timedelta(days=(d.weekday() + 1) % 7)


def _current_week_bounds() -> Tuple[str, str]:
    """Sunday–Saturday in Asia/Jerusalem. Same definition as Overview/Workouts."""
    week_start = _start_of_week_from_date(_app_today())
    week_end = week_start + timedelta(days=6)
    return week_start.isoformat(), week_end.isoformat()


def _legacy_utc_week_start_iso() -> str:
    """Previous Meals week key used UTC Sunday. Kept only to adopt in-week records."""
    return _start_of_week_from_date(datetime.now(timezone.utc).date()).isoformat()


def _to_json_safe(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    if isinstance(value, list):
        return [_to_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(k): _to_json_safe(v) for k, v in value.items()}
    return value


def _safe_string_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    output: List[str] = []
    for item in value:
        if isinstance(item, str):
            cleaned = item.strip()
            if cleaned:
                output.append(cleaned)
    return output


def _safe_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _safe_list_of_dicts(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list):
        return []
    output: List[Dict[str, Any]] = []
    for item in value:
        if isinstance(item, dict):
            output.append(_to_json_safe(item))
    return output


def _raw_dict_list(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _to_dynamodb_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, Decimal):
        return value
    if isinstance(value, dict):
        return {str(k): _to_dynamodb_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_to_dynamodb_safe(v) for v in value]
    return value


def _load_records_for_user(user_id: str, week_key: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    table = _meals_table()
    library = table.get_item(Key={"user_id": user_id, "record_key": "LIBRARY#current"}).get("Item") or {}
    week = table.get_item(Key={"user_id": user_id, "record_key": week_key}).get("Item") or {}
    return library, week


def _meal_id(raw: Any) -> str:
    if not isinstance(raw, dict):
        return ""
    return _safe_string(raw.get("id"))


def _meal_date(raw: Any) -> str:
    if not isinstance(raw, dict):
        return ""
    return _safe_string(raw.get("date"))


def _in_week(day_iso: str, week_start: str, week_end: str) -> bool:
    return bool(day_iso) and week_start <= day_iso <= week_end


def _adopt_legacy_utc_week_if_needed(
    user_id: str,
    canonical_key: str,
    week_item: Dict[str, Any],
    week_start: str,
    week_end: str,
) -> Dict[str, Any]:
    """
    If UTC Sunday still differs from Asia/Jerusalem Sunday, current-week meals may
    live under the old WEEK#{utc_sunday} key. Copy in-week meals onto the canonical
    Jerusalem key without deleting the legacy record.
    """
    legacy_start = _legacy_utc_week_start_iso()
    if legacy_start == week_start:
        return week_item if isinstance(week_item, dict) else {}

    table = _meals_table()
    legacy_item = table.get_item(Key={"user_id": user_id, "record_key": f"WEEK#{legacy_start}"}).get("Item") or {}
    if not isinstance(legacy_item, dict) or not legacy_item:
        return week_item if isinstance(week_item, dict) else {}

    canonical = week_item if isinstance(week_item, dict) else {}
    canonical_meals = _raw_dict_list(canonical.get("saved_meals_this_week"))
    canonical_ids = {_meal_id(meal) for meal in canonical_meals if _meal_id(meal)}
    extras: List[Dict[str, Any]] = []
    for meal in _raw_dict_list(legacy_item.get("saved_meals_this_week")):
        meal_id = _meal_id(meal)
        if not meal_id or meal_id in canonical_ids:
            continue
        if _in_week(_meal_date(meal), week_start, week_end):
            extras.append(meal)
            canonical_ids.add(meal_id)
    if not extras:
        return canonical

    merged_meals = [*canonical_meals, *extras]
    checked_keys = _safe_string_list(canonical.get("checked_grocery_items"))
    for key in _safe_string_list(legacy_item.get("checked_grocery_items")):
        if key not in checked_keys:
            checked_keys.append(key)
    grocery = _raw_dict_list(canonical.get("grocery_list"))
    if not grocery:
        grocery = _raw_dict_list(legacy_item.get("grocery_list"))
    updated_at = _iso_utc_now()
    adopted = {
        "user_id": user_id,
        "record_key": canonical_key,
        "saved_meals_this_week": merged_meals,
        "grocery_list": grocery,
        "checked_grocery_items": checked_keys,
        "updated_at": updated_at,
    }
    table.put_item(Item=_to_dynamodb_safe(adopted))
    return adopted


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    request_context = event.get("requestContext") or {}
    http = request_context.get("http") or {}
    method = (http.get("method") or event.get("httpMethod") or "").upper()

    if method == "OPTIONS":
        return {"statusCode": 200, "headers": dict(_CORS_HEADERS), "body": ""}

    if method != "GET":
        return _json_response(405, {"message": "Method not allowed."})

    user_id = _extract_cognito_sub(event)
    if not user_id:
        return _json_response(401, {"message": "Missing Cognito user id (sub) in request."})

    week_start_iso, week_end_iso = _current_week_bounds()
    week_key = f"WEEK#{week_start_iso}"

    try:
        library_item, week_item = _load_records_for_user(user_id, week_key)
        week_item = _adopt_legacy_utc_week_if_needed(
            user_id, week_key, week_item, week_start_iso, week_end_iso
        )
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception:
        return _json_response(500, {"message": "Unexpected error while loading meals state."})

    response_body = {
        "meal_library": _safe_list_of_dicts(library_item.get("meal_library")),
        "favorite_meals": _safe_string_list(library_item.get("favorite_meals")),
        "saved_meals_this_week": _safe_list_of_dicts(week_item.get("saved_meals_this_week")),
        "grocery_list": _safe_list_of_dicts(week_item.get("grocery_list")),
        "checked_grocery_items": _safe_string_list(week_item.get("checked_grocery_items")),
        "metadata": {
            "week_record_key": week_key,
            "week_start": week_start_iso,
            "week_end": week_end_iso,
            "library_record_key": "LIBRARY#current",
            "updated_at": _safe_string(week_item.get("updated_at"))
            or _safe_string(library_item.get("updated_at"))
            or _iso_utc_now(),
        },
    }
    return _json_response(200, response_body)
