import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import boto3

_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://main.dnp9vhzk0bw8l.amplifyapp.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,PATCH",
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


def _meals_table():
    table_name = os.getenv("MEALS_TABLE")
    if not table_name:
        raise ValueError("Missing MEALS_TABLE env var.")
    region = os.getenv("AWS_REGION")
    dynamodb = boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")
    return dynamodb.Table(table_name)


def _normalize_allergies(value: Any) -> List[str]:
    if isinstance(value, list):
        output: List[str] = []
        for item in value:
            if not isinstance(item, str):
                continue
            cleaned = item.strip()
            if cleaned:
                output.append(cleaned)
        return output
    if isinstance(value, str):
        parts = [part.strip() for part in value.split(",")]
        return [part for part in parts if part]
    return []


def _normalize_budget_level(value: Any) -> str:
    if not isinstance(value, str):
        return "Medium"
    cleaned = value.strip()
    if cleaned in {"Low", "Medium", "High"}:
        return cleaned
    return "Medium"


def _normalize_goal(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    request_context = event.get("requestContext") or {}
    http = request_context.get("http") or {}
    method = (http.get("method") or event.get("httpMethod") or "").upper()

    if method == "OPTIONS":
        return {"statusCode": 200, "headers": dict(_CORS_HEADERS), "body": ""}

    if method != "PATCH":
        return _json_response(405, {"message": "Method not allowed."})

    user_id = _extract_cognito_sub(event)
    if not user_id:
        return _json_response(401, {"message": "Missing Cognito user id (sub) in request."})

    try:
        payload = _parse_body(event)
    except json.JSONDecodeError:
        return _json_response(400, {"message": "Request body must be valid JSON."})

    allergies = _normalize_allergies(payload.get("allergies"))
    budget_level = _normalize_budget_level(payload.get("budget_level"))
    goal = _normalize_goal(payload.get("goal"))
    updated_at = _iso_utc_now()

    try:
        table = _meals_table()
        table.put_item(
            Item={
                "user_id": user_id,
                "record_key": "PREFERENCES",
                "allergies": allergies,
                "budget_level": budget_level,
                "goal": goal,
                "updated_at": updated_at,
            }
        )
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception:
        return _json_response(500, {"message": "Unexpected error while saving meal preferences."})

    return _json_response(
        200,
        {
            "meal_preferences": {
                "allergies": allergies,
                "budget_level": budget_level,
                "goal": goal,
                "updated_at": updated_at,
            }
        },
    )
