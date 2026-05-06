import json
import os
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

import boto3
from openai import APIConnectionError, APIError, APITimeoutError, OpenAI

OPENAI_MODEL = "gpt-4.1-mini"
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
    compact = {
        "preferences": preferences,
        "rules": {
            "meal_type_targets": MEAL_TYPE_TARGETS,
            "base_servings_always": 1,
            "return_json_only": True,
            "ingredient_rounding_allowed": ["none", "ceil"],
            "meal_type_allowed": ["Breakfast", "Lunch", "Dinner", "Snack"],
            "unit_examples": ["g", "kg", "ml", "l", "tbsp", "tsp", "can", "box", "jar", "egg"],
        },
    }
    return (
        "Generate a meal library JSON only (no markdown).\n"
        "Return exactly this top-level shape:\n"
        "{\n"
        '  "meal_library":[{\n'
        '    "id":"meal_1",\n'
        '    "title":"...",\n'
        '    "meal_type":"Breakfast|Lunch|Dinner|Snack",\n'
        '    "diet_tags":["..."],\n'
        '    "prep_time_minutes":20,\n'
        '    "estimated_calories":450,\n'
        '    "budget_level":"Low|Medium|High",\n'
        '    "goal_tags":["..."],\n'
        '    "summary_short":"...",\n'
        '    "ingredients":[{"name":"...","quantity":1,"unit":"g","category":"Pantry","rounding":"none|ceil"}],\n'
        '    "instructions":["..."],\n'
        '    "base_servings":1\n'
        "  }]\n"
        "}\n"
        f"Input: {json.dumps(compact, separators=(',', ':'))}"
    )


def _generate_library_from_openai(preferences: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], str]:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise ValueError("Missing OPENAI_API_KEY env var.")
    client = OpenAI(api_key=api_key)
    response = client.responses.create(
        model=OPENAI_MODEL,
        input=_openai_prompt(preferences),
        text={"format": {"type": "json_object"}},
    )
    output_text = getattr(response, "output_text", "")
    if not isinstance(output_text, str) or not output_text.strip():
        return [], "Model returned empty output."
    try:
        parsed = json.loads(output_text)
    except json.JSONDecodeError:
        return [], "Model returned malformed JSON."
    if not isinstance(parsed, dict):
        return [], "Model returned an unexpected JSON shape."
    library = _normalize_generated_library(parsed.get("meal_library"))
    return library, ""


def _load_existing_favorites(user_id: str) -> List[str]:
    table = _table_from_env("MEALS_TABLE")
    current = table.get_item(Key={"user_id": user_id, "record_key": "LIBRARY#current"}).get("Item") or {}
    return _safe_string_list(current.get("favorite_meals"))


def _save_library(user_id: str, meal_library: List[Dict[str, Any]], favorite_meals: List[str], generated_at: str) -> None:
    table = _table_from_env("MEALS_TABLE")
    table.put_item(
        Item={
            "user_id": user_id,
            "record_key": "LIBRARY#current",
            "meal_library": meal_library,
            "favorite_meals": favorite_meals,
            "generated_at": generated_at,
            "updated_at": generated_at,
        }
    )


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    request_context = event.get("requestContext") or {}
    http = request_context.get("http") or {}
    method = (http.get("method") or event.get("httpMethod") or "").upper()

    if method == "OPTIONS":
        return {"statusCode": 200, "headers": dict(_CORS_HEADERS), "body": ""}
    if method != "POST":
        return _json_response(405, {"message": "Method not allowed."})

    user_id = _extract_cognito_sub(event)
    if not user_id:
        return _json_response(401, {"message": "Missing Cognito user id (sub) in request."})

    try:
        _parse_body(event)
    except json.JSONDecodeError:
        return _json_response(400, {"message": "Request body must be valid JSON."})

    try:
        preferences = _read_generation_preferences(user_id)
        generated_library, warning = _generate_library_from_openai(preferences)
        if warning:
            return _json_response(502, {"message": warning})
        if not generated_library:
            return _json_response(502, {"message": "Generation returned no valid meals."})
        counts = _group_by_meal_type(generated_library)
        for meal_type, target in MEAL_TYPE_TARGETS.items():
            if len(counts.get(meal_type) or []) < target:
                return _json_response(
                    502,
                    {"message": f"Generation returned insufficient {meal_type} meals. Please retry."},
                )
        favorite_meals = _load_existing_favorites(user_id)
        generated_at = _iso_utc_now()
        _save_library(user_id, generated_library, favorite_meals, generated_at)
        return _json_response(
            200,
            {
                "meal_library": generated_library,
                "favorite_meals": favorite_meals,
                "metadata": {
                    "library_record_key": "LIBRARY#current",
                    "generated_at": generated_at,
                    "updated_at": generated_at,
                    "library_source": "generated",
                    "model": OPENAI_MODEL,
                },
            },
        )
    except ValueError as err:
        return _json_response(500, {"message": str(err)})
    except (APITimeoutError, APIConnectionError):
        return _json_response(502, {"message": "Could not reach OpenAI service. Please try again."})
    except APIError:
        return _json_response(502, {"message": "OpenAI request failed. Please retry."})
    except Exception:
        return _json_response(500, {"message": "Unexpected error while generating meals."})
