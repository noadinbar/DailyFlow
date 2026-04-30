import json
import os
from typing import Any, Dict, List, Tuple

from openai import APIConnectionError, APIError, APITimeoutError, OpenAI

from suggestions import (
    _CORS_HEADERS,
    _busyblocks_schema_ok,
    _extract_cognito_sub,
    _handle_common_weekly_derivation,
    _iso_utc_now,
    _json_response,
    _period_from_body,
    _read_user_preferences,
    _save_library,
    _workout_library_schema_ok,
)

OPENAI_MODEL = "gpt-4.1-mini"


def _openai_prompt_for_library(preferences: Dict[str, Any]) -> str:
    compact = {
        "preferences": preferences,
        "rules": {
            "return_unique_workouts_only": True,
            "no_duplicates_by_type_duration_title": True,
            "generate_compact_workout_flow_steps": True,
            "language": "English",
        },
    }
    return (
        "Generate a workout library JSON only.\n"
        "No markdown.\n"
        "Schema:\n"
        "{\n"
        '  "workout_library":[{\n'
        '    "id":"lib_1",\n'
        '    "title":"Upper body workout",\n'
        '    "workout_type":"Strength",\n'
        '    "duration_minutes":25,\n'
        '    "intensity":"Moderate",\n'
        '    "location":"Gym|Home|Outside",\n'
        '    "summary_short":"...",\n'
        '    "workout_flow":{\n'
        '      "summary":"...",\n'
        '      "warmup_steps":["..."],\n'
        '      "main_steps":["..."],\n'
        '      "cooldown_steps":["..."],\n'
        '      "notes":["..."]\n'
        "    }\n"
        "  }]\n"
        "}\n"
        f"Input: {json.dumps(compact, separators=(',', ':'))}"
    )


def _to_int(value: Any, default: int) -> int:
    try:
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
            return int(float(raw))
    except Exception:
        return default
    return default


def _normalize_generated_library(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    seen = set()
    cleaned: List[Dict[str, Any]] = []
    for index, entry in enumerate(raw, start=1):
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("title", "")).strip()
        workout_type = str(entry.get("workout_type", "")).strip()
        duration = _to_int(entry.get("duration_minutes"), 0)
        if not title or not workout_type or duration <= 0:
            continue
        dedupe_key = f"{workout_type.lower()}|{duration}|{title.lower()}"
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        intensity = str(entry.get("intensity", "")).strip() or "Moderate"
        location = str(entry.get("location", "")).strip() or "Home"
        summary_short = str(entry.get("summary_short", "")).strip() or f"{title} workout."
        workout_flow = entry.get("workout_flow")
        if not isinstance(workout_flow, dict):
            workout_flow = {
                "summary": summary_short,
                "warmup_steps": [],
                "main_steps": [],
                "cooldown_steps": [],
                "notes": [],
            }
        cleaned.append(
            {
                "id": f"lib_{index}",
                "title": title,
                "workout_type": workout_type,
                "duration_minutes": duration,
                "intensity": intensity,
                "location": location,
                "summary_short": summary_short,
                "workout_flow": workout_flow,
            }
        )
    return cleaned


def _generate_library_from_openai(preferences: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], str]:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise ValueError("Missing OPENAI_API_KEY env var.")
    client = OpenAI(api_key=api_key)
    response = client.responses.create(
        model=OPENAI_MODEL,
        input=_openai_prompt_for_library(preferences),
        text={"format": {"type": "json_object"}},
    )
    text_out = getattr(response, "output_text", "")
    if not isinstance(text_out, str) or not text_out.strip():
        return [], "Model returned empty output."
    try:
        parsed = json.loads(text_out)
    except json.JSONDecodeError:
        return [], "Model returned malformed JSON."
    if not isinstance(parsed, dict):
        return [], "Model returned an unexpected JSON shape."
    return _normalize_generated_library(parsed.get("workout_library")), ""


def _fallback_library(preferences: Dict[str, Any]) -> List[Dict[str, Any]]:
    preferred_types = preferences.get("preferred_workout_types") or []
    if not isinstance(preferred_types, list) or not preferred_types:
        preferred_types = ["walking", "strength", "yoga"]
    durations = [20, 30, 40]
    library: List[Dict[str, Any]] = []
    counter = 1
    for workout_type in preferred_types:
        if not isinstance(workout_type, str) or not workout_type.strip():
            continue
        for duration in durations:
            if counter > 9:
                break
            clean_type = workout_type.strip().replace("_", " ")
            title = f"{clean_type.title()} workout"
            library.append(
                {
                    "id": f"lib_{counter}",
                    "title": title,
                    "workout_type": clean_type.title(),
                    "duration_minutes": duration,
                    "intensity": "Moderate",
                    "location": "Home",
                    "summary_short": f"{clean_type.title()} in {duration} minutes.",
                    "workout_flow": {
                        "summary": f"{title} flow.",
                        "warmup_steps": ["Light warm-up 3-5 minutes"],
                        "main_steps": [f"Main {clean_type} sequence"],
                        "cooldown_steps": ["Cooldown and stretch"],
                        "notes": ["Adjust pace to fitness level"],
                    },
                }
            )
            counter += 1
    return library


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    request_context = event.get("requestContext") or {}
    http = request_context.get("http") or {}
    method = (http.get("method") or event.get("httpMethod") or "").upper()
    if method == "OPTIONS":
        return {"statusCode": 200, "headers": dict(_CORS_HEADERS), "body": ""}
    if method != "POST":
        return _json_response(405, {"message": "Method not allowed."})

    user_id = _extract_cognito_sub(event)
    if not user_id:
        return _json_response(401, {"message": "Missing Cognito user id (sub) in request."})

    start_date_value, end_date_value, period_error, _ = _period_from_body(event)
    if period_error:
        return _json_response(400, {"message": period_error})
    assert start_date_value is not None and end_date_value is not None

    try:
        if not _busyblocks_schema_ok():
            return _json_response(500, {"message": "BusyBlocks schema mismatch. Expected PK user_id, SK block_key."})
        if not _workout_library_schema_ok():
            return _json_response(500, {"message": "WorkoutLibrary schema mismatch. Expected PK user_id only."})
        preferences = _read_user_preferences(user_id)
        workout_library, generation_warning = _generate_library_from_openai(preferences)
        if not workout_library:
            workout_library = _fallback_library(preferences)
        generated_at = _iso_utc_now()
        _save_library(user_id, workout_library, generated_at)
        payload = _handle_common_weekly_derivation(
            user_id=user_id,
            start_date_value=start_date_value,
            end_date_value=end_date_value,
            workout_library=workout_library,
            generated_at=generated_at,
            library_source="generated",
        )
        if generation_warning:
            payload["metadata"]["generation_warning"] = generation_warning
        return _json_response(200, payload)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except (APIConnectionError, APITimeoutError):
        return _json_response(502, {"message": "Failed to reach OpenAI API."})
    except APIError as err:
        return _json_response(502, {"message": f"OpenAI request failed: {str(err)}"})
    except Exception:
        return _json_response(500, {"message": "Unexpected error while generating workout library."})
