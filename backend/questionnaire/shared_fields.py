"""
Shared validation and allow-lists for onboarding / profile questionnaire fields.
Used by questionnaire save Lambda and profile GET/PATCH handler.
"""

from __future__ import annotations

import math
from decimal import Decimal
from typing import Any, Dict, List, Optional, Set, Tuple

_ALLOWED_AGE_RANGE: Set[str] = {
    "under_18",
    "age_18_24",
    "age_25_34",
    "age_35_44",
    "age_45_plus",
}
_ALLOWED_STATUS_DAILY_ROUTINE: Set[str] = {
    "student",
    "full_time_job",
    "part_time_job",
    "shift_worker",
    "currently_not_working",
}
_ALLOWED_MAIN_GOAL: Set[str] = {
    "improve_fitness",
    "lose_weight",
    "build_strength",
    "reduce_stress",
    "improve_energy",
    "maintain_routine",
}
_ALLOWED_FITNESS_LEVEL: Set[str] = {"beginner", "intermediate", "advanced"}
_ALLOWED_ACTIVITY: Set[str] = {
    "knee_sensitivity",
    "back_sensitivity",
    "avoid_high_intensity",
    "avoid_high_heart_rate",
    "prefer_low_impact",
    "none",
}
_ALLOWED_WORKOUT_TIMES: Set[str] = {"morning", "noon", "afternoon", "evening", "any_time"}
_ALLOWED_WORKOUT_TYPES: Set[str] = {
    "walking",
    "gym",
    "strength",
    "yoga",
    "pilates",
    "running",
    "stretching",
    "home_workouts",
}
_ALLOWED_DIETARY: Set[str] = {
    "vegan",
    "vegetarian",
    "gluten_free",
    "keto",
    "lactose_intolerant",
    "kosher",
    "no_preferences",
}
_ALLOWED_BREAK_MEDITATION: Set[str] = {
    "break_suggestions",
    "meditation_suggestions",
    "both",
    "not_interested",
}
_ALLOWED_AUTO_SCHEDULE: Set[str] = {"yes", "no", "ask_me_first"}

QUESTIONNAIRE_KEYS: Set[str] = {
    "age_range",
    "status_daily_routine",
    "main_goal",
    "fitness_level",
    "activity_considerations",
    "workouts_per_week",
    "preferred_workout_times",
    "preferred_workout_types",
    "dietary_preferences",
    "break_meditation_interest",
    "auto_schedule_to_calendar",
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


def validate_workouts_per_week(value: Any) -> Optional[str]:
    """Non-negative integer only."""
    if isinstance(value, bool):
        return "workouts_per_week must be an integer."
    if isinstance(value, int) and not isinstance(value, bool):
        if value < 0:
            return "workouts_per_week must be a non-negative integer."
        return None
    if isinstance(value, float):
        if not math.isfinite(value) or value < 0 or not value.is_integer():
            return "workouts_per_week must be a non-negative integer."
        return None
    if isinstance(value, str):
        raw = value.strip()
        if raw == "":
            return "workouts_per_week cannot be empty."
        try:
            num = float(raw)
        except ValueError:
            return "workouts_per_week must be an integer."
        if not math.isfinite(num) or num < 0 or not num.is_integer():
            return "workouts_per_week must be a non-negative integer."
        return None
    if isinstance(value, Decimal):
        try:
            v = int(value)
        except Exception:
            return "workouts_per_week must be a non-negative integer."
        if v < 0:
            return "workouts_per_week must be a non-negative integer."
        return None
    return "workouts_per_week must be an integer."


def validate_questionnaire_payload(payload: Dict[str, Any]) -> Optional[str]:
    """Validate only keys present in payload (partial updates allowed)."""
    str_fields: Dict[str, Tuple[str, Set[str]]] = {
        "age_range": ("age_range", _ALLOWED_AGE_RANGE),
        "fitness_level": ("fitness_level", _ALLOWED_FITNESS_LEVEL),
        "break_meditation_interest": ("break_meditation_interest", _ALLOWED_BREAK_MEDITATION),
        "auto_schedule_to_calendar": ("auto_schedule_to_calendar", _ALLOWED_AUTO_SCHEDULE),
    }
    for key, (label, allowed) in str_fields.items():
        if key not in payload:
            continue
        v = payload.get(key)
        if not isinstance(v, str) or v not in allowed:
            return f"{label} must be one of: {', '.join(sorted(allowed))}."

    if "activity_considerations" in payload:
        lst, err = as_str_list(payload.get("activity_considerations"), "activity_considerations")
        if err:
            return err
        assert lst is not None
        if not lst:
            return "activity_considerations cannot be empty."
        bad = [x for x in lst if x not in _ALLOWED_ACTIVITY]
        if bad:
            return "activity_considerations contains invalid values."
        if "none" in lst and len(lst) > 1:
            return "activity_considerations: when none is selected, it must be the only selection."

    if "status_daily_routine" in payload:
        lst, err = as_str_list(payload.get("status_daily_routine"), "status_daily_routine")
        if err:
            return err
        assert lst is not None
        if not lst:
            return "status_daily_routine cannot be empty."
        bad = [x for x in lst if x not in _ALLOWED_STATUS_DAILY_ROUTINE]
        if bad:
            return "status_daily_routine contains invalid values."

    if "main_goal" in payload:
        lst, err = as_str_list(payload.get("main_goal"), "main_goal")
        if err:
            return err
        assert lst is not None
        if not lst:
            return "main_goal cannot be empty."
        bad = [x for x in lst if x not in _ALLOWED_MAIN_GOAL]
        if bad:
            return "main_goal contains invalid values."

    if "preferred_workout_times" in payload:
        lst, err = as_str_list(payload.get("preferred_workout_times"), "preferred_workout_times")
        if err:
            return err
        assert lst is not None
        if not lst:
            return "preferred_workout_times cannot be empty."
        bad = [x for x in lst if x not in _ALLOWED_WORKOUT_TIMES]
        if bad:
            return "preferred_workout_times contains invalid values."
        if "any_time" in lst and len(lst) > 1:
            return "preferred_workout_times: when any_time is selected, it must be the only time."

    if "preferred_workout_types" in payload:
        lst, err = as_str_list(payload.get("preferred_workout_types"), "preferred_workout_types")
        if err:
            return err
        assert lst is not None
        if not lst:
            return "preferred_workout_types cannot be empty."
        bad = [x for x in lst if x not in _ALLOWED_WORKOUT_TYPES]
        if bad:
            return "preferred_workout_types contains invalid values."

    if "dietary_preferences" in payload:
        lst, err = as_str_list(payload.get("dietary_preferences"), "dietary_preferences")
        if err:
            return err
        assert lst is not None
        if not lst:
            return "dietary_preferences cannot be empty."
        bad = [x for x in lst if x not in _ALLOWED_DIETARY]
        if bad:
            return "dietary_preferences contains invalid values."
        if "no_preferences" in lst and len(lst) > 1:
            return "dietary_preferences: when no_preferences is selected, it must be the only preference."

    if "workouts_per_week" in payload:
        w_err = validate_workouts_per_week(payload.get("workouts_per_week"))
        if w_err:
            return w_err

    return None


def normalize_workouts_per_week_for_storage(value: Any) -> int:
    """Convert client/JSON value to int for DynamoDB."""
    if isinstance(value, bool):
        raise ValueError("invalid workouts_per_week")
    if isinstance(value, str):
        v = value.strip()
        if v == "":
            raise ValueError("empty workouts_per_week")
        return int(float(v))
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return int(value)
    if isinstance(value, Decimal):
        return int(value)
    raise ValueError("invalid workouts_per_week")


def dynamodb_value_to_json(value: Any) -> Any:
    if isinstance(value, Decimal):
        fv = float(value)
        return int(fv) if fv.is_integer() else fv
    if isinstance(value, list):
        return [dynamodb_value_to_json(x) for x in value]
    return value


_MULTI_LEGACY_KEYS = frozenset(
    {
        "status_daily_routine",
        "main_goal",
        "activity_considerations",
        "preferred_workout_times",
        "preferred_workout_types",
        "dietary_preferences",
    }
)


def questionnaire_from_user_item(item: Dict[str, Any]) -> Dict[str, Any]:
    """Subset of user item fields for API JSON."""
    q: Dict[str, Any] = {}
    for k in QUESTIONNAIRE_KEYS:
        if k not in item:
            continue
        raw = item[k]
        if k in _MULTI_LEGACY_KEYS and isinstance(raw, str):
            q[k] = [raw]
            continue
        q[k] = dynamodb_value_to_json(raw)
    return q
