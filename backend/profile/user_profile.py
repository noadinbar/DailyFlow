import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import boto3

_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://main.dnp9vhzk0bw8l.amplifyapp.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,GET,PATCH",
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


def _users_table():
    region = os.getenv("AWS_REGION")
    table_name = os.getenv("USERS_TABLE")
    if not table_name:
        raise ValueError("Missing USERS_TABLE env var.")
    dynamodb = boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")
    return dynamodb.Table(table_name)


def _expected_profile_image_prefix(user_id: str) -> str:
    return f"users/{user_id}/profile-image/"


def _s3_client():
    region = os.getenv("AWS_REGION")
    return boto3.client("s3", region_name=region) if region else boto3.client("s3")


def _profile_image_display_ttl_seconds() -> int:
    raw = os.getenv("PROFILE_IMAGE_DISPLAY_URL_TTL_SECONDS", "") or os.getenv(
        "PROFILE_IMAGE_UPLOAD_URL_TTL_SECONDS", "900"
    )
    try:
        ttl = int(raw)
    except ValueError:
        ttl = 900
    return ttl if ttl > 0 else 900


def _presigned_get_url(*, bucket: str, object_key: str) -> str:
    s3 = _s3_client()
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": object_key},
        ExpiresIn=_profile_image_display_ttl_seconds(),
    )


def _profile_image_url_for_key(user_id: str, object_key: str) -> Optional[str]:
    if not object_key.strip():
        return None
    bucket = os.getenv("PROFILE_IMAGES_BUCKET", "").strip()
    if not bucket:
        return None
    expected_prefix = _expected_profile_image_prefix(user_id)
    if not object_key.startswith(expected_prefix):
        return None
    return _presigned_get_url(bucket=bucket, object_key=object_key)


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    request_context = event.get("requestContext") or {}
    http = request_context.get("http") or {}
    method = (http.get("method") or event.get("httpMethod") or "").upper()

    if method == "OPTIONS":
        return {"statusCode": 200, "headers": dict(_CORS_HEADERS), "body": ""}

    user_id = _extract_cognito_sub(event)
    if not user_id:
        return _json_response(401, {"message": "Missing Cognito user id (sub) in request."})

    try:
        table = _users_table()
    except ValueError as err:
        return _json_response(500, {"message": str(err)})

    if method == "GET":
        response = table.get_item(Key={"user_id": user_id})
        item = response.get("Item") or {}
        display_name = item.get("display_name")
        clean = display_name.strip() if isinstance(display_name, str) else ""
        body: Dict[str, Any] = {"user_id": user_id, "display_name": clean}
        raw_key = item.get("profile_image_key")
        if isinstance(raw_key, str) and raw_key.strip():
            key_clean = raw_key.strip()
            url = _profile_image_url_for_key(user_id, key_clean)
            if url:
                body["profile_image_url"] = url
                body["profile_image_url_expires_in_seconds"] = _profile_image_display_ttl_seconds()
        return _json_response(200, body)

    if method != "PATCH":
        return _json_response(405, {"message": "Method not allowed."})

    try:
        payload = _parse_body(event)
    except json.JSONDecodeError:
        return _json_response(400, {"message": "Request body must be valid JSON."})

    now_iso = _iso_utc_now()

    updates: Dict[str, str] = {}
    removes: list[str] = []
    expr_values: Dict[str, Any] = {":updated_at": now_iso}

    if "display_name" in payload:
        raw_name = payload.get("display_name")
        if raw_name is None:
            clean_name = ""
        elif isinstance(raw_name, str):
            clean_name = raw_name.strip()
        else:
            return _json_response(400, {"message": "display_name must be a string."})

        if clean_name:
            updates["display_name"] = ":display_name"
            expr_values[":display_name"] = clean_name
        else:
            removes.append("display_name")
    else:
        clean_name = None

    if "profile_image_key" in payload:
        raw_key = payload.get("profile_image_key")
        if raw_key is None:
            clean_key = ""
        elif isinstance(raw_key, str):
            clean_key = raw_key.strip()
        else:
            return _json_response(400, {"message": "profile_image_key must be a string."})

        expected_prefix = _expected_profile_image_prefix(user_id)
        if clean_key and not clean_key.startswith(expected_prefix):
            return _json_response(403, {"message": "profile_image_key is not owned by the current user."})

        if clean_key:
            updates["profile_image_key"] = ":profile_image_key"
            expr_values[":profile_image_key"] = clean_key
        else:
            removes.append("profile_image_key")
    else:
        clean_key = None

    if not updates and not removes:
        return _json_response(400, {"message": "At least one updatable field is required."})

    update_parts = []
    if removes:
        update_parts.append("REMOVE " + ", ".join(removes))
    if updates:
        set_parts = [f"{attr} = {token}" for attr, token in updates.items()]
        set_parts.append("updated_at = :updated_at")
        update_parts.append("SET " + ", ".join(set_parts))
    else:
        update_parts.append("SET updated_at = :updated_at")

    table.update_item(
        Key={"user_id": user_id},
        UpdateExpression=" ".join(update_parts),
        ExpressionAttributeValues=expr_values,
    )

    response_body: Dict[str, Any] = {
        "user_id": user_id,
        **({"display_name": clean_name} if isinstance(clean_name, str) else {}),
        **({"profile_image_key": clean_key} if isinstance(clean_key, str) else {}),
        "updated_at": now_iso,
    }
    if isinstance(clean_key, str) and clean_key.strip():
        url = _profile_image_url_for_key(user_id, clean_key.strip())
        if url:
            response_body["profile_image_url"] = url
            response_body["profile_image_url_expires_in_seconds"] = _profile_image_display_ttl_seconds()

    return _json_response(200, response_body)

