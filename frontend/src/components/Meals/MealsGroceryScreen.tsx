import React from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useLocation, useNavigate } from 'react-router-dom';
import ProfileSettingsModal from '../Home/ProfileSettingsModal';

type MealsGroceryScreenProps = {
  username?: string;
  onLogout?: () => Promise<void>;
};

type IngredientRounding = 'none' | 'ceil';
type MealType = 'Breakfast' | 'Lunch' | 'Dinner' | 'Snack';
type PrepTimeFilter = 'lt20' | '20to40' | 'gt40';
type BudgetLevel = 'Low' | 'Medium' | 'High';
type MealGoal =
  | 'Balanced'
  | 'Quick & easy'
  | 'High protein'
  | 'Budget friendly'
  | 'Family friendly'
  | 'Light meals'
  | 'Meal prep';

type MealIngredient = {
  name: string;
  quantity: number;
  unit: string;
  category: string;
  rounding: IngredientRounding;
};

type MealLibraryItem = {
  id: string;
  title: string;
  meal_type: MealType;
  diet_tags: string[];
  prep_time_minutes: number;
  short_ingredients_preview: string;
  base_servings: number;
  ingredients: MealIngredient[];
};

type SavedMealItem = {
  id: string;
  meal_id: string;
  meal_name: string;
  prep_time_minutes: number;
  date: string;
  start_time: string;
  end_time: string;
  servings: number;
  ingredients: MealIngredient[];
  base_servings: number;
};

type GroceryItem = {
  key: string;
  name: string;
  quantity: number;
  unit: string;
  category: string;
};

type MealsStateResponse = {
  meal_preferences?: {
    allergies?: string[];
    budget_level?: string;
    goals?: string[];
    goal?: string;
  };
  meal_library?: MealLibraryItem[];
  favorite_meals?: string[];
  saved_meals_this_week?: SavedMealItem[];
  checked_grocery_items?: string[];
};

const SAMPLE_MEALS: MealLibraryItem[] = [
  {
    id: 'meal-1',
    title: 'Greek Yogurt Berry Bowl',
    meal_type: 'Breakfast',
    diet_tags: ['Vegetarian', 'High-Protein'],
    prep_time_minutes: 10,
    short_ingredients_preview: 'Greek yogurt, berries, oats, chia seeds',
    base_servings: 1,
    ingredients: [
      { name: 'Greek yogurt', quantity: 200, unit: 'g', category: 'Dairy', rounding: 'none' },
      { name: 'Mixed berries', quantity: 120, unit: 'g', category: 'Fruits', rounding: 'none' },
      { name: 'Rolled oats', quantity: 30, unit: 'g', category: 'Pantry / Dry Goods', rounding: 'none' },
      { name: 'Chia seeds', quantity: 1, unit: 'tbsp', category: 'Pantry / Dry Goods', rounding: 'none' },
    ],
  },
  {
    id: 'meal-2',
    title: 'Chicken Rice Prep Bowl',
    meal_type: 'Lunch',
    diet_tags: ['Gluten-Free'],
    prep_time_minutes: 30,
    short_ingredients_preview: 'Chicken breast, brown rice, broccoli, olive oil',
    base_servings: 1,
    ingredients: [
      { name: 'Chicken breast', quantity: 220, unit: 'g', category: 'Meat', rounding: 'none' },
      { name: 'Brown rice', quantity: 100, unit: 'g', category: 'Pantry / Dry Goods', rounding: 'none' },
      { name: 'Broccoli', quantity: 160, unit: 'g', category: 'Vegetables', rounding: 'none' },
      { name: 'Olive oil', quantity: 1, unit: 'tbsp', category: 'Pantry / Dry Goods', rounding: 'none' },
    ],
  },
  {
    id: 'meal-3',
    title: 'Lentil Pasta Primavera',
    meal_type: 'Dinner',
    diet_tags: ['Vegetarian'],
    prep_time_minutes: 45,
    short_ingredients_preview: 'Lentil pasta, spinach, tomato, parmesan',
    base_servings: 1,
    ingredients: [
      { name: 'Lentil pasta', quantity: 100, unit: 'g', category: 'Pantry / Dry Goods', rounding: 'none' },
      { name: 'Spinach', quantity: 80, unit: 'g', category: 'Vegetables', rounding: 'none' },
      { name: 'Cherry tomatoes', quantity: 100, unit: 'g', category: 'Vegetables', rounding: 'none' },
      { name: 'Parmesan', quantity: 30, unit: 'g', category: 'Dairy', rounding: 'none' },
    ],
  },
  {
    id: 'meal-4',
    title: 'Hummus Veggie Wrap',
    meal_type: 'Lunch',
    diet_tags: ['Vegan'],
    prep_time_minutes: 15,
    short_ingredients_preview: 'Wrap, hummus, cucumber, lettuce, carrots',
    base_servings: 1,
    ingredients: [
      { name: 'Whole wheat wrap', quantity: 1, unit: 'piece', category: 'Pantry / Dry Goods', rounding: 'ceil' },
      { name: 'Hummus', quantity: 80, unit: 'g', category: 'Pantry / Dry Goods', rounding: 'none' },
      { name: 'Cucumber', quantity: 80, unit: 'g', category: 'Vegetables', rounding: 'none' },
      { name: 'Lettuce', quantity: 60, unit: 'g', category: 'Vegetables', rounding: 'none' },
    ],
  },
  {
    id: 'meal-5',
    title: 'Banana Peanut Smoothie',
    meal_type: 'Snack',
    diet_tags: ['Vegetarian', 'Quick'],
    prep_time_minutes: 8,
    short_ingredients_preview: 'Banana, milk, peanut butter, oats',
    base_servings: 1,
    ingredients: [
      { name: 'Banana', quantity: 1, unit: 'piece', category: 'Fruits', rounding: 'ceil' },
      { name: 'Milk', quantity: 250, unit: 'ml', category: 'Dairy', rounding: 'none' },
      { name: 'Peanut butter', quantity: 1, unit: 'tbsp', category: 'Pantry / Dry Goods', rounding: 'none' },
      { name: 'Rolled oats', quantity: 20, unit: 'g', category: 'Pantry / Dry Goods', rounding: 'none' },
    ],
  },
];

const MEAL_GOAL_OPTIONS: MealGoal[] = [
  'Balanced',
  'Quick & easy',
  'High protein',
  'Budget friendly',
  'Family friendly',
  'Light meals',
  'Meal prep',
];

function prepFilterMatch(prepTime: number, prepFilter: PrepTimeFilter): boolean {
  if (prepFilter === 'lt20') return prepTime < 20;
  if (prepFilter === '20to40') return prepTime >= 20 && prepTime <= 40;
  return prepTime > 40;
}

function formatDateTime(date: string, time: string): string {
  if (!date || !time) return 'Not scheduled';
  const base = new Date(`${date}T${time}:00`);
  if (!Number.isFinite(base.getTime())) return `${date} ${time}`;
  return base.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function calculateEndTime(startTime: string, durationMinutes: number): string {
  if (!startTime) return '';
  const [h, m] = startTime.split(':').map((part) => Number(part));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return '';
  const total = h * 60 + m + durationMinutes;
  const endH = Math.floor((total % (24 * 60)) / 60);
  const endM = total % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

function formatQuantity(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.?0+$/, '');
}

export default function MealsGroceryScreen(props: MealsGroceryScreenProps) {
  const { username, onLogout } = props;
  const navigate = useNavigate();
  const location = useLocation();

  const [isProfileSettingsOpen, setIsProfileSettingsOpen] = React.useState<boolean>(false);
  const [isLoggingOut, setIsLoggingOut] = React.useState<boolean>(false);
  const [displayName, setDisplayName] = React.useState<string>('');
  const [profileImageUrl, setProfileImageUrl] = React.useState<string>('');
  const [savedQuestionnaire, setSavedQuestionnaire] = React.useState<Record<string, unknown> | null>(null);

  const [mealLibraryOpen, setMealLibraryOpen] = React.useState<boolean>(true);
  const [savedMealsOpen, setSavedMealsOpen] = React.useState<boolean>(true);
  const [groceryOpen, setGroceryOpen] = React.useState<boolean>(true);

  const [selectedMealTypes, setSelectedMealTypes] = React.useState<MealType[]>([]);
  const [selectedDietTags, setSelectedDietTags] = React.useState<string[]>([]);
  const [selectedPrepFilters, setSelectedPrepFilters] = React.useState<PrepTimeFilter[]>([]);
  const [mealLibrary, setMealLibrary] = React.useState<MealLibraryItem[]>(SAMPLE_MEALS);
  const [favoriteMealIds, setFavoriteMealIds] = React.useState<string[]>([]);
  const [savedMeals, setSavedMeals] = React.useState<SavedMealItem[]>([]);
  const [checkedGroceryKeys, setCheckedGroceryKeys] = React.useState<string[]>([]);
  const [mealsApiError, setMealsApiError] = React.useState<string>('');
  const [mealGenerationWarning, setMealGenerationWarning] = React.useState<string>('');

  const [isMealPreferencesOpen, setIsMealPreferencesOpen] = React.useState<boolean>(false);
  const [allergiesInput, setAllergiesInput] = React.useState<string>('');
  const [budgetLevel, setBudgetLevel] = React.useState<BudgetLevel>('Medium');
  const [goalInput, setGoalInput] = React.useState<MealGoal[]>(['Balanced']);
  const [isSavingMealPreferences, setIsSavingMealPreferences] = React.useState<boolean>(false);
  const [isGeneratingMeals, setIsGeneratingMeals] = React.useState<boolean>(false);

  const [addMealSource, setAddMealSource] = React.useState<MealLibraryItem | null>(null);
  const [addMealDate, setAddMealDate] = React.useState<string>('');
  const [addMealStartTime, setAddMealStartTime] = React.useState<string>('');
  const [addMealError, setAddMealError] = React.useState<string>('');

  const effectiveName = (displayName || username || 'Noa Levi').trim();
  const initials = (effectiveName || 'N').slice(0, 2).toUpperCase();
  const isMealsRoute = location.pathname.startsWith('/meals');

  function getApiBaseUrl(): string {
    const rawBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
    const cleaned = typeof rawBaseUrl === 'string' ? rawBaseUrl.trim().replace(/\/+$/, '') : '';
    if (!cleaned) throw new Error('Missing API base URL (VITE_API_BASE_URL).');
    return cleaned;
  }

  async function getAuthToken(): Promise<string> {
    const session = await fetchAuthSession();
    const accessToken = session.tokens?.accessToken?.toString();
    const idToken = session.tokens?.idToken?.toString();
    const token = accessToken || idToken;
    if (!token) throw new Error('You need to be signed in.');
    return token;
  }

  async function loadProfile(): Promise<{
    displayName: string;
    profileImageUrl: string;
    questionnaire: Record<string, unknown> | null;
  }> {
    const baseUrl = getApiBaseUrl();
    const token = await getAuthToken();
    const response = await fetch(`${baseUrl}/profile`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    let payload: {
      display_name?: string;
      profile_image_url?: string;
      questionnaire?: Record<string, unknown>;
      message?: string;
    } = {};
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const message =
        typeof payload.message === 'string' && payload.message.trim()
          ? payload.message
          : `Could not load profile (${response.status}).`;
      throw new Error(message);
    }
    const name = typeof payload.display_name === 'string' ? payload.display_name.trim() : '';
    const imageUrl = typeof payload.profile_image_url === 'string' ? payload.profile_image_url.trim() : '';
    if (name) setDisplayName(name);
    setProfileImageUrl(imageUrl);
    const q =
      payload.questionnaire && typeof payload.questionnaire === 'object' && !Array.isArray(payload.questionnaire)
        ? payload.questionnaire
        : null;
    setSavedQuestionnaire(q);
    return { displayName: name, profileImageUrl: imageUrl, questionnaire: q };
  }

  async function saveProfileDisplayName(nextName: string): Promise<void> {
    const baseUrl = getApiBaseUrl();
    const token = await getAuthToken();
    const response = await fetch(`${baseUrl}/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ display_name: nextName }),
    });
    let payload: { display_name?: string; profile_image_url?: string; message?: string } = {};
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const message =
        typeof payload.message === 'string' && payload.message.trim()
          ? payload.message
          : `Could not save profile (${response.status}).`;
      throw new Error(message);
    }
    const name = typeof payload.display_name === 'string' ? payload.display_name.trim() : '';
    setDisplayName(name);
    const imageUrl = typeof payload.profile_image_url === 'string' ? payload.profile_image_url.trim() : '';
    if (imageUrl) setProfileImageUrl(imageUrl);
  }

  async function saveQuestionnairePreferences(patch: Record<string, unknown>): Promise<void> {
    const baseUrl = getApiBaseUrl();
    const token = await getAuthToken();
    const response = await fetch(`${baseUrl}/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(patch),
    });
    let payload: { questionnaire?: Record<string, unknown>; message?: string } = {};
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const message =
        typeof payload.message === 'string' && payload.message.trim()
          ? payload.message
          : `Could not save preferences (${response.status}).`;
      throw new Error(message);
    }
    if (
      payload.questionnaire &&
      typeof payload.questionnaire === 'object' &&
      !Array.isArray(payload.questionnaire)
    ) {
      setSavedQuestionnaire(payload.questionnaire);
    }
  }

  async function requestProfileImageUploadUrl(args: { contentType: string }): Promise<{
    uploadUrl: string;
    objectKey: string;
  }> {
    const baseUrl = getApiBaseUrl();
    const token = await getAuthToken();
    const response = await fetch(`${baseUrl}/profile/image/upload-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ content_type: args.contentType }),
    });
    let payload: { upload_url?: string; object_key?: string; message?: string } = {};
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const message =
        typeof payload.message === 'string' && payload.message.trim()
          ? payload.message
          : `Could not create upload URL (${response.status}).`;
      throw new Error(message);
    }
    const uploadUrl = typeof payload.upload_url === 'string' ? payload.upload_url : '';
    const objectKey = typeof payload.object_key === 'string' ? payload.object_key : '';
    if (!uploadUrl || !objectKey) throw new Error('Upload URL response is missing required fields.');
    return { uploadUrl, objectKey };
  }

  async function saveProfileImageKey(objectKey: string): Promise<void> {
    const baseUrl = getApiBaseUrl();
    const token = await getAuthToken();
    const response = await fetch(`${baseUrl}/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ profile_image_key: objectKey }),
    });
    let payload: { profile_image_url?: string; message?: string } = {};
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const message =
        typeof payload.message === 'string' && payload.message.trim()
          ? payload.message
          : `Could not save profile (${response.status}).`;
      throw new Error(message);
    }
    const imageUrl = typeof payload.profile_image_url === 'string' ? payload.profile_image_url.trim() : '';
    if (imageUrl) setProfileImageUrl(imageUrl);
  }

  async function handleLogoutClick() {
    setIsLoggingOut(true);
    try {
      if (onLogout) await onLogout();
    } finally {
      setIsLoggingOut(false);
    }
  }

  function toggleMealTypeFilter(type: MealType) {
    setSelectedMealTypes((prev) => (prev.includes(type) ? prev.filter((item) => item !== type) : [...prev, type]));
  }

  function toggleDietTagFilter(tag: string) {
    setSelectedDietTags((prev) => (prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag]));
  }

  function togglePrepFilter(filter: PrepTimeFilter) {
    setSelectedPrepFilters((prev) =>
      prev.includes(filter) ? prev.filter((item) => item !== filter) : [...prev, filter]
    );
  }

  const availableDietTags = React.useMemo(
    () => Array.from(new Set(mealLibrary.flatMap((meal) => meal.diet_tags))).sort(),
    [mealLibrary]
  );

  const filteredMealLibrary = React.useMemo(() => {
    return mealLibrary.filter((meal) => {
      const mealTypeMatch = selectedMealTypes.length === 0 || selectedMealTypes.includes(meal.meal_type);
      const dietMatch =
        selectedDietTags.length === 0 || selectedDietTags.every((tag) => meal.diet_tags.includes(tag));
      const prepMatch =
        selectedPrepFilters.length === 0 ||
        selectedPrepFilters.some((filter) => prepFilterMatch(meal.prep_time_minutes, filter));
      return mealTypeMatch && dietMatch && prepMatch;
    });
  }, [mealLibrary, selectedMealTypes, selectedDietTags, selectedPrepFilters]);

  const groceryItemsByCategory = React.useMemo(() => {
    const map = new Map<string, GroceryItem>();
    for (const savedMeal of savedMeals) {
      for (const ingredient of savedMeal.ingredients) {
        const key = `${ingredient.category}::${ingredient.name.toLowerCase()}::${ingredient.unit}`;
        const servingScale = savedMeal.servings / Math.max(1, savedMeal.base_servings);
        const scaledQty = ingredient.quantity * servingScale;
        const existing = map.get(key);
        const nextQty = (existing?.quantity || 0) + scaledQty;
        map.set(key, {
          key,
          name: ingredient.name,
          unit: ingredient.unit,
          category: ingredient.category,
          quantity: ingredient.rounding === 'ceil' ? Math.ceil(nextQty) : Number(nextQty.toFixed(2)),
        });
      }
    }
    const grouped = new Map<string, GroceryItem[]>();
    for (const item of map.values()) {
      if (!grouped.has(item.category)) grouped.set(item.category, []);
      grouped.get(item.category)?.push(item);
    }
    for (const [category, items] of grouped.entries()) {
      grouped.set(
        category,
        items.sort((a, b) => a.name.localeCompare(b.name))
      );
    }
    return grouped;
  }, [savedMeals]);

  function openAddMealModal(meal: MealLibraryItem) {
    setAddMealError('');
    setAddMealSource(meal);
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')}`;
    setAddMealDate(day);
    setAddMealStartTime('18:00');
  }

  function closeAddMealModal() {
    setAddMealError('');
    setAddMealSource(null);
    setAddMealDate('');
    setAddMealStartTime('');
  }

  function saveMealToWeek() {
    if (!addMealSource) return;
    if (!addMealDate || !addMealStartTime) {
      setAddMealError('Please select date and start time.');
      return;
    }
    const endTime = calculateEndTime(addMealStartTime, addMealSource.prep_time_minutes);
    const newSavedMeal: SavedMealItem = {
      id: `saved-${Date.now()}`,
      meal_id: addMealSource.id,
      meal_name: addMealSource.title,
      prep_time_minutes: addMealSource.prep_time_minutes,
      date: addMealDate,
      start_time: addMealStartTime,
      end_time: endTime,
      servings: 1,
      ingredients: addMealSource.ingredients,
      base_servings: addMealSource.base_servings,
    };
    setSavedMeals((prev) => [...prev, newSavedMeal]);
    closeAddMealModal();
  }

  function updateServings(savedId: string, nextServings: number) {
    setSavedMeals((prev) =>
      prev.map((meal) => (meal.id === savedId ? { ...meal, servings: Math.max(1, nextServings) } : meal))
    );
  }

  function removeSavedMeal(savedId: string) {
    setSavedMeals((prev) => prev.filter((meal) => meal.id !== savedId));
  }

  function toggleGroceryChecked(key: string) {
    setCheckedGroceryKeys((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));
  }

  function clearCheckedGroceryItems() {
    setCheckedGroceryKeys([]);
  }

  async function loadMealsState(): Promise<void> {
    const baseUrl = getApiBaseUrl();
    try {
      const token = await getAuthToken();
      const response = await fetch(`${baseUrl}/meals`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      let payload: MealsStateResponse = {};
      try {
        payload = (await response.json()) as MealsStateResponse;
      } catch {
        payload = {};
      }
      if (!response.ok) return;

      const incomingLibrary = Array.isArray(payload.meal_library) ? payload.meal_library : [];
      setMealLibrary(incomingLibrary.length > 0 ? incomingLibrary : SAMPLE_MEALS);
      setFavoriteMealIds(Array.isArray(payload.favorite_meals) ? payload.favorite_meals : []);
      setSavedMeals(Array.isArray(payload.saved_meals_this_week) ? payload.saved_meals_this_week : []);
      setCheckedGroceryKeys(
        Array.isArray(payload.checked_grocery_items) ? payload.checked_grocery_items : []
      );

      const pref = payload.meal_preferences || {};
      const prefAllergies = Array.isArray(pref.allergies)
        ? pref.allergies.filter((value): value is string => typeof value === 'string')
        : [];
      const prefBudget =
        pref.budget_level === 'Low' || pref.budget_level === 'Medium' || pref.budget_level === 'High'
          ? pref.budget_level
          : 'Medium';
      setAllergiesInput(prefAllergies.join(', '));
      setBudgetLevel(prefBudget);
      const incomingGoals = Array.isArray(pref.goals)
        ? pref.goals.filter((goal): goal is MealGoal => MEAL_GOAL_OPTIONS.includes(goal as MealGoal))
        : [];
      if (incomingGoals.length > 0) {
        setGoalInput(incomingGoals);
      } else if (typeof pref.goal === 'string' && MEAL_GOAL_OPTIONS.includes(pref.goal as MealGoal)) {
        setGoalInput([pref.goal as MealGoal]);
      } else {
        setGoalInput(['Balanced']);
      }
    } catch {
      // Silent fallback to local sample meals for this step.
    }
  }

  async function saveMealPreferences() {
    setMealsApiError('');
    let baseUrl = '';
    try {
      baseUrl = getApiBaseUrl();
    } catch {
      setMealsApiError('Missing API base URL configuration.');
      return;
    }
    setIsSavingMealPreferences(true);
    try {
      const token = await getAuthToken();
      const allergies = allergiesInput
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      const response = await fetch(`${baseUrl}/meals/preferences`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          allergies,
          budget_level: budgetLevel,
          goals: goalInput,
          goal: goalInput[0] || '',
        }),
      });
      let payload: { message?: string } = {};
      try {
        payload = (await response.json()) as { message?: string };
      } catch {
        payload = {};
      }
      if (!response.ok) {
        setMealsApiError(payload.message || `Could not save meal preferences (${response.status}).`);
        return;
      }
      setIsMealPreferencesOpen(false);
    } catch {
      setMealsApiError('Could not save meal preferences right now.');
    } finally {
      setIsSavingMealPreferences(false);
    }
  }

  function runMockGenerate(event?: React.MouseEvent<HTMLButtonElement>) {
    event?.preventDefault();
    event?.stopPropagation();
    void (async () => {
      setMealsApiError('');
      setMealGenerationWarning('');
      setIsGeneratingMeals(true);
      try {
        const baseUrl = getApiBaseUrl();
        const token = await getAuthToken();
        const response = await fetch(`${baseUrl}/meals/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        });
        let payload: {
          message?: string;
          meal_library?: MealLibraryItem[];
          favorite_meals?: string[];
          metadata?: { generation_warning?: string };
        } = {};
        try {
          payload = (await response.json()) as typeof payload;
        } catch {
          payload = {};
        }
        if (!response.ok) {
          setMealsApiError(payload.message || `Could not generate meals (${response.status}).`);
          return;
        }
        const generatedLibrary = Array.isArray(payload.meal_library) ? payload.meal_library : [];
        if (generatedLibrary.length > 0) setMealLibrary(generatedLibrary);
        if (Array.isArray(payload.favorite_meals)) setFavoriteMealIds(payload.favorite_meals);
        const warn = payload.metadata?.generation_warning;
        setMealGenerationWarning(typeof warn === 'string' && warn.trim() ? warn.trim() : '');
      } catch (err) {
        const anyErr = err as { message?: string };
        setMealsApiError(anyErr?.message || 'Could not generate meals right now.');
      } finally {
        setIsGeneratingMeals(false);
      }
    })();
  }

  React.useEffect(() => {
    void (async () => {
      try {
        await loadProfile();
      } catch {
        // Keep username fallback when profile cannot be loaded.
      }
      await loadMealsState();
    })();
  }, []);

  return (
    <section className="df-calendarPage df-workoutsPage" aria-label="DailyFlow meals and grocery screen">
      <aside className="df-calendarLeftNav">
        <div className="df-calendarBrand">DailyFlow</div>
        <div className="df-calendarProfile">
          <div className="df-calendarProfileAvatar">
            {profileImageUrl ? (
              <img key={profileImageUrl} src={profileImageUrl} alt="" className="df-calendarProfileAvatarImg" />
            ) : (
              initials
            )}
          </div>
          <div>
            <div className="df-calendarProfileName">{effectiveName}</div>
            <div className="df-calendarProfileHint">Plan your week</div>
          </div>
          <button
            type="button"
            className="df-iconBtn"
            onClick={() => setIsProfileSettingsOpen(true)}
            aria-label="Open profile settings"
            title="Settings"
            style={{ marginInlineStart: 'auto' }}
          >
            ⚙️
          </button>
        </div>

        <nav className="df-calendarMenu" aria-label="Main sections">
          <button type="button" className="df-calendarMenuItem" onClick={() => navigate('/calendar')}>
            Calendar
          </button>
          <button
            type="button"
            className={`df-calendarMenuItem${isMealsRoute ? ' df-calendarMenuItemActive' : ''}`}
            onClick={() => navigate('/meals')}
          >
            Meals & Grocery
          </button>
          <button type="button" className="df-calendarMenuItem" onClick={() => navigate('/workouts')}>
            Workouts
          </button>
          <button type="button" className="df-calendarMenuItem" disabled>
            Stress & Breaks
          </button>
          <button type="button" className="df-calendarMenuItem" disabled>
            Overview
          </button>
        </nav>
      </aside>

      <div className="df-calendarMain">
        <header className="df-calendarTopbar">
          <div className="df-calendarTopbarLeft">
            <button
              type="button"
              className="df-btn df-btnPrimary"
              onClick={runMockGenerate}
              disabled={isGeneratingMeals}
            >
              {isGeneratingMeals ? 'Generating...' : 'Generate'}
            </button>
            <button type="button" className="df-btn" onClick={() => setIsMealPreferencesOpen(true)}>
              Meal Preferences
            </button>
          </div>
          <div className="df-calendarTopbarRight">
            <button type="button" className="df-btn" onClick={() => void handleLogoutClick()} disabled={isLoggingOut}>
              {isLoggingOut ? 'Signing out...' : 'Log out'}
            </button>
          </div>
        </header>

        {mealsApiError && <div className="df-errorText" style={{ padding: '8px 16px 0' }}>{mealsApiError}</div>}
        {mealGenerationWarning && (
          <div className="df-mealsGenerateNotice" role="status">
            {mealGenerationWarning}
          </div>
        )}

        <div className="df-workoutsContent">
          <section className="df-workoutsSection">
            <div className="df-workoutsSectionHeader">
              <button
                type="button"
                className="df-sectionToggle"
                onClick={() => setMealLibraryOpen((prev) => !prev)}
                aria-expanded={mealLibraryOpen}
                aria-controls="meals-library-section"
              >
                <span className={`df-sectionChevron${mealLibraryOpen ? ' df-sectionChevronOpen' : ''}`} aria-hidden>
                  ▶
                </span>
                <h2 className="df-workoutsTitle" style={{ fontSize: 26 }}>
                  Meal Library
                </h2>
              </button>
            </div>
            {mealLibraryOpen && (
              <div id="meals-library-section">
                <div className="df-workoutFilters">
                  <div className="df-workoutFilterGroup">
                    <span className="df-workoutFilterLabel">Meal type</span>
                    {(['Breakfast', 'Lunch', 'Dinner', 'Snack'] as MealType[]).map((type) => (
                      <button
                        key={type}
                        type="button"
                        className={`df-workoutFilterChip${selectedMealTypes.includes(type) ? ' df-workoutFilterChipActive' : ''}`}
                        onClick={() => toggleMealTypeFilter(type)}
                      >
                        {type}
                      </button>
                    ))}
                  </div>
                  <div className="df-workoutFilterGroup">
                    <span className="df-workoutFilterLabel">Diet tags</span>
                    {availableDietTags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className={`df-workoutFilterChip${selectedDietTags.includes(tag) ? ' df-workoutFilterChipActive' : ''}`}
                        onClick={() => toggleDietTagFilter(tag)}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                  <div className="df-workoutFilterGroup">
                    <span className="df-workoutFilterLabel">Prep time</span>
                    {[
                      { id: 'lt20', label: '<20 min' },
                      { id: '20to40', label: '20-40 min' },
                      { id: 'gt40', label: '40+ min' },
                    ].map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`df-workoutFilterChip${selectedPrepFilters.includes(item.id as PrepTimeFilter) ? ' df-workoutFilterChipActive' : ''}`}
                        onClick={() => togglePrepFilter(item.id as PrepTimeFilter)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="df-workoutLibraryGrid df-mealsLibraryGrid">
                  {filteredMealLibrary.map((meal) => (
                    <article key={meal.id} className="df-workoutLibraryCard">
                      <div className="df-workoutLibraryCardTop">
                        <h3 className="df-workoutLibraryTitle" style={{ fontSize: 20 }}>
                          {meal.title}
                        </h3>
                        <div className="df-weeklyPlanControls">
                          <button
                            type="button"
                            className={`df-workoutFavoriteBtn${favoriteMealIds.includes(meal.id) ? ' df-workoutFavoriteBtnActive' : ''}`}
                            aria-label={`Toggle favorite for ${meal.title}`}
                            onClick={() =>
                              setFavoriteMealIds((prev) =>
                                prev.includes(meal.id) ? prev.filter((id) => id !== meal.id) : [...prev, meal.id]
                              )
                            }
                          >
                            ❤
                          </button>
                          <button
                            type="button"
                            className="df-workoutLibraryAdd"
                            aria-label={`Add ${meal.title}`}
                            onClick={() => openAddMealModal(meal)}
                          >
                            +
                          </button>
                        </div>
                      </div>
                      <div className="df-workoutTypePill">{meal.meal_type}</div>
                      <div className="df-workoutMeta">{meal.diet_tags.join(' · ') || 'No tags'}</div>
                      <div className="df-workoutMeta">{meal.prep_time_minutes} min prep</div>
                      <div className="df-workoutMeta">{meal.short_ingredients_preview}</div>
                    </article>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="df-workoutsSection">
            <div className="df-workoutsSectionHeader">
              <button
                type="button"
                className="df-sectionToggle"
                onClick={() => setSavedMealsOpen((prev) => !prev)}
                aria-expanded={savedMealsOpen}
                aria-controls="saved-meals-section"
              >
                <span className={`df-sectionChevron${savedMealsOpen ? ' df-sectionChevronOpen' : ''}`} aria-hidden>
                  ▶
                </span>
                <h2 className="df-workoutsTitle" style={{ fontSize: 26 }}>
                  Saved Meals This Week
                </h2>
              </button>
            </div>
            {savedMealsOpen && (
              <div id="saved-meals-section" className="df-workoutLibraryGrid df-mealsSavedGrid">
                {savedMeals.map((savedMeal) => (
                  <article key={savedMeal.id} className="df-workoutLibraryCard">
                    <div className="df-workoutLibraryCardTop">
                      <h3 className="df-workoutLibraryTitle" style={{ fontSize: 18 }}>
                        {savedMeal.meal_name}
                      </h3>
                      <button
                        type="button"
                        className="df-weeklyPlanControlBtn df-weeklyPlanControlRemove"
                        onClick={() => removeSavedMeal(savedMeal.id)}
                        aria-label={`Remove ${savedMeal.meal_name}`}
                      >
                        🗑
                      </button>
                    </div>
                    <div className="df-workoutMeta">{formatDateTime(savedMeal.date, savedMeal.start_time)}</div>
                    <div className="df-workoutMeta">
                      {savedMeal.start_time} - {savedMeal.end_time} ({savedMeal.prep_time_minutes} min)
                    </div>
                    <div className="df-weeklyPlanControls">
                      <span className="df-workoutFilterLabel">Servings</span>
                      <button
                        type="button"
                        className="df-weeklyPlanControlBtn"
                        onClick={() => updateServings(savedMeal.id, savedMeal.servings - 1)}
                      >
                        -
                      </button>
                      <input
                        type="number"
                        min={1}
                        value={savedMeal.servings}
                        className="df-input df-mealServingsInput"
                        onChange={(event) => updateServings(savedMeal.id, Number(event.target.value) || 1)}
                      />
                      <button
                        type="button"
                        className="df-weeklyPlanControlBtn"
                        onClick={() => updateServings(savedMeal.id, savedMeal.servings + 1)}
                      >
                        +
                      </button>
                    </div>
                  </article>
                ))}
                {savedMeals.length === 0 && (
                  <div className="df-calendarLegend" style={{ color: '#6b7280' }}>
                    No meals saved yet. Use + in the Meal Library to add one.
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="df-workoutsSection">
            <div className="df-workoutsSectionHeader">
              <button
                type="button"
                className="df-sectionToggle"
                onClick={() => setGroceryOpen((prev) => !prev)}
                aria-expanded={groceryOpen}
                aria-controls="grocery-section"
              >
                <span className={`df-sectionChevron${groceryOpen ? ' df-sectionChevronOpen' : ''}`} aria-hidden>
                  ▶
                </span>
                <h2 className="df-workoutsTitle" style={{ fontSize: 26 }}>
                  Grocery List
                </h2>
              </button>
              <div>
                <button type="button" className="df-btn" onClick={clearCheckedGroceryItems}>
                  Clear checked
                </button>
              </div>
            </div>
            {groceryOpen && (
              <div id="grocery-section" className="df-mealsGroceryWrap">
                {Array.from(groceryItemsByCategory.entries()).map(([category, items]) => (
                  <article key={category} className="df-calendarsList">
                    <h2 style={{ marginBottom: 8 }}>{category}</h2>
                    <div className="df-checkboxList">
                      {items.map((item) => (
                        <label key={item.key} className="df-checkboxItem">
                          <input
                            type="checkbox"
                            checked={checkedGroceryKeys.includes(item.key)}
                            onChange={() => toggleGroceryChecked(item.key)}
                          />
                          <span>
                            {item.name} - {formatQuantity(item.quantity)} {item.unit}
                          </span>
                        </label>
                      ))}
                    </div>
                  </article>
                ))}
                {groceryItemsByCategory.size === 0 && (
                  <div className="df-calendarLegend" style={{ color: '#6b7280' }}>
                    Grocery list will populate from Saved Meals This Week.
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>

      <ProfileSettingsModal
        isOpen={isProfileSettingsOpen}
        initialName={effectiveName}
        savedProfileImageUrl={profileImageUrl}
        savedQuestionnaire={savedQuestionnaire}
        onLoadProfile={loadProfile}
        onSaveDisplayName={saveProfileDisplayName}
        onRequestProfileImageUploadUrl={requestProfileImageUploadUrl}
        onSaveProfileImageKey={saveProfileImageKey}
        onSaveQuestionnaire={saveQuestionnairePreferences}
        onClose={() => setIsProfileSettingsOpen(false)}
      />

      {isMealPreferencesOpen && (
        <div
          className="df-modalBackdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsMealPreferencesOpen(false);
          }}
        >
          <div className="df-modalPanel df-addWeeklyModal" role="dialog" aria-modal="true" aria-label="Meal preferences">
            <div className="df-modalHeader">
              <div className="df-modalTitle">Meal Preferences</div>
              <button
                type="button"
                className="df-iconBtn"
                onClick={() => setIsMealPreferencesOpen(false)}
                aria-label="Close meal preferences"
              >
                ✕
              </button>
            </div>
            <div className="df-settingsContent" style={{ display: 'grid', gap: 12 }}>
              <label className="df-field">
                <div className="df-fieldLabel" style={{ textAlign: 'start' }}>
                  Allergies
                </div>
                <input
                  type="text"
                  className="df-input"
                  placeholder="e.g. peanuts, shellfish"
                  value={allergiesInput}
                  onChange={(event) => setAllergiesInput(event.target.value)}
                />
              </label>
              <label className="df-field">
                <div className="df-fieldLabel" style={{ textAlign: 'start' }}>
                  Budget level
                </div>
                <select
                  className="df-select"
                  value={budgetLevel}
                  onChange={(event) => setBudgetLevel(event.target.value as BudgetLevel)}
                >
                  <option value="Low">Low</option>
                  <option value="Medium">Medium</option>
                  <option value="High">High</option>
                </select>
              </label>
              <label className="df-field">
                <div className="df-fieldLabel" style={{ textAlign: 'start' }}>
                  Goal
                </div>
                <select
                  className="df-select df-selectMulti"
                  value={goalInput}
                  multiple
                  onChange={(event) => {
                    const selected = Array.from(event.target.selectedOptions).map((option) => option.value as MealGoal);
                    setGoalInput(selected);
                  }}
                >
                  {MEAL_GOAL_OPTIONS.map((goal) => (
                    <option key={goal} value={goal}>
                      {goal}
                    </option>
                  ))}
                </select>
                <div className="df-settingsHint">You can select multiple goals (Ctrl/Cmd + click).</div>
              </label>
              <div className="df-weeklyPlanActions">
                <button
                  type="button"
                  className="df-weeklyPlanActionBtn"
                  onClick={() => void saveMealPreferences()}
                  disabled={isSavingMealPreferences}
                >
                  {isSavingMealPreferences ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  className="df-weeklyPlanActionBtn"
                  onClick={() => setIsMealPreferencesOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {addMealSource && (
        <div
          className="df-modalBackdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeAddMealModal();
          }}
        >
          <div className="df-modalPanel df-addWeeklyModal" role="dialog" aria-modal="true" aria-label="Add meal">
            <div className="df-modalHeader">
              <div className="df-modalTitle">Add meal to week</div>
              <button type="button" className="df-iconBtn" onClick={closeAddMealModal} aria-label="Close add meal popup">
                ✕
              </button>
            </div>
            <div className="df-settingsContent" style={{ display: 'grid', gap: 12 }}>
              <div className="df-workoutMeta">
                <strong>{addMealSource.title}</strong> · {addMealSource.prep_time_minutes} min prep
              </div>
              <label className="df-field">
                <div className="df-fieldLabel" style={{ textAlign: 'start' }}>
                  Date
                </div>
                <input
                  type="date"
                  className="df-input"
                  value={addMealDate}
                  onChange={(event) => {
                    setAddMealDate(event.target.value);
                    setAddMealError('');
                  }}
                />
              </label>
              <label className="df-field">
                <div className="df-fieldLabel" style={{ textAlign: 'start' }}>
                  Start time
                </div>
                <input
                  type="time"
                  className="df-input"
                  value={addMealStartTime}
                  onChange={(event) => {
                    setAddMealStartTime(event.target.value);
                    setAddMealError('');
                  }}
                />
              </label>
              <div className="df-workoutMeta">
                End time: {calculateEndTime(addMealStartTime, addMealSource.prep_time_minutes) || '--:--'}
              </div>
              <div className="df-workoutMeta">Ingredients: {addMealSource.short_ingredients_preview}</div>
              {addMealError && <div className="df-errorText">{addMealError}</div>}
              <div className="df-weeklyPlanActions">
                <button type="button" className="df-weeklyPlanActionBtn" onClick={saveMealToWeek}>
                  Save
                </button>
                <button type="button" className="df-weeklyPlanActionBtn" onClick={closeAddMealModal}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
