"""
Curated YouTube whitelist for Stress & Breaks Timed activities.

OpenAI must NEVER invent or return YouTube URLs / video IDs.
All video metadata comes from this backend-owned catalog.

Supported YouTube categories: breathing, meditation, music.
Stretching / walking are intentionally excluded from this catalog.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from activity_categories import category_label

# Design target: ~10 selectable videos per YouTube-supported category.
TARGET_VIDEOS_PER_CATEGORY = 10
# How many activities to surface per relevant YouTube category on Generate.
ACTIVITIES_PER_YOUTUBE_CATEGORY = 3

YOUTUBE_CATEGORIES: Tuple[str, ...] = ("breathing", "meditation", "music")
YOUTUBE_CATEGORY_SET: Set[str] = set(YOUTUBE_CATEGORIES)

# Exact duration_seconds verified from YouTube lengthSeconds where verified=True.
# duration_minutes used by DailyFlow = ceil(duration_seconds / 60).
# Entries with verified=False must not invent URLs; they are ignored by selection.
CURATED_YOUTUBE_VIDEOS: Tuple[Dict[str, Any], ...] = (
    # --- Breathing (~10 verified) ---
    {
        "id": "yt_breathing_box_nhs",
        "category": "breathing",
        "video_title": "Box breathing relaxation technique: how to calm feelings of stress or anxiety",
        "youtube_url": "https://www.youtube.com/watch?v=tEmt1Znux58",
        "duration_seconds": 167,
        "verified": True,
        "tags": ("box_breathing", "anxiety"),
    },
    {
        "id": "yt_breathing_box_feelinghealing_4444",
        "category": "breathing",
        "video_title": "Guided Box Breathing - 5 Minute Meditation (4-4-4-4)",
        "youtube_url": "https://www.youtube.com/watch?v=aPYmZOhJF5Q",
        "duration_seconds": 326,
        "verified": True,
        "tags": ("box_breathing",),
    },
    {
        "id": "yt_breathing_box_sandstone",
        "category": "breathing",
        "video_title": "Box Breathing Technique and Exercise | 5 Minute | 4 4 4 4",
        "youtube_url": "https://www.youtube.com/watch?v=y0aL1n2SODc",
        "duration_seconds": 306,
        "verified": True,
        "tags": ("box_breathing",),
    },
    {
        "id": "yt_breathing_guided_5min",
        "category": "breathing",
        "video_title": "Breathing Exercises with Guided Meditation | 5 Minutes",
        "youtube_url": "https://www.youtube.com/watch?v=DbDoBzGY3vo",
        "duration_seconds": 360,
        "verified": True,
        "tags": ("guided",),
    },
    {
        "id": "yt_breathing_box_mindful",
        "category": "breathing",
        "video_title": "5 Minute Box Breath Meditation",
        "youtube_url": "https://www.youtube.com/watch?v=0VPbJ7N1rI0",
        "duration_seconds": 430,
        "verified": True,
        "tags": ("box_breathing",),
    },
    {
        "id": "yt_breathing_478_10min",
        "category": "breathing",
        "video_title": "4-7-8 Calm Breathing Exercise | 10 Minutes of Deep Relaxation",
        "youtube_url": "https://www.youtube.com/watch?v=LiUnFJ8P4gM",
        "duration_seconds": 633,
        "verified": True,
        "tags": ("4_7_8",),
    },
    {
        "id": "yt_breathing_box_feelinghealing_5555",
        "category": "breathing",
        "video_title": "Guided Box Breathing - 5 Minute Meditation (5-5-5-5)",
        "youtube_url": "https://www.youtube.com/watch?v=zq07gbFLCAs",
        "duration_seconds": 328,
        "verified": True,
        "tags": ("box_breathing",),
    },
    {
        "id": "yt_breathing_box_beginner_pace",
        "category": "breathing",
        "video_title": "5 Minutes Box Breathing Relaxation Exercise | Beginner Pace",
        "youtube_url": "https://www.youtube.com/watch?v=oN8xV3Kb5-Q",
        "duration_seconds": 413,
        "verified": True,
        "tags": ("box_breathing", "beginner"),
    },
    {
        "id": "yt_breathing_ucla_meditation",
        "category": "breathing",
        "video_title": "Breathing Meditation | UCLA Mindful Awareness Research Center",
        "youtube_url": "https://www.youtube.com/watch?v=YFSc7Ck0Ao0",
        "duration_seconds": 332,
        "verified": True,
        "tags": ("ucla", "mindful"),
    },
    {
        "id": "yt_breathing_deep_15min_city_of_hope",
        "category": "breathing",
        "video_title": "15 Minute Deep Breathing Exercise | City of Hope",
        "youtube_url": "https://www.youtube.com/watch?v=F28MGLlpP90",
        "duration_seconds": 836,
        "verified": True,
        "tags": ("deep_breathing",),
    },
    # --- Meditation (~10 verified) ---
    {
        "id": "yt_meditation_breathing_space",
        "category": "meditation",
        "video_title": "Mindfulness Meditation 3 Minute Breathing Space",
        "youtube_url": "https://www.youtube.com/watch?v=rOne1P0TKL8",
        "duration_seconds": 208,
        "verified": True,
        "tags": ("mindfulness", "short"),
    },
    {
        "id": "yt_meditation_desk_5min",
        "category": "meditation",
        "video_title": "5 minute Guided Meditation at your Desk | Sarah Beth Yoga",
        "youtube_url": "https://www.youtube.com/watch?v=Z9v8kakpAAs",
        "duration_seconds": 300,
        "verified": True,
        "tags": ("desk", "guided"),
    },
    {
        "id": "yt_meditation_goodful_5min",
        "category": "meditation",
        "video_title": "5-Minute Meditation You Can Do Anywhere | Goodful",
        "youtube_url": "https://www.youtube.com/watch?v=inpok4MKVLM",
        "duration_seconds": 317,
        "verified": True,
        "tags": ("guided",),
    },
    {
        "id": "yt_meditation_cosmic_8min",
        "category": "meditation",
        "video_title": "Relaxing Cosmic Escape | 8-Minute Meditation & Ambient Journey",
        "youtube_url": "https://www.youtube.com/watch?v=dCD5yuRKuxQ",
        "duration_seconds": 483,
        "verified": True,
        "tags": ("ambient",),
    },
    {
        "id": "yt_meditation_mindfulness_10min",
        "category": "meditation",
        "video_title": "Mindfulness Meditation - Guided 10 Minutes",
        "youtube_url": "https://www.youtube.com/watch?v=6p_yaNFSYao",
        "duration_seconds": 588,
        "verified": True,
        "tags": ("mindfulness",),
    },
    {
        "id": "yt_meditation_anxiety_10min",
        "category": "meditation",
        "video_title": "10-Minute Meditation For Anxiety | Goodful",
        "youtube_url": "https://www.youtube.com/watch?v=O-6f5wQXSu8",
        "duration_seconds": 620,
        "verified": True,
        "tags": ("anxiety",),
    },
    {
        "id": "yt_meditation_stress_10min",
        "category": "meditation",
        "video_title": "10-Minute Meditation For Stress | Goodful",
        "youtube_url": "https://www.youtube.com/watch?v=z6X5oEIg6Ak",
        "duration_seconds": 618,
        "verified": True,
        "tags": ("stress",),
    },
    {
        "id": "yt_meditation_box_beginner",
        "category": "meditation",
        "video_title": "Box-Breathing Meditation (Beginner 5-Minutes)",
        "youtube_url": "https://www.youtube.com/watch?v=DM0KRDO5YDg",
        "duration_seconds": 461,
        "verified": True,
        "tags": ("box_breathing", "beginner"),
    },
    {
        "id": "yt_meditation_wim_hof_breathing",
        "category": "meditation",
        "video_title": "Guided Wim Hof Method Breathing",
        "youtube_url": "https://www.youtube.com/watch?v=tybOi4hjZFQ",
        "duration_seconds": 660,
        "verified": True,
        "tags": ("breathwork",),
    },
    {
        "id": "yt_meditation_heartbeat_5min",
        "category": "meditation",
        "video_title": "5-Minute Meditation - Heartbeat of ONE",
        "youtube_url": "https://www.youtube.com/watch?v=fRxjpUCtQPI",
        "duration_seconds": 300,
        "verified": True,
        "tags": ("short", "guided"),
    },
    # --- Music / calming audio (verified short break-length tracks) ---
    # Pool is intentionally smaller until more short tracks are curator-verified.
    {
        "id": "yt_music_weightless",
        "category": "music",
        "video_title": "Marconi Union - Weightless (Official Video)",
        "youtube_url": "https://www.youtube.com/watch?v=UfcAVejslrU",
        "duration_seconds": 489,
        "verified": True,
        "tags": ("ambient", "calm"),
    },
    {
        "id": "yt_music_relaxing_piano_10min",
        "category": "music",
        "video_title": "4 Beautiful Soundtracks | Relaxing Piano [10min]",
        "youtube_url": "https://www.youtube.com/watch?v=t_Kd_G7p6ZQ",
        "duration_seconds": 613,
        "verified": True,
        "tags": ("piano",),
    },
    {
        "id": "yt_music_moonlight_sonata",
        "category": "music",
        "video_title": "Beethoven - Moonlight Sonata (FULL)",
        "youtube_url": "https://www.youtube.com/watch?v=4Tr0otuiQuU",
        "duration_seconds": 900,
        "verified": True,
        "tags": ("classical", "piano"),
    },
    {
        "id": "yt_music_somewhere_over_rainbow",
        "category": "music",
        "video_title": "OFFICIAL Somewhere over the Rainbow - Israel Kamakawiwoʻole",
        "youtube_url": "https://www.youtube.com/watch?v=V1bFr2SWP1I",
        "duration_seconds": 227,
        "verified": True,
        "tags": ("calm", "song"),
    },
    {
        "id": "yt_music_clair_de_lune",
        "category": "music",
        "video_title": "CLAUDE DEBUSSY: CLAIR DE LUNE",
        "youtube_url": "https://www.youtube.com/watch?v=CvFH_6DNRCY",
        "duration_seconds": 302,
        "verified": True,
        "tags": ("classical", "piano"),
    },
    {
        "id": "yt_music_chopin_nocturne",
        "category": "music",
        "video_title": "Chopin - Nocturne op.9 No.2",
        "youtube_url": "https://www.youtube.com/watch?v=9E6b3swbnWg",
        "duration_seconds": 269,
        "verified": True,
        "tags": ("classical", "piano"),
    },
)

_BY_ID: Dict[str, Dict[str, Any]] = {str(v["id"]): v for v in CURATED_YOUTUBE_VIDEOS}
_STRIP_URL_KEYS = (
    "external_url",
    "url",
    "video_url",
    "youtube_url",
    "youtube_title",
    "youtube_link",
    "video_title",
)


def duration_minutes_from_seconds(duration_seconds: int) -> int:
    """Round video length UP to the next whole minute (exact minute stays as-is)."""
    secs = int(duration_seconds)
    if secs <= 0:
        return 1
    return max(1, int(math.ceil(secs / 60.0)))


def get_curated_video(video_id: str) -> Optional[Dict[str, Any]]:
    entry = _BY_ID.get(str(video_id or "").strip())
    if not entry:
        return None
    if entry.get("verified") is False:
        return None
    url = str(entry.get("youtube_url", "")).strip()
    if not url.startswith("https://www.youtube.com/watch?v="):
        return None
    return dict(entry)


def strip_untrusted_video_fields(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Remove any model-supplied or untrusted URL/title fields before normalize."""
    return {k: v for k, v in raw.items() if k not in _STRIP_URL_KEYS}


def _catalog_fields(entry: Dict[str, Any]) -> Dict[str, Any]:
    seconds = int(entry["duration_seconds"])
    return {
        "youtube_video_id": str(entry["id"]),
        "youtube_url": str(entry["youtube_url"]),
        "youtube_title": str(entry["video_title"]),
        "duration_minutes": duration_minutes_from_seconds(seconds),
    }


def hydrate_curated_youtube(activity: Dict[str, Any]) -> Dict[str, Any]:
    """
    Re-resolve YouTube metadata from the whitelist only.

    If youtube_video_id is missing or not in the catalog, the activity has no video.
    Duration is forced from the catalog when a video is attached.
    """
    out = dict(activity)
    for key in ("youtube_url", "youtube_title", "youtube_video_id"):
        out.pop(key, None)

    video_id = str(activity.get("youtube_video_id", "")).strip()
    entry = get_curated_video(video_id) if video_id else None
    category = str(out.get("category", "")).strip().lower().replace(" ", "_")
    if not entry or str(entry.get("category", "")).strip() != category:
        return out

    out.update(_catalog_fields(entry))
    return out


def _is_selectable(entry: Dict[str, Any]) -> bool:
    if entry.get("verified") is False:
        return False
    url = str(entry.get("youtube_url", "")).strip()
    if not url.startswith("https://www.youtube.com/watch?v="):
        return False
    try:
        secs = int(entry.get("duration_seconds") or 0)
    except Exception:
        return False
    return secs > 0


def videos_for_category(category: str) -> List[Dict[str, Any]]:
    cat = str(category or "").strip().lower().replace(" ", "_")
    return [dict(v) for v in CURATED_YOUTUBE_VIDEOS if str(v.get("category", "")).strip() == cat and _is_selectable(v)]


def normalize_recent_youtube_by_category(raw: Any) -> Dict[str, List[str]]:
    """Parse StressBreaksLibrary.recent_youtube_by_category into {category: [video_id,...]}."""
    out: Dict[str, List[str]] = {c: [] for c in YOUTUBE_CATEGORIES}
    if not isinstance(raw, dict):
        return out
    known_ids = set(_BY_ID.keys())
    for cat in YOUTUBE_CATEGORIES:
        values = raw.get(cat)
        if not isinstance(values, list):
            continue
        cleaned: List[str] = []
        seen: Set[str] = set()
        for item in values:
            vid = str(item or "").strip()
            if not vid or vid in seen or vid not in known_ids:
                continue
            seen.add(vid)
            cleaned.append(vid)
        out[cat] = cleaned
    return out


def _score_video(
    entry: Dict[str, Any],
    *,
    allowed_durations: Optional[Set[int]],
    preferred_durations: Sequence[int],
) -> Tuple[int, int, str]:
    ceil_m = duration_minutes_from_seconds(int(entry["duration_seconds"]))
    duration_ok = 0 if (not allowed_durations or ceil_m in allowed_durations) else 1
    if preferred_durations:
        closest = min(abs(ceil_m - int(p)) for p in preferred_durations)
    else:
        closest = abs(ceil_m - 5)
    return (duration_ok, closest, str(entry["id"]))


def select_rotated_videos_for_category(
    category: str,
    *,
    count: int = ACTIVITIES_PER_YOUTUBE_CATEGORY,
    recent_ids: Optional[Sequence[str]] = None,
    allowed_durations: Optional[Iterable[int]] = None,
) -> List[Dict[str, Any]]:
    """
    Pick ~2–3 curated videos for one category.

    Prefer videos not in the previous Generate's recent set, then prefer durations
    that fit the user's allowed duration minutes. If unused eligible videos run out,
    fall back to older videos from the same category pool (rotation, not permanent exclusion).
    """
    cat = str(category or "").strip().lower().replace(" ", "_")
    if cat not in YOUTUBE_CATEGORY_SET:
        return []
    pool = videos_for_category(cat)
    if not pool or count <= 0:
        return []

    allowed: Optional[Set[int]] = None
    if allowed_durations is not None:
        allowed = {int(x) for x in allowed_durations if int(x) > 0}
    preferred = sorted(allowed) if allowed else [3, 5, 8, 10, 12, 15]
    recent = {str(x).strip() for x in (recent_ids or []) if str(x).strip()}

    unused = [v for v in pool if str(v["id"]) not in recent]
    used = [v for v in pool if str(v["id"]) in recent]

    def _pick_from(candidates: List[Dict[str, Any]], need: int, already: Set[str]) -> List[Dict[str, Any]]:
        ranked = sorted(
            [c for c in candidates if str(c["id"]) not in already],
            key=lambda e: _score_video(e, allowed_durations=allowed, preferred_durations=preferred),
        )
        # Prefer duration-fitting first; if none fit, still use ranked order (fallback).
        fitting = [
            e
            for e in ranked
            if not allowed or duration_minutes_from_seconds(int(e["duration_seconds"])) in allowed
        ]
        ordered = fitting + [e for e in ranked if e not in fitting]
        return ordered[:need]

    target = max(0, min(int(count), ACTIVITIES_PER_YOUTUBE_CATEGORY, len(pool)))
    if target <= 0:
        return []

    selected: List[Dict[str, Any]] = []
    selected_ids: Set[str] = set()
    for source in (unused, used, pool):
        still_need = target - len(selected)
        if still_need <= 0:
            break
        for entry in _pick_from(source, still_need, selected_ids):
            vid = str(entry["id"])
            if vid in selected_ids:
                continue
            selected.append(entry)
            selected_ids.add(vid)
            if len(selected) >= target:
                break

    return selected


def build_activity_from_curated_video(entry: Dict[str, Any], *, activity_id: str = "") -> Dict[str, Any]:
    """Build a Timed library activity owned entirely by curated video metadata."""
    cat = str(entry.get("category", "")).strip().lower().replace(" ", "_")
    title = str(entry.get("video_title", "")).strip() or f"{category_label(cat)} break"
    # Keep titles readable in the library (drop trailing channel suffixes when long).
    if " | " in title:
        title = title.split(" | ", 1)[0].strip() or title
    if len(title) > 72:
        title = title[:69].rstrip() + "…"
    fields = _catalog_fields(entry)
    summary = f"A guided {category_label(cat).lower()} break with a curated YouTube video."
    if cat == "music":
        instructions = [
            "Put on headphones if you can.",
            "Open the Watch video link and listen without multitasking.",
            "Breathe steadily and let the audio reset your pace.",
            "Stop when the track ends or when you feel ready to continue.",
        ]
        summary = "A short calming audio break using a curated YouTube track."
    elif cat == "meditation":
        instructions = [
            "Sit or stand comfortably and reduce distractions.",
            "Open the Watch video link and follow along.",
            "If your mind wanders, gently return to the guidance.",
            "Finish with one slow breath before returning to your day.",
        ]
    else:
        instructions = [
            "Find a comfortable posture and soften your shoulders.",
            "Open the Watch video link and follow the breathing guidance.",
            "Keep the pace gentle; skip any cue that feels uncomfortable.",
            "Close with one easy breath before continuing your day.",
        ]
    return {
        "id": str(activity_id or "").strip(),
        "kind": "timed",
        "title": title,
        "category": cat,
        "category_label": category_label(cat),
        "duration_minutes": fields["duration_minutes"],
        "summary_short": summary,
        "instructions": instructions,
        "youtube_video_id": fields["youtube_video_id"],
        "youtube_url": fields["youtube_url"],
        "youtube_title": fields["youtube_title"],
    }


def generate_youtube_activities_for_categories(
    categories: Sequence[str],
    *,
    recent_by_category: Optional[Mapping[str, Sequence[str]]] = None,
    allowed_durations: Optional[Iterable[int]] = None,
    per_category_count: int = ACTIVITIES_PER_YOUTUBE_CATEGORY,
) -> Tuple[List[Dict[str, Any]], Dict[str, List[str]]]:
    """
    For each relevant YouTube category, select ~2–3 rotated videos and build Timed activities.

    Returns (activities, new_recent_by_category_for_selected_categories).
    """
    recent_map = normalize_recent_youtube_by_category(dict(recent_by_category or {}))
    activities: List[Dict[str, Any]] = []
    selected_recent: Dict[str, List[str]] = {}
    seen_cats: Set[str] = set()

    for raw_cat in categories:
        cat = str(raw_cat or "").strip().lower().replace(" ", "_")
        if cat not in YOUTUBE_CATEGORY_SET or cat in seen_cats:
            continue
        seen_cats.add(cat)
        picked = select_rotated_videos_for_category(
            cat,
            count=per_category_count,
            recent_ids=recent_map.get(cat) or [],
            allowed_durations=allowed_durations,
        )
        selected_recent[cat] = [str(v["id"]) for v in picked]
        for entry in picked:
            activities.append(build_activity_from_curated_video(entry))

    return activities, selected_recent


def merge_recent_youtube_by_category(
    existing: Any,
    selected_this_run: Mapping[str, Sequence[str]],
) -> Dict[str, List[str]]:
    """Update only categories that participated in this Generate; keep others intact."""
    merged = normalize_recent_youtube_by_category(existing)
    for cat, ids in (selected_this_run or {}).items():
        key = str(cat or "").strip().lower().replace(" ", "_")
        if key not in YOUTUBE_CATEGORY_SET:
            continue
        cleaned: List[str] = []
        seen: Set[str] = set()
        for item in ids or []:
            vid = str(item or "").strip()
            if not vid or vid in seen or vid not in _BY_ID:
                continue
            seen.add(vid)
            cleaned.append(vid)
        merged[key] = cleaned
    return merged


def youtube_categories_from_preferences(
    *,
    timed_categories: Sequence[str],
    flexible_categories: Sequence[str],
) -> List[str]:
    """
    Breathing/Meditation participate when selected as Timed prefs.
    Music participates when selected as the Music preference (Flexible preference id).
    """
    timed_set = {str(x).strip().lower().replace(" ", "_") for x in timed_categories if str(x).strip()}
    flexible_set = {
        str(x).strip().lower().replace(" ", "_") for x in flexible_categories if str(x).strip()
    }
    out: List[str] = []
    if "breathing" in timed_set:
        out.append("breathing")
    if "meditation" in timed_set:
        out.append("meditation")
    if "music" in flexible_set:
        out.append("music")
    return out


# Back-compat: older generate path called attach_curated_youtube_videos.
# Keep a thin wrapper that only hydrates existing ids and never invents matches
# across categories after the rotation-based generate path is primary.
def attach_curated_youtube_videos(
    activities: List[Dict[str, Any]],
    *,
    allowed_durations: Optional[Iterable[int]] = None,
) -> List[Dict[str, Any]]:
    """Hydrate trusted catalog fields only; do not attach new cross-matched videos here."""
    del allowed_durations
    return [hydrate_curated_youtube(item) for item in activities]
