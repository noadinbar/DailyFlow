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
type GoogleCalendarStatus = 'connected' | 'reconnect_required';

const GOOGLE_RECONNECT_MESSAGE = 'Google connection expired, reconnect required';
const GOOGLE_RECONNECT_MESSAGE_NEW = 'Google Calendar connection expired. Please reconnect.';

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
  estimated_calories?: number | null;
  summary_short?: string;
  instructions?: string[];
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
  google_event_id?: string;
  dailyflow_calendar_id?: string;
};

type GroceryItem = {
  key: string;
  name: string;
  quantity: number;
  unit: string;
  category: string;
};

type MealsStateResponse = {
  meal_library?: MealLibraryItem[];
  favorite_meals?: string[];
  saved_meals_this_week?: SavedMealItem[];
  grocery_list?: GroceryItem[];
  checked_grocery_items?: string[];
  metadata?: {
    week_record_key?: string;
    week_start?: string;
    week_end?: string;
    library_record_key?: string;
    updated_at?: string;
  };
};

type MealsSavedPatchResponse = {
  message?: string;
  favorite_meals?: string[];
  saved_meals_this_week?: SavedMealItem[];
  grocery_list?: GroceryItem[];
  checked_grocery_items?: string[];
  saved_meal?: SavedMealItem;
  updated_at?: string;
  week_record_key?: string;
  reconnect_required?: boolean;
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

const ALLOWED_DIET_TAG_ORDER = [
  'Kosher',
  'Vegan',
  'Vegetarian',
  'Gluten-Free',
  'High-Protein',
  'Low-Carb',
] as const;

type AllowedDietTag = (typeof ALLOWED_DIET_TAG_ORDER)[number];

const DIET_TAG_CANONICAL_MAP: Record<string, AllowedDietTag> = {
  kosher: 'Kosher',
  vegan: 'Vegan',
  vegetarian: 'Vegetarian',
  'glutenfree': 'Gluten-Free',
  'gluten-free': 'Gluten-Free',
  gluten_free: 'Gluten-Free',
  'highprotein': 'High-Protein',
  'high-protein': 'High-Protein',
  high_protein: 'High-Protein',
  'lowcarb': 'Low-Carb',
  'low-carb': 'Low-Carb',
  low_carb: 'Low-Carb',
};

function normalizeDietTag(tag: string): AllowedDietTag | null {
  const cleaned = tag.trim().toLowerCase();
  if (!cleaned) return null;
  const compact = cleaned.replace(/[\s_-]+/g, '');
  return DIET_TAG_CANONICAL_MAP[cleaned] ?? DIET_TAG_CANONICAL_MAP[compact] ?? null;
}

function normalizedMealDietTags(tags: string[]): AllowedDietTag[] {
  const set = new Set<AllowedDietTag>();
  for (const tag of tags) {
    const normalized = normalizeDietTag(tag);
    if (normalized && ALLOWED_DIET_TAG_ORDER.includes(normalized)) set.add(normalized);
  }
  return ALLOWED_DIET_TAG_ORDER.filter((tag) => set.has(tag));
}

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

function groupGroceryFromFlat(items: GroceryItem[]): Map<string, GroceryItem[]> {
  const grouped = new Map<string, GroceryItem[]>();
  for (const item of items) {
    if (!grouped.has(item.category)) grouped.set(item.category, []);
    grouped.get(item.category)?.push(item);
  }
  for (const [, list] of grouped.entries()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return grouped;
}

function groceryFromSavedMeals(savedMeals: SavedMealItem[]): GroceryItem[] {
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
  return Array.from(map.values()).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
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
  const [selectedDietTags, setSelectedDietTags] = React.useState<AllowedDietTag[]>([]);
  const [selectedPrepFilters, setSelectedPrepFilters] = React.useState<PrepTimeFilter[]>([]);
  const [showFavoritesOnly, setShowFavoritesOnly] = React.useState<boolean>(false);
  const [mealLibrary, setMealLibrary] = React.useState<MealLibraryItem[]>([]);
  const [favoriteMealIds, setFavoriteMealIds] = React.useState<string[]>([]);
  const [savedMeals, setSavedMeals] = React.useState<SavedMealItem[]>([]);
  const [groceryListServer, setGroceryListServer] = React.useState<GroceryItem[]>([]);
  const [weekRecordKey, setWeekRecordKey] = React.useState<string>('');
  const [weekStartIso, setWeekStartIso] = React.useState<string>('');
  const [weekEndIso, setWeekEndIso] = React.useState<string>('');
  const [checkedGroceryKeys, setCheckedGroceryKeys] = React.useState<string[]>([]);
  const [mealsApiError, setMealsApiError] = React.useState<string>('');
  const [mealGenerationWarning, setMealGenerationWarning] = React.useState<string>('');
  const [mealDetail, setMealDetail] = React.useState<MealLibraryItem | null>(null);
  const [isSavingMealCalendar, setIsSavingMealCalendar] = React.useState<boolean>(false);

  const [isGeneratingMeals, setIsGeneratingMeals] = React.useState<boolean>(false);

  const [googleCalendarStatus, setGoogleCalendarStatus] = React.useState<GoogleCalendarStatus>('connected');
  const [googleCalendarStatusMessage, setGoogleCalendarStatusMessage] = React.useState<string>('');
  const [isConnectingGoogleCalendar, setIsConnectingGoogleCalendar] = React.useState<boolean>(false);

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

  function applyWeekPatchPayload(payload: MealsSavedPatchResponse) {
    if (Array.isArray(payload.saved_meals_this_week)) setSavedMeals(payload.saved_meals_this_week);
    if (Array.isArray(payload.grocery_list)) setGroceryListServer(payload.grocery_list);
    if (Array.isArray(payload.checked_grocery_items)) setCheckedGroceryKeys(payload.checked_grocery_items);
    if (typeof payload.week_record_key === 'string' && payload.week_record_key.startsWith('WEEK#')) {
      setWeekRecordKey(payload.week_record_key);
    }
  }

  function detectReconnectRequired(payload: MealsSavedPatchResponse, status: number): boolean {
    if (payload && payload.reconnect_required === true) return true;
    const message = typeof payload?.message === 'string' ? payload.message.trim() : '';
    if (!message) return false;
    if (status !== 401 && status !== 403) return false;
    return message === GOOGLE_RECONNECT_MESSAGE || message === GOOGLE_RECONNECT_MESSAGE_NEW;
  }

  async function patchMealsSaved(
    body: Record<string, unknown>,
    options?: { setGlobalError?: boolean }
  ): Promise<{ ok: boolean; status: number; payload: MealsSavedPatchResponse }> {
    const setGlobal = options?.setGlobalError !== false;
    const baseUrl = getApiBaseUrl();
    const token = await getAuthToken();
    const response = await fetch(`${baseUrl}/meals/saved`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    let payload: MealsSavedPatchResponse = {};
    try {
      payload = (await response.json()) as MealsSavedPatchResponse;
    } catch {
      payload = {};
    }
    if (!response.ok) {
      if (detectReconnectRequired(payload, response.status)) {
        setGoogleCalendarStatus('reconnect_required');
        setGoogleCalendarStatusMessage(
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : GOOGLE_RECONNECT_MESSAGE_NEW
        );
      }
      if (setGlobal) {
        setMealsApiError(
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : `Request failed (${response.status}).`
        );
      }
    } else if (googleCalendarStatus !== 'connected') {
      setGoogleCalendarStatus('connected');
      setGoogleCalendarStatusMessage('');
    }
    return { ok: response.ok, status: response.status, payload };
  }

  function handleConnectGoogleCalendarClick() {
    setIsConnectingGoogleCalendar(true);
    void (async () => {
      try {
        const baseUrl = getApiBaseUrl();
        const session = await fetchAuthSession();
        const accessToken = session.tokens?.accessToken?.toString();
        if (!accessToken) {
          setMealsApiError('You need to be signed in to connect Google Calendar.');
          setIsConnectingGoogleCalendar(false);
          return;
        }
        const startUrl = `${baseUrl}/auth/google/start?access_token=${encodeURIComponent(accessToken)}`;
        window.location.assign(startUrl);
      } catch (err) {
        const anyErr = err as { message?: string };
        setMealsApiError(
          typeof anyErr?.message === 'string' ? anyErr.message : 'Failed to start Google Calendar connection.'
        );
        setIsConnectingGoogleCalendar(false);
      }
    })();
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

  function toggleDietTagFilter(tag: AllowedDietTag) {
    setSelectedDietTags((prev) => (prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag]));
  }

  function togglePrepFilter(filter: PrepTimeFilter) {
    setSelectedPrepFilters((prev) =>
      prev.includes(filter) ? prev.filter((item) => item !== filter) : [...prev, filter]
    );
  }

  const availableDietTags = React.useMemo(
    () => {
      const set = new Set<AllowedDietTag>();
      for (const meal of mealLibrary) {
        for (const tag of normalizedMealDietTags(meal.diet_tags)) set.add(tag);
      }
      return ALLOWED_DIET_TAG_ORDER.filter((tag) => set.has(tag));
    },
    [mealLibrary]
  );
  const selectedMealTypeForGenerate: MealType | null = selectedMealTypes.length === 1 ? selectedMealTypes[0] : null;

  const filteredMealLibrary = React.useMemo(() => {
    return mealLibrary.filter((meal) => {
      const mealTypeMatch = selectedMealTypes.length === 0 || selectedMealTypes.includes(meal.meal_type);
      const mealDietTags = normalizedMealDietTags(meal.diet_tags);
      const dietMatch =
        selectedDietTags.length === 0 || selectedDietTags.every((tag) => mealDietTags.includes(tag));
      const prepMatch =
        selectedPrepFilters.length === 0 ||
        selectedPrepFilters.some((filter) => prepFilterMatch(meal.prep_time_minutes, filter));
      const favMatch = !showFavoritesOnly || favoriteMealIds.includes(meal.id);
      return mealTypeMatch && dietMatch && prepMatch && favMatch;
    });
  }, [mealLibrary, selectedMealTypes, selectedDietTags, selectedPrepFilters, showFavoritesOnly, favoriteMealIds]);

  const groceryItemsByCategory = React.useMemo(() => {
    const flat =
      groceryListServer.length > 0 || savedMeals.length === 0
        ? groceryListServer
        : groceryFromSavedMeals(savedMeals);
    return groupGroceryFromFlat(flat);
  }, [groceryListServer, savedMeals]);

  const groceryItemTotal = React.useMemo(() => {
    let total = 0;
    for (const items of groceryItemsByCategory.values()) total += items.length;
    return total;
  }, [groceryItemsByCategory]);

  function buildGroceryExportText(): string {
    const lines: string[] = ['DailyFlow Grocery List', ''];
    const checkedSet = new Set(checkedGroceryKeys);
    for (const [rawCategory, items] of groceryItemsByCategory.entries()) {
      if (!items || items.length === 0) continue;
      const categoryLabel = (typeof rawCategory === 'string' && rawCategory.trim()) ? rawCategory.trim() : 'Other';
      lines.push(categoryLabel);
      for (const item of items) {
        const name = (item.name && item.name.trim()) || 'Item';
        const qty = Number.isFinite(item.quantity) ? formatQuantity(item.quantity) : '';
        const unit = (item.unit && item.unit.trim()) || '';
        const qtyPart = [qty, unit].filter((part) => part.length > 0).join(' ');
        const checkbox = checkedSet.has(item.key) ? '[x]' : '[ ]';
        lines.push(qtyPart ? `${checkbox} ${name} — ${qtyPart}` : `${checkbox} ${name}`);
      }
      lines.push('');
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n') + '\n';
  }

  function handleExportGroceryList() {
    if (groceryItemTotal === 0) return;
    const content = buildGroceryExportText();
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'dailyflow-grocery-list.txt';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

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

  async function saveMealToWeek() {
    if (!addMealSource) return;
    if (!addMealDate || !addMealStartTime) {
      setAddMealError('Please select date and start time.');
      return;
    }
    setAddMealError('');
    setIsSavingMealCalendar(true);
    try {
      const { ok, status, payload } = await patchMealsSaved(
        {
          action: 'add_to_calendar',
          meal_id: addMealSource.id,
          date: addMealDate,
          start_time: addMealStartTime,
        },
        { setGlobalError: false }
      );
      if (!ok) {
        const msg =
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message.trim()
            : status === 404
              ? 'Google Calendar is not connected. Connect Google from Calendar, then try again.'
              : `Could not add meal to calendar (${status}).`;
        setAddMealError(msg);
        return;
      }
      applyWeekPatchPayload(payload);
      closeAddMealModal();
    } catch {
      setAddMealError('Could not add meal to calendar right now.');
    } finally {
      setIsSavingMealCalendar(false);
    }
  }

  async function updateServings(savedId: string, nextServings: number) {
    const n = Math.max(1, nextServings);
    const { ok, payload } = await patchMealsSaved(
      {
        action: 'update_servings',
        saved_meal_id: savedId,
        servings: n,
        week_record_key: weekRecordKey || undefined,
      },
      { setGlobalError: true }
    );
    if (ok) applyWeekPatchPayload(payload);
  }

  async function removeSavedMeal(savedId: string) {
    const { ok, payload } = await patchMealsSaved(
      {
        action: 'remove_saved_meal',
        saved_meal_id: savedId,
        week_record_key: weekRecordKey || undefined,
      },
      { setGlobalError: true }
    );
    if (ok) applyWeekPatchPayload(payload);
  }

  async function toggleGroceryChecked(key: string) {
    const { ok, payload } = await patchMealsSaved(
      {
        action: 'toggle_grocery_item',
        grocery_key: key,
        week_record_key: weekRecordKey || undefined,
      },
      { setGlobalError: true }
    );
    if (ok) applyWeekPatchPayload(payload);
  }

  async function clearCheckedGroceryItems() {
    const { ok, payload } = await patchMealsSaved(
      { action: 'clear_checked', week_record_key: weekRecordKey || undefined },
      { setGlobalError: true }
    );
    if (ok) applyWeekPatchPayload(payload);
  }

  async function toggleFavoriteMeal(mealId: string) {
    setMealsApiError('');
    const { ok, payload } = await patchMealsSaved({ action: 'toggle_favorite', meal_id: mealId });
    if (ok && Array.isArray(payload.favorite_meals)) setFavoriteMealIds(payload.favorite_meals);
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
      if (!response.ok) {
        setMealLibrary(SAMPLE_MEALS);
        return;
      }

      const incomingLibrary = Array.isArray(payload.meal_library) ? payload.meal_library : [];
      setMealLibrary(incomingLibrary);
      setFavoriteMealIds(Array.isArray(payload.favorite_meals) ? payload.favorite_meals : []);
      setSavedMeals(Array.isArray(payload.saved_meals_this_week) ? payload.saved_meals_this_week : []);
      setGroceryListServer(Array.isArray(payload.grocery_list) ? payload.grocery_list : []);
      setCheckedGroceryKeys(
        Array.isArray(payload.checked_grocery_items) ? payload.checked_grocery_items : []
      );
      const meta = payload.metadata || {};
      if (typeof meta.week_record_key === 'string') setWeekRecordKey(meta.week_record_key);
      if (typeof meta.week_start === 'string') setWeekStartIso(meta.week_start);
      if (typeof meta.week_end === 'string') setWeekEndIso(meta.week_end);
    } catch {
      setMealLibrary(SAMPLE_MEALS);
    }
  }

  function runMockGenerate(event?: React.MouseEvent<HTMLButtonElement>) {
    event?.preventDefault();
    event?.stopPropagation();
    void (async () => {
      setMealsApiError('');
      setMealGenerationWarning('');
      if (!selectedMealTypeForGenerate) return;
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
          body: JSON.stringify({ meal_type: selectedMealTypeForGenerate }),
        });
        let payload: {
          message?: string;
          meal_library?: MealLibraryItem[];
          favorite_meals?: string[];
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
        setMealGenerationWarning('');
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

      <div className="df-calendarMain" style={{ position: 'relative' }}>
        <header className="df-calendarTopbar">
          <div className="df-calendarTopbarLeft">
            <button
              type="button"
              className="df-btn df-btnPrimary"
              onClick={runMockGenerate}
              disabled={isGeneratingMeals || !selectedMealTypeForGenerate}
            >
              {isGeneratingMeals ? 'Generating...' : 'Generate'}
            </button>
            {!selectedMealTypeForGenerate && (
              <span className="df-calendarLegend" style={{ marginInlineStart: 8 }}>
                Select exactly one meal type to generate.
              </span>
            )}
          </div>
          <div className="df-calendarTopbarRight">
            {googleCalendarStatus === 'reconnect_required' && (
              <button
                type="button"
                className="df-btn df-btnPrimary"
                onClick={handleConnectGoogleCalendarClick}
                disabled={isConnectingGoogleCalendar}
              >
                {isConnectingGoogleCalendar ? 'Connecting...' : 'Connect Google Calendar'}
              </button>
            )}
            <button type="button" className="df-btn" onClick={() => void handleLogoutClick()} disabled={isLoggingOut}>
              {isLoggingOut ? 'Signing out...' : 'Log out'}
            </button>
          </div>
        </header>

        {mealsApiError && <div className="df-errorText" style={{ padding: '8px 16px 0' }}>{mealsApiError}</div>}
        {googleCalendarStatus === 'reconnect_required' && (
          <div className="df-calendarLegend" style={{ padding: '6px 16px 0', color: '#b45309' }} role="alert">
            {googleCalendarStatusMessage || GOOGLE_RECONNECT_MESSAGE_NEW}
          </div>
        )}
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
                className="df-sectionToggle df-mealsLibrarySectionToggle"
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
              <button
                type="button"
                className={`df-workoutFavoriteToggle${showFavoritesOnly ? ' df-workoutFavoriteToggleActive' : ''}`}
                onClick={() => setShowFavoritesOnly((prev) => !prev)}
                aria-label={showFavoritesOnly ? 'Show all meals' : 'Show favorite meals only'}
                title={showFavoritesOnly ? 'Showing favorites' : 'Show favorites'}
              >
                ❤
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
                    <article key={meal.id} className="df-mealLibraryCard">
                      <div className="df-mealLibraryCardHeader">
                        <h3 className="df-mealLibraryCardTitle">{meal.title}</h3>
                        <button
                          type="button"
                          className={`df-mealLibraryCardHeart${favoriteMealIds.includes(meal.id) ? ' df-mealLibraryCardHeartActive' : ''}`}
                          aria-label={`Toggle favorite for ${meal.title}`}
                          onClick={() => void toggleFavoriteMeal(meal.id)}
                        >
                          {favoriteMealIds.includes(meal.id) ? '♥' : '♡'}
                        </button>
                      </div>
                      <div
                        className="df-mealLibraryCardBody"
                        role="button"
                        tabIndex={0}
                        onClick={() => setMealDetail(meal)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setMealDetail(meal);
                          }
                        }}
                      >
                        <div className="df-mealLibraryDietTags">
                          {(normalizedMealDietTags(meal.diet_tags).length
                            ? normalizedMealDietTags(meal.diet_tags)
                            : ['Balanced']
                          ).map((tag) => (
                            <span key={`${meal.id}-${tag}`} className="df-mealLibraryDietPill">
                              {tag}
                            </span>
                          ))}
                        </div>
                        <div className="df-mealLibraryMetaRow">
                          <span className="df-mealLibraryMetaItem" title="Prep time">
                            <span aria-hidden>⏱</span> {meal.prep_time_minutes} min
                          </span>
                          {meal.estimated_calories != null && meal.estimated_calories > 0 ? (
                            <span className="df-mealLibraryMetaItem" title="Estimated calories">
                              <span aria-hidden>🔥</span> {meal.estimated_calories} kcal
                            </span>
                          ) : null}
                        </div>
                        <div className="df-mealLibraryIngredientsBlock">
                          <div className="df-mealLibraryIngredientsLabel">Ingredients:</div>
                          <div className="df-mealLibraryIngredientsPreview">{meal.short_ingredients_preview}</div>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="df-mealLibraryCalendarBtn"
                        onClick={() => openAddMealModal(meal)}
                      >
                        <span aria-hidden className="df-mealLibraryCalendarBtnIcon">
                          📅
                        </span>
                        Add to calendar
                      </button>
                    </article>
                  ))}
                </div>
                {mealLibrary.length > 0 && filteredMealLibrary.length === 0 && (
                  <div className="df-calendarLegend" style={{ marginTop: 10, color: '#6b7280' }}>
                    No meals match these filters.
                  </div>
                )}
                {mealLibrary.length === 0 && (
                  <div className="df-calendarLegend" style={{ marginTop: 10, color: '#6b7280' }}>
                    No meals in your library yet. Tap Generate to create one.
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
                        onClick={() => void removeSavedMeal(savedMeal.id)}
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
                        onClick={() => void updateServings(savedMeal.id, savedMeal.servings - 1)}
                      >
                        -
                      </button>
                      <input
                        type="number"
                        min={1}
                        value={savedMeal.servings}
                        className="df-input df-mealServingsInput"
                        onChange={(event) => void updateServings(savedMeal.id, Number(event.target.value) || 1)}
                      />
                      <button
                        type="button"
                        className="df-weeklyPlanControlBtn"
                        onClick={() => void updateServings(savedMeal.id, savedMeal.servings + 1)}
                      >
                        +
                      </button>
                    </div>
                  </article>
                ))}
                {savedMeals.length === 0 && (
                  <div className="df-calendarLegend" style={{ color: '#6b7280' }}>
                    No meals saved yet. Use &quot;Add to calendar&quot; on a library meal to schedule one.
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
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="df-btn"
                  onClick={handleExportGroceryList}
                  disabled={groceryItemTotal === 0}
                  title={groceryItemTotal === 0 ? 'No grocery items to export.' : 'Export grocery list as .txt'}
                >
                  Export
                </button>
                <button type="button" className="df-btn" onClick={() => void clearCheckedGroceryItems()}>
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
                            onChange={() => void toggleGroceryChecked(item.key)}
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

        {isGeneratingMeals && (
          <div className="df-workoutsLoadingOverlay" role="status" aria-live="polite" aria-label="Generating meals">
            <div className="df-workoutsLoadingShade" aria-hidden />
            <div className="df-workoutsLoadingCenter">
              <div className="df-workoutsLoadingCard">
                <div className="df-workoutsBasicSpinner" aria-hidden />
                <div className="df-workoutsLoadingText">Generating new meal library...</div>
              </div>
            </div>
          </div>
        )}
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
                  min={weekStartIso || undefined}
                  max={weekEndIso || undefined}
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
                <button
                  type="button"
                  className="df-weeklyPlanActionBtn"
                  onClick={() => void saveMealToWeek()}
                  disabled={isSavingMealCalendar}
                >
                  {isSavingMealCalendar ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  className="df-weeklyPlanActionBtn"
                  onClick={closeAddMealModal}
                  disabled={isSavingMealCalendar}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {mealDetail && (
        <div
          className="df-modalBackdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMealDetail(null);
          }}
        >
          <div className="df-modalPanel df-addWeeklyModal" role="dialog" aria-modal="true" aria-label="Meal details">
            <div className="df-modalHeader">
              <div className="df-modalTitle">{mealDetail.title}</div>
              <button
                type="button"
                className="df-iconBtn"
                onClick={() => setMealDetail(null)}
                aria-label="Close meal details"
              >
                ✕
              </button>
            </div>
            <div className="df-settingsContent df-mealDetailModalBody">
              <div className="df-mealDetailChips">
                <span className="df-mealLibraryDietPill">{mealDetail.meal_type}</span>
                {normalizedMealDietTags(mealDetail.diet_tags).map((tag) => (
                  <span key={`d-${tag}`} className="df-mealLibraryDietPill">
                    {tag}
                  </span>
                ))}
              </div>
              <div className="df-mealLibraryMetaRow" style={{ marginTop: 8 }}>
                <span className="df-mealLibraryMetaItem">
                  <span aria-hidden>⏱</span> {mealDetail.prep_time_minutes} min prep
                </span>
                {mealDetail.estimated_calories != null && mealDetail.estimated_calories > 0 ? (
                  <span className="df-mealLibraryMetaItem">
                    <span aria-hidden>🔥</span> {mealDetail.estimated_calories} kcal
                  </span>
                ) : null}
              </div>
              {mealDetail.summary_short ? (
                <p className="df-mealDetailSummary">{mealDetail.summary_short}</p>
              ) : null}
              <h4 className="df-mealDetailSectionTitle">Ingredients</h4>
              <ul className="df-mealDetailList">
                {mealDetail.ingredients.map((ing, idx) => (
                  <li key={`${mealDetail.id}-ing-${idx}`}>
                    {ing.name}: {formatQuantity(ing.quantity)} {ing.unit}
                  </li>
                ))}
              </ul>
              {mealDetail.instructions && mealDetail.instructions.length > 0 ? (
                <>
                  <h4 className="df-mealDetailSectionTitle">Instructions</h4>
                  <ol className="df-mealDetailList df-mealDetailSteps">
                    {mealDetail.instructions.map((step, idx) => (
                      <li key={`step-${idx}`}>{step}</li>
                    ))}
                  </ol>
                </>
              ) : null}
              <div className="df-weeklyPlanActions" style={{ marginTop: 16 }}>
                <button
                  type="button"
                  className="df-weeklyPlanActionBtn"
                  onClick={() => {
                    openAddMealModal(mealDetail);
                    setMealDetail(null);
                  }}
                >
                  Add to calendar
                </button>
                <button type="button" className="df-weeklyPlanActionBtn" onClick={() => setMealDetail(null)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
