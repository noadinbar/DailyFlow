"""
Shared scheduling overlap checks for Workouts, Meals, and Stress.

BusyBlocks and DailyFlow-created events stay separate sources. Callers pass
BusyBlocks from their existing query and merge them with calendar-linked
DailyFlow slots loaded here. Overlap uses the existing half-open rule:
max(start, other_start) < min(end, other_end). Touching endpoints are allowed.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import boto3

OVERLAP_ERROR_MESSAGE = "This time overlaps with another scheduled event. Please choose a different time."
WORKOUT_LIBRARY_DEFAULT_TABLE = "WorkoutLibrary"
MEALS_DEFAULT_TABLE = "MealsAndGroceries"
STRESS_BREAKS_LIBRARY_DEFAULT_TABLE = "StressBreaksLibrary"


def _dynamodb_resource():
    region = os.getenv("AWS_REGION")
    return boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")


def _table(env_name: str, default_name: str = "") -> Any:
    table_name = (os.getenv(env_name) or default_name).strip()
    if not table_name:
        return None
    return _dynamodb_resource().Table(table_name)


def _safe_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _hh_mm(value: Any) -> str:
    raw = _safe_string(value)
    if len(raw) >= 5 and raw[2] == ":":
        return raw[:5]
    return ""


def _has_google_event(item: Dict[str, Any]) -> bool:
    return bool(_safe_string(item.get("google_event_id")))


def _in_week(day_iso: str, week_start: str, week_end: str) -> bool:
    return bool(day_iso) and week_start <= day_iso <= week_end


def _slot(day_iso: str, start_time: str, end_time: str) -> Optional[Dict[str, str]]:
    start_hhmm = _hh_mm(start_time)
    end_hhmm = _hh_mm(end_time)
    if not day_iso or not start_hhmm or not end_hhmm:
        return None
    return {"date": day_iso, "start_time": start_hhmm, "end_time": end_hhmm}


def _legacy_utc_week_start_iso() -> str:
    now_utc = datetime.now(timezone.utc).date()
    return (now_utc - timedelta(days=(now_utc.weekday() + 1) % 7)).isoformat()


def _append_slot(out: List[Dict[str, str]], slot: Optional[Dict[str, str]]) -> None:
    if not slot:
        return
    key = (slot["date"], slot["start_time"], slot["end_time"])
    if key in {(item["date"], item["start_time"], item["end_time"]) for item in out}:
        return
    out.append(slot)


def _load_workout_calendar_slots(user_id: str, week_start: str, week_end: str) -> List[Dict[str, str]]:
    table = _table("WORKOUT_LIBRARY_TABLE", WORKOUT_LIBRARY_DEFAULT_TABLE)
    if table is None:
        return []
    item = table.get_item(Key={"user_id": user_id}).get("Item") or {}
    if not isinstance(item, dict):
        return []
    saved_start = _safe_string(item.get("current_week_plan_week_start"))
    saved_end = _safe_string(item.get("current_week_plan_week_end"))
    if saved_start != week_start or saved_end != week_end:
        return []
    out: List[Dict[str, str]] = []
    for raw in item.get("current_week_plan") or []:
        if not isinstance(raw, dict) or not _has_google_event(raw):
            continue
        day_iso = _safe_string(raw.get("recommended_day"))
        if not _in_week(day_iso, week_start, week_end):
            continue
        _append_slot(out, _slot(day_iso, raw.get("recommended_start_time"), raw.get("recommended_end_time")))
    return out


def _load_meal_calendar_slots(user_id: str, week_start: str, week_end: str) -> List[Dict[str, str]]:
    table = _table("MEALS_TABLE", MEALS_DEFAULT_TABLE)
    if table is None:
        return []
    week_keys = [f"WEEK#{week_start}"]
    legacy_start = _legacy_utc_week_start_iso()
    if legacy_start != week_start:
        week_keys.append(f"WEEK#{legacy_start}")
    seen_ids = set()
    out: List[Dict[str, str]] = []
    for week_key in week_keys:
        week_item = table.get_item(Key={"user_id": user_id, "record_key": week_key}).get("Item") or {}
        if not isinstance(week_item, dict):
            continue
        for raw in week_item.get("saved_meals_this_week") or []:
            if not isinstance(raw, dict) or not _has_google_event(raw):
                continue
            meal_id = _safe_string(raw.get("id"))
            day_iso = _safe_string(raw.get("date"))
            if meal_id and meal_id in seen_ids:
                continue
            if not _in_week(day_iso, week_start, week_end):
                continue
            if meal_id:
                seen_ids.add(meal_id)
            _append_slot(out, _slot(day_iso, raw.get("start_time"), raw.get("end_time")))
    return out


def _load_break_calendar_slots(user_id: str, week_start: str, week_end: str) -> List[Dict[str, str]]:
    table = _table("STRESS_BREAKS_LIBRARY_TABLE", STRESS_BREAKS_LIBRARY_DEFAULT_TABLE)
    if table is None:
        return []
    item = table.get_item(Key={"user_id": user_id}).get("Item") or {}
    if not isinstance(item, dict):
        return []
    saved_start = _safe_string(item.get("current_week_plan_week_start"))
    saved_end = _safe_string(item.get("current_week_plan_week_end"))
    if saved_start != week_start or saved_end != week_end:
        return []
    out: List[Dict[str, str]] = []
    for raw in item.get("current_week_plan") or []:
        if not isinstance(raw, dict) or not _has_google_event(raw):
            continue
        day_iso = _safe_string(raw.get("recommended_day"))
        if not _in_week(day_iso, week_start, week_end):
            continue
        _append_slot(
            out,
            _slot(day_iso, raw.get("recommended_start_time"), raw.get("recommended_end_time")),
        )
    return out


def load_dailyflow_calendar_slots(user_id: str, week_start: str, week_end: str) -> List[Dict[str, str]]:
    """Calendar-linked DailyFlow events from Workouts, Meals, and Stress. Not BusyBlocks."""
    out: List[Dict[str, str]] = []
    loaders = (
        ("workouts", _load_workout_calendar_slots),
        ("meals", _load_meal_calendar_slots),
        ("stress", _load_break_calendar_slots),
    )
    for label, loader in loaders:
        try:
            for slot in loader(user_id, week_start, week_end):
                _append_slot(out, slot)
        except Exception as err:
            print(f"[scheduling-conflicts] {label} calendar slots failed: {err}")
    return out


def occupied_slots_for_week(
    user_id: str,
    week_start: str,
    week_end: str,
    busy_blocks: List[Dict[str, Any]],
) -> List[Dict[str, str]]:
    """BusyBlocks plus calendar-linked DailyFlow events, same slot shape for _slot_is_valid."""
    return merge_occupied_slots(busy_blocks, load_dailyflow_calendar_slots(user_id, week_start, week_end))


def merge_occupied_slots(*groups: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    for group in groups:
        for raw in group or []:
            if not isinstance(raw, dict):
                continue
            _append_slot(out, _slot(_safe_string(raw.get("date")), raw.get("start_time"), raw.get("end_time")))
    return out
