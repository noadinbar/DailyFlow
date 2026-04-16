import json
import os
from typing import Any, Dict, Optional
from uuid import uuid4

import boto3

_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://main.dnp9vhzk0bw8l.amplifyapp.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
}

_ALLOWED_IMAGE_CONTENT_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


def _json_response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": dict(_CORS_HEADERS),
        "body": json.dumps(body),
    }


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


def _s3_client():
    region = os.getenv("AWS_REGION")
    return boto3.client("s3", region_name=region) if region else boto3.client("s3")


def _build_object_key(user_id: str, ext: str) -> str:
    # User-scoped key: do not allow overriding other users' objects.
    # Example: users/<cognito-sub>/profile-image/<uuid>.jpg
    return f"users/{user_id}/profile-image/{uuid4().hex}{ext}"


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    request_context = event.get("requestContext") or {}
    http = request_context.get("http") or {}
    method = (http.get("method") or event.get("httpMethod") or "").upper()

    if method == "OPTIONS":
        return {"statusCode": 200, "headers": dict(_CORS_HEADERS), "body": ""}
    if method != "POST":
        return _json_response(405, {"message": "Method not allowed."})

    bucket = os.getenv("PROFILE_IMAGES_BUCKET", "").strip()
    if not bucket:
        return _json_response(500, {"message": "Missing PROFILE_IMAGES_BUCKET env var."})

    user_id = _extract_cognito_sub(event)
    if not user_id:
        return _json_response(401, {"message": "Missing Cognito user id (sub) in request."})

    try:
        payload = _parse_body(event)
    except json.JSONDecodeError:
        return _json_response(400, {"message": "Request body must be valid JSON."})

    content_type = payload.get("content_type")
    if not isinstance(content_type, str) or not content_type.strip():
        return _json_response(400, {"message": "content_type is required."})
    content_type = content_type.strip().lower()

    ext = _ALLOWED_IMAGE_CONTENT_TYPES.get(content_type)
    if not ext:
        return _json_response(400, {"message": "Unsupported image content_type."})

    object_key = _build_object_key(user_id, ext)
    expires_in = int(os.getenv("PROFILE_IMAGE_UPLOAD_URL_TTL_SECONDS", "900") or "900")
    if expires_in <= 0:
        expires_in = 900

    s3 = _s3_client()
    upload_url = s3.generate_presigned_url(
        ClientMethod="put_object",
        Params={
            "Bucket": bucket,
            "Key": object_key,
            "ContentType": content_type,
        },
        ExpiresIn=expires_in,
    )

    return _json_response(
        200,
        {
            "upload_url": upload_url,
            "object_key": object_key,
            "content_type": content_type,
            "expires_in_seconds": expires_in,
        },
    )

