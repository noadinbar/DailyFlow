"""
POST /overview/insights — generate 3–7 AI Weekly Insights from current-week facts.

OpenAI receives structured data only. Python computes any future workout window
from BusyBlocks + workout preferences + library duration, using the same
06:00–22:00 free-window rules as Workouts. The model must not invent events,
dates, times, or free windows. Insights are not persisted.
"""

from __future__ import annotations

import json
import os
import re
import traceback
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

from openai import APIConnectionError, APIError, APITimeoutError, OpenAI

APP_TIMEZONE_ID = "Asia/Jerusalem"
OPENAI_MODEL = "gpt-4.1-mini"
OPENAI_TIMEOUT_SECONDS = 12
OPENAI_MAX_RETRIES = 0
MIN_INSIGHTS = 3
MAX_INSIGHTS = 7
MAX_INSIGHT_CHARS = 320
MIN_FREE_WINDOW_MINUTES = 20
DEFAULT_WORKOUT_DURATION_MINUTES = 30
DAY_START = time(6, 0)
DAY_END = time(22, 0)
INSIGHT_KINDS = ("observation", "progress", "suggestion")
PREFERRED_TIME_RANGES: Dict[str, Tuple[time, time]] = {
    "morning": (time(6, 0), time(11, 0)),
    "noon": (time(11, 0), time(15, 0)),
    "afternoon": (time(15, 0), time(18, 0)),
    "evening": (time(18, 0), time(22, 0)),
    "any_time": (time(6, 0), time(22, 0)),
}
DAY_NAMES = (
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
)
ISO_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
HHMM_RE = re.compile(r"\b(?:[01]\d|2[0-3]):[0-5]\d\b")
AMPM_RE = re.compile(r"\b\d{1,2}(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)\b", re.IGNORECASE)
EMOJI_RE = re.compile(
    r"[\U00010000-\U0010ffff]|[\u2600-\u27bf]|[\u2300-\u23ff]|[\u2b00-\u2bff]|[\u200d\ufe0f]"
)


def now_in_app_timezone() -> datetime:
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo(APP_TIMEZONE_ID))
    except Exception:
        return datetime.now(timezone.utc)


def _parse_hh_mm(value: Any) -> Optional[time]:
    if not isinstance(value, str):
        return None
    raw = value.strip()
    if len(raw) < 5:
        return None
    try:
        hour = int(raw[0:2])
        minute = int(raw[3:5])
        if hour < 0 or hour > 23 or minute < 0 or minute > 59:
            return None
        return time(hour, minute)
    except Exception:
        return None


def _minutes_between(start_t: time, end_t: time) -> int:
    return max(0, (end_t.hour * 60 + end_t.minute) - (start_t.hour * 60 + start_t.minute))


def _hh_mm(value: time) -> str:
    return value.strftime("%H:%M")


def _time_from_minutes(total: int) -> time:
    total = max(0, min(total, 23 * 60 + 59))
    return time(total // 60, total % 60)


def _day_label(iso_day: str) -> str:
    try:
        return DAY_NAMES[date.fromisoformat(iso_day).weekday()]
    except Exception:
        return iso_day


def _time_label_for(start_t: time) -> str:
    hour = start_t.hour
    if 6 <= hour < 11:
        return "Morning"
    if 11 <= hour < 15:
        return "Noon"
    if 15 <= hour < 18:
        return "Afternoon"
    return "Evening"


def typical_workout_duration_minutes(library_durations: List[int]) -> int:
    cleaned = [int(value) for value in library_durations if isinstance(value, int) and value > 0]
    if not cleaned:
        return max(MIN_FREE_WINDOW_MINUTES, DEFAULT_WORKOUT_DURATION_MINUTES)
    return max(MIN_FREE_WINDOW_MINUTES, min(cleaned))


def _derive_free_windows(
    *,
    start_date_value: date,
    end_date_value: date,
    busy_blocks: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    by_day: Dict[str, List[Tuple[time, time]]] = {}
    for block in busy_blocks:
        if not isinstance(block, dict):
            continue
        block_date = str(block.get("date") or "").strip()
        start_t = _parse_hh_mm(block.get("start_time"))
        end_t = _parse_hh_mm(block.get("end_time"))
        if not block_date or not start_t or not end_t or _minutes_between(start_t, end_t) <= 0:
            continue
        by_day.setdefault(block_date, []).append((start_t, end_t))

    windows: List[Dict[str, Any]] = []
    day_cursor = start_date_value
    while day_cursor <= end_date_value:
        day_key = day_cursor.isoformat()
        day_busy = sorted(by_day.get(day_key, []), key=lambda pair: (pair[0].hour, pair[0].minute))
        merged: List[Tuple[time, time]] = []
        for start_t, end_t in day_busy:
            if not merged:
                merged.append((start_t, end_t))
                continue
            prev_start, prev_end = merged[-1]
            if start_t <= prev_end:
                if end_t > prev_end:
                    merged[-1] = (prev_start, end_t)
            else:
                merged.append((start_t, end_t))
        current = DAY_START
        for busy_start, busy_end in merged:
            if busy_start > current:
                duration = _minutes_between(current, busy_start)
                if duration >= MIN_FREE_WINDOW_MINUTES:
                    windows.append(
                        {
                            "date": day_key,
                            "start_time": _hh_mm(current),
                            "end_time": _hh_mm(busy_start),
                            "duration_minutes": duration,
                        }
                    )
            if busy_end > current:
                current = busy_end
        if current < DAY_END:
            duration = _minutes_between(current, DAY_END)
            if duration >= MIN_FREE_WINDOW_MINUTES:
                windows.append(
                    {
                        "date": day_key,
                        "start_time": _hh_mm(current),
                        "end_time": _hh_mm(DAY_END),
                        "duration_minutes": duration,
                    }
                )
        day_cursor = day_cursor + timedelta(days=1)
    return windows


def _allowed_preference_windows(preferred_times: List[str]) -> List[Tuple[time, time]]:
    keys = [key for key in preferred_times if key in PREFERRED_TIME_RANGES]
    if not keys or "any_time" in keys:
        return [PREFERRED_TIME_RANGES["any_time"]]
    ordered: List[Tuple[time, time]] = []
    for key in ("morning", "noon", "afternoon", "evening"):
        if key in keys:
            ordered.append(PREFERRED_TIME_RANGES[key])
    return ordered or [PREFERRED_TIME_RANGES["any_time"]]


def _intersect_time_ranges(
    left_start: time, left_end: time, right_start: time, right_end: time
) -> Optional[Tuple[time, time]]:
    start_minutes = max(left_start.hour * 60 + left_start.minute, right_start.hour * 60 + right_start.minute)
    end_minutes = min(left_end.hour * 60 + left_end.minute, right_end.hour * 60 + right_end.minute)
    if end_minutes <= start_minutes:
        return None
    return _time_from_minutes(start_minutes), _time_from_minutes(end_minutes)


def _derive_eligible_windows(free_windows: List[Dict[str, Any]], preferred_times: List[str]) -> List[Dict[str, Any]]:
    ranges = _allowed_preference_windows(preferred_times)
    eligible: List[Dict[str, Any]] = []
    for window in free_windows:
        free_start = _parse_hh_mm(window.get("start_time"))
        free_end = _parse_hh_mm(window.get("end_time"))
        if not free_start or not free_end:
            continue
        for pref_start, pref_end in ranges:
            overlap = _intersect_time_ranges(free_start, free_end, pref_start, pref_end)
            if not overlap:
                continue
            slot_start, slot_end = overlap
            duration = _minutes_between(slot_start, slot_end)
            if duration < MIN_FREE_WINDOW_MINUTES:
                continue
            eligible.append(
                {
                    "date": window["date"],
                    "start_time": _hh_mm(slot_start),
                    "end_time": _hh_mm(slot_end),
                    "duration_minutes": duration,
                    "time_label": _time_label_for(slot_start),
                }
            )
    eligible.sort(key=lambda row: (row["date"], row["start_time"]))
    return eligible


def _clip_windows_from_now(windows: List[Dict[str, Any]], now: datetime) -> List[Dict[str, Any]]:
    today_iso = now.date().isoformat()
    now_t = time(now.hour, now.minute)
    if now.hour > 23:
        now_t = time(23, 59)
    clipped: List[Dict[str, Any]] = []
    for window in windows:
        window_date = str(window.get("date") or "")
        if window_date < today_iso:
            continue
        start_t = _parse_hh_mm(window.get("start_time"))
        end_t = _parse_hh_mm(window.get("end_time"))
        if not start_t or not end_t:
            continue
        if window_date == today_iso:
            if end_t <= now_t:
                continue
            if start_t < now_t:
                start_t = now_t
        duration = _minutes_between(start_t, end_t)
        if duration < MIN_FREE_WINDOW_MINUTES:
            continue
        clipped.append(
            {
                "date": window_date,
                "start_time": _hh_mm(start_t),
                "end_time": _hh_mm(end_t),
                "duration_minutes": duration,
            }
        )
    return clipped


def compute_suggested_workout_window(
    *,
    weekly_goal: int,
    scheduled_count: int,
    busy_blocks: List[Dict[str, Any]],
    preferred_times: List[str],
    needed_minutes: int,
    now: datetime,
    week_start: str,
    week_end: str,
) -> Optional[Dict[str, Any]]:
    if scheduled_count >= weekly_goal:
        return None
    needed = max(MIN_FREE_WINDOW_MINUTES, int(needed_minutes or 0))
    try:
        week_start_d = date.fromisoformat(week_start)
        week_end_d = date.fromisoformat(week_end)
    except Exception:
        return None
    today = now.date()
    if today > week_end_d:
        return None
    search_start = today if today >= week_start_d else week_start_d
    free_windows = _derive_free_windows(
        start_date_value=search_start,
        end_date_value=week_end_d,
        busy_blocks=busy_blocks,
    )
    free_windows = _clip_windows_from_now(free_windows, now)
    eligible = _derive_eligible_windows(free_windows, preferred_times)
    for window in eligible:
        if int(window.get("duration_minutes") or 0) < needed:
            continue
        start_t = _parse_hh_mm(window["start_time"])
        end_t = _parse_hh_mm(window["end_time"])
        if not start_t or not end_t:
            continue
        slot_end = _time_from_minutes(start_t.hour * 60 + start_t.minute + needed)
        if _minutes_between(start_t, slot_end) < needed or slot_end > end_t:
            continue
        return {
            "date": window["date"],
            "day_label": _day_label(window["date"]),
            "start_time": _hh_mm(start_t),
            "end_time": _hh_mm(slot_end),
            "duration_minutes": needed,
            "time_label": window.get("time_label") or _time_label_for(start_t),
        }
    return None


def remaining_days(today_iso: str, week_end: str) -> List[str]:
    try:
        cursor = date.fromisoformat(today_iso)
        end_d = date.fromisoformat(week_end)
    except Exception:
        return []
    out: List[str] = []
    while cursor <= end_d:
        out.append(cursor.isoformat())
        cursor += timedelta(days=1)
    return out


def _safe_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    cleaned = EMOJI_RE.sub("", value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def _allowed_times_from_facts(facts: Dict[str, Any]) -> Set[str]:
    times: Set[str] = set()

    def add_time(value: Any) -> None:
        parsed = _parse_hh_mm(value if isinstance(value, str) else "")
        if parsed:
            times.add(_hh_mm(parsed))

    add_time(facts.get("now"))
    workouts = facts.get("workouts") if isinstance(facts.get("workouts"), dict) else {}
    meals = facts.get("meals") if isinstance(facts.get("meals"), dict) else {}
    stress = facts.get("stress_breaks") if isinstance(facts.get("stress_breaks"), dict) else {}
    for item in list(workouts.get("scheduled_items") or []) + list(meals.get("scheduled_items") or []) + list(
        stress.get("scheduled_items") or []
    ):
        if not isinstance(item, dict):
            continue
        add_time(item.get("start_time"))
        add_time(item.get("end_time"))
    for block in facts.get("busy_blocks") or []:
        if not isinstance(block, dict):
            continue
        add_time(block.get("start_time"))
        add_time(block.get("end_time"))
    window = facts.get("suggested_workout_window")
    if isinstance(window, dict):
        add_time(window.get("start_time"))
        add_time(window.get("end_time"))
    return times


def _allowed_dates_from_facts(facts: Dict[str, Any]) -> Set[str]:
    dates: Set[str] = set()
    week_start = str(facts.get("week_start") or "")
    week_end = str(facts.get("week_end") or "")
    try:
        cursor = date.fromisoformat(week_start)
        end_d = date.fromisoformat(week_end)
        while cursor <= end_d:
            dates.add(cursor.isoformat())
            cursor += timedelta(days=1)
    except Exception:
        pass
    return dates


def _insight_mentions_invented_facts(text: str, *, allowed_dates: Set[str], allowed_times: Set[str]) -> bool:
    if AMPM_RE.search(text):
        return True
    for match in ISO_DATE_RE.findall(text):
        if match not in allowed_dates:
            return True
    for match in HHMM_RE.findall(text):
        if match not in allowed_times:
            return True
    return False


def normalize_insights(raw: Any, *, facts: Dict[str, Any]) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    allowed_dates = _allowed_dates_from_facts(facts)
    allowed_times = _allowed_times_from_facts(facts)
    out: List[Dict[str, Any]] = []
    seen_text: Set[str] = set()
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        text = _safe_text(entry.get("text") or entry.get("insight") or entry.get("body"))
        if not text:
            continue
        if len(text) > MAX_INSIGHT_CHARS:
            text = text[:MAX_INSIGHT_CHARS].rsplit(" ", 1)[0].rstrip(" ,;:")
        if not text or text.lower() in seen_text:
            continue
        if _insight_mentions_invented_facts(text, allowed_dates=allowed_dates, allowed_times=allowed_times):
            continue
        kind = _safe_text(entry.get("kind")).lower()
        if kind not in INSIGHT_KINDS:
            kind = "observation"
        seen_text.add(text.lower())
        out.append(
            {
                "id": f"insight_{len(out) + 1}",
                "kind": kind,
                "text": text,
            }
        )
        if len(out) >= MAX_INSIGHTS:
            break
    return out


def _openai_prompt(facts: Dict[str, Any]) -> str:
    compact = json.dumps(facts, separators=(",", ":"), ensure_ascii=True)
    window = facts.get("suggested_workout_window")
    window_rule = (
        "You MAY suggest exactly that one workout window, copying date/day_label/start_time/end_time exactly. "
        "Do not suggest any other workout time."
        if isinstance(window, dict)
        else "Do not suggest any specific day or time for another workout. You may note that the weekly workout goal is not yet met, without naming a slot."
    )
    return (
        "You write DailyFlow Overview weekly insights.\n"
        "Return JSON only: {\"insights\":[{\"id\":\"insight_1\",\"kind\":\"observation|progress|suggestion\",\"text\":\"...\"}]}.\n"
        f"Return {MIN_INSIGHTS} to {MAX_INSIGHTS} insights, preferably 5. Each text is 1-2 concise sentences.\n"
        "Use a mix of observation, progress, and suggestion kinds. Vary wording; do not repeat the same point.\n"
        "Ground every claim only in the structured facts JSON. Never invent workouts, meals, breaks, BusyBlocks, "
        "completed items, dates, calendar events, or free windows.\n"
        "You may only mention ISO dates that appear in the facts week range, titles from scheduled_items, "
        "and HH:mm times that appear in the facts (including busy_blocks and suggested_workout_window).\n"
        "Use 24-hour HH:mm only. No 12-hour am/pm. No emoji. No markdown.\n"
        "Do not tell the user to auto-schedule anything. Suggestions are guidance only.\n"
        f"{window_rule}\n"
        "Do not mention Daily Motivation.\n"
        f"Facts:{compact}"
    )


def _parse_openai_json(output_text: str) -> Optional[Dict[str, Any]]:
    if not isinstance(output_text, str) or not output_text.strip():
        return None
    try:
        parsed = json.loads(output_text)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _call_openai(facts: Dict[str, Any]) -> Tuple[Optional[List[Dict[str, Any]]], str]:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        print("[overview-insights] openai skipped: missing OPENAI_API_KEY")
        return None, "missing_api_key"
    prompt = _openai_prompt(facts)
    print(f"[overview-insights] prompt_length={len(prompt)} seed={facts.get('wording_seed')}")
    try:
        client = OpenAI(api_key=api_key, timeout=OPENAI_TIMEOUT_SECONDS, max_retries=OPENAI_MAX_RETRIES)
        print(f"[overview-insights] before openai call (timeout={OPENAI_TIMEOUT_SECONDS}s, retries={OPENAI_MAX_RETRIES})")
        response = client.responses.create(
            model=OPENAI_MODEL,
            input=prompt,
            text={"format": {"type": "json_object"}},
            timeout=OPENAI_TIMEOUT_SECONDS,
        )
        print("[overview-insights] after openai call")
    except APITimeoutError as err:
        print(f"[overview-insights] openai timed out: {repr(err)}")
        return None, "openai_timeout"
    except APIConnectionError as err:
        print(f"[overview-insights] openai connection error: {repr(err)}")
        return None, "openai_connection"
    except APIError as err:
        print(f"[overview-insights] openai api error: {repr(err)}")
        return None, "openai_api_error"
    except Exception:
        print(f"[overview-insights] openai unexpected error\n{traceback.format_exc()}")
        return None, "openai_api_error"

    output_text = getattr(response, "output_text", "")
    if not isinstance(output_text, str) or not output_text.strip():
        print("[overview-insights] openai returned empty output")
        return None, "openai_empty_output"
    parsed = _parse_openai_json(output_text)
    if parsed is None:
        print("[overview-insights] openai returned malformed JSON")
        return None, "openai_bad_json"
    insights = normalize_insights(parsed.get("insights"), facts=facts)
    if len(insights) < MIN_INSIGHTS:
        print(f"[overview-insights] openai output invalid after normalize count={len(insights)}")
        return None, "openai_invalid_or_incomplete"
    return insights, ""


def generate_weekly_insights(facts: Dict[str, Any]) -> Tuple[Optional[List[Dict[str, Any]]], str]:
    insights, reason = _call_openai(facts)
    if insights:
        return insights, ""
    if reason == "missing_api_key":
        return None, reason
    retry_facts = dict(facts)
    retry_facts["wording_seed"] = f"{facts.get('wording_seed') or 'retry'}-retry"
    retry_insights, retry_reason = _call_openai(retry_facts)
    if retry_insights:
        return retry_insights, ""
    return None, retry_reason or reason


def failure_http(reason: str) -> Tuple[int, str]:
    message = "Insights are currently unavailable. Please try again."
    if reason == "openai_timeout":
        return 504, message
    return 502, message
