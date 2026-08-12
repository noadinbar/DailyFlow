"""
Stress & Breaks preference fields stored on the Users table.

Separate from the global onboarding questionnaire (shared_fields.py).
DynamoDB attributes use a consistent stress_breaks_ prefix.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Set, Tuple

# DynamoDB attribute names
ATTR_COMPLETED = "stress_breaks_questionnaire_completed"
ATTR_BUSIEST_TIMES = "stress_breaks_busiest_times"
ATTR_BUSIEST_DAYS = "stress_breaks_busiest_days"
ATTR_BUSY_DAY_FACTORS = "stress_breaks_busy_day_factors"
ATTR_PREFERRED_ACTIVITIES = "stress_breaks_preferred_activities"
ATTR_DURATIONS = "stress_breaks_durations"

STRESS_BREAKS_ANSWER_ATTRS: Tuple[str, ...] = (
    ATTR_BUSIEST_TIMES,
    ATTR_BUSIEST_DAYS,
    ATTR_BUSY_DAY_FACTORS,
    ATTR_PREFERRED_ACTIVITIES,
    ATTR_DURATIONS,
)

STRESS_BREAKS_ALL_ATTRS: Tuple[str, ...] = (ATTR_COMPLETED,) + STRESS_BREAKS_ANSWER_ATTRS

# API object keys (nested under stress_breaks)
API_KEY_COMPLETED = "questionnaire_completed"
API_KEY_BUSIEST_TIMES = "busiest_times"
API_KEY_BUSIEST_DAYS = "busiest_days"
API_KEY_BUSY_DAY_FACTORS = "busy_day_factors"
API_KEY_PREFERRED_ACTIVITIES = "preferred_activities"
API_KEY_DURATIONS = "durations"

API_ANSWER_KEYS: Tuple[str, ...] = (
    API_KEY_BUSIEST_TIMES,
    API_KEY_BUSIEST_DAYS,
    API_KEY_BUSY_DAY_FACTORS,
    API_KEY_PREFERRED_ACTIVITIES,
    API_KEY_DURATIONS,
)

API_TO_ATTR: Dict[str, str] = {
    API_KEY_COMPLETED: ATTR_COMPLETED,
    API_KEY_BUSIEST_TIMES: ATTR_BUSIEST_TIMES,
    API_KEY_BUSIEST_DAYS: ATTR_BUSIEST_DAYS,
    API_KEY_BUSY_DAY_FACTORS: ATTR_BUSY_DAY_FACTORS,
    API_KEY_PREFERRED_ACTIVITIES: ATTR_PREFERRED_ACTIVITIES,
    API_KEY_DURATIONS: ATTR_DURATIONS,
}

ATTR_TO_API: Dict[str, str] = {v: k for k, v in API_TO_ATTR.items()}

_ALLOWED_BUSIEST_TIMES: Set[str] = {
    "morning",
    "midday",
    "afternoon",
    "evening",
    "varies",
}
_EXCLUSIVE_BUSIEST_TIMES = "varies"

_ALLOWED_BUSIEST_DAYS: Set[str] = {
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "changes_weekly",
}
_EXCLUSIVE_BUSIEST_DAYS = "changes_weekly"

_ALLOWED_BUSY_DAY_FACTORS: Set[str] = {
    "many_activities",
    "long_continuous",
    "back_to_back",
    "few_free_gaps",
    "early_mornings",
    "late_evenings",
    "depends",
}
_EXCLUSIVE_BUSY_DAY_FACTORS = "depends"

_ALLOWED_PREFERRED_ACTIVITIES: Set[str] = {
    "breathing",
    "meditation",
    "walking",
    "stretching",
    "reading",
    "journaling",
    "music",
    "screen_free",
}

_ALLOWED_DURATIONS: Set[str] = {
    "3_5",
    "5_10",
    "10_15",
    "15_20",
    "depends_on_schedule",
}
_EXCLUSIVE_DURATIONS = "depends_on_schedule"

_FIELD_RULES: Dict[str, Tuple[Set[str], Optional[str]]] = {
    API_KEY_BUSIEST_TIMES: (_ALLOWED_BUSIEST_TIMES, _EXCLUSIVE_BUSIEST_TIMES),
    API_KEY_BUSIEST_DAYS: (_ALLOWED_BUSIEST_DAYS, _EXCLUSIVE_BUSIEST_DAYS),
    API_KEY_BUSY_DAY_FACTORS: (_ALLOWED_BUSY_DAY_FACTORS, _EXCLUSIVE_BUSY_DAY_FACTORS),
    API_KEY_PREFERRED_ACTIVITIES: (_ALLOWED_PREFERRED_ACTIVITIES, None),
    API_KEY_DURATIONS: (_ALLOWED_DURATIONS, _EXCLUSIVE_DURATIONS),
}


def as_str_list(value: Any, field: str) -> Tuple[Optional[List[str]], Optional[str]]:
    if not isinstance(value, list):
        return None, f"{field} must be a JSON array."
    out: List[str] = []
    for x in value:
        if not isinstance(x, str):
            return None, f"{field} must contain only strings."
        out.append(x)
    return out, None


def _validate_multi(
    field: str,
    value: Any,
    allowed: Set[str],
    exclusive: Optional[str],
) -> Optional[str]:
    lst, err = as_str_list(value, field)
    if err:
        return err
    assert lst is not None
    if not lst:
        return f"{field} cannot be empty."
    bad = [x for x in lst if x not in allowed]
    if bad:
        return f"{field} contains invalid values."
    if exclusive and exclusive in lst and len(lst) > 1:
        return f"{field}: when {exclusive} is selected, it must be the only selection."
    # Deduplicate while preserving order for storage consistency
    return None


def validate_stress_breaks_payload(payload: Dict[str, Any], *, require_all_answers: bool = False) -> Optional[str]:
    """
    Validate a stress_breaks object from the API body.
    Only keys present are validated unless require_all_answers is True.
    """
    if not isinstance(payload, dict):
        return "stress_breaks must be a JSON object."

    if require_all_answers:
        missing = [k for k in API_ANSWER_KEYS if k not in payload]
        if missing:
            return f"stress_breaks requires all answer fields. Missing: {', '.join(missing)}."

    for key, (allowed, exclusive) in _FIELD_RULES.items():
        if key not in payload:
            continue
        err = _validate_multi(key, payload.get(key), allowed, exclusive)
        if err:
            return err

    if API_KEY_COMPLETED in payload:
        completed = payload.get(API_KEY_COMPLETED)
        if not isinstance(completed, bool):
            return "questionnaire_completed must be a boolean."
        if completed is True:
            # Completion may only be set when all five answers are present and valid.
            missing = [k for k in API_ANSWER_KEYS if k not in payload]
            if missing:
                return (
                    "questionnaire_completed can only be true when all five answer fields "
                    f"are included. Missing: {', '.join(missing)}."
                )
            for key, (allowed, exclusive) in _FIELD_RULES.items():
                err = _validate_multi(key, payload.get(key), allowed, exclusive)
                if err:
                    return err

    return None


def normalize_stress_breaks_for_storage(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Build DynamoDB attribute map from a validated stress_breaks API object.
    Deduplicates list values while preserving order.
    """
    out: Dict[str, Any] = {}
    for api_key, attr in API_TO_ATTR.items():
        if api_key not in payload:
            continue
        value = payload[api_key]
        if api_key == API_KEY_COMPLETED:
            out[attr] = bool(value)
            continue
        if isinstance(value, list):
            seen: Set[str] = set()
            deduped: List[str] = []
            for item in value:
                if not isinstance(item, str) or item in seen:
                    continue
                seen.add(item)
                deduped.append(item)
            out[attr] = deduped
    return out


def stress_breaks_from_user_item(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Build API stress_breaks object from a Users table item.
    Returns None when no Stress & Breaks attributes are present.
    """
    has_any = any(attr in item for attr in STRESS_BREAKS_ALL_ATTRS)
    if not has_any:
        return None

    result: Dict[str, Any] = {}
    raw_completed = item.get(ATTR_COMPLETED)
    result[API_KEY_COMPLETED] = True if raw_completed is True else False

    for attr in STRESS_BREAKS_ANSWER_ATTRS:
        api_key = ATTR_TO_API[attr]
        raw = item.get(attr)
        if isinstance(raw, list):
            result[api_key] = [x for x in raw if isinstance(x, str)]
        elif isinstance(raw, str) and raw:
            result[api_key] = [raw]
        else:
            result[api_key] = []

    return result
