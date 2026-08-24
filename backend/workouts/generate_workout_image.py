"""
Standalone workout image generation and cleanup worker.

Direct-invoke events:
  { "user_id": "...", "plan_id": "..." }
  { "action": "delete", "user_id": "...", "plan_id": "..." }
  { "action": "cleanup", "user_id": "...", "keep_plan_ids": ["..."] }

Default action generates a PNG infographic and stores it in S3.
"""

from __future__ import annotations

import base64
import hashlib
import os
import re
import traceback
from datetime import datetime, timezone
from io import BytesIO
from typing import Any, Dict, List, Optional, Tuple

import boto3
from botocore.exceptions import ClientError
from openai import APIConnectionError, APIError, APITimeoutError, OpenAI

OPENAI_MODEL = "gpt-image-1-mini"
OPENAI_TIMEOUT_SECONDS = 90
OPENAI_MAX_RETRIES = 0
IMAGE_SIZE = "1024x1536"
IMAGE_QUALITY = "medium"
IMAGE_OUTPUT_FORMAT = "png"
DEFAULT_REFERENCE_KEY = "assets/workout-style-reference.png"
WORKOUT_LIBRARY_DEFAULT_TABLE_NAME = "WorkoutLibrary"

PALETTE_SETS: List[List[str]] = [
    ["navy", "sky blue", "off-white"],
    ["navy", "teal", "sage/green", "off-white"],
    ["navy", "lavender", "soft peach"],
    ["blue", "sky blue", "teal", "off-white"],
    ["navy", "blue", "lavender", "off-white"],
    ["teal", "sage/green", "off-white"],
    ["navy", "soft peach", "sky blue"],
    ["sage/green", "lavender", "off-white", "navy"],
]

_LEADING_INSTRUCTION = re.compile(
    r"^(?:please\s+)?(?:perform|complete|do|then|next|start(?:ing)? with|finish(?:ing)? with|"
    r"include|add|try|begin with)\s+",
    re.IGNORECASE,
)
_LEADING_QUANTITY = re.compile(
    r"^(?:\d+(?:\s*[-–]\s*\d+)?\s*(?:x|×)?\s*(?:\d+\s*)?"
    r"(?:rounds?|sets?|reps?|repetitions?|seconds?|secs?|minutes?|mins?|min)?\s*"
    r"(?:of\s+)?)+\s*",
    re.IGNORECASE,
)
_EMBEDDED_QUANTITY = re.compile(
    r"\b\d+\s*(?:x|×)\s*\d+\b|\b\d+[-\s]?(?:rounds?|sets?|reps?|repetitions?|"
    r"seconds?|secs?|minutes?|mins?|min)\b",
    re.IGNORECASE,
)
_TRAILING_MODIFIER = re.compile(
    r"\b(?:with|using|keeping|focusing|maintaining|while|ensuring|making sure)\b.*$",
    re.IGNORECASE,
)
_NON_LABEL_WORDS = {
    "a",
    "an",
    "and",
    "for",
    "of",
    "on",
    "the",
    "to",
}


def _iso_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_err(err: BaseException) -> str:
    text = str(err)
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if api_key:
        text = text.replace(api_key, "[redacted]")
    return text


def _result(
    *,
    status: str,
    plan_id: str = "",
    workout_image_key: str = "",
    generated: bool = False,
    deleted: int = 0,
    message: str = "",
) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "status": status,
        "plan_id": plan_id,
        "workout_image_key": workout_image_key,
        "generated": generated,
    }
    if deleted:
        body["deleted"] = deleted
    if message:
        body["message"] = message
    return body


def _s3_client():
    region = os.getenv("AWS_REGION")
    return boto3.client("s3", region_name=region) if region else boto3.client("s3")


def _dynamodb_resource():
    region = os.getenv("AWS_REGION")
    return boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")


def _workout_library_table():
    table_name = (os.getenv("WORKOUT_LIBRARY_TABLE") or WORKOUT_LIBRARY_DEFAULT_TABLE_NAME).strip()
    if not table_name:
        raise ValueError("Missing WORKOUT_LIBRARY_TABLE env var.")
    return _dynamodb_resource().Table(table_name)


def _bucket_and_reference() -> Tuple[str, str]:
    bucket = os.getenv("WORKOUT_IMAGES_BUCKET", "").strip()
    if not bucket:
        raise ValueError("Missing WORKOUT_IMAGES_BUCKET env var.")
    reference_key = (os.getenv("WORKOUT_IMAGE_STYLE_REFERENCE_KEY") or DEFAULT_REFERENCE_KEY).strip()
    if not reference_key:
        reference_key = DEFAULT_REFERENCE_KEY
    return bucket, reference_key


def _output_key(user_id: str, plan_id: str) -> str:
    return f"users/{user_id}/workout-image/{plan_id}.png"


def _legacy_svg_key(user_id: str, plan_id: str) -> str:
    return f"users/{user_id}/workout-image/{plan_id}.svg"


def _user_image_prefix(user_id: str) -> str:
    return f"users/{user_id}/workout-image/"


def _s3_object_exists(s3, bucket: str, key: str) -> bool:
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except ClientError as err:
        code = str((err.response or {}).get("Error", {}).get("Code", ""))
        if code in {"404", "NoSuchKey", "NotFound"}:
            return False
        raise


def _delete_s3_key(s3, bucket: str, key: str) -> bool:
    try:
        s3.delete_object(Bucket=bucket, Key=key)
        print(f"[workout-image] deleted s3 key={key}")
        return True
    except ClientError as err:
        print(f"[workout-image] s3 delete failed key={key}: {_safe_err(err)}")
        raise


def _plan_image_keys(user_id: str, plan_id: str) -> List[str]:
    return [_output_key(user_id, plan_id), _legacy_svg_key(user_id, plan_id)]


def _delete_plan_image_objects(s3, bucket: str, user_id: str, plan_id: str) -> int:
    deleted = 0
    for key in _plan_image_keys(user_id, plan_id):
        _delete_s3_key(s3, bucket, key)
        deleted += 1
    return deleted


def _plan_id_from_image_key(key: str, prefix: str) -> str:
    if not key.startswith(prefix):
        return ""
    name = key[len(prefix) :]
    if not name or "/" in name:
        return ""
    if name.endswith(".png") or name.endswith(".svg"):
        return name.rsplit(".", 1)[0].strip()
    return ""


def _scheduled_plan_item(user_id: str, plan_id: str) -> Optional[Dict[str, Any]]:
    item = _load_user_item(user_id)
    weekly_plan = _weekly_plan(item)
    idx = _find_plan_index(weekly_plan, plan_id)
    if idx is None:
        return None
    plan_item = weekly_plan[idx]
    if not str(plan_item.get("google_event_id", "")).strip():
        return None
    return plan_item


def _load_user_item(user_id: str) -> Dict[str, Any]:
    response = _workout_library_table().get_item(Key={"user_id": user_id}, ConsistentRead=True)
    item = response.get("Item") if isinstance(response, dict) else None
    if not isinstance(item, dict):
        return {}
    return item


def _weekly_plan(item: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw = item.get("current_week_plan")
    if not isinstance(raw, list):
        return []
    return [entry for entry in raw if isinstance(entry, dict)]


def _find_plan_index(weekly_plan: List[Dict[str, Any]], plan_id: str) -> Optional[int]:
    for idx, entry in enumerate(weekly_plan):
        if str(entry.get("id", "")).strip() == plan_id:
            return idx
    return None


def _find_library_item(item: Dict[str, Any], library_workout_id: str) -> Optional[Dict[str, Any]]:
    library = item.get("workout_library")
    if not isinstance(library, list) or not library_workout_id:
        return None
    for entry in library:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("id", "")).strip() == library_workout_id:
            return entry
    return None


def _string_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    cleaned: List[str] = []
    for entry in value:
        if isinstance(entry, str) and entry.strip():
            cleaned.append(entry.strip())
    return cleaned


def _palette_for_plan(plan_id: str) -> List[str]:
    digest = hashlib.sha1(plan_id.encode("utf-8")).hexdigest()
    return PALETTE_SETS[int(digest[:8], 16) % len(PALETTE_SETS)]


def _visual_emphasis(workout_type: str, location: str) -> str:
    lowered = f"{workout_type} {location}".lower()
    if "run" in lowered or "jog" in lowered:
        return "Give slightly more visual weight to an outdoor running hero scene that matches the saved location."
    if "walk" in lowered:
        return "Give slightly more visual weight to an outdoor walking hero scene that matches the saved location."
    if "yoga" in lowered or "stretch" in lowered or "pilates" in lowered:
        return "Give slightly more visual weight to calm indoor mobility and stretching demonstrations."
    if "strength" in lowered or "gym" in lowered:
        return "Give slightly more visual weight to strength-training demonstrations that match the saved location."
    return "Balance the hero visual with the saved workout type and location. Do not invent a different sport."


def _short_exercise_label(step: str) -> str:
    """Derive a 2-4 word label from saved step text. Never invent new words."""
    text = " ".join(str(step or "").split())
    if not text:
        return ""
    text = text.strip(" .,:;-")
    changed = True
    while changed and text:
        changed = False
        stripped = _LEADING_INSTRUCTION.sub("", text, count=1).strip(" .,:;-")
        if stripped != text:
            text = stripped
            changed = True
            continue
        stripped = _LEADING_QUANTITY.sub("", text, count=1).strip(" .,:;-")
        if stripped != text:
            text = stripped
            changed = True
    text = _TRAILING_MODIFIER.sub("", text).strip(" .,:;-")
    text = _EMBEDDED_QUANTITY.sub(" ", text)
    text = " ".join(text.split())
    words = [word for word in re.findall(r"[A-Za-z][A-Za-z'-]*", text) if word]
    selected = [word for word in words if word.lower() not in _NON_LABEL_WORDS][:4]
    if not selected:
        return ""
    return " ".join(word.capitalize() if word.islower() else word for word in selected)


def _labeled_steps(steps: List[str]) -> List[Dict[str, str]]:
    labeled: List[Dict[str, str]] = []
    for step in steps:
        labeled.append({"source": step, "label": _short_exercise_label(step)})
    return labeled


def _workout_prompt_data(library_item: Dict[str, Any]) -> Dict[str, Any]:
    title = str(library_item.get("title", "")).strip() or "Workout"
    workout_type = str(library_item.get("workout_type", "")).strip()
    intensity = str(library_item.get("intensity", "")).strip()
    location = str(library_item.get("location", "")).strip()
    duration = library_item.get("duration_minutes")
    flow = library_item.get("workout_flow") if isinstance(library_item.get("workout_flow"), dict) else {}
    subtitle_parts: List[str] = []
    if duration not in (None, ""):
        subtitle_parts.append(f"{duration} min")
    if workout_type:
        subtitle_parts.append(workout_type)
    if intensity:
        subtitle_parts.append(intensity)
    return {
        "title": title,
        "subtitle": " · ".join(subtitle_parts),
        "warmup": _labeled_steps(_string_list(flow.get("warmup_steps"))),
        "main_steps": _labeled_steps(_string_list(flow.get("main_steps"))),
        "cooldown": _labeled_steps(_string_list(flow.get("cooldown_steps"))),
        "has_notes": bool(_string_list(flow.get("notes"))),
        "workout_type": workout_type,
        "intensity": intensity,
        "location": location,
        "duration": "" if duration in (None, "") else str(duration),
    }


def _section_prompt_lines(heading: str, items: List[Dict[str, str]]) -> str:
    if not items:
        return ""
    lines = [f"{heading}:"]
    for item in items:
        label = item["label"]
        source = item["source"]
        if label:
            lines.append(f"- Depict: {source} | allowed label only: {label}")
        else:
            lines.append(f"- Depict: {source} | omit any text label for this movement")
    return "\n".join(lines) + "\n"


def _build_prompt(*, workout: Dict[str, Any], plan_id: str) -> str:
    palette = ", ".join(_palette_for_plan(plan_id))
    type_line = workout["workout_type"] or "general fitness"
    intensity_line = workout["intensity"] or "unspecified"
    location_line = workout["location"] or "unspecified"
    duration_line = f"{workout['duration']} min" if workout["duration"] else "unspecified"
    headings = ["OVERVIEW", "WARMUP", "MAIN", "COOLDOWN"]
    if workout["has_notes"]:
        headings.append("NOTES")
    section_blocks = "".join(
        [
            _section_prompt_lines("WARMUP movements", workout["warmup"]),
            _section_prompt_lines("MAIN movements", workout["main_steps"]),
            _section_prompt_lines("COOLDOWN movements", workout["cooldown"]),
        ]
    ).strip()
    if not section_blocks:
        section_blocks = (
            "No saved warmup/main/cooldown steps. Depict a matching general fitness hero only; "
            "do not invent extra exercises or labels."
        )
    allowed_labels: List[str] = []
    for group in (workout["warmup"], workout["main_steps"], workout["cooldown"]):
        for item in group:
            if item["label"]:
                allowed_labels.append(item["label"])
    labels_line = ", ".join(allowed_labels) if allowed_labels else "none — omit exercise labels"

    return (
        "Create a portrait DailyFlow fitness infographic PNG.\n"
        "The attached image is STYLE and DESIGN inspiration only, not a rigid template.\n"
        "Do not copy the reference wording, exercises, athlete identity, or exact layout grid.\n"
        "All images should feel like one coherent DailyFlow fitness infographic family, but this image must not look identical to the reference or to other workouts.\n"
        "\n"
        "Keep:\n"
        "- portrait 1024x1536 clean modern fitness infographic\n"
        "- light, clean background\n"
        "- strong visual hierarchy and clear section structure\n"
        "- realistic, accurate photographic-style exercise demonstrations of THIS saved workout\n"
        "- a hero exercise visual drawn from the saved MAIN movements when present\n"
        "Communicate primarily through visuals, not text.\n"
        "\n"
        "SAVED WORKOUT GUIDANCE (do not invent exercises):\n"
        f"- type={type_line}; intensity={intensity_line}; duration={duration_line}; location={location_line}\n"
        f"{section_blocks}\n"
        "Depict only these saved movements. Do not add extra exercises, sports, or equipment that are not implied by the saved steps.\n"
        "\n"
        "ALLOWED TEXT (minimal, large, clean, readable):\n"
        f"- Workout title: {workout['title']}\n"
        + (f"- Optional short subtitle: {workout['subtitle']}\n" if workout["subtitle"] else "")
        + f"- Section headings only: {', '.join(headings)}\n"
        f"- Exercise labels only, 2-4 words max: {labels_line}\n"
        "\n"
        "DO NOT RENDER:\n"
        "- long descriptions, full instructions, or sentences explaining how to do an exercise\n"
        "- detailed reps/sets/duration paragraphs\n"
        "- overview body copy or notes body copy\n"
        "- duplicated calendar/app details beyond the short title/subtitle above\n"
        "- fake, decorative, duplicated, or pseudo-text to fill empty space\n"
        "- invented labels. If a short label is missing or uncertain, omit that label rather than render gibberish\n"
        "\n"
        "Prioritize realistic and accurate exercise demonstrations over text.\n"
        "Never fill empty space with extra words.\n"
        "\n"
        "Allow slight variation:\n"
        "- different composition and image placement\n"
        "- slight layout variation and different section proportions\n"
        f"- {_visual_emphasis(type_line, location_line)}\n"
        "\n"
        f"Color palette for THIS image only (2-4 accents plus off-white/light ground): {palette}.\n"
        "Stay in this family: navy, blue, sky blue, teal, sage/green, lavender, soft peach, off-white.\n"
        f"Unique layout variation seed: {plan_id}\n"
    )


def _reference_filename(reference_key: str, content_type: str) -> str:
    name = reference_key.rsplit("/", 1)[-1].strip() or "workout-style-reference.png"
    if "." in name:
        return name
    if "jpeg" in content_type or content_type.endswith("/jpg"):
        return f"{name}.jpg"
    if "webp" in content_type:
        return f"{name}.webp"
    return f"{name}.png"


def _load_reference_image(s3, bucket: str, reference_key: str) -> Tuple[bytes, str, str]:
    try:
        response = s3.get_object(Bucket=bucket, Key=reference_key)
    except ClientError as err:
        code = str((err.response or {}).get("Error", {}).get("Code", ""))
        if code in {"404", "NoSuchKey", "NotFound"}:
            raise ValueError(f"Style reference image not found at s3://{bucket}/{reference_key}") from err
        raise
    body = response["Body"].read()
    if not body:
        raise ValueError("Style reference image is empty.")
    content_type = str(response.get("ContentType") or "").strip().lower() or "image/png"
    if content_type in {"binary/octet-stream", "application/octet-stream"}:
        lowered = reference_key.lower()
        if lowered.endswith(".jpg") or lowered.endswith(".jpeg"):
            content_type = "image/jpeg"
        elif lowered.endswith(".webp"):
            content_type = "image/webp"
        else:
            content_type = "image/png"
    filename = _reference_filename(reference_key, content_type)
    return body, filename, content_type


def _generate_image(prompt: str, reference_bytes: bytes, filename: str, content_type: str) -> bytes:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise ValueError("Missing OPENAI_API_KEY env var.")
    client = OpenAI(api_key=api_key, timeout=OPENAI_TIMEOUT_SECONDS, max_retries=OPENAI_MAX_RETRIES)
    image_file = BytesIO(reference_bytes)
    print(
        f"[workout-image] openai images.edit model={OPENAI_MODEL} size={IMAGE_SIZE} "
        f"quality={IMAGE_QUALITY} prompt_length={len(prompt)}"
    )
    response = client.images.edit(
        model=OPENAI_MODEL,
        image=(filename, image_file, content_type),
        prompt=prompt,
        n=1,
        size=IMAGE_SIZE,
        quality=IMAGE_QUALITY,
        output_format=IMAGE_OUTPUT_FORMAT,
    )
    data = getattr(response, "data", None) or []
    if not data:
        raise RuntimeError("OpenAI image edit returned no image data.")
    b64_json = getattr(data[0], "b64_json", None)
    if not isinstance(b64_json, str) or not b64_json.strip():
        raise RuntimeError("OpenAI image edit returned empty b64_json.")
    return base64.b64decode(b64_json)


def _save_plan_image_key(*, user_id: str, plan_id: str, workout_image_key: str) -> Tuple[bool, str]:
    """Reload the plan after OpenAI/S3, then set workout_image_key on the matching scheduled item only."""
    item = _load_user_item(user_id)
    weekly_plan = _weekly_plan(item)
    idx = _find_plan_index(weekly_plan, plan_id)
    if idx is None:
        return False, "Plan item was not found after image upload."
    if not str(weekly_plan[idx].get("google_event_id", "")).strip():
        return False, "Plan item is no longer scheduled."
    existing = str(weekly_plan[idx].get("workout_image_key", "")).strip()
    if existing == workout_image_key:
        return True, ""
    try:
        _workout_library_table().update_item(
            Key={"user_id": user_id},
            UpdateExpression=(
                f"SET current_week_plan[{idx}].workout_image_key = :key, updated_at = :updated_at"
            ),
            ConditionExpression=(
                f"current_week_plan[{idx}].id = :plan_id AND "
                f"attribute_exists(current_week_plan[{idx}].google_event_id) AND "
                f"current_week_plan[{idx}].google_event_id <> :empty"
            ),
            ExpressionAttributeValues={
                ":key": workout_image_key,
                ":updated_at": _iso_utc_now(),
                ":plan_id": plan_id,
                ":empty": "",
            },
        )
    except ClientError as err:
        code = str((err.response or {}).get("Error", {}).get("Code", ""))
        if code == "ConditionalCheckFailedException":
            return False, "Plan item is no longer scheduled."
        raise
    return True, ""


def _clear_plan_image_key(*, user_id: str, plan_id: str) -> None:
    item = _load_user_item(user_id)
    weekly_plan = _weekly_plan(item)
    idx = _find_plan_index(weekly_plan, plan_id)
    if idx is None:
        return
    if not str(weekly_plan[idx].get("workout_image_key", "")).strip():
        return
    try:
        _workout_library_table().update_item(
            Key={"user_id": user_id},
            UpdateExpression=(
                f"REMOVE current_week_plan[{idx}].workout_image_key SET updated_at = :updated_at"
            ),
            ConditionExpression=f"current_week_plan[{idx}].id = :plan_id",
            ExpressionAttributeValues={
                ":updated_at": _iso_utc_now(),
                ":plan_id": plan_id,
            },
        )
    except ClientError as err:
        code = str((err.response or {}).get("Error", {}).get("Code", ""))
        if code == "ConditionalCheckFailedException":
            return
        raise


def _handle_delete(*, user_id: str, plan_id: str) -> Dict[str, Any]:
    if not plan_id:
        return _result(status="error", plan_id=plan_id, message="plan_id is required.")
    bucket, _reference_key = _bucket_and_reference()
    s3 = _s3_client()
    deleted = _delete_plan_image_objects(s3, bucket, user_id, plan_id)
    _clear_plan_image_key(user_id=user_id, plan_id=plan_id)
    print(f"[workout-image] delete done plan_id={plan_id} keys={deleted}")
    return _result(status="ok", plan_id=plan_id, deleted=deleted, message="Deleted workout image objects.")


def _handle_cleanup(*, user_id: str, keep_plan_ids: Any) -> Dict[str, Any]:
    if keep_plan_ids is None:
        keep_plan_ids = []
    if not isinstance(keep_plan_ids, list):
        return _result(status="error", message="keep_plan_ids must be a list.")
    keep = {str(entry).strip() for entry in keep_plan_ids if str(entry).strip()}
    bucket, reference_key = _bucket_and_reference()
    prefix = _user_image_prefix(user_id)
    if reference_key.startswith(prefix):
        raise ValueError("Style reference key is under a user workout-image prefix; refusing cleanup.")
    s3 = _s3_client()
    paginator = s3.get_paginator("list_objects_v2")
    to_delete: List[str] = []
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents") or []:
            key = str(obj.get("Key") or "").strip()
            if not key or key == prefix:
                continue
            plan_id = _plan_id_from_image_key(key, prefix)
            if not plan_id:
                continue
            if plan_id not in keep:
                to_delete.append(key)
    deleted = 0
    for key in to_delete:
        _delete_s3_key(s3, bucket, key)
        deleted += 1
    print(f"[workout-image] cleanup keep={len(keep)} deleted={deleted} prefix={prefix}")
    return _result(status="ok", deleted=deleted, message="Cleaned workout images outside keep set.")


def _handle_generate(*, user_id: str, plan_id: str) -> Dict[str, Any]:
    if not plan_id:
        return _result(status="error", plan_id=plan_id, message="plan_id is required.")

    output_key = _output_key(user_id, plan_id)
    print(f"[workout-image] start user={user_id[:8]}… plan_id={plan_id}")

    bucket, reference_key = _bucket_and_reference()
    item = _load_user_item(user_id)
    if not item:
        return _result(status="error", plan_id=plan_id, message="WorkoutLibrary item was not found.")

    weekly_plan = _weekly_plan(item)
    idx = _find_plan_index(weekly_plan, plan_id)
    if idx is None:
        return _result(status="error", plan_id=plan_id, message="Weekly plan item was not found.")
    plan_item = weekly_plan[idx]
    if not str(plan_item.get("google_event_id", "")).strip():
        return _result(
            status="error",
            plan_id=plan_id,
            message="Plan item is not on Google Calendar yet.",
        )
    existing_key = str(plan_item.get("workout_image_key", "")).strip()
    if existing_key:
        print(f"[workout-image] skip existing workout_image_key plan_id={plan_id}")
        return _result(
            status="ok",
            plan_id=plan_id,
            workout_image_key=existing_key,
            generated=False,
            message="Image already linked on the plan item.",
        )

    s3 = _s3_client()
    stale_png = _s3_object_exists(s3, bucket, output_key)
    stale_svg = _s3_object_exists(s3, bucket, _legacy_svg_key(user_id, plan_id))
    if stale_png or stale_svg:
        print(f"[workout-image] stale s3 object without workout_image_key plan_id={plan_id}; regenerating")
        _delete_plan_image_objects(s3, bucket, user_id, plan_id)

    library_workout_id = str(plan_item.get("library_workout_id", "")).strip()
    library_item = _find_library_item(item, library_workout_id)
    if not library_item:
        return _result(
            status="error",
            plan_id=plan_id,
            message="Matching workout library item was not found.",
        )

    workout = _workout_prompt_data(library_item)
    print(
        "[workout-image] prompt fields "
        f"title={bool(workout['title'])} subtitle={bool(workout['subtitle'])} "
        f"warmup={len(workout['warmup'])} main={len(workout['main_steps'])} "
        f"cooldown={len(workout['cooldown'])} notes={int(workout['has_notes'])}"
    )
    prompt = _build_prompt(workout=workout, plan_id=plan_id)
    reference_bytes, filename, content_type = _load_reference_image(s3, bucket, reference_key)
    image_bytes = _generate_image(prompt, reference_bytes, filename, content_type)
    if not image_bytes:
        return _result(status="error", plan_id=plan_id, message="OpenAI returned an empty image.")

    if _scheduled_plan_item(user_id, plan_id) is None:
        print(f"[workout-image] abort after openai: plan no longer scheduled plan_id={plan_id}")
        _delete_plan_image_objects(s3, bucket, user_id, plan_id)
        return _result(
            status="ok",
            plan_id=plan_id,
            generated=False,
            message="Workout was removed during generation.",
        )

    s3.put_object(
        Bucket=bucket,
        Key=output_key,
        Body=image_bytes,
        ContentType="image/png",
    )
    print(f"[workout-image] uploaded key={output_key} png_bytes={len(image_bytes)}")

    saved, save_message = _save_plan_image_key(
        user_id=user_id, plan_id=plan_id, workout_image_key=output_key
    )
    if not saved:
        print(f"[workout-image] discard uploaded image after persist check plan_id={plan_id}")
        _delete_plan_image_objects(s3, bucket, user_id, plan_id)
        return _result(
            status="ok",
            plan_id=plan_id,
            generated=False,
            message=save_message or "Workout was removed during generation.",
        )
    return _result(
        status="ok",
        plan_id=plan_id,
        workout_image_key=output_key,
        generated=True,
    )


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    event = event if isinstance(event, dict) else {}
    user_id = str(event.get("user_id", "")).strip()
    plan_id = str(event.get("plan_id", "")).strip()
    action = str(event.get("action", "")).strip().lower() or "generate"
    if not user_id:
        return _result(status="error", plan_id=plan_id, message="user_id is required.")
    if "/" in user_id or ".." in user_id:
        return _result(status="error", plan_id=plan_id, message="Invalid user_id.")

    print(f"[workout-image] action={action} user={user_id[:8]}… plan_id={plan_id or '-'}")

    try:
        if action == "delete":
            return _handle_delete(user_id=user_id, plan_id=plan_id)
        if action == "cleanup":
            return _handle_cleanup(user_id=user_id, keep_plan_ids=event.get("keep_plan_ids"))
        if action != "generate":
            return _result(status="error", plan_id=plan_id, message=f"Unsupported action: {action}")
        return _handle_generate(user_id=user_id, plan_id=plan_id)
    except APITimeoutError as err:
        print(f"[workout-image] openai timeout: {_safe_err(err)}")
        return _result(status="error", plan_id=plan_id, message="OpenAI image request timed out.")
    except APIConnectionError as err:
        print(f"[workout-image] openai connection error: {_safe_err(err)}")
        return _result(status="error", plan_id=plan_id, message="Failed to reach OpenAI API.")
    except APIError as err:
        print(f"[workout-image] openai api error: {_safe_err(err)}")
        return _result(status="error", plan_id=plan_id, message="OpenAI image request failed.")
    except ClientError as err:
        print(f"[workout-image] aws error: {_safe_err(err)}")
        return _result(status="error", plan_id=plan_id, message="S3 or DynamoDB request failed.")
    except ValueError as err:
        print(f"[workout-image] validation error: {_safe_err(err)}")
        return _result(status="error", plan_id=plan_id, message=_safe_err(err))
    except Exception as err:
        print(f"[workout-image] unexpected error: {_safe_err(err)}\n{traceback.format_exc()}")
        return _result(status="error", plan_id=plan_id, message="Unexpected error while generating workout image.")
