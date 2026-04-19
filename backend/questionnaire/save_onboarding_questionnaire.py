import json
import math
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

import boto3

_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://main.dnp9vhzk0bw8l.amplifyapp.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
}

_ALLOWED_AGE_RANGE: Set[str] = {
    "under_18",
    "age_18_24",
    "age_25_34",
    "age_35_44",
    "age_45_plus",
}
_ALLOWED_STATUS_DAILY_ROUTINE: Set[str] = {
    "student",
    "full_time_job",
    "part_time_job",
    "shift_worker",
    "currently_not_working",
}
_ALLOWED_MAIN_GOAL: Set[str] = {
    "improve_fitness",
    "lose_weight",
    "build_strength",
    "reduce_stress",
    "improve_energy",
    "maintain_routine",
}
_ALLOWED_FITNESS_LEVEL: Set[str] = {"beginner", "intermediate", "advanced"}
_ALLOWED_ACTIVITY: Set[str] = {
    "knee_sensitivity",
    "back_sensitivity",
    "avoid_high_intensity",
    "avoid_high_heart_rate",
    "prefer_low_impact",
    "none",
}
_ALLOWED_WORKOUT_TIMES: Set[str] = {"morning", "noon", "afternoon", "evening", "any_time"}
_ALLOWED_WORKOUT_TYPES: Set[str] = {
    "walking",
    "gym",
    "strength",
    "yoga",
    "pilates",
    "running",
    "stretching",
    "home_workouts",
}
_ALLOWED_DIETARY: Set[str] = {
    "vegan",
    "vegetarian",
    "gluten_free",
    "keto",
    "lactose_intolerant",
    "kosher",
    "no_preferences",
}
_ALLOWED_BREAK_MEDITATION: Set[str] = {
    "break_suggestions",
    "meditation_suggestions",
    "both",
    "not_interested",
}
_ALLOWED_AUTO_SCHEDULE: Set[str] = {"yes", "no", "ask_me_first"}

# Keys accepted on POST /onboarding/questionnaire — only these may be written to the user item.
_QUESTIONNAIRE_KEYS: Set[str] = {
    "age_range",
    "status_daily_routine",
    "main_goal",
    "fitness_level",
    "activity_considerations",
    "workouts_per_week",
    "preferred_workout_times",
    "preferred_workout_types",
    "dietary_preferences",
    "break_meditation_interest",
    "auto_schedule_to_calendar",
}


def _extract_cognito_sub(event: Dict[str, Any]) -> Optional[str]:
    """
    Extract the Cognito stable user identifier (the `sub`) from API Gateway event.
    Works with common Cognito authorizer claim locations.
    """
    request_context = event.get("requestContext") or {}
    authorizer = request_context.get("authorizer") or {}

    # Cognito authorizer (REST API) typically: requestContext.authorizer.claims.sub
    claims = authorizer.get("claims") or {}
    sub = claims.get("sub") or claims.get("cognito:sub")
    if isinstance(sub, str) and sub.strip():
        return sub.strip()

    # Cognito authorizer (HTTP API / JWT authorizer) sometimes: authorizer.jwt.claims.sub
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
        body = body.strip()
        if not body:
            return {}
        return json.loads(body)

    return {}


def _iso_utc_now() -> str:
    # DynamoDB-friendly ISO timestamp in UTC.
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _as_str_list(value: Any, field: str) -> Tuple[Optional[List[str]], Optional[str]]:
    if not isinstance(value, list):
        return None, f"{field} must be a JSON array."
    out: List[str] = []
    for x in value:
        if not isinstance(x, str):
            return None, f"{field} must contain only strings."
        out.append(x)
    return out, None


def _validate_payload(payload: Dict[str, Any]) -> Optional[str]:
    """
    Return an error message if the payload is invalid; otherwise None.
    """
    str_fields: Dict[str, Tuple[str, Set[str]]] = {
        "age_range": ("age_range", _ALLOWED_AGE_RANGE),
        "status_daily_routine": ("status_daily_routine", _ALLOWED_STATUS_DAILY_ROUTINE),
        "main_goal": ("main_goal", _ALLOWED_MAIN_GOAL),
        "fitness_level": ("fitness_level", _ALLOWED_FITNESS_LEVEL),
        "break_meditation_interest": ("break_meditation_interest", _ALLOWED_BREAK_MEDITATION),
        "auto_schedule_to_calendar": ("auto_schedule_to_calendar", _ALLOWED_AUTO_SCHEDULE),
    }
    for key, (label, allowed) in str_fields.items():
        if key not in payload:
            continue
        v = payload.get(key)
        if not isinstance(v, str) or v not in allowed:
            return f"{label} must be one of: {', '.join(sorted(allowed))}."

    if "activity_considerations" in payload:
        lst, err = _as_str_list(payload.get("activity_considerations"), "activity_considerations")
        if err:
            return err
        assert lst is not None
        if not lst:
            return "activity_considerations cannot be empty."
        bad = [x for x in lst if x not in _ALLOWED_ACTIVITY]
        if bad:
            return "activity_considerations contains invalid values."
        if "none" in lst and len(lst) > 1:
            return "activity_considerations: when none is selected, it must be the only selection."

    if "preferred_workout_times" in payload:
        lst, err = _as_str_list(payload.get("preferred_workout_times"), "preferred_workout_times")
        if err:
            return err
        assert lst is not None
        if not lst:
            return "preferred_workout_times cannot be empty."
        bad = [x for x in lst if x not in _ALLOWED_WORKOUT_TIMES]
        if bad:
            return "preferred_workout_times contains invalid values."
        if "any_time" in lst and len(lst) > 1:
            return "preferred_workout_times: when any_time is selected, it must be the only time."

    if "preferred_workout_types" in payload:
        lst, err = _as_str_list(payload.get("preferred_workout_types"), "preferred_workout_types")
        if err:
            return err
        assert lst is not None
        if not lst:
            return "preferred_workout_types cannot be empty."
        bad = [x for x in lst if x not in _ALLOWED_WORKOUT_TYPES]
        if bad:
            return "preferred_workout_types contains invalid values."

    if "dietary_preferences" in payload:
        lst, err = _as_str_list(payload.get("dietary_preferences"), "dietary_preferences")
        if err:
            return err
        assert lst is not None
        if not lst:
            return "dietary_preferences cannot be empty."
        bad = [x for x in lst if x not in _ALLOWED_DIETARY]
        if bad:
            return "dietary_preferences contains invalid values."
        if "no_preferences" in lst and len(lst) > 1:
            return "dietary_preferences: when no_preferences is selected, it must be the only preference."

    if "workouts_per_week" in payload:
        w_err = _validate_workouts_per_week(payload.get("workouts_per_week"))
        if w_err:
            return w_err

    return None


def _validate_workouts_per_week(value: Any) -> Optional[str]:
    """Non-negative integer only (persisted as DynamoDB Number / int)."""
    if isinstance(value, bool):
        return "workouts_per_week must be an integer."
    if isinstance(value, int) and not isinstance(value, bool):
        if value < 0:
            return "workouts_per_week must be a non-negative integer."
        return None
    if isinstance(value, float):
        if not math.isfinite(value) or value < 0 or not value.is_integer():
            return "workouts_per_week must be a non-negative integer."
        return None
    if isinstance(value, str):
        raw = value.strip()
        if raw == "":
            return "workouts_per_week cannot be empty."
        try:
            num = float(raw)
        except ValueError:
            return "workouts_per_week must be an integer."
        if not math.isfinite(num) or num < 0 or not num.is_integer():
            return "workouts_per_week must be a non-negative integer."
        return None
    return "workouts_per_week must be an integer."


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    request_context = event.get("requestContext") or {}
    http = request_context.get("http") or {}
    method = (http.get("method") or event.get("httpMethod") or "").upper()
    if method == "OPTIONS":
        return {
            "statusCode": 200,
            "headers": dict(_CORS_HEADERS),
            "body": "",
        }

    aws_region = os.getenv("AWS_REGION")
    users_table_name = os.getenv("USERS_TABLE")
    if not users_table_name:
        return {
            "statusCode": 500,
            "headers": dict(_CORS_HEADERS),
            "body": json.dumps({"message": "Missing USERS_TABLE env var."}),
        }

    user_id = _extract_cognito_sub(event)
    if not user_id:
        return {
            "statusCode": 401,
            "headers": dict(_CORS_HEADERS),
            "body": json.dumps({"message": "Missing Cognito user id (sub) in request."}),
        }

    try:
        payload = _parse_body(event)
    except json.JSONDecodeError:
        return {
            "statusCode": 400,
            "headers": dict(_CORS_HEADERS),
            "body": json.dumps({"message": "Request body must be valid JSON."}),
        }

    # Ignore unknown keys so we never persist unrelated client fields onto the user item.
    questionnaire_payload = {k: v for k, v in payload.items() if k in _QUESTIONNAIRE_KEYS}

    err = _validate_payload(questionnaire_payload)
    if err:
        return {
            "statusCode": 400,
            "headers": dict(_CORS_HEADERS),
            "body": json.dumps({"message": err}),
        }

    # Persist questionnaire answers on the user item (DynamoDB document fields).
    field_mapping = {
        "age_range": "age_range",
        "status_daily_routine": "status_daily_routine",
        "main_goal": "main_goal",
        "fitness_level": "fitness_level",
        "activity_considerations": "activity_considerations",
        "workouts_per_week": "workouts_per_week",
        "preferred_workout_times": "preferred_workout_times",
        "preferred_workout_types": "preferred_workout_types",
        "dietary_preferences": "dietary_preferences",
        "break_meditation_interest": "break_meditation_interest",
        "auto_schedule_to_calendar": "auto_schedule_to_calendar",
    }

    set_clauses = []
    expr_attr_values: Dict[str, Any] = {}

    now_iso = _iso_utc_now()

    # Always set completion + updated_at.
    set_clauses.append("questionnaire_completed = :questionnaire_completed")
    expr_attr_values[":questionnaire_completed"] = True

    set_clauses.append("updated_at = :updated_at")
    expr_attr_values[":updated_at"] = now_iso

    for request_key, attribute_name in field_mapping.items():
        if request_key not in questionnaire_payload:
            continue

        value = questionnaire_payload.get(request_key)
        if value is None:
            continue

        if request_key == "workouts_per_week":
            if isinstance(value, bool):
                continue
            if isinstance(value, str):
                value = value.strip()
                if value == "":
                    continue
                value = int(float(value))
            elif isinstance(value, (int, float)) and not isinstance(value, bool):
                value = int(value)

        set_clauses.append(f"{attribute_name} = :{attribute_name}")
        expr_attr_values[f":{attribute_name}"] = value

    update_expression = "SET " + ", ".join(set_clauses)

    dynamodb = boto3.resource("dynamodb", region_name=aws_region) if aws_region else boto3.resource("dynamodb")
    table = dynamodb.Table(users_table_name)

    table.update_item(
        Key={"user_id": user_id},
        UpdateExpression=update_expression,
        ExpressionAttributeValues=expr_attr_values,
    )

    return {
        "statusCode": 200,
        "headers": dict(_CORS_HEADERS),
        "body": json.dumps(
            {
                "message": "Onboarding questionnaire saved.",
                "user_id": user_id,
                "questionnaire_completed": True,
                "updated_at": now_iso,
            }
        ),
    }
