"""
POST /stress/activities/generate

- Timed: OpenAI generation from Stress & Breaks preferences (Users table)
- Flexible: refresh from fixed catalog using saved preferences
- Persists to StressBreaksLibrary; preserves Timed favorites by stable signature

On failure: does not overwrite an existing successful library.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import boto3
from openai import APIConnectionError, APIError, APITimeoutError, OpenAI

_STRESS_DIR = str(Path(__file__).resolve().parent)
if _STRESS_DIR not in sys.path:
    sys.path.insert(0, _STRESS_DIR)

from activity_categories import (  # noqa: E402
    category_label,
    duration_minutes_options,
    flexible_activities_for_prefs,
    split_preferred_activities,
    suggested_timed_count,
)
from activity_model import (  # noqa: E402
    activity_signature,
    assign_timed_ids,
    iso_utc_now,
    json_safe,
    library_table,
    load_library_item,
    merge_flexible_preserving_plan_refs,
    merge_timed_preserving_favorites,
    normalize_activity_list,
    normalize_favorites,
    normalize_timed_activity,
    normalize_weekly_break_plan,
    safe_string_list,
    to_dynamodb_safe,
    weekly_plan_referenced_ids,
)
from curated_youtube import (  # noqa: E402
    ACTIVITIES_PER_YOUTUBE_CATEGORY,
    YOUTUBE_CATEGORY_SET,
    generate_youtube_activities_for_categories,
    merge_recent_youtube_by_category,
    normalize_recent_youtube_by_category,
    strip_untrusted_video_fields,
    youtube_categories_from_preferences,
)

OPENAI_MODEL = "gpt-4.1-mini"

_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://main.dnp9vhzk0bw8l.amplifyapp.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
}


def _json_response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {"statusCode": status_code, "headers": dict(_CORS_HEADERS), "body": json.dumps(json_safe(body))}


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


def _users_table():
    table_name = os.getenv("USERS_TABLE", "").strip()
    if not table_name:
        raise ValueError("Missing USERS_TABLE env var.")
    region = os.getenv("AWS_REGION")
    dynamodb = boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")
    return dynamodb.Table(table_name)


def _read_stress_preferences(user_id: str) -> Dict[str, Any]:
    item = _users_table().get_item(Key={"user_id": user_id}, ConsistentRead=True).get("Item") or {}
    completed = item.get("stress_breaks_questionnaire_completed") is True
    preferred = safe_string_list(item.get("stress_breaks_preferred_activities"))
    durations = safe_string_list(item.get("stress_breaks_durations"))
    return {
        "questionnaire_completed": completed,
        "preferred_activities": preferred,
        "durations": durations,
    }


def _openai_prompt(
    *,
    timed_categories: List[str],
    duration_minutes: List[int],
    target_count: int,
    avoid_titles: List[str],
) -> str:
    category_payload = [
        {"id": cat, "label": category_label(cat)} for cat in timed_categories
    ]
    compact = {
        "timed_categories": category_payload,
        "allowed_duration_minutes": duration_minutes,
        "target_count": target_count,
        "avoid_repeating_titles": avoid_titles[:40],
        "rules": {
            "language": "English",
            "self_contained_instructions_only": True,
            "no_external_urls": True,
            "no_youtube_links": True,
            "no_markdown": True,
            "title_must_not_include_duration": True,
            "only_use_provided_categories": True,
            "duration_minutes_must_be_whole_numbers_from_allowed_list": True,
            "distribute_across_selected_categories_when_possible": True,
            "do_not_pad_with_irrelevant_activities": True,
        },
    }
    return (
        "Generate a Stress & Breaks Timed activity library as JSON only.\n"
        "No markdown.\n"
        "Activities must be calming short breaks matching the user's selected Timed categories and durations.\n"
        "Each title must be the activity name only (example: \"Box Breathing\"), never include minutes in the title.\n"
        "Do not invent websites, YouTube links, or any external_url.\n"
        "Provide clear self-contained instructions the user can follow inside DailyFlow.\n"
        "Schema:\n"
        "{\n"
        '  "timed_activities":[{\n'
        '    "id":"timed_1",\n'
        '    "title":"Box Breathing",\n'
        '    "category":"breathing|meditation|stretching",\n'
        '    "duration_minutes":5,\n'
        '    "summary_short":"...",\n'
        '    "instructions":["step 1","step 2"]\n'
        "  }]\n"
        "}\n"
        f"Input: {json.dumps(compact, separators=(',', ':'))}"
    )


def _generate_timed_from_openai(
    *,
    timed_categories: List[str],
    duration_minutes: List[int],
    target_count: int,
    avoid_titles: List[str],
) -> Tuple[List[Dict[str, Any]], str]:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        return [], "missing_api_key"
    if target_count <= 0 or not timed_categories:
        return [], ""

    client = OpenAI(api_key=api_key)
    prompt = _openai_prompt(
        timed_categories=timed_categories,
        duration_minutes=duration_minutes,
        target_count=target_count,
        avoid_titles=avoid_titles,
    )
    print(
        f"[stress-generate] openai start categories={timed_categories} "
        f"target={target_count} durations={duration_minutes}"
    )
    try:
        response = client.responses.create(
            model=OPENAI_MODEL,
            input=prompt,
            text={"format": {"type": "json_object"}},
        )
    except APITimeoutError:
        return [], "openai_timeout"
    except APIConnectionError:
        return [], "openai_connection"
    except APIError:
        return [], "openai_api_error"
    except Exception:
        print(f"[stress-generate] openai unexpected error\n{traceback.format_exc()}")
        return [], "openai_api_error"

    text_out = getattr(response, "output_text", "")
    if not isinstance(text_out, str) or not text_out.strip():
        return [], "openai_empty_output"
    try:
        parsed = json.loads(text_out)
    except json.JSONDecodeError:
        return [], "openai_bad_json"
    if not isinstance(parsed, dict):
        return [], "openai_bad_shape"

    raw_library = parsed.get("timed_activities")
    if not isinstance(raw_library, list):
        return [], "openai_bad_shape"

    allowed: Set[str] = set(timed_categories)
    allowed_durations = set(duration_minutes)
    normalized: List[Dict[str, Any]] = []
    seen_sigs: Set[str] = set()
    for entry in raw_library:
        if not isinstance(entry, dict):
            continue
        # Strip any model-provided URL fields before normalize.
        # YouTube links come only from the curated backend catalog.
        entry = strip_untrusted_video_fields(entry)
        entry.pop("youtube_video_id", None)
        item = normalize_timed_activity(entry, allowed_categories=allowed)
        if not item:
            continue
        if allowed_durations and item["duration_minutes"] not in allowed_durations:
            # Keep only durations within the user's preferred ranges.
            continue
        sig = activity_signature(item)
        if sig in seen_sigs:
            continue
        seen_sigs.add(sig)
        normalized.append(item)

    if not normalized:
        return [], "openai_invalid_or_incomplete"
    # Never attach YouTube from OpenAI output; curated videos are selected separately.
    cleaned = []
    for item in assign_timed_ids(normalized):
        next_item = dict(item)
        next_item.pop("youtube_video_id", None)
        next_item.pop("youtube_url", None)
        next_item.pop("youtube_title", None)
        cleaned.append(next_item)
    return cleaned, ""


def _openai_failure_response(reason: str) -> Dict[str, Any]:
    print(f"[stress-generate] openai failure reason={reason}")
    return _json_response(502, {"message": "Activity generation is currently unavailable. Please try again."})


def _save_library(
    user_id: str,
    *,
    timed_activities: List[Dict[str, Any]],
    flexible_activities: List[Dict[str, Any]],
    favorite_activities: List[Dict[str, Any]],
    generated_at: str,
    existing_item: Optional[Dict[str, Any]] = None,
    recent_youtube_by_category: Optional[Dict[str, List[str]]] = None,
) -> None:
    existing = existing_item or {}
    item = {
        "user_id": user_id,
        "timed_activities": timed_activities,
        "flexible_activities": flexible_activities,
        "favorite_activities": favorite_activities,
        "generated_at": generated_at,
        "updated_at": generated_at,
        # Preserve Weekly Break Plan across library regeneration (Workouts-style).
        "current_week_plan": normalize_weekly_break_plan(existing.get("current_week_plan")),
        "recent_youtube_by_category": normalize_recent_youtube_by_category(
            recent_youtube_by_category
            if recent_youtube_by_category is not None
            else existing.get("recent_youtube_by_category")
        ),
    }
    week_start = existing.get("current_week_plan_week_start")
    week_end = existing.get("current_week_plan_week_end")
    plan_updated_at = existing.get("current_week_plan_updated_at")
    if isinstance(week_start, str) and week_start.strip():
        item["current_week_plan_week_start"] = week_start.strip()
    if isinstance(week_end, str) and week_end.strip():
        item["current_week_plan_week_end"] = week_end.strip()
    if isinstance(plan_updated_at, str) and plan_updated_at.strip():
        item["current_week_plan_updated_at"] = plan_updated_at.strip()
    library_table().put_item(Item=to_dynamodb_safe(item))


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

    try:
        prefs = _read_stress_preferences(user_id)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception as err:
        print(f"[stress-generate] preferences load failed: {err}")
        return _json_response(503, {"message": "Could not load Stress & Breaks preferences. Try again shortly."})

    if not prefs.get("questionnaire_completed"):
        return _json_response(
            400,
            {"message": "Complete the Stress & Breaks questionnaire before generating activities."},
        )

    preferred = prefs.get("preferred_activities") or []
    timed_cats, flexible_cats = split_preferred_activities(preferred)
    if not timed_cats and not flexible_cats:
        return _json_response(
            400,
            {
                "message": (
                    "No break activity types are selected in your Stress & Breaks preferences. "
                    "Update preferences, then generate again."
                )
            },
        )

    try:
        existing = load_library_item(user_id)
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except Exception as err:
        print(f"[stress-generate] library load failed: {err}")
        return _json_response(503, {"message": "Could not load Stress & Breaks library. Try again shortly."})

    previous_timed = normalize_activity_list(existing.get("timed_activities"), kind="timed")
    previous_flexible = normalize_activity_list(existing.get("flexible_activities"), kind="flexible")
    favorite_activities = normalize_favorites(existing.get("favorite_activities"))
    existing_weekly_plan = normalize_weekly_break_plan(existing.get("current_week_plan"))
    referenced_ids = weekly_plan_referenced_ids(existing_weekly_plan)
    flexible_activities = merge_flexible_preserving_plan_refs(
        refreshed=flexible_activities_for_prefs(flexible_cats),
        previous_flexible=previous_flexible,
        referenced_library_ids=referenced_ids,
    )

    duration_minutes = duration_minutes_options(prefs.get("durations") or [])
    recent_youtube = normalize_recent_youtube_by_category(existing.get("recent_youtube_by_category"))
    youtube_cats = youtube_categories_from_preferences(
        timed_categories=timed_cats,
        flexible_categories=flexible_cats,
    )
    # Non-YouTube Timed categories (e.g. stretching) still use OpenAI.
    openai_timed_cats = [c for c in timed_cats if c not in YOUTUBE_CATEGORY_SET]

    youtube_generated, selected_recent = generate_youtube_activities_for_categories(
        youtube_cats,
        recent_by_category=recent_youtube,
        allowed_durations=duration_minutes,
        per_category_count=ACTIVITIES_PER_YOUTUBE_CATEGORY,
    )
    # Catalog hydration owns duration/URL fields; assign stable ids after merge with OpenAI.
    youtube_generated = [
        item
        for item in (normalize_timed_activity({**raw, "id": ""}) for raw in youtube_generated)
        if item
    ]

    openai_generated: List[Dict[str, Any]] = []
    if openai_timed_cats:
        target = max(
            len(openai_timed_cats) * 2,
            suggested_timed_count(len(openai_timed_cats), len(flexible_activities)),
        )
        # Prefer ~2–3 per non-YouTube Timed category.
        target = max(target, len(openai_timed_cats) * ACTIVITIES_PER_YOUTUBE_CATEGORY)
        avoid_titles = [
            str(item.get("title", "")).strip()
            for item in previous_timed
            if str(item.get("title", "")).strip()
        ]
        openai_generated, failure = _generate_timed_from_openai(
            timed_categories=openai_timed_cats,
            duration_minutes=duration_minutes,
            target_count=target,
            avoid_titles=avoid_titles,
        )
        if failure:
            # Keep previous library untouched.
            return _openai_failure_response(failure)
        # Re-assign ids together with YouTube activities to avoid timed_N collisions.
        openai_generated = [{**item, "id": ""} for item in openai_generated]

    generated: List[Dict[str, Any]] = assign_timed_ids(list(youtube_generated) + list(openai_generated))

    timed_activities: List[Dict[str, Any]] = []
    if generated or referenced_ids:
        timed_activities = merge_timed_preserving_favorites(
            generated=generated,
            favorite_activities=favorite_activities,
            previous_timed=previous_timed,
            referenced_library_ids=referenced_ids,
        )
    else:
        timed_activities = []

    # Drop stale Timed youtube activities whose category is no longer preferred.
    preferred_youtube = set(youtube_cats)
    preferred_openai = set(openai_timed_cats)
    preferred_timed = set(timed_cats)
    filtered_timed: List[Dict[str, Any]] = []
    for item in timed_activities:
        cat = str(item.get("category", "")).strip()
        lib_id = str(item.get("id", "")).strip()
        # Always keep plan-referenced items.
        if lib_id in referenced_ids:
            filtered_timed.append(item)
            continue
        if cat in YOUTUBE_CATEGORY_SET:
            if cat in preferred_youtube:
                filtered_timed.append(item)
            continue
        if cat in preferred_openai or cat in preferred_timed:
            filtered_timed.append(item)
    timed_activities = filtered_timed

    next_recent = merge_recent_youtube_by_category(recent_youtube, selected_recent)

    generated_at = iso_utc_now()
    try:
        _save_library(
            user_id,
            timed_activities=timed_activities,
            flexible_activities=flexible_activities,
            favorite_activities=favorite_activities,
            generated_at=generated_at,
            existing_item=existing,
            recent_youtube_by_category=next_recent,
        )
    except Exception as err:
        print(f"[stress-generate] save failed: {err}\n{traceback.format_exc()}")
        return _json_response(503, {"message": "Could not save the activity library. Try again shortly."})

    return _json_response(
        200,
        {
            "timed_activities": timed_activities,
            "flexible_activities": flexible_activities,
            "favorite_activities": favorite_activities,
            "weekly_break_plan": existing_weekly_plan,
            "has_library": bool(timed_activities or flexible_activities),
            "generated_at": generated_at,
            "updated_at": generated_at,
            "metadata": {
                "timed_categories": timed_cats,
                "flexible_categories": flexible_cats,
                "youtube_categories": youtube_cats,
                "timed_count": len(timed_activities),
                "flexible_count": len(flexible_activities),
                "youtube_per_category": ACTIVITIES_PER_YOUTUBE_CATEGORY,
            },
        },
    )
