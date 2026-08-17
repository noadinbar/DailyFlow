"""
Potentially Stressful Periods insights for Stress & Breaks.

Deterministic analysis of BusyBlocks + questionnaire preferences.
Does not schedule Weekly Break Plan items or create calendar events.
Does not call OpenAI (facts stay grounded in provided BusyBlocks).
"""

from __future__ import annotations

from datetime import date
from typing import Any, Dict, List, Optional, Sequence, Tuple

from activity_categories import CATEGORY_LABELS, FLEXIBLE_ACTIVITY_ID_SET, TIMED_ACTIVITY_ID_SET

DAY_NAMES = (
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
)

TIME_OF_DAY_WINDOWS: Dict[str, Tuple[int, int]] = {
    "morning": (6 * 60, 11 * 60),
    "midday": (11 * 60, 15 * 60),
    "afternoon": (15 * 60, 18 * 60),
    "evening": (18 * 60, 22 * 60),
}

TIME_OF_DAY_LABELS: Dict[str, str] = {
    "morning": "morning",
    "midday": "midday",
    "afternoon": "afternoon",
    "evening": "evening",
}

DURATION_DISPLAY_MINUTES: Dict[str, int] = {
    "3_5": 5,
    "5_10": 10,
    "10_15": 10,
    "15_20": 15,
    "depends_on_schedule": 10,
}

ACTIVITY_PHRASES: Dict[str, str] = {
    "breathing": "a short breathing exercise",
    "meditation": "a brief mindfulness break",
    "stretching": "a short stretching break",
    "walking": "a short walk",
    "reading": "a quiet reading pause",
    "journaling": "a quick journaling reset",
    "music": "a short music break",
    "screen_free": "a brief screen-free pause",
}

# Absolute floors — below this, a day is not treated as "particularly busy".
MIN_BUSY_MINUTES_FOR_INSIGHT = 90
MIN_BLOCKS_FOR_INSIGHT = 2
MIN_SCORE_FOR_INSIGHT = 4.0
MAX_INSIGHTS = 3


def _parse_hh_mm_minutes(value: str) -> Optional[int]:
    raw = str(value or "").strip()
    if len(raw) < 5 or raw[2] != ":":
        return None
    try:
        hour = int(raw[0:2])
        minute = int(raw[3:5])
    except Exception:
        return None
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        return None
    return hour * 60 + minute


def _safe_string_list(raw: Any) -> List[str]:
    if not isinstance(raw, list):
        return []
    out: List[str] = []
    for value in raw:
        if isinstance(value, str) and value.strip():
            cleaned = value.strip()
            if cleaned not in out:
                out.append(cleaned)
    return out


def _day_name(iso_day: str) -> str:
    try:
        return DAY_NAMES[date.fromisoformat(iso_day).weekday()]
    except Exception:
        return iso_day


def _weekday_pref_id(iso_day: str) -> str:
    try:
        return DAY_NAMES[date.fromisoformat(iso_day).weekday()].lower()
    except Exception:
        return ""


def _time_of_day_for_minutes(mid_m: int) -> str:
    for key, (start_m, end_m) in TIME_OF_DAY_WINDOWS.items():
        if start_m <= mid_m < end_m:
            return key
    if mid_m < 6 * 60:
        return "morning"
    return "evening"


def _normalize_blocks(busy_blocks: Sequence[Dict[str, Any]], week_start: str, week_end: str) -> List[Dict[str, Any]]:
    cleaned: List[Dict[str, Any]] = []
    for block in busy_blocks:
        if not isinstance(block, dict):
            continue
        block_date = str(block.get("date", "")).strip()
        if not block_date or block_date < week_start or block_date > week_end:
            continue
        start_m = _parse_hh_mm_minutes(str(block.get("start_time", "")))
        end_m = _parse_hh_mm_minutes(str(block.get("end_time", "")))
        if start_m is None or end_m is None or end_m <= start_m:
            continue
        cleaned.append(
            {
                "date": block_date,
                "start_m": start_m,
                "end_m": end_m,
                "duration_m": end_m - start_m,
            }
        )
    cleaned.sort(key=lambda b: (b["date"], b["start_m"], b["end_m"]))
    return cleaned


def _analyze_day(blocks: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not blocks:
        return {
            "block_count": 0,
            "busy_minutes": 0,
            "longest_block": 0,
            "back_to_back": 0,
            "small_gaps": 0,
            "peak_tod": "afternoon",
            "peak_tod_minutes": 0,
        }
    busy_minutes = sum(int(b["duration_m"]) for b in blocks)
    longest_block = max(int(b["duration_m"]) for b in blocks)
    back_to_back = 0
    small_gaps = 0
    for prev, nxt in zip(blocks, blocks[1:]):
        gap = int(nxt["start_m"]) - int(prev["end_m"])
        if 0 <= gap < 15:
            back_to_back += 1
        elif 15 <= gap < 30:
            small_gaps += 1

    tod_minutes: Dict[str, int] = {k: 0 for k in TIME_OF_DAY_WINDOWS}
    for block in blocks:
        mid = (int(block["start_m"]) + int(block["end_m"])) // 2
        tod = _time_of_day_for_minutes(mid)
        tod_minutes[tod] = tod_minutes.get(tod, 0) + int(block["duration_m"])
    peak_tod = max(tod_minutes.items(), key=lambda kv: kv[1])[0] if tod_minutes else "afternoon"

    return {
        "block_count": len(blocks),
        "busy_minutes": busy_minutes,
        "longest_block": longest_block,
        "back_to_back": back_to_back,
        "small_gaps": small_gaps,
        "peak_tod": peak_tod,
        "peak_tod_minutes": tod_minutes.get(peak_tod, 0),
    }


def _score_day(
    stats: Dict[str, Any],
    *,
    iso_day: str,
    prefs: Dict[str, Any],
) -> Tuple[float, str]:
    """Return (score, primary_reason_code)."""
    factors = set(prefs.get("busy_day_factors") or [])
    busiest_days = set(prefs.get("busiest_days") or [])
    busiest_times = set(prefs.get("busiest_times") or [])

    busy_minutes = int(stats["busy_minutes"])
    block_count = int(stats["block_count"])
    longest = int(stats["longest_block"])
    back_to_back = int(stats["back_to_back"])
    small_gaps = int(stats["small_gaps"])
    peak_tod = str(stats["peak_tod"])

    score = 0.0
    reasons: List[Tuple[float, str]] = []

    load_weight = 1.4 if "many_activities" in factors else 1.0
    load_score = (busy_minutes / 60.0) * load_weight + max(0, block_count - 1) * 0.8 * load_weight
    reasons.append((load_score, "high_load"))

    long_weight = 1.5 if "long_continuous" in factors else 1.0
    if longest >= 120:
        reasons.append((2.5 * long_weight, "long_block"))
    elif longest >= 90:
        reasons.append((1.5 * long_weight, "long_block"))

    btb_weight = 1.6 if "back_to_back" in factors else 1.0
    if back_to_back > 0:
        reasons.append((back_to_back * 1.8 * btb_weight, "back_to_back"))

    gap_weight = 1.5 if "few_free_gaps" in factors else 1.0
    if small_gaps + back_to_back >= 2:
        reasons.append((1.4 * gap_weight, "few_gaps"))

    if "early_mornings" in factors and peak_tod == "morning":
        reasons.append((1.2, "high_load"))
    if "late_evenings" in factors and peak_tod == "evening":
        reasons.append((1.2, "high_load"))

    day_pref = _weekday_pref_id(iso_day)
    if day_pref and day_pref in busiest_days:
        score += 1.5
    if "changes_weekly" not in busiest_days and busiest_days and day_pref not in busiest_days:
        score -= 0.3

    if peak_tod in busiest_times:
        score += 1.0
    if "varies" not in busiest_times and busiest_times and peak_tod not in busiest_times:
        score -= 0.2

    score += sum(r[0] for r in reasons)
    primary = max(reasons, key=lambda r: r[0])[1] if reasons else "high_load"
    return score, primary


def _pick_duration_minutes(prefs: Dict[str, Any]) -> int:
    durations = prefs.get("durations") or []
    for dur_id in durations:
        if dur_id in DURATION_DISPLAY_MINUTES:
            return DURATION_DISPLAY_MINUTES[dur_id]
    return 10


def _preferred_categories(prefs: Dict[str, Any], library_categories: Sequence[str]) -> List[str]:
    preferred = [c for c in (prefs.get("preferred_activities") or []) if c in CATEGORY_LABELS]
    library_set = {c for c in library_categories if c in CATEGORY_LABELS}
    # Prefer intersection with library when available.
    ordered: List[str] = []
    for cat in preferred:
        if cat in library_set and cat not in ordered:
            ordered.append(cat)
    for cat in preferred:
        if cat not in ordered:
            ordered.append(cat)
    if not ordered:
        for cat in library_categories:
            if cat in CATEGORY_LABELS and cat not in ordered:
                ordered.append(cat)
    if not ordered:
        ordered = ["breathing", "stretching", "walking"]
    return ordered


def _headline(day_label: str, tod_label: str, reason: str) -> str:
    if reason == "back_to_back":
        return f"{day_label} has several back-to-back commitments."
    if reason == "long_block":
        return f"{day_label} includes a long continuous busy stretch."
    if reason == "few_gaps":
        return f"{day_label} looks packed, with limited gaps between blocks."
    return f"{day_label} {tod_label} looks especially busy."


def _recommendation_text(
    *,
    category: str,
    duration_minutes: int,
    reason: str,
) -> str:
    phrase = ACTIVITY_PHRASES.get(category, "a short calming break")
    label = CATEGORY_LABELS.get(category, category.replace("_", " ").title())
    if reason == "back_to_back":
        return f"Recommended: take a {duration_minutes}-minute {label.lower()} break between scheduled blocks."
    if reason == "long_block":
        return f"Recommended: add {phrase} (~{duration_minutes} min) before or after the long stretch."
    if reason == "few_gaps":
        return f"Recommended: choose a short {label.lower()} activity ({duration_minutes} min) in a small free window."
    return f"Recommended: take a {duration_minutes}-minute calming break — try {phrase}."


def build_stressful_periods_insights(
    *,
    week_start: str,
    week_end: str,
    busy_blocks: Sequence[Dict[str, Any]],
    preferences: Dict[str, Any],
    library_categories: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    """
    Build 0–3 insight objects for the visible week.

    preferences keys: busiest_times, busiest_days, busy_day_factors,
    preferred_activities, durations (lists of preference ids).
    """
    blocks = _normalize_blocks(busy_blocks, week_start, week_end)
    prefs = {
        "busiest_times": _safe_string_list(preferences.get("busiest_times")),
        "busiest_days": _safe_string_list(preferences.get("busiest_days")),
        "busy_day_factors": _safe_string_list(preferences.get("busy_day_factors")),
        "preferred_activities": _safe_string_list(preferences.get("preferred_activities")),
        "durations": _safe_string_list(preferences.get("durations")),
    }
    categories = _preferred_categories(prefs, library_categories or [])
    duration_minutes = _pick_duration_minutes(prefs)

    empty_payload = {
        "week_start": week_start,
        "week_end": week_end,
        "busy_block_count": len(blocks),
        "insights": [],
        "empty_message": "No particularly busy periods were identified this week.",
    }

    if len(blocks) < 2:
        return empty_payload

    by_day: Dict[str, List[Dict[str, Any]]] = {}
    for block in blocks:
        by_day.setdefault(str(block["date"]), []).append(block)

    scored: List[Dict[str, Any]] = []
    for iso_day, day_blocks in by_day.items():
        stats = _analyze_day(day_blocks)
        if int(stats["busy_minutes"]) < MIN_BUSY_MINUTES_FOR_INSIGHT and int(stats["block_count"]) < MIN_BLOCKS_FOR_INSIGHT + 1:
            # Require meaningful load: either enough minutes or enough blocks.
            if int(stats["busy_minutes"]) < MIN_BUSY_MINUTES_FOR_INSIGHT and int(stats["block_count"]) < 3:
                continue
        score, reason = _score_day(stats, iso_day=iso_day, prefs=prefs)
        if score < MIN_SCORE_FOR_INSIGHT:
            continue
        if int(stats["busy_minutes"]) < 60 and int(stats["block_count"]) < 3:
            continue
        scored.append(
            {
                "iso_day": iso_day,
                "stats": stats,
                "score": score,
                "reason": reason,
            }
        )

    if not scored:
        return empty_payload

    scored.sort(key=lambda row: (-float(row["score"]), str(row["iso_day"])))
    top = scored[:MAX_INSIGHTS]

    insights: List[Dict[str, Any]] = []
    for idx, row in enumerate(top):
        iso_day = str(row["iso_day"])
        stats = row["stats"]
        reason = str(row["reason"])
        tod = str(stats["peak_tod"])
        tod_label = TIME_OF_DAY_LABELS.get(tod, tod)
        day_label = _day_name(iso_day)
        category = categories[idx % len(categories)]
        # Keep category ids valid for Timed/Flexible sets only.
        if category not in TIMED_ACTIVITY_ID_SET and category not in FLEXIBLE_ACTIVITY_ID_SET:
            category = "breathing"
        insight = {
            "id": f"insight_{idx + 1}",
            "day": iso_day,
            "day_label": day_label,
            "period_label": tod_label,
            "headline": _headline(day_label, tod_label, reason),
            "recommendation": _recommendation_text(
                category=category,
                duration_minutes=duration_minutes,
                reason=reason,
            ),
            "suggested_category": category,
            "suggested_category_label": CATEGORY_LABELS.get(category, category),
            "suggested_duration_minutes": duration_minutes,
            "reason_code": reason,
        }
        insights.append(insight)

    return {
        "week_start": week_start,
        "week_end": week_end,
        "busy_block_count": len(blocks),
        "insights": insights,
        "empty_message": None if insights else "No particularly busy periods were identified this week.",
    }
