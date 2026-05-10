import json
import os
import traceback
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

import boto3
from openai import APIConnectionError, APIError, APITimeoutError, OpenAI

OPENAI_MODEL = "gpt-4.1-mini"
OPENAI_TIMEOUT_SECONDS = 12
OPENAI_MAX_RETRIES = 0
MEAL_TYPE_TARGETS: Dict[str, int] = {
    "Breakfast": 3,
    "Lunch": 3,
    "Dinner": 3,
    "Snack": 3,
}
PACKAGE_ROUNDING_UNITS = {"can", "box", "package", "pack", "jar", "bottle", "unit", "egg", "piece"}
NORMAL_ROUNDING_UNITS = {"g", "kg", "ml", "l", "tbsp", "tsp"}

_CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://main.dnp9vhzk0bw8l.amplifyapp.com",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
}


def _json_response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": dict(_CORS_HEADERS),
        "body": json.dumps(body),
    }


def _iso_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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


def _safe_goals(value: Any, fallback_goal: Any = "") -> List[str]:
    goals = _safe_string_list(value)
    if goals:
        return goals
    single = _safe_string(fallback_goal)
    return [single] if single else []


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
            output.append(step_text)
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


def _enforce_type_targets(meals: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    grouped = _group_by_meal_type(meals)
    output: List[Dict[str, Any]] = []
    for meal_type, target_count in MEAL_TYPE_TARGETS.items():
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


def _normalize_generated_library(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    dedupe = set()
    normalized: List[Dict[str, Any]] = []
    for idx, entry in enumerate(raw, start=1):
        meal = _normalize_meal_entry(entry, idx)
        if not meal:
            continue
        key = f"{meal['meal_type'].lower()}|{meal['title'].strip().lower()}"
        if key in dedupe:
            continue
        dedupe.add(key)
        normalized.append(meal)
    normalized = _enforce_type_targets(normalized)
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


def _build_fallback_library(preferences: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Deterministic 12-meal library when OpenAI is unavailable or returns invalid output."""
    budget_level = _safe_budget_level(preferences.get("budget_level"))
    meal_goals = _safe_string_list(preferences.get("goals"))
    profile_goals = _safe_string_list(preferences.get("main_goal"))
    goal_tags = list(dict.fromkeys([*meal_goals, *profile_goals]))
    if not goal_tags:
        goal_tags = ["Balanced"]
    diet_tags = _diet_tags_from_preferences(preferences)
    allergies = _safe_string_list(preferences.get("allergies"))
    allergy_note = f" Check labels; avoid: {', '.join(allergies)}." if allergies else ""

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

    meals: List[Dict[str, Any]] = []
    for idx, (meal_type, title, prep_min, kcal, ingredients, instructions) in enumerate(blueprints, start=1):
        summary = f"{title} — quick plan-friendly meal.{allergy_note}".strip()
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
                "instructions": [s + allergy_note if allergy_note else s for s in instructions],
                "base_servings": 1,
            }
        )

    return _reindex_meal_ids(meals)


def _read_generation_preferences(user_id: str) -> Dict[str, Any]:
    meals_table = _table_from_env("MEALS_TABLE")
    users_table = _table_from_env("USERS_TABLE")
    pref_item = meals_table.get_item(Key={"user_id": user_id, "record_key": "PREFERENCES"}).get("Item") or {}
    user_item = users_table.get_item(Key={"user_id": user_id}, ConsistentRead=True).get("Item") or {}
    return {
        "allergies": _safe_string_list(pref_item.get("allergies")),
        "budget_level": _safe_budget_level(pref_item.get("budget_level")),
        "goals": _safe_goals(pref_item.get("goals"), pref_item.get("goal")),
        "dietary_preferences": _safe_string_list(user_item.get("dietary_preferences")),
        "main_goal": _safe_string_list(user_item.get("main_goal")),
        "activity_considerations": _safe_string_list(user_item.get("activity_considerations")),
    }


def _openai_prompt(preferences: Dict[str, Any]) -> str:
    compact = {"preferences": preferences, "targets": MEAL_TYPE_TARGETS}
    return (
        "Output JSON only with key meal_library.\n"
        "Generate about 12 meals total: 3 Breakfast, 3 Lunch, 3 Dinner, 3 Snack.\n"
        "Each meal must include: id,title,meal_type,diet_tags,prep_time_minutes,estimated_calories,"
        "budget_level,goal_tags,summary_short,ingredients,instructions,base_servings.\n"
        "Ingredient object: name,quantity,unit,category,rounding where rounding is none or ceil.\n"
        "base_servings must always be 1.\n"
        f"Input: {json.dumps(compact, separators=(',', ':'))}"
    )


def _try_openai_library(preferences: Dict[str, Any]) -> Tuple[Optional[List[Dict[str, Any]]], str]:
    """Call OpenAI; return (library, '') only when output is complete and valid; else (None, reason_code)."""
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        print("[meals-generate] openai skipped: missing OPENAI_API_KEY")
        return None, "missing_api_key"
    try:
        client = OpenAI(api_key=api_key, timeout=OPENAI_TIMEOUT_SECONDS, max_retries=OPENAI_MAX_RETRIES)
        print(f"[meals-generate] before openai call (timeout={OPENAI_TIMEOUT_SECONDS}s, retries={OPENAI_MAX_RETRIES})")
        response = client.responses.create(
            model=OPENAI_MODEL,
            input=_openai_prompt(preferences),
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
    library = _normalize_generated_library(parsed.get("meal_library"))
    if not library or not _library_has_full_coverage(library):
        print("[meals-generate] openai output invalid or incomplete after normalize")
        return None, "openai_invalid_or_incomplete"
    return library, ""


def _load_existing_favorites(user_id: str) -> List[str]:
    table = _table_from_env("MEALS_TABLE")
    current = table.get_item(Key={"user_id": user_id, "record_key": "LIBRARY#current"}).get("Item") or {}
    return _safe_string_list(current.get("favorite_meals"))


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
        _parse_body(event)
    except json.JSONDecodeError:
        return _json_response(400, {"message": "Request body must be valid JSON."})

    try:
        print("[meals-generate] loading preferences")
        preferences = _read_generation_preferences(user_id)
        print("[meals-generate] preferences loaded")
        openai_library, openai_reason = _try_openai_library(preferences)
        generation_warning: Optional[str] = None
        if openai_library:
            final_library = openai_library
            source = "openai"
        else:
            print(f"[meals-generate] fallback: openai did not return a valid library ({openai_reason})")
            final_library = _build_fallback_library(preferences)
            source = "fallback"
            generation_warning = (
                "AI meal generation was slow or unavailable. Showing a starter library you can refine in Meal Preferences."
            )
            print("[meals-generate] fallback library built")
        if not final_library or not _library_has_full_coverage(final_library):
            print("[meals-generate] refuse save: library empty or incomplete")
            return _json_response(500, {"message": "Could not build a valid meal library."})
        print("[meals-generate] loading existing favorites")
        favorite_meals = _load_existing_favorites(user_id)
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
        }
        if generation_warning:
            metadata["generation_warning"] = generation_warning
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
