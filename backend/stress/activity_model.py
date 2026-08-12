"""
Shared normalization, favorite keys, and DynamoDB helpers for Stress & Breaks activities.
"""

from __future__ import annotations

import math
import os
from datetime import datetime, timezone
from decimal import Decimal
from hashlib import sha1
from typing import Any, Dict, List, Optional, Set

import boto3

from activity_categories import (
    STRESS_BREAKS_LIBRARY_DEFAULT_TABLE,
    TIMED_ACTIVITY_ID_SET,
    category_label,
)


def iso_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def json_safe(value: Any) -> Any:
    if isinstance(value, list):
        return [json_safe(v) for v in value]
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, Decimal):
        fv = float(value)
        return int(fv) if fv.is_integer() else fv
    return value


def to_dynamodb_safe(value: Any) -> Any:
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, list):
        return [to_dynamodb_safe(v) for v in value]
    if isinstance(value, dict):
        return {str(k): to_dynamodb_safe(v) for k, v in value.items()}
    return value


def safe_string_list(value: Any) -> List[str]:
    if isinstance(value, list):
        return [x.strip() for x in value if isinstance(x, str) and x.strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def to_int(value: Any, default: int = 0) -> int:
    try:
        if isinstance(value, bool):
            return default
        if isinstance(value, Decimal):
            return int(value)
        return int(value)
    except Exception:
        return default


def ceil_duration_minutes(value: Any) -> Optional[int]:
    """
    Convert a duration to whole minutes, rounding UP fractional minutes.
    Example: 7.21 or "7:21" style floats -> 8.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        try:
            num = float(value)
        except Exception:
            return None
        if not math.isfinite(num) or num <= 0:
            return None
        return max(1, int(math.ceil(num)))
    if isinstance(value, str):
        raw = value.strip().lower().replace("minutes", "").replace("minute", "").replace("min", "").strip()
        if not raw:
            return None
        # Support "7:21" -> 7 + 21/60 minutes, ceil to whole minute
        if ":" in raw:
            parts = raw.split(":")
            try:
                minutes = float(parts[0])
                seconds = float(parts[1]) if len(parts) > 1 else 0.0
                total = minutes + (seconds / 60.0)
            except Exception:
                return None
            if not math.isfinite(total) or total <= 0:
                return None
            return max(1, int(math.ceil(total)))
        try:
            num = float(raw)
        except Exception:
            return None
        if not math.isfinite(num) or num <= 0:
            return None
        return max(1, int(math.ceil(num)))
    return None


def library_table():
    table_name = (os.getenv("STRESS_BREAKS_LIBRARY_TABLE") or STRESS_BREAKS_LIBRARY_DEFAULT_TABLE).strip()
    if not table_name:
        raise ValueError("Missing STRESS_BREAKS_LIBRARY_TABLE env var.")
    region = os.getenv("AWS_REGION")
    dynamodb = boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")
    return dynamodb.Table(table_name)


def load_library_item(user_id: str) -> Dict[str, Any]:
    item = library_table().get_item(Key={"user_id": user_id}).get("Item") or {}
    return item if isinstance(item, dict) else {}


def activity_signature(item: Dict[str, Any]) -> str:
    """Stable signature for Timed favorite matching / dedupe (Workouts-style)."""
    kind = str(item.get("kind", "")).strip().lower() or "timed"
    if kind == "flexible":
        # Flexible favorites are keyed by stable catalog id.
        return f"flexible|{str(item.get('id', '')).strip().lower()}"
    material = "|".join(
        [
            "timed",
            str(item.get("title", "")).strip().lower(),
            str(item.get("category", "")).strip().lower().replace(" ", "_"),
            str(ceil_duration_minutes(item.get("duration_minutes")) or to_int(item.get("duration_minutes"), 0)),
        ]
    )
    return sha1(material.encode("utf-8")).hexdigest()


def favorite_key_from_item(item: Dict[str, Any]) -> str:
    return activity_signature(item)


def _normalize_instructions(raw: Any) -> List[str]:
    if isinstance(raw, list):
        out = [str(x).strip() for x in raw if isinstance(x, str) and str(x).strip()]
        return out[:12]
    if isinstance(raw, str) and raw.strip():
        return [raw.strip()]
    return []


def normalize_timed_activity(raw: Dict[str, Any], *, allowed_categories: Optional[Set[str]] = None) -> Optional[Dict[str, Any]]:
    title = str(raw.get("title", "")).strip()
    category = str(raw.get("category", "")).strip().lower().replace(" ", "_")
    if not title or not category:
        return None
    if allowed_categories is not None and category not in allowed_categories:
        return None
    if category not in TIMED_ACTIVITY_ID_SET:
        return None
    duration = ceil_duration_minutes(raw.get("duration_minutes"))
    if duration is None or duration <= 0:
        return None
    summary = str(raw.get("summary_short", "")).strip() or f"A short {category_label(category).lower()} break."
    instructions = _normalize_instructions(raw.get("instructions"))
    if not instructions:
        instructions = [summary]
    item_id = str(raw.get("id", "")).strip()
    # Never persist model-invented external URLs in this phase.
    normalized = {
        "id": item_id,
        "kind": "timed",
        "title": title,
        "category": category,
        "category_label": category_label(category),
        "duration_minutes": duration,
        "summary_short": summary,
        "instructions": instructions,
    }
    return normalized


def normalize_flexible_activity(raw: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    item_id = str(raw.get("id", "")).strip()
    title = str(raw.get("title", "")).strip()
    category = str(raw.get("category", "")).strip().lower().replace(" ", "_")
    if not item_id or not title or not category:
        return None
    summary = str(raw.get("summary_short", "")).strip() or f"A flexible {category_label(category).lower()} break."
    instructions = _normalize_instructions(raw.get("instructions"))
    if not instructions:
        instructions = [summary]
    return {
        "id": item_id,
        "kind": "flexible",
        "title": title,
        "category": category,
        "category_label": category_label(category),
        "duration_minutes": None,
        "summary_short": summary,
        "instructions": instructions,
    }


def normalize_activity(raw: Any, *, allowed_timed_categories: Optional[Set[str]] = None) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("kind", "")).strip().lower()
    if kind == "flexible" or str(raw.get("id", "")).startswith("flex_"):
        return normalize_flexible_activity(raw)
    return normalize_timed_activity(raw, allowed_categories=allowed_timed_categories)


def normalize_activity_list(
    raw: Any,
    *,
    kind: Optional[str] = None,
    allowed_timed_categories: Optional[Set[str]] = None,
) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, Any]] = []
    seen_ids: Set[str] = set()
    seen_sigs: Set[str] = set()
    for entry in raw:
        item = normalize_activity(entry, allowed_timed_categories=allowed_timed_categories)
        if not item:
            continue
        if kind and item.get("kind") != kind:
            continue
        item_id = str(item.get("id", "")).strip()
        sig = activity_signature(item)
        if item_id and item_id in seen_ids:
            continue
        if sig in seen_sigs:
            continue
        if item_id:
            seen_ids.add(item_id)
        seen_sigs.add(sig)
        out.append(item)
    return out


def normalize_favorite_activity(raw: Any) -> Optional[Dict[str, Any]]:
    item = normalize_activity(raw)
    if not item:
        return None
    fav = dict(item)
    fav["favorite_key"] = str(raw.get("favorite_key", "")).strip() if isinstance(raw, dict) else ""
    fav["favorite_key"] = fav["favorite_key"] or favorite_key_from_item(fav)
    return fav


def normalize_favorites(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for entry in raw:
        fav = normalize_favorite_activity(entry)
        if not fav:
            continue
        key = str(fav.get("favorite_key", "")).strip()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(fav)
    return out


def next_timed_id(existing_ids: Set[str]) -> str:
    max_idx = 0
    for item_id in existing_ids:
        if item_id.startswith("timed_") and item_id[6:].isdigit():
            max_idx = max(max_idx, int(item_id[6:]))
    next_idx = max_idx + 1
    while f"timed_{next_idx}" in existing_ids:
        next_idx += 1
    return f"timed_{next_idx}"


def assign_timed_ids(activities: List[Dict[str, Any]], reserved_ids: Optional[Set[str]] = None) -> List[Dict[str, Any]]:
    used = set(reserved_ids or set())
    out: List[Dict[str, Any]] = []
    for item in activities:
        next_item = dict(item)
        item_id = str(next_item.get("id", "")).strip()
        if not item_id or item_id in used or not item_id.startswith("timed_"):
            item_id = next_timed_id(used)
            next_item["id"] = item_id
        used.add(item_id)
        out.append(next_item)
    return out


def merge_timed_preserving_favorites(
    *,
    generated: List[Dict[str, Any]],
    favorite_activities: List[Dict[str, Any]],
    previous_timed: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Workouts-style merge: keep favorited Timed activities (by signature),
    then append new generated activities that are not signature-duplicates.
    """
    fav_keys = {
        str(f.get("favorite_key", "")).strip() or favorite_key_from_item(f)
        for f in favorite_activities
        if str(f.get("kind", "")).strip().lower() != "flexible"
    }
    previous_by_sig = {activity_signature(item): item for item in previous_timed}
    favorites_by_sig = {
        (str(f.get("favorite_key", "")).strip() or favorite_key_from_item(f)): f
        for f in favorite_activities
        if str(f.get("kind", "")).strip().lower() != "flexible"
    }

    preserved: List[Dict[str, Any]] = []
    used_ids: Set[str] = set()
    used_sigs: Set[str] = set()

    for key in fav_keys:
        source = favorites_by_sig.get(key) or previous_by_sig.get(key)
        if not source:
            continue
        item = normalize_timed_activity(source)
        if not item:
            continue
        sig = activity_signature(item)
        if sig in used_sigs:
            continue
        item_id = str(item.get("id", "")).strip()
        if not item_id or item_id in used_ids:
            item_id = next_timed_id(used_ids)
            item["id"] = item_id
        used_ids.add(item_id)
        used_sigs.add(sig)
        preserved.append(item)

    merged = list(preserved)
    for item in generated:
        sig = activity_signature(item)
        if sig in used_sigs:
            continue
        next_item = dict(item)
        item_id = str(next_item.get("id", "")).strip()
        if not item_id or item_id in used_ids:
            item_id = next_timed_id(used_ids)
            next_item["id"] = item_id
        used_ids.add(item_id)
        used_sigs.add(sig)
        merged.append(next_item)
    return merged
