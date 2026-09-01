import React from 'react';
import { jsPDF } from 'jspdf';
import { fetchAuthSession } from 'aws-amplify/auth';
import ProfileSettingsModal from '../Home/ProfileSettingsModal';
import AppSidebar, {
  CalendarPlusIcon,
  ClockIcon,
  FireIcon,
  HeartIcon,
  useSidebarCollapsed,
} from '../Sidebar/AppSidebar';
import { pastelTagStyle } from '../shared/pastelTags';
import {
  GOOGLE_RECONNECT_MESSAGE_NEW,
  googleCalendarReconnectDisplayMessage,
  isGoogleCalendarReconnectOrMissing,
} from '../../services/googleCalendarConnection';

type MealsGroceryScreenProps = {
  username?: string;
  onLogout?: () => Promise<void>;
};

type IngredientRounding = 'none' | 'ceil';
type MealType = 'Breakfast' | 'Lunch' | 'Dinner' | 'Snack';
type PrepTimeFilter = 'lt20' | '20to40' | 'gt40';
type GoogleCalendarStatus = 'checking' | 'connected' | 'not_connected' | 'reconnect_required';

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
  const datePart = base.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const timePart = `${String(base.getHours()).padStart(2, '0')}:${String(base.getMinutes()).padStart(2, '0')}`;
  return `${datePart} ${timePart}`;
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

const ENGLISH_DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function toIsoDateLocal(value: Date): string {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

function formatAddPopupDayLabel(date: Date): string {
  return `${ENGLISH_DAY_NAMES[date.getDay()]} ${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}`;
}

function buildAddPopupDayOptions(
  now: Date,
  weekStartIso?: string,
  weekEndIso?: string
): { value: string; label: string }[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const todayIso = toIsoDateLocal(today);
  const startIso =
    typeof weekStartIso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(weekStartIso) ? weekStartIso : todayIso;
  const localSaturday = new Date(today);
  localSaturday.setDate(today.getDate() + (6 - today.getDay()));
  const endIso =
    typeof weekEndIso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(weekEndIso)
      ? weekEndIso
      : toIsoDateLocal(localSaturday);

  const options: { value: string; label: string }[] = [];
  const cursor = new Date(`${startIso}T00:00:00`);
  const end = new Date(`${endIso}T00:00:00`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return options;
  while (cursor <= end && options.length < 7) {
    const value = toIsoDateLocal(cursor);
    if (value >= todayIso) {
      options.push({ value, label: formatAddPopupDayLabel(cursor) });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return options;
}

function isValidHHmm(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function buildHHmm15MinuteOptions(): string[] {
  const out: string[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (let minute = 0; minute < 60; minute += 15) {
      out.push(`${pad2(hour)}:${pad2(minute)}`);
    }
  }
  return out;
}

const HHMM_15_MINUTE_OPTIONS = buildHHmm15MinuteOptions();

function timeSelectOptions(current: string): string[] {
  if (current && !HHMM_15_MINUTE_OPTIONS.includes(current) && isValidHHmm(current)) {
    return [current, ...HHMM_15_MINUTE_OPTIONS];
  }
  return HHMM_15_MINUTE_OPTIONS;
}

function sanitizeHHmmTyping(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
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

function collapseGroceryWs(value: string): string {
  return value.trim().split(/\s+/).join(' ');
}

function groceryNameKey(name: string): string {
  return collapseGroceryWs(name).toLowerCase();
}

function groceryUnitKey(unit: string): string {
  const cleaned = collapseGroceryWs(unit).toLowerCase();
  return cleaned || 'unit';
}

function sentenceCaseGroceryName(name: string): string {
  const collapsed = collapseGroceryWs(name);
  if (!collapsed) return '';
  return collapsed.charAt(0).toUpperCase() + collapsed.slice(1).toLowerCase();
}

function groceryMergeKey(name: string, unit: string): string {
  return `${groceryNameKey(name)}::${groceryUnitKey(unit)}`;
}

function mapLegacyGroceryKey(rawKey: string): string {
  const raw = rawKey.trim();
  if (!raw) return '';
  const parts = raw.split('::');
  if (parts.length >= 2) {
    return groceryMergeKey(parts[parts.length - 2], parts[parts.length - 1]);
  }
  return groceryNameKey(raw);
}

function nameKeyFromGroceryItemKey(rawKey: string): string {
  const mapped = mapLegacyGroceryKey(rawKey);
  if (!mapped) return '';
  const sep = mapped.indexOf('::');
  return sep === -1 ? mapped : mapped.slice(0, sep);
}

function remapCheckedGroceryKeys(checked: string[], grocery: GroceryItem[]): string[] {
  const valid = new Set(grocery.map((item) => item.key).filter(Boolean));
  const remapped: string[] = [];
  const seen = new Set<string>();
  for (const oldKey of checked) {
    const candidate = valid.has(oldKey) ? oldKey : mapLegacyGroceryKey(oldKey);
    if (valid.has(candidate) && !seen.has(candidate)) {
      remapped.push(candidate);
      seen.add(candidate);
    }
  }
  return remapped;
}

function collapseGroceryDisplayByName(items: GroceryItem[]): GroceryItem[] {
  const map = new Map<string, GroceryItem>();
  for (const item of items) {
    const nameKey = groceryNameKey(item.name);
    if (!nameKey) continue;
    const category = collapseGroceryWs(item.category || '');
    const existing = map.get(nameKey);
    if (!existing) {
      map.set(nameKey, {
        key: nameKey,
        name: sentenceCaseGroceryName(item.name),
        unit: item.unit,
        category,
        quantity: item.quantity,
      });
    } else if (!existing.category && category) {
      existing.category = category;
    }
  }
  return Array.from(map.values()).map((item) => ({
    ...item,
    category: item.category || 'Pantry',
  }));
}

function resolveSavedMealDetail(savedMeal: SavedMealItem, library: MealLibraryItem[]): MealLibraryItem {
  const fromLibrary = library.find((meal) => meal.id === savedMeal.meal_id);
  if (fromLibrary) return fromLibrary;
  const ingredients = Array.isArray(savedMeal.ingredients) ? savedMeal.ingredients : [];
  return {
    id: savedMeal.meal_id || savedMeal.id,
    title: savedMeal.meal_name,
    meal_type: 'Dinner',
    diet_tags: [],
    prep_time_minutes: savedMeal.prep_time_minutes,
    short_ingredients_preview: ingredients.map((ing) => ing.name).filter(Boolean).join(', '),
    base_servings: savedMeal.base_servings,
    ingredients,
  };
}

function groceryFromSavedMeals(savedMeals: SavedMealItem[]): GroceryItem[] {
  type Acc = {
    key: string;
    name: string;
    unit: string;
    category: string;
    quantity: number;
    rounding: IngredientRounding;
  };
  const map = new Map<string, Acc>();
  for (const savedMeal of savedMeals) {
    const servingScale = savedMeal.servings / Math.max(1, savedMeal.base_servings);
    for (const ingredient of savedMeal.ingredients || []) {
      const name = sentenceCaseGroceryName(ingredient.name || '');
      if (!name) continue;
      const unit = groceryUnitKey(ingredient.unit || '');
      const category = collapseGroceryWs(ingredient.category || '');
      const key = groceryMergeKey(name, unit);
      const scaledQty = ingredient.quantity * servingScale;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          key,
          name,
          unit,
          category,
          quantity: scaledQty,
          rounding: ingredient.rounding === 'ceil' ? 'ceil' : 'none',
        });
      } else {
        if (!existing.category && category) existing.category = category;
        existing.quantity += scaledQty;
      }
    }
  }
  return Array.from(map.values())
    .map((item) => ({
      key: item.key,
      name: item.name,
      unit: item.unit,
      category: item.category || 'Pantry',
      quantity: item.rounding === 'ceil' ? Math.ceil(item.quantity) : Number(item.quantity.toFixed(2)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export default function MealsGroceryScreen(props: MealsGroceryScreenProps) {
  const { username, onLogout } = props;
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useSidebarCollapsed();

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

  const [googleCalendarStatus, setGoogleCalendarStatus] = React.useState<GoogleCalendarStatus>('checking');
  const [googleCalendarStatusMessage, setGoogleCalendarStatusMessage] = React.useState<string>('');
  const [isConnectingGoogleCalendar, setIsConnectingGoogleCalendar] = React.useState<boolean>(false);

  const [addMealSource, setAddMealSource] = React.useState<MealLibraryItem | null>(null);
  const [addMealDate, setAddMealDate] = React.useState<string>('');
  const [addMealStartTime, setAddMealStartTime] = React.useState<string>('');
  const [addMealError, setAddMealError] = React.useState<string>('');

  const addMealDayOptions = React.useMemo(
    () => (addMealSource ? buildAddPopupDayOptions(new Date(), weekStartIso, weekEndIso) : []),
    [addMealSource, weekStartIso, weekEndIso]
  );

  const effectiveName = (displayName || username || 'Noa Levi').trim();

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

  function applyGoogleReconnectFromResponse(payload: MealsSavedPatchResponse, status: number): boolean {
    if (!isGoogleCalendarReconnectOrMissing(payload, status)) return false;
    setGoogleCalendarStatus(status === 404 ? 'not_connected' : 'reconnect_required');
    setGoogleCalendarStatusMessage(googleCalendarReconnectDisplayMessage(payload));
    return true;
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
      const isGoogleIssue = applyGoogleReconnectFromResponse(payload, response.status);
      if (setGlobal && !isGoogleIssue) {
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

  const refreshGoogleCalendarConnectionState = React.useCallback(async () => {
    try {
      setGoogleCalendarStatus('checking');
      setGoogleCalendarStatusMessage('');
      const baseUrl = getApiBaseUrl();
      const token = await getAuthToken();
      const response = await fetch(`${baseUrl}/auth/google/calendars`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      let payload: MealsSavedPatchResponse = {};
      try {
        payload = (await response.json()) as MealsSavedPatchResponse;
      } catch {
        payload = {};
      }
      if (response.status === 404) {
        setGoogleCalendarStatus('not_connected');
        setGoogleCalendarStatusMessage('');
        return;
      }
      if (!response.ok) {
        if (applyGoogleReconnectFromResponse(payload, response.status)) {
          return;
        }
        setGoogleCalendarStatus('connected');
        setGoogleCalendarStatusMessage('');
        return;
      }
      setGoogleCalendarStatus('connected');
      setGoogleCalendarStatusMessage('');
    } catch {
      setGoogleCalendarStatus('connected');
      setGoogleCalendarStatusMessage('');
    }
  }, []);

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
        const startUrl = `${baseUrl}/auth/google/start?access_token=${encodeURIComponent(accessToken)}&return_to=${encodeURIComponent('/meals')}`;
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

  const groceryUnitItems = React.useMemo(() => {
    if (groceryListServer.length > 0 || savedMeals.length === 0) return groceryListServer;
    return groceryFromSavedMeals(savedMeals);
  }, [groceryListServer, savedMeals]);

  const groceryItemsByCategory = React.useMemo(() => {
    return groupGroceryFromFlat(collapseGroceryDisplayByName(groceryUnitItems));
  }, [groceryUnitItems]);

  const checkedGroceryNameKeys = React.useMemo(() => {
    const remapped = remapCheckedGroceryKeys(checkedGroceryKeys, groceryUnitItems);
    const names = new Set<string>();
    for (const key of remapped) {
      const nameKey = nameKeyFromGroceryItemKey(key);
      if (nameKey) names.add(nameKey);
    }
    for (const item of groceryUnitItems) {
      if (remapped.includes(item.key)) {
        const nameKey = groceryNameKey(item.name);
        if (nameKey) names.add(nameKey);
      }
    }
    return names;
  }, [checkedGroceryKeys, groceryUnitItems]);

  const groceryItemTotal = React.useMemo(() => {
    let total = 0;
    for (const items of groceryItemsByCategory.values()) total += items.length;
    return total;
  }, [groceryItemsByCategory]);

  function handleExportGroceryListPdf() {
    if (groceryItemTotal === 0) return;

    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 16;
    const contentLeft = margin;
    const contentRight = pageWidth - margin;
    const contentWidth = contentRight - contentLeft;
    const checkedSet = checkedGroceryNameKeys;

    const COLOR_HEADER_BG: [number, number, number] = [244, 228, 226];
    const COLOR_HEADER_ACCENT: [number, number, number] = [201, 158, 156];
    const COLOR_CATEGORY_BG: [number, number, number] = [250, 236, 233];
    const COLOR_CATEGORY_TEXT: [number, number, number] = [120, 70, 70];
    const COLOR_TEXT: [number, number, number] = [60, 45, 45];
    const COLOR_MUTED: [number, number, number] = [140, 120, 120];
    const COLOR_DOTTED: [number, number, number] = [200, 180, 180];

    const headerHeight = 34;
    const categoryBandHeight = 9;
    const itemRowHeight = 8;
    const bulletRadius = 1.7;
    const sectionGap = 5;
    const footerHeight = 10;

    let y = 0;

    const drawHeader = () => {
      doc.setFillColor(...COLOR_HEADER_BG);
      doc.rect(0, 0, pageWidth, headerHeight, 'F');
      doc.setDrawColor(...COLOR_HEADER_ACCENT);
      doc.setLineWidth(0.4);
      doc.line(margin, headerHeight, pageWidth - margin, headerHeight);

      doc.setTextColor(...COLOR_TEXT);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(22);
      doc.text('DailyFlow Grocery List', contentLeft, 16);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(...COLOR_MUTED);
      doc.text('Generated from your saved weekly meals', contentLeft, 22);

      const exportDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      const dateLabel = `Date: ${exportDate}`;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(...COLOR_TEXT);
      const dateWidth = doc.getTextWidth(dateLabel);
      doc.text(dateLabel, contentRight - dateWidth, 22);

      y = headerHeight + 8;
    };

    const startNewPage = () => {
      doc.addPage();
      drawHeader();
    };

    const ensureSpace = (neededMm: number) => {
      if (y + neededMm > pageHeight - footerHeight - margin / 2) {
        startNewPage();
      }
    };

    const drawCategoryBand = (label: string) => {
      ensureSpace(categoryBandHeight + itemRowHeight);
      doc.setFillColor(...COLOR_CATEGORY_BG);
      const bandRadius = 2.5;
      const bandY = y;
      if (typeof (doc as unknown as { roundedRect?: Function }).roundedRect === 'function') {
        doc.roundedRect(contentLeft, bandY, contentWidth, categoryBandHeight, bandRadius, bandRadius, 'F');
      } else {
        doc.rect(contentLeft, bandY, contentWidth, categoryBandHeight, 'F');
      }
      doc.setTextColor(...COLOR_CATEGORY_TEXT);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.text(label.toUpperCase(), contentLeft + 4, bandY + categoryBandHeight - 3);
      y += categoryBandHeight + 3;
    };

    const drawDottedLine = (x1: number, x2: number, lineY: number) => {
      doc.setDrawColor(...COLOR_DOTTED);
      doc.setLineWidth(0.3);
      const segment = 0.6;
      const gap = 1.4;
      let cursor = x1;
      while (cursor < x2) {
        const end = Math.min(cursor + segment, x2);
        doc.line(cursor, lineY, end, lineY);
        cursor = end + gap;
      }
    };

    const drawBullet = (cx: number, cy: number, checked: boolean) => {
      doc.setDrawColor(...COLOR_HEADER_ACCENT);
      doc.setLineWidth(0.4);
      if (checked) {
        doc.setFillColor(...COLOR_HEADER_ACCENT);
        doc.circle(cx, cy, bulletRadius, 'FD');
        doc.setDrawColor(255, 255, 255);
        doc.setLineWidth(0.5);
        const r = bulletRadius - 0.5;
        doc.line(cx - r, cy, cx - r / 3, cy + r / 1.4);
        doc.line(cx - r / 3, cy + r / 1.4, cx + r, cy - r / 1.4);
      } else {
        doc.circle(cx, cy, bulletRadius, 'S');
      }
    };

    const drawItem = (item: GroceryItem) => {
      const name = (item.name && item.name.trim()) || 'Item';
      const checked = checkedSet.has(item.key);

      const bulletX = contentLeft + 3;
      const textX = bulletX + 5;
      const textWidth = contentRight - textX - 2;
      const wrapped = doc.splitTextToSize(name, textWidth) as string[];
      const blockHeight = Math.max(itemRowHeight, wrapped.length * 5 + 3);
      ensureSpace(blockHeight);

      const baseY = y;
      drawBullet(bulletX, baseY + 2.5, checked);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(...COLOR_TEXT);
      let lineCursor = baseY + 3;
      for (const line of wrapped) {
        doc.text(line, textX, lineCursor);
        lineCursor += 5;
      }

      drawDottedLine(textX, contentRight, baseY + blockHeight - 2);
      y += blockHeight;
    };

    drawHeader();

    for (const [rawCategory, items] of groceryItemsByCategory.entries()) {
      if (!items || items.length === 0) continue;
      const categoryLabel =
        typeof rawCategory === 'string' && rawCategory.trim() ? rawCategory.trim() : 'Other';
      drawCategoryBand(categoryLabel);
      for (const item of items) drawItem(item);
      y += sectionGap;
    }

    const totalPages = doc.getNumberOfPages();
    if (totalPages > 1) {
      for (let pageIdx = 1; pageIdx <= totalPages; pageIdx += 1) {
        doc.setPage(pageIdx);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(...COLOR_MUTED);
        const footerLabel = `Page ${pageIdx} / ${totalPages}`;
        const labelWidth = doc.getTextWidth(footerLabel);
        doc.text(footerLabel, (pageWidth - labelWidth) / 2, pageHeight - 7);
      }
    }

    doc.save('dailyflow-grocery-list.pdf');
  }

  function openAddMealModal(meal: MealLibraryItem) {
    setAddMealError('');
    setAddMealSource(meal);
    setAddMealDate(toIsoDateLocal(new Date()));
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
    if (!isValidHHmm(addMealStartTime)) {
      setAddMealError('Please enter start time as HH:mm (00:00 to 23:59).');
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
        if (applyGoogleReconnectFromResponse(payload, status)) {
          setAddMealError(googleCalendarReconnectDisplayMessage(payload));
          return;
        }
        const msg =
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message.trim()
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

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('google_calendar_connected') === '1') {
      params.delete('google_calendar_connected');
      const nextSearch = params.toString();
      const next = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', next);
    }
    void refreshGoogleCalendarConnectionState();
  }, [refreshGoogleCalendarConnectionState]);

  return (
    <section
      className={`df-calendarPage df-workoutsPage df-mealsScreen${isSidebarCollapsed ? ' df-calendarPageNavCollapsed' : ''}`}
      aria-label="DailyFlow meals and grocery screen"
    >
      <AppSidebar
        displayName={effectiveName}
        profileImageUrl={profileImageUrl}
        onOpenSettings={() => setIsProfileSettingsOpen(true)}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapsed={() => setIsSidebarCollapsed((prev) => !prev)}
      />

      <div className="df-calendarMain" style={{ position: 'relative' }}>
        <header className="df-calendarTopbar">
          <div className="df-calendarTopbarLeft">
            <span
              title={
                !selectedMealTypeForGenerate
                  ? 'Select exactly one meal type to generate.'
                  : undefined
              }
              style={{ display: 'inline-flex' }}
            >
              <button
                type="button"
                className="df-btn df-btnPrimary"
                onClick={runMockGenerate}
                disabled={isGeneratingMeals || !selectedMealTypeForGenerate}
                title={
                  !selectedMealTypeForGenerate
                    ? 'Select exactly one meal type to generate.'
                    : undefined
                }
              >
                {isGeneratingMeals ? 'Generating...' : 'Generate'}
              </button>
            </span>
          </div>
          <div className="df-calendarTopbarRight">
            {(googleCalendarStatus === 'reconnect_required' ||
              googleCalendarStatus === 'not_connected') && (
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

        {mealsApiError && <div className="df-errorText df-screenStatus">{mealsApiError}</div>}
        {(googleCalendarStatus === 'reconnect_required' ||
          googleCalendarStatus === 'not_connected') && (
          <div className="df-calendarLegend df-screenStatus df-legendWarn" role="alert">
            {googleCalendarStatus === 'not_connected'
              ? 'Connect Google Calendar to add meals to your calendar.'
              : googleCalendarStatusMessage || GOOGLE_RECONNECT_MESSAGE_NEW}
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
                <h2 className="df-workoutsTitle">
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
                          className={`df-favoriteHeartBtn${favoriteMealIds.includes(meal.id) ? ' df-favoriteHeartBtnActive' : ''}`}
                          aria-label={`Toggle favorite for ${meal.title}`}
                          aria-pressed={favoriteMealIds.includes(meal.id)}
                          onClick={() => void toggleFavoriteMeal(meal.id)}
                        >
                          <HeartIcon size={18} filled={favoriteMealIds.includes(meal.id)} />
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
                            <span
                              key={`${meal.id}-${tag}`}
                              className="df-mealLibraryDietPill"
                              style={pastelTagStyle(tag)}
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                        <div className="df-mealLibraryMetaRow">
                          <span className="df-mealLibraryMetaItem" title="Prep time">
                            <span className="df-inlineIcon" aria-hidden>
                              <ClockIcon size={14} />
                            </span>
                            {meal.prep_time_minutes} min
                          </span>
                          {meal.estimated_calories != null && meal.estimated_calories > 0 ? (
                            <span className="df-mealLibraryMetaItem" title="Estimated calories">
                              <span className="df-inlineIcon df-inlineIconMuted" aria-hidden>
                                <FireIcon size={13} />
                              </span>
                              {meal.estimated_calories} kcal
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
                        <span className="df-mealLibraryCalendarBtnIcon df-inlineIcon" aria-hidden>
                          <CalendarPlusIcon size={16} />
                        </span>
                        Add to calendar
                      </button>
                    </article>
                  ))}
                </div>
                {mealLibrary.length > 0 && filteredMealLibrary.length === 0 && (
                  <div className="df-calendarLegend df-emptyHint" style={{ marginTop: 10 }}>
                    No meals match these filters.
                  </div>
                )}
                {mealLibrary.length === 0 && (
                  <div className="df-calendarLegend df-emptyHint" style={{ marginTop: 10 }}>
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
                <h2 className="df-workoutsTitle">
                  Saved Meals This Week
                </h2>
              </button>
            </div>
            {savedMealsOpen && (
              <div id="saved-meals-section" className="df-workoutLibraryGrid df-mealsSavedGrid">
                {savedMeals.map((savedMeal) => (
                  <article key={savedMeal.id} className="df-workoutLibraryCard">
                    <div className="df-workoutLibraryCardTop">
                      <div
                        className="df-mealLibraryCardBody df-savedMealDetailHit"
                        role="button"
                        tabIndex={0}
                        onClick={() => setMealDetail(resolveSavedMealDetail(savedMeal, mealLibrary))}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setMealDetail(resolveSavedMealDetail(savedMeal, mealLibrary));
                          }
                        }}
                        aria-label={`Open details for ${savedMeal.meal_name}`}
                      >
                        <h3 className="df-workoutLibraryTitle">
                          {savedMeal.meal_name}
                        </h3>
                        <div className="df-workoutMeta">{formatDateTime(savedMeal.date, savedMeal.start_time)}</div>
                        <div className="df-workoutMeta">
                          {savedMeal.start_time} - {savedMeal.end_time} ({savedMeal.prep_time_minutes} min)
                        </div>
                      </div>
                      <button
                        type="button"
                        className="df-weeklyPlanControlBtn df-weeklyPlanControlRemove"
                        onClick={() => void removeSavedMeal(savedMeal.id)}
                        aria-label={`Remove ${savedMeal.meal_name}`}
                      >
                        🗑
                      </button>
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
                  <div className="df-calendarLegend df-emptyHint">
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
                <h2 className="df-workoutsTitle">
                  Grocery List
                </h2>
              </button>
              <div className="df-mealsHeaderActions">
                <button
                  type="button"
                  className="df-btn"
                  onClick={handleExportGroceryListPdf}
                  disabled={groceryItemTotal === 0}
                  title={
                    groceryItemTotal === 0 ? 'No grocery items to export.' : 'Export grocery list as PDF'
                  }
                >
                  Export PDF
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
                    <h2>{category}</h2>
                    <div className="df-checkboxList">
                      {items.map((item) => (
                        <label key={item.key} className="df-checkboxItem">
                          <input
                            type="checkbox"
                            checked={checkedGroceryNameKeys.has(item.key)}
                            onChange={() => void toggleGroceryChecked(item.key)}
                          />
                          <span>{(item.name && item.name.trim()) || 'Item'}</span>
                        </label>
                      ))}
                    </div>
                  </article>
                ))}
                {groceryItemsByCategory.size === 0 && (
                  <div className="df-calendarLegend df-emptyHint">
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
        username={username}
        savedProfileImageUrl={profileImageUrl}
        savedQuestionnaire={savedQuestionnaire}
        onLoadProfile={loadProfile}
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
            <div className="df-settingsContent df-modalBody">
              <div className="df-workoutMeta">
                <strong>{addMealSource.title}</strong> · {addMealSource.prep_time_minutes} min prep
              </div>
              <label className="df-field">
                <div className="df-fieldLabel" style={{ textAlign: 'start' }}>
                  Date
                </div>
                <select
                  className="df-select"
                  value={addMealDate}
                  onChange={(event) => {
                    setAddMealDate(event.target.value);
                    setAddMealError('');
                  }}
                >
                  {addMealDayOptions.length === 0 && (
                    <option value="" disabled>
                      No available days this week
                    </option>
                  )}
                  {addMealDayOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="df-field">
                <div className="df-fieldLabel" style={{ textAlign: 'start' }}>
                  Start time (24h, HH:mm)
                </div>
                <input
                  type="text"
                  inputMode="numeric"
                  className="df-input df-timeInputDesktop"
                  value={addMealStartTime}
                  placeholder="HH:mm"
                  maxLength={5}
                  pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
                  aria-label="Start time in 24-hour HH:mm format"
                  onChange={(event) => {
                    setAddMealStartTime(sanitizeHHmmTyping(event.target.value));
                    setAddMealError('');
                  }}
                />
                <select
                  className="df-select df-timeSelectMobile"
                  value={addMealStartTime}
                  aria-label="Start time in 24-hour HH:mm format"
                  onChange={(event) => {
                    setAddMealStartTime(event.target.value);
                    setAddMealError('');
                  }}
                >
                  <option value="">Select time</option>
                  {timeSelectOptions(addMealStartTime).map((time) => (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  ))}
                </select>
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
                {mealLibrary.some((meal) => meal.id === mealDetail.id) ? (
                  <span
                    className="df-mealLibraryDietPill"
                    style={pastelTagStyle(mealDetail.meal_type)}
                  >
                    {mealDetail.meal_type}
                  </span>
                ) : null}
                {normalizedMealDietTags(mealDetail.diet_tags).map((tag) => (
                  <span
                    key={`d-${tag}`}
                    className="df-mealLibraryDietPill"
                    style={pastelTagStyle(tag)}
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <div className="df-mealLibraryMetaRow">
                <span className="df-mealLibraryMetaItem">
                  <span className="df-inlineIcon" aria-hidden>
                    <ClockIcon size={14} />
                  </span>
                  {mealDetail.prep_time_minutes} min prep
                </span>
                {mealDetail.estimated_calories != null && mealDetail.estimated_calories > 0 ? (
                  <span className="df-mealLibraryMetaItem">
                    <span className="df-inlineIcon df-inlineIconMuted" aria-hidden>
                      <FireIcon size={14} />
                    </span>
                    {mealDetail.estimated_calories} kcal
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
              <div className="df-weeklyPlanActions">
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
