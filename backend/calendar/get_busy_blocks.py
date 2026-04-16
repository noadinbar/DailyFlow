import json
import os
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import boto3
from boto3.dynamodb.conditions import Key

_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://main.dnp9vhzk0bw8l.amplifyapp.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,GET",
}

APP_TIMEZONE = ZoneInfo("Asia/Jerusalem")


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


def _busyblocks_table():
    region = os.getenv("AWS_REGION")
    table_name = os.getenv("BUSY_BLOCKS_TABLE")
    if not table_name:
        raise ValueError("Missing BUSY_BLOCKS_TABLE env var.")
    dynamodb = boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")
    return dynamodb.Table(table_name)


def _safe_str(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _query_user_busy_blocks(user_id: str) -> List[Dict[str, Any]]:
    table = _busyblocks_table()
    items: List[Dict[str, Any]] = []
    last_evaluated_key: Optional[Dict[str, Any]] = None

    while True:
        query_args: Dict[str, Any] = {
            "KeyConditionExpression": Key("user_id").eq(user_id),
        }
        if last_evaluated_key:
            query_args["ExclusiveStartKey"] = last_evaluated_key
        response = table.query(**query_args)
        batch = response.get("Items") or []
        for item in batch:
            if isinstance(item, dict):
                items.append(item)
        last_evaluated_key = response.get("LastEvaluatedKey")
        if not last_evaluated_key:
            break

    return items


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
    if method != "GET":
        return _json_response(405, {"message": "Method not allowed."})

    user_id = _extract_cognito_sub(event)
    if not user_id:
        return _json_response(401, {"message": "Missing Cognito user id (sub) in request."})

    try:
        items = _query_user_busy_blocks(user_id)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception:
        return _json_response(500, {"message": "Unexpected error while loading busy blocks."})

    today_local = datetime.now(APP_TIMEZONE).date()
    today = today_local.isoformat()
    max_date = (today_local + timedelta(days=30)).isoformat()

    busy_blocks: List[Dict[str, str]] = []
    min_busy_block_date: Optional[str] = None
    for item in items:
        block_date = _safe_str(item.get("date"))
        if not block_date or block_date > max_date:
            continue

        start_time = _safe_str(item.get("start_time"))
        end_time = _safe_str(item.get("end_time"))
        source_calendar_id = _safe_str(item.get("source_calendar_id"))
        if not start_time or not end_time or not source_calendar_id:
            continue
        if min_busy_block_date is None or block_date < min_busy_block_date:
            min_busy_block_date = block_date

        busy_blocks.append(
            {
                "block_key": _safe_str(item.get("block_key")),
                "date": block_date,
                "start_time": start_time,
                "end_time": end_time,
                "source_calendar_id": source_calendar_id,
                "source_calendar_color": _safe_str(item.get("source_calendar_color")) or "#3b82f6",
                "source_event_title": _safe_str(item.get("source_event_title")) or "Busy",
                "updated_at": _safe_str(item.get("updated_at")),
            }
        )

    busy_blocks.sort(key=lambda block: (block["date"], block["start_time"], block["end_time"], block["block_key"]))
    window_start_date = min_busy_block_date or today

    return _json_response(
        200,
        {
            "busy_blocks": busy_blocks,
            "window_start_date": window_start_date,
            "window_end_date": max_date,
            "updated_at": datetime.now(APP_TIMEZONE).isoformat(),
        },
    )
