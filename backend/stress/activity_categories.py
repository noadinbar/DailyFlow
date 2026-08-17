"""
Stress & Breaks activity category mapping and Flexible catalog.

Timed categories are OpenAI-generated; Flexible come from this fixed catalog.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Set, Tuple

# Preference ids from Phase 1 Q4 (stress_breaks_preferred_activities)
TIMED_ACTIVITY_IDS: Tuple[str, ...] = ("breathing", "meditation", "stretching")
FLEXIBLE_ACTIVITY_IDS: Tuple[str, ...] = (
    "walking",
    "reading",
    "journaling",
    "music",
    "screen_free",
)

TIMED_ACTIVITY_ID_SET: Set[str] = set(TIMED_ACTIVITY_IDS)
FLEXIBLE_ACTIVITY_ID_SET: Set[str] = set(FLEXIBLE_ACTIVITY_IDS)

CATEGORY_LABELS: Dict[str, str] = {
    "breathing": "Breathing",
    "meditation": "Meditation",
    "stretching": "Stretching",
    "walking": "Walking",
    "reading": "Reading",
    "journaling": "Journaling",
    "music": "Music",
    "screen_free": "Screen-free",
}

# Preferred break duration preference ids -> inclusive minute ranges
DURATION_RANGES: Dict[str, Tuple[int, int]] = {
    "3_5": (3, 5),
    "5_10": (5, 10),
    "10_15": (10, 15),
    "15_20": (15, 20),
}

# When user selected "It depends on my schedule"
DEPENDS_DURATION_MIX: Tuple[int, ...] = (3, 5, 8, 10, 12, 15)

# Target overall library size (soft guidance; Generate prefers per-category caps).
SOFT_LIBRARY_TARGET = 12

# Hard Generate rule: approximately 2–3 Timed activities per relevant category.
ACTIVITIES_PER_TIMED_CATEGORY = 3

STRESS_BREAKS_LIBRARY_DEFAULT_TABLE = "StressBreaksLibrary"

# Fixed Flexible catalog. Stable ids for favorite persistence.
# external_url is intentionally omitted (curated links can be added later).
FLEXIBLE_CATALOG: Tuple[Dict[str, Any], ...] = (
    {
        "id": "flex_walking",
        "category": "walking",
        "title": "Short Walk",
        "summary_short": "A brief walk to reset your focus and loosen up.",
        "instructions": [
            "Step away from your desk or screen.",
            "Walk at an easy, comfortable pace.",
            "Breathe steadily and notice your surroundings.",
            "Return when you feel a bit clearer.",
        ],
    },
    {
        "id": "flex_reading",
        "category": "reading",
        "title": "Quiet Reading",
        "summary_short": "A short reading break to give your mind a gentle shift.",
        "instructions": [
            "Choose something enjoyable, not work-related if possible.",
            "Read without multitasking.",
            "Stop at a natural pause when your break feels complete.",
        ],
    },
    {
        "id": "flex_journaling",
        "category": "journaling",
        "title": "Quick Journal Reset",
        "summary_short": "Write briefly to clear mental clutter and settle your thoughts.",
        "instructions": [
            "Open a notes app or notebook.",
            "Write whatever is on your mind for a few minutes.",
            "Optionally end with one small next step or something you appreciate.",
        ],
    },
    {
        "id": "flex_music",
        "category": "music",
        "title": "Listen to Music",
        "summary_short": "Use music as a calming or energizing pause between tasks.",
        "instructions": [
            "Put on a playlist or song that matches the mood you want.",
            "Close extra tabs or put your phone face-down if needed.",
            "Listen intentionally until you feel ready to continue.",
        ],
    },
    {
        "id": "flex_screen_free",
        "category": "screen_free",
        "title": "Screen-Free Pause",
        "summary_short": "Step away from screens to rest your eyes and attention.",
        "instructions": [
            "Silence or put away screens for this break.",
            "Look into the distance, stretch lightly, or sit quietly.",
            "Return when your eyes and mind feel a bit fresher.",
        ],
    },
)


def category_label(category_id: str) -> str:
    return CATEGORY_LABELS.get(category_id, category_id.replace("_", " ").title())


def split_preferred_activities(preferred: List[str]) -> Tuple[List[str], List[str]]:
    """Return (timed_ids, flexible_ids) preserving preference order and uniqueness."""
    timed: List[str] = []
    flexible: List[str] = []
    seen: Set[str] = set()
    for raw in preferred:
        if not isinstance(raw, str):
            continue
        key = raw.strip()
        if not key or key in seen:
            continue
        seen.add(key)
        if key in TIMED_ACTIVITY_ID_SET:
            timed.append(key)
        elif key in FLEXIBLE_ACTIVITY_ID_SET:
            flexible.append(key)
    return timed, flexible


def duration_minutes_options(duration_prefs: List[str]) -> List[int]:
    """Expand Phase 1 duration prefs into allowed whole-minute values for Timed generation."""
    minutes: List[int] = []
    seen: Set[int] = set()
    depends = False
    for raw in duration_prefs:
        if not isinstance(raw, str):
            continue
        key = raw.strip()
        if key == "depends_on_schedule":
            depends = True
            continue
        rng = DURATION_RANGES.get(key)
        if not rng:
            continue
        lo, hi = rng
        for m in range(lo, hi + 1):
            if m not in seen:
                seen.add(m)
                minutes.append(m)
    if depends or not minutes:
        for m in DEPENDS_DURATION_MIX:
            if m not in seen:
                seen.add(m)
                minutes.append(m)
    return minutes


def flexible_activities_for_prefs(preferred_flexible_ids: List[str]) -> List[Dict[str, Any]]:
    """Snapshot Flexible catalog entries matching the user's selected flexible prefs."""
    wanted = {x for x in preferred_flexible_ids if x in FLEXIBLE_ACTIVITY_ID_SET}
    out: List[Dict[str, Any]] = []
    for entry in FLEXIBLE_CATALOG:
        cat = str(entry.get("category", "")).strip()
        if cat not in wanted:
            continue
        out.append(
            {
                "id": str(entry["id"]),
                "kind": "flexible",
                "title": str(entry["title"]),
                "category": cat,
                "category_label": category_label(cat),
                "duration_minutes": None,
                "summary_short": str(entry["summary_short"]),
                "instructions": list(entry.get("instructions") or []),
            }
        )
    return out


def suggested_timed_count(timed_category_count: int, flexible_count: int = 0) -> int:
    """Exact Generate target: ACTIVITIES_PER_TIMED_CATEGORY per Timed category."""
    del flexible_count  # kept for call-site compatibility; per-category cap is authoritative
    if timed_category_count <= 0:
        return 0
    return timed_category_count * ACTIVITIES_PER_TIMED_CATEGORY


def limit_activities_per_category(
    activities: List[Dict[str, Any]],
    *,
    max_per_category: int = ACTIVITIES_PER_TIMED_CATEGORY,
    protected_ids: Optional[Set[str]] = None,
) -> List[Dict[str, Any]]:
    """
    Enforce max N activities per category.

    Protected ids (favorites / plan refs) are always kept even if a category
    already exceeds the cap; non-protected extras are dropped first.
    """
    if max_per_category <= 0:
        return []
    protected = {x for x in (protected_ids or set()) if x}
    by_cat: Dict[str, List[Dict[str, Any]]] = {}
    order: List[str] = []
    for item in activities:
        if not isinstance(item, dict):
            continue
        cat = str(item.get("category", "")).strip().lower().replace(" ", "_") or "_unknown"
        if cat not in by_cat:
            by_cat[cat] = []
            order.append(cat)
        by_cat[cat].append(item)

    out: List[Dict[str, Any]] = []
    for cat in order:
        group = by_cat[cat]
        keep: List[Dict[str, Any]] = []
        extras: List[Dict[str, Any]] = []
        for item in group:
            item_id = str(item.get("id", "")).strip()
            if item_id and item_id in protected:
                keep.append(item)
            else:
                extras.append(item)
        remaining = max(0, max_per_category - len(keep))
        out.extend(keep)
        out.extend(extras[:remaining])
    return out
