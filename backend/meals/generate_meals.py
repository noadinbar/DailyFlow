import copy
import hashlib
import json
import os
import random
import traceback
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Set, Tuple

import boto3
from openai import APIConnectionError, APIError, APITimeoutError, OpenAI

OPENAI_MODEL = "gpt-5-mini"
OPENAI_TIMEOUT_SECONDS = 12
OPENAI_MAX_RETRIES = 0
MEAL_TYPE_TARGETS: Dict[str, int] = {
    "Breakfast": 3,
    "Lunch": 3,
    "Dinner": 3,
    "Snack": 3,
}
GENERATE_TARGET_COUNT = 3
VALID_MEAL_TYPES = tuple(MEAL_TYPE_TARGETS.keys())
PACKAGE_ROUNDING_UNITS = {"can", "box", "package", "pack", "jar", "bottle", "unit", "egg", "piece"}
NORMAL_ROUNDING_UNITS = {"g", "kg", "ml", "l", "tbsp", "tsp"}

_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://main.dnp9vhzk0bw8l.amplifyapp.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
}


def _to_json_safe(value: Any) -> Any:
    """Recursively convert DynamoDB-friendly Decimals (and nested structures) for json.dumps."""
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, Decimal):
        if value % 1 == 0:
            return int(value)
        return float(value)
    if isinstance(value, float):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, dict):
        return {k: _to_json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_to_json_safe(v) for v in value]
    if isinstance(value, tuple):
        return [_to_json_safe(v) for v in value]
    return value


def _json_response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": dict(_CORS_HEADERS),
        "body": json.dumps(_to_json_safe(body)),
    }


def _iso_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _meal_dedupe_key(meal: Dict[str, Any]) -> str:
    mt = str(meal.get("meal_type", "")).strip().lower()
    title = str(meal.get("title", "")).strip().lower()
    prep = _to_int(meal.get("prep_time_minutes"), 0)
    return f"{mt}|{title}|{prep}"


def _generation_seed_int(user_id: str) -> int:
    raw = f"{user_id}|{_iso_utc_now()}".encode("utf-8")
    return int.from_bytes(hashlib.sha256(raw).digest()[:8], "big", signed=False)


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


def _parse_body(event: Dict[str, Any]) -> Dict[str, Any]:
    body = event.get("body")
    if body is None:
        return {}
    if isinstance(body, dict):
        return body
    if isinstance(body, str):
        raw = body.strip()
        if not raw:
            return {}
        return json.loads(raw)
    return {}


def _dynamodb_resource():
    region = os.getenv("AWS_REGION")
    return boto3.resource("dynamodb", region_name=region) if region else boto3.resource("dynamodb")


def _table_from_env(env_name: str):
    table_name = os.getenv(env_name)
    if not table_name:
        raise ValueError(f"Missing {env_name} env var.")
    return _dynamodb_resource().Table(table_name)


def _to_dynamodb_safe(value: Any) -> Any:
    """Recursively convert floats to Decimal for boto3 DynamoDB items. JSON responses use raw floats elsewhere."""
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, int):
        return value
    if isinstance(value, Decimal):
        return value
    if isinstance(value, dict):
        return {k: _to_dynamodb_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_to_dynamodb_safe(v) for v in value]
    if isinstance(value, tuple):
        return [_to_dynamodb_safe(v) for v in value]
    return value


def _safe_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _safe_string_list(value: Any) -> List[str]:
    if isinstance(value, list):
        return [item.strip() for item in value if isinstance(item, str) and item.strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _safe_budget_level(value: Any) -> str:
    cleaned = _safe_string(value)
    if cleaned in {"Low", "Medium", "High"}:
        return cleaned
    return "Medium"


def _to_number(value: Any, default: float = 0.0) -> float:
    try:
        if isinstance(value, Decimal):
            return float(value)
        if isinstance(value, bool):
            return default
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            raw = value.strip()
            if not raw:
                return default
            return float(raw)
    except Exception:
        return default
    return default


def _to_int(value: Any, default: int = 0) -> int:
    number = _to_number(value, float(default))
    if number <= 0:
        return default
    return int(round(number))


def _normalize_meal_type(value: Any) -> str:
    raw = _safe_string(value).lower()
    mapping = {
        "breakfast": "Breakfast",
        "lunch": "Lunch",
        "dinner": "Dinner",
        "snack": "Snack",
    }
    return mapping.get(raw, "")


def _normalize_rounding(unit: str, explicit_rounding: Any) -> str:
    provided = _safe_string(explicit_rounding).lower()
    if provided in {"none", "ceil"}:
        return provided
    unit_clean = unit.lower()
    if unit_clean in NORMAL_ROUNDING_UNITS:
        return "none"
    if unit_clean in PACKAGE_ROUNDING_UNITS:
        return "ceil"
    return "none"


def _normalize_ingredient(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    name = _safe_string(raw.get("name"))
    if not name:
        return None
    quantity = _to_number(raw.get("quantity"), 0.0)
    if quantity <= 0:
        quantity = 1.0
    unit = _safe_string(raw.get("unit")).lower() or "unit"
    category = _safe_string(raw.get("category")) or "Pantry"
    rounding = _normalize_rounding(unit, raw.get("rounding"))
    return {
        "name": name,
        "quantity": round(quantity, 2),
        "unit": unit,
        "category": category,
        "rounding": rounding,
    }


def _normalize_instructions(raw: Any) -> List[str]:
    if not isinstance(raw, list):
        return []
    output: List[str] = []
    for step in raw:
        step_text = _safe_string(step)
        if step_text:
            output.append(step_text[:160])
        if len(output) >= 4:
            break
    return output


def _normalize_meal_entry(raw: Any, idx: int) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    title = _safe_string(raw.get("title"))
    meal_type = _normalize_meal_type(raw.get("meal_type"))
    prep_minutes = _to_int(raw.get("prep_time_minutes"), 0)
    if not title or not meal_type or prep_minutes <= 0:
        return None
    diet_tags = _safe_string_list(raw.get("diet_tags"))
    goal_tags = _safe_string_list(raw.get("goal_tags"))
    summary_short = _safe_string(raw.get("summary_short")) or f"{title} meal."
    ingredients_raw = raw.get("ingredients")
    ingredients: List[Dict[str, Any]] = []
    if isinstance(ingredients_raw, list):
        for ingredient_raw in ingredients_raw:
            normalized = _normalize_ingredient(ingredient_raw)
            if normalized:
                ingredients.append(normalized)
            if len(ingredients) >= 5:
                break
    if not ingredients:
        return None
    instructions = _normalize_instructions(raw.get("instructions"))
    estimated_calories = _to_int(raw.get("estimated_calories"), 0)
    budget_level = _safe_budget_level(raw.get("budget_level"))
    return {
        "id": _safe_string(raw.get("id")) or f"meal_{idx}",
        "title": title,
        "meal_type": meal_type,
        "diet_tags": diet_tags,
        "prep_time_minutes": prep_minutes,
        "estimated_calories": estimated_calories if estimated_calories > 0 else None,
        "budget_level": budget_level,
        "goal_tags": goal_tags,
        "summary_short": summary_short,
        "short_ingredients_preview": ", ".join([ingredient["name"] for ingredient in ingredients[:4]]),
        "ingredients": ingredients,
        "instructions": instructions,
        "base_servings": 1,
    }


def _group_by_meal_type(meals: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    grouped: Dict[str, List[Dict[str, Any]]] = {meal_type: [] for meal_type in MEAL_TYPE_TARGETS}
    for meal in meals:
        meal_type = _safe_string(meal.get("meal_type"))
        if meal_type in grouped:
            grouped[meal_type].append(meal)
    return grouped


def _enforce_type_targets(meals: List[Dict[str, Any]], target_counts: Dict[str, int]) -> List[Dict[str, Any]]:
    grouped = _group_by_meal_type(meals)
    output: List[Dict[str, Any]] = []
    for meal_type, target_count in target_counts.items():
        entries = grouped.get(meal_type) or []
        output.extend(entries[:target_count])
    return output


def _reindex_meal_ids(meals: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    result: List[Dict[str, Any]] = []
    for idx, meal in enumerate(meals, start=1):
        item = dict(meal)
        item["id"] = f"meal_{idx}"
        result.append(item)
    return result


def _library_has_full_coverage(meals: List[Dict[str, Any]]) -> bool:
    counts = _group_by_meal_type(meals)
    for meal_type, target in MEAL_TYPE_TARGETS.items():
        if len(counts.get(meal_type) or []) < target:
            return False
    return True


def _finalize_meal_ids(meals: List[Dict[str, Any]], favorite_id_set: Set[str]) -> List[Dict[str, Any]]:
    used: Set[str] = set()
    for m in meals:
        mid = str(m.get("id", "")).strip()
        if mid in favorite_id_set:
            used.add(mid)
    n = 1
    out: List[Dict[str, Any]] = []
    for m in meals:
        item = copy.deepcopy(m)
        mid = str(item.get("id", "")).strip()
        if mid in favorite_id_set:
            out.append(item)
            continue
        while f"meal_{n}" in used:
            n += 1
        item["id"] = f"meal_{n}"
        used.add(item["id"])
        n += 1
        out.append(item)
    return out


def _topup_meal_coverage(
    meals: List[Dict[str, Any]],
    preferences: Dict[str, Any],
    seed: int,
    avoid_keys: Set[str],
) -> List[Dict[str, Any]]:
    grouped = _group_by_meal_type(meals)
    avoid = set(avoid_keys)
    fb = _build_fallback_library(preferences, seed=seed, avoid_keys=avoid)
    fb_grouped = _group_by_meal_type(fb)
    for meal_type, target in MEAL_TYPE_TARGETS.items():
        rows = list(grouped.get(meal_type) or [])
        if len(rows) >= target:
            continue
        need = target - len(rows)
        for m in fb_grouped.get(meal_type) or []:
            k = _meal_dedupe_key(m)
            if k in avoid:
                continue
            rows.append(copy.deepcopy(m))
            avoid.add(k)
            need -= 1
            if need <= 0:
                break
        grouped[meal_type] = rows
    out: List[Dict[str, Any]] = []
    for meal_type in MEAL_TYPE_TARGETS:
        out.extend(grouped.get(meal_type) or [])
    return out


def _merge_meals_preserve_favorites(
    *,
    old_library: List[Dict[str, Any]],
    favorite_ids: List[str],
    fresh_library: List[Dict[str, Any]],
    preferences: Dict[str, Any],
    seed: int,
) -> List[Dict[str, Any]]:
    fav_set = {fid.strip() for fid in favorite_ids if isinstance(fid, str) and fid.strip()}
    old_by_id: Dict[str, Dict[str, Any]] = {}
    for m in old_library:
        if not isinstance(m, dict):
            continue
        mid = str(m.get("id", "")).strip()
        if mid:
            old_by_id[mid] = m

    preserved: List[Dict[str, Any]] = []
    for fid in fav_set:
        src = old_by_id.get(fid)
        if src:
            preserved.append(copy.deepcopy(src))

    old_non_fav_keys = {
        _meal_dedupe_key(m) for mid, m in old_by_id.items() if mid not in fav_set
    }

    grouped_fresh = _group_by_meal_type(fresh_library)
    combined: List[Dict[str, Any]] = []
    seen_keys: Set[str] = set()

    for meal_type, target in MEAL_TYPE_TARGETS.items():
        favs = [copy.deepcopy(m) for m in preserved if str(m.get("meal_type", "")).strip() == meal_type]
        news_pool = list(grouped_fresh.get(meal_type) or [])
        row: List[Dict[str, Any]] = []
        seen_row: Set[str] = set()

        for m in favs:
            k = _meal_dedupe_key(m)
            if k in seen_row:
                continue
            row.append(m)
            seen_row.add(k)

        need_more = max(0, max(target, len(row)) - len(row))
        for m in news_pool:
            if need_more <= 0:
                break
            k = _meal_dedupe_key(m)
            if k in seen_row or k in old_non_fav_keys:
                continue
            row.append(copy.deepcopy(m))
            seen_row.add(k)
            need_more -= 1

        combined.extend(row)
        seen_keys.update(seen_row)

    topped = _topup_meal_coverage(combined, preferences, seed=seed + 31, avoid_keys=seen_keys | old_non_fav_keys)
    return _finalize_meal_ids(topped, fav_set)


def _normalize_generated_library(raw: Any, target_counts: Optional[Dict[str, int]] = None) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    targets = target_counts or MEAL_TYPE_TARGETS
    dedupe = set()
    normalized: List[Dict[str, Any]] = []
    for idx, entry in enumerate(raw, start=1):
        meal = _normalize_meal_entry(entry, idx)
        if not meal:
            continue
        if _safe_string(meal.get("meal_type")) not in targets:
            continue
        key = f"{meal['meal_type'].lower()}|{meal['title'].strip().lower()}|{meal['prep_time_minutes']}"
        if key in dedupe:
            continue
        dedupe.add(key)
        normalized.append(meal)
    normalized = _enforce_type_targets(normalized, targets)
    return _reindex_meal_ids(normalized)


def _diet_tags_from_preferences(preferences: Dict[str, Any]) -> List[str]:
    dietary = preferences.get("dietary_preferences") or []
    mapping = {
        "vegan": "Vegan",
        "vegetarian": "Vegetarian",
        "gluten_free": "Gluten-Free",
        "keto": "Keto",
        "lactose_intolerant": "Lactose-free",
        "kosher": "Kosher",
    }
    tags: List[str] = []
    for key in dietary:
        if isinstance(key, str) and key in mapping and mapping[key] not in tags:
            tags.append(mapping[key])
    if not tags and isinstance(dietary, list) and "no_preferences" in dietary:
        return ["Balanced"]
    return tags if tags else ["Balanced"]


def _build_fallback_library(
    preferences: Dict[str, Any],
    *,
    seed: int = 0,
    avoid_keys: Optional[Set[str]] = None,
    target_counts: Optional[Dict[str, int]] = None,
) -> List[Dict[str, Any]]:
    """Varied 12-meal library when OpenAI is unavailable or returns invalid output."""
    budget_level = "Medium"
    profile_goals = _safe_string_list(preferences.get("main_goal"))
    goal_tags = list(dict.fromkeys(profile_goals)) if profile_goals else ["Balanced"]
    diet_tags = _diet_tags_from_preferences(preferences)

    def ing(name: str, qty: float, unit: str, category: str, rounding: str) -> Dict[str, Any]:
        return {
            "name": name,
            "quantity": round(qty, 2),
            "unit": unit.lower(),
            "category": category,
            "rounding": rounding if rounding in {"none", "ceil"} else "none",
        }

    dietary = preferences.get("dietary_preferences") or []
    vegan = "vegan" in dietary
    vegetarian = "vegetarian" in dietary and not vegan
    gluten_free = "gluten_free" in dietary

    def protein_main() -> List[Dict[str, Any]]:
        if vegan:
            return [ing("Firm tofu", 200, "g", "Protein", "none")]
        if vegetarian:
            return [ing("Eggs", 2, "unit", "Dairy", "ceil")]
        return [ing("Chicken breast", 180, "g", "Meat", "none")]

    def dairy_milk() -> List[Dict[str, Any]]:
        if vegan:
            return [ing("Oat milk", 200, "ml", "Dairy", "none")]
        return [ing("Milk", 200, "ml", "Dairy", "none")]

    blueprints: List[Tuple[str, str, int, int, List[Dict[str, Any]], List[str]]] = [
        (
            "Breakfast",
            "Berry overnight oats",
            10,
            380,
            [
                ing("Rolled oats", 50, "g", "Pantry", "none"),
                *dairy_milk(),
                ing("Mixed berries", 80, "g", "Fruits", "none"),
                ing("Chia seeds", 1, "tbsp", "Pantry", "none"),
            ],
            [
                "Combine oats, milk, and chia in a jar; chill 4+ hours or soak 15 min for a quick version.",
                "Top with berries before serving.",
            ],
        ),
        (
            "Breakfast",
            "Veggie scramble wrap",
            15,
            420,
            [
                ing("Corn tortilla" if gluten_free else "Whole wheat tortilla", 1, "unit", "Pantry", "ceil"),
                ing("Eggs", 2, "unit", "Dairy", "ceil") if not vegan else ing("Chickpea flour", 40, "g", "Pantry", "none"),
                ing("Spinach", 60, "g", "Vegetables", "none"),
                ing("Cherry tomatoes", 80, "g", "Vegetables", "none"),
            ],
            [
                "Sauté vegetables until softened.",
                "Scramble eggs (or chickpea batter) and fold into a warm tortilla.",
            ],
        ),
        (
            "Breakfast",
            "Greek yogurt fruit bowl" if not vegan else "Coconut yogurt fruit bowl",
            8,
            320,
            [
                ing("Greek yogurt", 200, "g", "Dairy", "none") if not vegan else ing("Coconut yogurt", 200, "g", "Dairy", "none"),
                ing("Banana", 1, "unit", "Fruits", "ceil"),
                ing("Walnuts", 20, "g", "Pantry", "none"),
                ing("Honey", 1, "tsp", "Pantry", "none"),
            ],
            [
                "Layer yogurt, sliced banana, and walnuts.",
                "Drizzle honey (or maple syrup if vegan).",
            ],
        ),
        (
            "Lunch",
            "Mediterranean grain bowl",
            25,
            520,
            [
                ing("Cooked quinoa", 150, "g", "Pantry", "none"),
                ing("Cucumber", 100, "g", "Vegetables", "none"),
                ing("Feta cheese", 40, "g", "Dairy", "none") if not vegan else ing("Olives", 40, "g", "Pantry", "none"),
                ing("Chickpeas", 120, "g", "Pantry", "none"),
                ing("Lemon", 0.5, "unit", "Fruits", "ceil"),
            ],
            [
                "Warm quinoa; toss with chopped cucumber, chickpeas, and lemon juice.",
                "Top with feta or olives.",
            ],
        ),
        (
            "Lunch",
            "Turkey avocado salad" if not vegetarian and not vegan else "Chickpea avocado salad",
            20,
            480,
            [
                *([] if vegetarian or vegan else [ing("Turkey slices", 120, "g", "Meat", "none")]),
                *([ing("Chickpeas", 150, "g", "Pantry", "none")] if vegetarian or vegan else []),
                ing("Mixed greens", 100, "g", "Vegetables", "none"),
                ing("Avocado", 0.5, "unit", "Vegetables", "ceil"),
                ing("Olive oil", 1, "tbsp", "Pantry", "none"),
            ],
            [
                "Arrange greens and protein.",
                "Slice avocado; dress with olive oil, salt, and pepper.",
            ],
        ),
        (
            "Lunch",
            "Tomato lentil soup",
            35,
            400,
            [
                ing("Red lentils", 80, "g", "Pantry", "none"),
                ing("Canned diced tomatoes", 1, "can", "Pantry", "ceil"),
                ing("Vegetable broth", 500, "ml", "Pantry", "none"),
                ing("Onion", 0.5, "unit", "Vegetables", "ceil"),
            ],
            [
                "Sauté onion; add lentils, tomatoes, and broth.",
                "Simmer 20–25 minutes until lentils are tender.",
            ],
        ),
        (
            "Dinner",
            "One-pan lemon herb dinner",
            35,
            560,
            [
                *protein_main(),
                ing("Broccoli", 200, "g", "Vegetables", "none"),
                ing("Baby potatoes", 250, "g", "Vegetables", "none"),
                ing("Olive oil", 1.5, "tbsp", "Pantry", "none"),
                ing("Lemon", 0.5, "unit", "Fruits", "ceil"),
            ],
            [
                "Toss protein and vegetables with oil, salt, and herbs.",
                "Roast or pan-sear until cooked through; finish with lemon.",
            ],
        ),
        (
            "Dinner",
            "Vegetable stir-fry with rice",
            30,
            540,
            [
                ing("Jasmine rice", 80, "g", "Pantry", "none"),
                ing("Bell pepper", 1, "unit", "Vegetables", "ceil"),
                ing("Snap peas", 120, "g", "Vegetables", "none"),
                ing("Soy sauce", 2, "tbsp", "Pantry", "none"),
                *([] if vegan else [ing("Eggs", 1, "unit", "Dairy", "ceil")]),
                *([ing("Edamame", 80, "g", "Vegetables", "none")] if vegan else []),
            ],
            [
                "Cook rice.",
                "Stir-fry vegetables; add soy sauce; serve over rice.",
            ],
        ),
        (
            "Dinner",
            "Baked fish with herbs" if not vegan and not vegetarian else "Baked tofu with herbs",
            40,
            520,
            [
                *([] if vegan or vegetarian else [ing("White fish fillet", 200, "g", "Meat", "none")]),
                *([ing("Firm tofu", 250, "g", "Protein", "none")] if vegan or vegetarian else []),
                ing("Zucchini", 1, "unit", "Vegetables", "ceil"),
                ing("Cherry tomatoes", 120, "g", "Vegetables", "none"),
                ing("Olive oil", 1, "tbsp", "Pantry", "none"),
            ],
            [
                "Season protein; bake with vegetables 18–22 minutes at 200°C.",
                "Serve warm.",
            ],
        ),
        (
            "Snack",
            "Apple almond butter",
            5,
            220,
            [
                ing("Apple", 1, "unit", "Fruits", "ceil"),
                ing("Almond butter", 2, "tbsp", "Pantry", "none"),
            ],
            ["Slice apple; serve with almond butter for dipping."],
        ),
        (
            "Snack",
            "Veggie sticks and hummus",
            8,
            180,
            [
                ing("Carrots", 100, "g", "Vegetables", "none"),
                ing("Celery", 80, "g", "Vegetables", "none"),
                ing("Hummus", 80, "g", "Pantry", "none"),
            ],
            ["Cut vegetables; serve with hummus."],
        ),
        (
            "Snack",
            "Protein smoothie",
            7,
            260,
            [
                ing("Banana", 1, "unit", "Fruits", "ceil"),
                *dairy_milk(),
                ing("Protein powder", 1, "scoop", "Pantry", "ceil") if not vegan else ing("Peanut butter", 1, "tbsp", "Pantry", "none"),
            ],
            ["Blend until smooth; add ice if desired."],
        ),
    ]

    fallback_variants: List[Tuple[str, str, int, int, List[Dict[str, Any]], List[str]]] = [
        (
            "Breakfast",
            "Savory spinach oat pancakes",
            18,
            410,
            [
                ing("Oat flour", 60, "g", "Pantry", "none"),
                ing("Eggs", 2, "unit", "Dairy", "ceil") if not vegan else ing("Chickpea flour", 55, "g", "Pantry", "none"),
                ing("Spinach", 70, "g", "Vegetables", "none"),
                ing("Olive oil", 1, "tsp", "Pantry", "none"),
            ],
            [
                "Blend batter ingredients until smooth.",
                "Cook small pancakes on a lightly oiled pan until both sides set.",
            ],
        ),
        (
            "Lunch",
            "Tuna bean salad" if not vegan and not vegetarian else "White bean herb salad",
            15,
            430,
            [
                *([] if vegan or vegetarian else [ing("Canned tuna", 1, "can", "Meat", "ceil")]),
                *([ing("White beans", 140, "g", "Pantry", "none")] if vegan or vegetarian else [ing("White beans", 90, "g", "Pantry", "none")]),
                ing("Red onion", 0.25, "unit", "Vegetables", "ceil"),
                ing("Parsley", 10, "g", "Vegetables", "none"),
                ing("Lemon", 0.5, "unit", "Fruits", "ceil"),
            ],
            [
                "Drain and combine protein, beans, onion, and parsley.",
                "Dress with lemon, olive oil, salt, and pepper.",
            ],
        ),
        (
            "Dinner",
            "Turkey chili skillet" if not vegan and not vegetarian else "Bean chili skillet",
            32,
            570,
            [
                *([] if vegan or vegetarian else [ing("Ground turkey", 170, "g", "Meat", "none")]),
                *([ing("Kidney beans", 160, "g", "Pantry", "none")] if vegan or vegetarian else [ing("Kidney beans", 90, "g", "Pantry", "none")]),
                ing("Tomato sauce", 200, "ml", "Pantry", "none"),
                ing("Bell pepper", 1, "unit", "Vegetables", "ceil"),
                ing("Onion", 0.5, "unit", "Vegetables", "ceil"),
            ],
            [
                "Cook onion and pepper, then add protein and brown lightly.",
                "Add beans and tomato sauce; simmer 12-15 minutes.",
            ],
        ),
        (
            "Snack",
            "Cottage bowl with cucumber" if not vegan else "Tofu cucumber bowl",
            6,
            210,
            [
                ing("Cottage cheese", 160, "g", "Dairy", "none") if not vegan else ing("Silken tofu", 160, "g", "Protein", "none"),
                ing("Cucumber", 90, "g", "Vegetables", "none"),
                ing("Olive oil", 1, "tsp", "Pantry", "none"),
                ing("Lemon", 0.25, "unit", "Fruits", "ceil"),
            ],
            [
                "Mix protein base with chopped cucumber.",
                "Finish with lemon juice, olive oil, and seasoning.",
            ],
        ),
    ]
    expanded: List[Tuple[str, str, int, int, List[Dict[str, Any]], List[str]]] = list(blueprints) + fallback_variants

    rng = random.Random(seed)
    avoid = set(avoid_keys or [])
    targets = target_counts or MEAL_TYPE_TARGETS
    by_type: Dict[str, List[Tuple[str, str, int, int, List[Dict[str, Any]], List[str]]]] = {k: [] for k in targets}
    for tup in expanded:
        mt = tup[0]
        if mt in by_type:
            by_type[mt].append(tup)

    selected: List[Tuple[str, str, int, int, List[Dict[str, Any]], List[str]]] = []
    for meal_type in targets:
        pool = list(by_type.get(meal_type) or [])
        rng.shuffle(pool)
        picked: List[Tuple[str, str, int, int, List[Dict[str, Any]], List[str]]] = []
        local_avoid = set(avoid)
        for tup in pool:
            if len(picked) >= targets[meal_type]:
                break
            _, title, prep_min, _, _, _ = tup
            key = _meal_dedupe_key({"meal_type": meal_type, "title": title, "prep_time_minutes": prep_min})
            if key in local_avoid:
                continue
            picked.append(tup)
            local_avoid.add(key)
        for tup in picked:
            _, title, prep_min, _, _, _ = tup
            avoid.add(_meal_dedupe_key({"meal_type": meal_type, "title": title, "prep_time_minutes": prep_min}))
        selected.extend(picked)

    meals: List[Dict[str, Any]] = []
    for idx, (meal_type, title, prep_min, kcal, ingredients, instructions) in enumerate(selected, start=1):
        summary = f"{title} — quick plan-friendly meal.".strip()
        meals.append(
            {
                "id": f"meal_{idx}",
                "title": title,
                "meal_type": meal_type,
                "diet_tags": list(diet_tags),
                "prep_time_minutes": prep_min,
                "estimated_calories": kcal,
                "budget_level": budget_level,
                "goal_tags": list(goal_tags),
                "summary_short": summary,
                "short_ingredients_preview": ", ".join([i["name"] for i in ingredients[:4]]),
                "ingredients": ingredients,
                "instructions": instructions,
                "base_servings": 1,
            }
        )

    return meals


def _read_generation_preferences(user_id: str) -> Dict[str, Any]:
    """Profile/onboarding fields only (Users table). Meal-specific PREFERENCES record is not used."""
    users_table = _table_from_env("USERS_TABLE")
    user_item = users_table.get_item(Key={"user_id": user_id}, ConsistentRead=True).get("Item") or {}
    return {
        "dietary_preferences": _safe_string_list(user_item.get("dietary_preferences")),
        "main_goal": _safe_string_list(user_item.get("main_goal")),
        "activity_considerations": _safe_string_list(user_item.get("activity_considerations")),
    }


def _openai_diet_context(preferences: Dict[str, Any]) -> Dict[str, Any]:
    dietary = _safe_string_list(preferences.get("dietary_preferences"))
    main_goal = _safe_string_list(preferences.get("main_goal"))
    return {
        "dietary_preferences": dietary[:6],
        "main_goal": main_goal[:3],
    }


def _openai_prompt(
    diet_context: Dict[str, Any],
    meal_type: str,
    target_count: int,
    avoid_titles: List[str],
    diversity_nonce: str,
) -> str:
    compact = {"meal_type": meal_type, "target_count": target_count, "diet": diet_context, "avoid_titles": avoid_titles[:8]}
    return (
        "Output JSON only with key meal_library.\n"
        f"Generate exactly {target_count} {meal_type} meals.\n"
        "Do not repeat avoid_titles. Do not recreate same concept under a new title.\n"
        "Each meal must be meaningfully different in main ingredients and preparation style.\n"
        "Each meal max 5 ingredients and concise instructions (2-4 short steps).\n"
        "Schema per meal: id,title,meal_type,diet_tags,prep_time_minutes,estimated_calories,"
        "budget_level,goal_tags,summary_short,short_ingredients_preview,ingredients,instructions,base_servings.\n"
        "Ingredient object: name,quantity,unit,category,rounding (none|ceil). base_servings=1.\n"
        f"Input:{json.dumps(compact, separators=(',', ':'))}|nonce:{diversity_nonce}"
    )


def _try_openai_library(
    diet_context: Dict[str, Any],
    *,
    meal_type: str,
    target_count: int,
    avoid_titles: List[str],
    diversity_nonce: str,
) -> Tuple[Optional[List[Dict[str, Any]]], str]:
    """Call OpenAI; return (library, '') only when output is complete and valid; else (None, reason_code)."""
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        print("[meals-generate] openai skipped: missing OPENAI_API_KEY")
        return None, "missing_api_key"
    prompt = _openai_prompt(diet_context, meal_type, target_count, avoid_titles, diversity_nonce)
    print(f"[meals-generate] prompt_length={len(prompt)}")
    try:
        client = OpenAI(api_key=api_key, timeout=OPENAI_TIMEOUT_SECONDS, max_retries=OPENAI_MAX_RETRIES)
        print(f"[meals-generate] before openai call (timeout={OPENAI_TIMEOUT_SECONDS}s, retries={OPENAI_MAX_RETRIES})")
        response = client.responses.create(
            model=OPENAI_MODEL,
            input=prompt,
            text={"format": {"type": "json_object"}},
            timeout=OPENAI_TIMEOUT_SECONDS,
        )
        print("[meals-generate] after openai call")
    except APITimeoutError as err:
        print(f"[meals-generate] openai timed out: {repr(err)}")
        return None, "openai_timeout"
    except APIConnectionError as err:
        print(f"[meals-generate] openai connection error: {repr(err)}")
        return None, "openai_connection"
    except APIError as err:
        print(f"[meals-generate] openai api error: {repr(err)}")
        return None, "openai_api_error"
    output_text = getattr(response, "output_text", "")
    if not isinstance(output_text, str) or not output_text.strip():
        print("[meals-generate] openai returned empty output")
        return None, "openai_empty_output"
    try:
        parsed = json.loads(output_text)
    except json.JSONDecodeError:
        print("[meals-generate] openai returned malformed JSON")
        return None, "openai_bad_json"
    if not isinstance(parsed, dict):
        print("[meals-generate] openai JSON not an object")
        return None, "openai_bad_shape"
    library = _normalize_generated_library(parsed.get("meal_library"), target_counts={meal_type: target_count})
    type_count = len([m for m in library if _safe_string(m.get("meal_type")) == meal_type])
    if not library or type_count < target_count:
        print("[meals-generate] openai output invalid or incomplete after normalize")
        return None, "openai_invalid_or_incomplete"
    return library, ""


def _next_meal_id(existing_ids: Set[str]) -> str:
    idx = 1
    while f"meal_{idx}" in existing_ids:
        idx += 1
    return f"meal_{idx}"


def _merge_generated_for_selected_type(
    *,
    old_library: List[Dict[str, Any]],
    favorite_ids: List[str],
    generated_type_meals: List[Dict[str, Any]],
    meal_type: str,
    target_count: int,
) -> List[Dict[str, Any]]:
    fav_set = {fid.strip() for fid in favorite_ids if isinstance(fid, str) and fid.strip()}
    untouched: List[Dict[str, Any]] = []
    requested_old: List[Dict[str, Any]] = []
    for meal in old_library:
        if _safe_string(meal.get("meal_type")) == meal_type:
            requested_old.append(meal)
        else:
            untouched.append(copy.deepcopy(meal))

    preserved_favorites: List[Dict[str, Any]] = []
    old_non_fav_keys: Set[str] = set()
    for meal in requested_old:
        meal_id = _safe_string(meal.get("id"))
        if meal_id and meal_id in fav_set:
            preserved_favorites.append(copy.deepcopy(meal))
        else:
            old_non_fav_keys.add(_meal_dedupe_key(meal))

    generated_pool = [
        copy.deepcopy(meal) for meal in generated_type_meals if _safe_string(meal.get("meal_type")) == meal_type
    ]
    selected_new: List[Dict[str, Any]] = []
    seen_keys = {_meal_dedupe_key(meal) for meal in preserved_favorites}
    for meal in generated_pool:
        if len(selected_new) >= max(0, target_count - len(preserved_favorites)):
            break
        key = _meal_dedupe_key(meal)
        if key in seen_keys or key in old_non_fav_keys:
            continue
        selected_new.append(meal)
        seen_keys.add(key)

    existing_ids = {_safe_string(meal.get("id")) for meal in untouched + preserved_favorites if _safe_string(meal.get("id"))}
    finalized_new: List[Dict[str, Any]] = []
    for meal in selected_new:
        item = copy.deepcopy(meal)
        item["id"] = _next_meal_id(existing_ids)
        existing_ids.add(item["id"])
        finalized_new.append(item)

    merged = untouched + preserved_favorites + finalized_new
    order = {meal: idx for idx, meal in enumerate(VALID_MEAL_TYPES)}
    return sorted(
        merged,
        key=lambda m: (
            order.get(_safe_string(m.get("meal_type")), 99),
            _safe_string(m.get("title")).lower(),
            _safe_string(m.get("id")).lower(),
        ),
    )


def _openai_failure_response(reason: str) -> Dict[str, Any]:
    if reason == "openai_timeout":
        return _json_response(504, {"message": "Meal generation is currently unavailable. Please try again."})
    if reason in {"openai_connection", "openai_api_error"}:
        return _json_response(502, {"message": "Meal generation is currently unavailable. Please try again."})
    if reason in {"openai_empty_output", "openai_bad_json", "openai_bad_shape", "openai_invalid_or_incomplete"}:
        return _json_response(502, {"message": "Meal generation is currently unavailable. Please try again."})
    if reason == "missing_api_key":
        return _json_response(502, {"message": "Meal generation is currently unavailable. Please try again."})
    return _json_response(502, {"message": "Meal generation is currently unavailable. Please try again."})


def _save_library(user_id: str, meal_library: List[Dict[str, Any]], favorite_meals: List[str], generated_at: str) -> None:
    table = _table_from_env("MEALS_TABLE")
    item = {
        "user_id": user_id,
        "record_key": "LIBRARY#current",
        "meal_library": meal_library,
        "favorite_meals": favorite_meals,
        "generated_at": generated_at,
        "updated_at": generated_at,
    }
    table.put_item(Item=_to_dynamodb_safe(item))


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    request_context = event.get("requestContext") or {}
    http = request_context.get("http") or {}
    method = (http.get("method") or event.get("httpMethod") or "").upper()

    if method == "OPTIONS":
        return {"statusCode": 200, "headers": dict(_CORS_HEADERS), "body": ""}
    if method != "POST":
        return _json_response(405, {"message": "Method not allowed."})
    print("[meals-generate] request received")

    user_id = _extract_cognito_sub(event)
    if not user_id:
        return _json_response(401, {"message": "Missing Cognito user id (sub) in request."})

    try:
        payload = _parse_body(event)
    except json.JSONDecodeError:
        return _json_response(400, {"message": "Request body must be valid JSON."})
    requested_meal_type = _normalize_meal_type((payload or {}).get("meal_type"))
    if requested_meal_type not in VALID_MEAL_TYPES:
        return _json_response(400, {"message": "meal_type must be one of Breakfast, Lunch, Dinner, Snack."})
    print(f"[meals-generate] requested_meal_type={requested_meal_type}")

    try:
        print("[meals-generate] loading preferences")
        preferences = _read_generation_preferences(user_id)
        print("[meals-generate] preferences loaded")
        meals_table = _table_from_env("MEALS_TABLE")
        current_item = meals_table.get_item(Key={"user_id": user_id, "record_key": "LIBRARY#current"}).get("Item") or {}
        old_library_raw = current_item.get("meal_library") or []
        old_library: List[Dict[str, Any]] = [m for m in old_library_raw if isinstance(m, dict)]
        favorite_meals = _safe_string_list(current_item.get("favorite_meals"))
        fav_set = {fid for fid in favorite_meals}
        previous_titles: List[str] = []
        previous_title_seen: Set[str] = set()
        for m in old_library:
            if _safe_string(m.get("meal_type")) != requested_meal_type:
                continue
            mid = str(m.get("id", "")).strip()
            if mid in fav_set:
                continue
            title = str(m.get("title", "")).strip()
            title_key = title.lower()
            if title and title_key not in previous_title_seen and len(previous_titles) < 8:
                previous_titles.append(title)
                previous_title_seen.add(title_key)
        print(f"[meals-generate] previous_titles_count={len(previous_titles)}")
        seed = _generation_seed_int(user_id)
        diet_context = _openai_diet_context(preferences)
        openai_library, openai_reason = _try_openai_library(
            diet_context,
            meal_type=requested_meal_type,
            target_count=GENERATE_TARGET_COUNT,
            avoid_titles=previous_titles,
            diversity_nonce=str(seed),
        )
        if not openai_library:
            print(f"[meals-generate] generation_failed reason={openai_reason}")
            return _openai_failure_response(openai_reason)
        fresh_library = openai_library
        source = "openai"
        selected_titles = [
            _safe_string(m.get("title"))
            for m in fresh_library
            if _safe_string(m.get("meal_type")) == requested_meal_type and _safe_string(m.get("title"))
        ]
        print(f"[meals-generate] source={source}")
        print(f"[meals-generate] selected_generated_titles={selected_titles[:GENERATE_TARGET_COUNT]}")
        fresh_type_count = len([m for m in fresh_library if _safe_string(m.get("meal_type")) == requested_meal_type])
        if not fresh_library or fresh_type_count < GENERATE_TARGET_COUNT:
            print("[meals-generate] refuse save: fresh type library empty or incomplete")
            return _json_response(500, {"message": "Could not build a valid meal library."})
        final_library = _merge_generated_for_selected_type(
            old_library=old_library,
            favorite_ids=favorite_meals,
            generated_type_meals=fresh_library,
            meal_type=requested_meal_type,
            target_count=GENERATE_TARGET_COUNT,
        )
        final_type_count = len([m for m in final_library if _safe_string(m.get("meal_type")) == requested_meal_type])
        favorite_type_count = len(
            [
                m
                for m in old_library
                if _safe_string(m.get("meal_type")) == requested_meal_type and _safe_string(m.get("id")) in fav_set
            ]
        )
        required_type_count = max(GENERATE_TARGET_COUNT, favorite_type_count)
        if not final_library or final_type_count < required_type_count:
            print("[meals-generate] generation_failed reason=merge_incomplete")
            return _json_response(502, {"message": "Meal generation is currently unavailable. Please try again."})
        generated_at = _iso_utc_now()
        print("[meals-generate] before dynamodb save")
        _save_library(user_id, final_library, favorite_meals, generated_at)
        print("[meals-generate] after dynamodb save")
        metadata: Dict[str, Any] = {
            "library_record_key": "LIBRARY#current",
            "generated_at": generated_at,
            "updated_at": generated_at,
            "library_source": "generated",
            "source": source,
            "model": OPENAI_MODEL,
            "generated_meal_type": requested_meal_type,
        }
        return _json_response(
            200,
            {
                "meal_library": final_library,
                "favorite_meals": favorite_meals,
                "metadata": metadata,
            },
        )
    except ValueError as err:
        print(f"[meals-generate] value error: {repr(err)}")
        return _json_response(500, {"message": str(err)})
    except Exception as err:
        print(f"[meals-generate] unexpected error: {repr(err)}")
        print(traceback.format_exc())
        return _json_response(500, {"message": "Unexpected error while generating meals."})
