import json
import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

import boto3

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


def _start_of_week_iso_utc() -> str:
    now_utc = datetime.now(timezone.utc)
    week_start = (now_utc - timedelta(days=(now_utc.weekday() + 1) % 7)).date()
    return week_start.isoformat()


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


def _safe_budget_level(value: Any) -> str:
    if not isinstance(value, str):
        return "Medium"
    cleaned = value.strip()
    if cleaned in {"Low", "Medium", "High"}:
        return cleaned
    return "Medium"


def _safe_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _safe_goals(value: Any, fallback_goal: Any = "") -> List[str]:
    goals = _safe_string_list(value)
    if goals:
        return goals
    single = _safe_string(fallback_goal)
    return [single] if single else []


def _safe_list_of_dicts(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list):
        return []
    output: List[Dict[str, Any]] = []
    for item in value:
        if isinstance(item, dict):
            output.append(_to_json_safe(item))
    return output


def _load_records_for_user(user_id: str, week_key: str) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    table = _meals_table()
    pref = table.get_item(Key={"user_id": user_id, "record_key": "PREFERENCES"}).get("Item") or {}
    library = table.get_item(Key={"user_id": user_id, "record_key": "LIBRARY#current"}).get("Item") or {}
    week = table.get_item(Key={"user_id": user_id, "record_key": week_key}).get("Item") or {}
    return pref, library, week


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

    week_start_iso = _start_of_week_iso_utc()
    week_key = f"WEEK#{week_start_iso}"

    try:
        pref_item, library_item, week_item = _load_records_for_user(user_id, week_key)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception:
        return _json_response(500, {"message": "Unexpected error while loading meals state."})

    week_end_iso = (datetime.fromisoformat(week_start_iso).date() + timedelta(days=6)).isoformat()

    response_body = {
        "meal_preferences": {
            "allergies": _safe_string_list(pref_item.get("allergies")),
            "budget_level": _safe_budget_level(pref_item.get("budget_level")),
            "goals": _safe_goals(pref_item.get("goals"), pref_item.get("goal")),
            "goal": _safe_string(pref_item.get("goal")),
            "updated_at": _safe_string(pref_item.get("updated_at")),
        },
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
            or _safe_string(pref_item.get("updated_at"))
            or _iso_utc_now(),
        },
    }
    return _json_response(200, response_body)
