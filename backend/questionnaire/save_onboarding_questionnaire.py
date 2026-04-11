import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import boto3

_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://main.dnp9vhzk0bw8l.amplifyapp.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
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

    # Optional fields: we only update attributes that exist in the payload.
    # Frontend later should send these keys:
    # - gender
    # - dietary_preferences
    # - workouts_per_week
    # - preferred_workout_times
    field_mapping = {
        "gender": "gender",
        "dietary_preferences": "dietary_preferences",
        "workouts_per_week": "workouts_per_week",
        "preferred_workout_times": "preferred_workout_times",
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
        if request_key not in payload:
            continue

        value = payload.get(request_key)
        if value is None:
            continue

        # Light normalization for workouts_per_week, which may arrive as string.
        if request_key == "workouts_per_week":
            if isinstance(value, str):
                value = value.strip()
                if value == "":
                    continue
                # Store as int if possible, else float.
                try:
                    value = int(value)
                except ValueError:
                    value = float(value)

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

