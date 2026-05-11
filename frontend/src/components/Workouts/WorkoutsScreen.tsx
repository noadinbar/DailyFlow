import React from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useLocation, useNavigate } from 'react-router-dom';
import ProfileSettingsModal from '../Home/ProfileSettingsModal';

type WorkoutsScreenProps = {
  username?: string;
  onLogout?: () => Promise<void>;
};

type WeeklyPlanSuggestion = {
  id: string;
  library_workout_id: string;
  recommended_day: string;
  recommended_start_time: string;
  recommended_end_time: string;
  recommended_time_label: string;
  reason_short: string;
  google_event_id?: string;
  dailyflow_calendar_id?: string;
};

type WorkoutLibraryItem = {
  id: string;
  title: string;
  workout_type: string;
  duration_minutes: number;
  intensity: string;
  location: string;
  summary_short: string;
  workout_flow?: {
    summary?: string;
    warmup_steps?: string[];
    main_steps?: string[];
    cooldown_steps?: string[];
    notes?: string[];
  };
};

type FavoriteWorkoutItem = WorkoutLibraryItem & {
  favorite_key: string;
  duration_bucket?: string;
};

type SuggestionsResponse = {
  period?: { start_date?: string; end_date?: string };
  weekly_plan_suggestions?: WeeklyPlanSuggestion[];
  workout_library?: WorkoutLibraryItem[];
  favorite_workouts?: FavoriteWorkoutItem[];
  metadata?: { generation_warning?: string; library_source?: string };
  message?: string;
};

type FavoriteToggleResponse = {
  favorite_workouts?: FavoriteWorkoutItem[];
  toggled_favorite_key?: string;
  is_favorite?: boolean;
  message?: string;
};

type WeeklyPlanUpdateResponse = {
  weekly_plan_suggestions?: WeeklyPlanSuggestion[];
  updated_at?: string;
  already_scheduled?: boolean;
  google_event_id?: string;
  dailyflow_calendar_id?: string;
  reconnect_required?: boolean;
  message?: string;
};

type PlanCalendarStatus = {
  state: 'loading' | 'success' | 'error';
  message?: string;
};

type DayPlanModalState = {
  dayIso: string;
  dayLabel: string;
};

type GoogleCalendarStatus = 'checking' | 'connected' | 'not_connected' | 'reconnect_required' | 'error';

const GOOGLE_RECONNECT_MESSAGE = 'Google connection expired, reconnect required';
const GOOGLE_RECONNECT_MESSAGE_NEW = 'Google Calendar connection expired. Please reconnect.';

type WeekDayCard = { dayLabel: string; dateIso: string };

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function toIsoDateLocal(value: Date): string {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

function normalizeTypeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '_');
}

function getDurationBucket(durationMinutes: number): string {
  if (durationMinutes <= 20) return '10_20';
  if (durationMinutes <= 40) return '20_40';
  return '40_60';
}

function favoriteSignature(item: {
  title: string;
  workout_type: string;
  duration_minutes: number;
  intensity: string;
  location: string;
}): string {
  return [
    item.title.trim().toLowerCase(),
    normalizeTypeKey(item.workout_type),
    String(item.duration_minutes),
    item.intensity.trim().toLowerCase(),
    item.location.trim().toLowerCase(),
  ].join('|');
}

function startOfWeek(value: Date): Date {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() - next.getDay());
  return next;
}

function buildWeekCards(weekStart: Date): WeekDayCard[] {
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const cards: WeekDayCard[] = [];
  for (let i = 0; i < 7; i += 1) {
    const day = new Date(weekStart);
    day.setDate(weekStart.getDate() + i);
    cards.push({ dayLabel: labels[i], dateIso: toIsoDateLocal(day) });
  }
  return cards;
}

export default function WorkoutsScreen(props: WorkoutsScreenProps) {
  const { username, onLogout } = props;
  const navigate = useNavigate();
  const location = useLocation();
  const [isProfileSettingsOpen, setIsProfileSettingsOpen] = React.useState<boolean>(false);
  const [isLoggingOut, setIsLoggingOut] = React.useState<boolean>(false);
  const [displayName, setDisplayName] = React.useState<string>('');
  const [profileImageUrl, setProfileImageUrl] = React.useState<string>('');
  const [savedQuestionnaire, setSavedQuestionnaire] = React.useState<Record<string, unknown> | null>(null);
  const [weekStartDate, setWeekStartDate] = React.useState<Date>(() => startOfWeek(new Date()));
  const [weeklyPlanSuggestions, setWeeklyPlanSuggestions] = React.useState<WeeklyPlanSuggestion[]>([]);
  const [workoutLibrary, setWorkoutLibrary] = React.useState<WorkoutLibraryItem[]>([]);
  const [favoriteWorkouts, setFavoriteWorkouts] = React.useState<FavoriteWorkoutItem[]>([]);
  const [isFavoritesMode, setIsFavoritesMode] = React.useState<boolean>(false);
  const [selectedTypeFilters, setSelectedTypeFilters] = React.useState<string[]>([]);
  const [selectedDurationFilters, setSelectedDurationFilters] = React.useState<string[]>([]);
  const [isGeneratingPlan, setIsGeneratingPlan] = React.useState<boolean>(false);
  const [isTogglingFavorite, setIsTogglingFavorite] = React.useState<boolean>(false);
  const [isSavingWeeklyPlan, setIsSavingWeeklyPlan] = React.useState<boolean>(false);
  const [isAddingAllToCalendar, setIsAddingAllToCalendar] = React.useState<boolean>(false);
  const [isConnectingGoogleCalendar, setIsConnectingGoogleCalendar] = React.useState<boolean>(false);
  const [googleCalendarStatus, setGoogleCalendarStatus] = React.useState<GoogleCalendarStatus>('checking');
  const [googleCalendarStatusMessage, setGoogleCalendarStatusMessage] = React.useState<string>('');
  const [addFromLibraryWorkout, setAddFromLibraryWorkout] = React.useState<WorkoutLibraryItem | null>(null);
  const [addFromLibraryDay, setAddFromLibraryDay] = React.useState<string>('');
  const [addFromLibraryStartTime, setAddFromLibraryStartTime] = React.useState<string>('18:00');
  const [addFromLibraryError, setAddFromLibraryError] = React.useState<string>('');
  const [generateError, setGenerateError] = React.useState<string>('');
  const [generateHint, setGenerateHint] = React.useState<string>('Click Generate plan to load suggestions.');
  const [selectedLibraryWorkout, setSelectedLibraryWorkout] = React.useState<WorkoutLibraryItem | null>(null);
  const [dayPlanModal, setDayPlanModal] = React.useState<DayPlanModalState | null>(null);
  const [planCalendarStatusById, setPlanCalendarStatusById] = React.useState<Record<string, PlanCalendarStatus>>({});

  const effectiveName = (displayName || username || 'Noa Levi').trim();
  const initials = (effectiveName || 'N').slice(0, 2).toUpperCase();
  const isWorkoutsRoute = location.pathname.startsWith('/workouts');
  const isMealsRoute = location.pathname.startsWith('/meals');
  const weekCards = React.useMemo(() => buildWeekCards(weekStartDate), [weekStartDate]);
  const weekStartIso = React.useMemo(() => toIsoDateLocal(weekStartDate), [weekStartDate]);
  const weekEndIso = React.useMemo(() => {
    const end = new Date(weekStartDate);
    end.setDate(weekStartDate.getDate() + 6);
    return toIsoDateLocal(end);
  }, [weekStartDate]);
  const suggestionsByDay = React.useMemo(() => {
    const grouped = new Map<string, WeeklyPlanSuggestion[]>();
    for (const suggestion of weeklyPlanSuggestions) {
      const day = suggestion.recommended_day;
      if (!day) continue;
      if (!grouped.has(day)) grouped.set(day, []);
      grouped.get(day)?.push(suggestion);
    }
    return grouped;
  }, [weeklyPlanSuggestions]);
  const favoriteKeySet = React.useMemo(
    () => new Set(favoriteWorkouts.map((item) => item.favorite_key)),
    [favoriteWorkouts]
  );
  const favoriteSignatureSet = React.useMemo(
    () =>
      new Set(
        favoriteWorkouts.map((item) =>
          favoriteSignature({
            title: item.title,
            workout_type: item.workout_type,
            duration_minutes: item.duration_minutes,
            intensity: item.intensity,
            location: item.location,
          })
        )
      ),
    [favoriteWorkouts]
  );
  const availableWorkoutTypes = React.useMemo(() => {
    const all = [...workoutLibrary, ...favoriteWorkouts];
    return Array.from(new Set(all.map((item) => item.workout_type))).slice(0, 12);
  }, [workoutLibrary, favoriteWorkouts]);
  const availableDurationBuckets = React.useMemo(() => {
    const all = [...workoutLibrary, ...favoriteWorkouts];
    const unique = Array.from(
      new Set(
        all.map((item) =>
          'duration_bucket' in item && typeof item.duration_bucket === 'string'
            ? item.duration_bucket
            : getDurationBucket(item.duration_minutes)
        )
      )
    );
    const order = ['10_20', '20_40', '40_60'];
    return order.filter((bucket) => unique.includes(bucket));
  }, [workoutLibrary, favoriteWorkouts]);
  const displayedLibrary = React.useMemo(() => {
    const base = isFavoritesMode ? favoriteWorkouts : workoutLibrary;
    return base.filter((item) => {
      const typeMatch =
        selectedTypeFilters.length === 0 || selectedTypeFilters.includes(item.workout_type);
      const durationBucket =
        'duration_bucket' in item && typeof item.duration_bucket === 'string'
          ? item.duration_bucket
          : getDurationBucket(item.duration_minutes);
      const durationMatch =
        selectedDurationFilters.length === 0 || selectedDurationFilters.includes(durationBucket);
      return typeMatch && durationMatch;
    });
  }, [
    isFavoritesMode,
    favoriteWorkouts,
    workoutLibrary,
    selectedTypeFilters,
    selectedDurationFilters,
  ]);
  const libraryById = React.useMemo(() => {
    const map = new Map<string, WorkoutLibraryItem>();
    for (const item of workoutLibrary) {
      map.set(item.id, item);
    }
    return map;
  }, [workoutLibrary]);
  const scheduledWorkoutCount = weeklyPlanSuggestions.length;
  const dayPlanModalSuggestions = React.useMemo(() => {
    if (!dayPlanModal) return [];
    return suggestionsByDay.get(dayPlanModal.dayIso) || [];
  }, [dayPlanModal, suggestionsByDay]);

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
    const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
    if (!baseUrl?.trim()) throw new Error('Missing API base URL (VITE_API_BASE_URL).');
    const token = await getAuthToken();
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/profile`, {
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
    const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
    if (!baseUrl?.trim()) throw new Error('Missing API base URL (VITE_API_BASE_URL).');
    const token = await getAuthToken();
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/profile`, {
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
    const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
    if (!baseUrl?.trim()) throw new Error('Missing API base URL (VITE_API_BASE_URL).');
    const token = await getAuthToken();
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/profile`, {
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
    const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
    if (!baseUrl?.trim()) throw new Error('Missing API base URL (VITE_API_BASE_URL).');
    const token = await getAuthToken();
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/profile/image/upload-url`, {
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
    const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
    if (!baseUrl?.trim()) throw new Error('Missing API base URL (VITE_API_BASE_URL).');
    const token = await getAuthToken();
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/profile`, {
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
    setGenerateError('');
    setIsLoggingOut(true);
    try {
      if (onLogout) await onLogout();
    } catch (e) {
      const anyErr = e as { message?: string };
      const message =
        anyErr && typeof anyErr.message === 'string'
          ? anyErr.message
          : 'Failed to sign out. Please try again.';
      setGenerateError(message);
      // eslint-disable-next-line no-console
      console.error(e);
    } finally {
      setIsLoggingOut(false);
    }
  }

  function handleConnectGoogleCalendarClick() {
    setIsConnectingGoogleCalendar(true);
    void (async () => {
      try {
        const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
        if (!baseUrl?.trim()) {
          setGenerateError('Missing API base URL configuration (VITE_API_BASE_URL).');
          setIsConnectingGoogleCalendar(false);
          return;
        }
        const session = await fetchAuthSession();
        const accessToken = session.tokens?.accessToken?.toString();
        if (!accessToken) {
          setGenerateError('You need to be signed in to connect Google Calendar.');
          setIsConnectingGoogleCalendar(false);
          return;
        }
        const startUrl = `${baseUrl.replace(/\/$/, '')}/auth/google/start?access_token=${encodeURIComponent(accessToken)}`;
        window.location.assign(startUrl);
      } catch (e) {
        const anyErr = e as { message?: string };
        setGenerateError(
          typeof anyErr?.message === 'string' ? anyErr.message : 'Failed to start Google Calendar connection.'
        );
        setIsConnectingGoogleCalendar(false);
      }
    })();
  }

  const refreshGoogleCalendarConnectionState = React.useCallback(async () => {
    try {
      setGoogleCalendarStatus('checking');
      setGoogleCalendarStatusMessage('');
      const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
      if (!baseUrl?.trim()) {
        setGoogleCalendarStatus('error');
        setGoogleCalendarStatusMessage('Missing API base URL (VITE_API_BASE_URL).');
        return;
      }
      const token = await getAuthToken();
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/auth/google/calendars`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      let payload: { message?: string } = {};
      try {
        payload = (await response.json()) as { message?: string };
      } catch {
        payload = {};
      }
      if (response.status === 404) {
        setGoogleCalendarStatus('not_connected');
        setGoogleCalendarStatusMessage('');
        return;
      }
      if (
        response.status === 403 &&
        (payload.message === GOOGLE_RECONNECT_MESSAGE || payload.message === GOOGLE_RECONNECT_MESSAGE_NEW)
      ) {
        setGoogleCalendarStatus('reconnect_required');
        setGoogleCalendarStatusMessage(payload.message || GOOGLE_RECONNECT_MESSAGE_NEW);
        return;
      }
      if (!response.ok) {
        setGoogleCalendarStatus('error');
        setGoogleCalendarStatusMessage(
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : `Could not load calendar connection (${response.status}).`
        );
        return;
      }
      setGoogleCalendarStatus('connected');
      setGoogleCalendarStatusMessage('');
    } catch (e) {
      const anyErr = e as { message?: string };
      setGoogleCalendarStatus('error');
      setGoogleCalendarStatusMessage(
        typeof anyErr?.message === 'string' ? anyErr.message : 'Failed to load Google Calendar connection.'
      );
    }
  }, []);

  async function loadWorkoutsData(args: { mode: 'saved' | 'generate'; startDate: string; endDate: string }) {
    const { mode, startDate, endDate } = args;
    setGenerateError('');
    setGenerateHint('');
    setIsGeneratingPlan(mode === 'generate');
    try {
      const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
      if (!baseUrl?.trim()) throw new Error('Missing API base URL (VITE_API_BASE_URL).');
      const token = await getAuthToken();
      const isGenerate = mode === 'generate';
      const endpoint = isGenerate
        ? `${baseUrl.replace(/\/$/, '')}/workouts/suggestions/generate`
        : `${baseUrl.replace(/\/$/, '')}/workouts/suggestions?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`;
      const response = await fetch(endpoint, {
        method: isGenerate ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        ...(isGenerate
          ? {
              body: JSON.stringify({
                start_date: startDate,
                end_date: endDate,
              }),
            }
          : {}),
      });

      let payload: SuggestionsResponse = {};
      try {
        payload = (await response.json()) as SuggestionsResponse;
      } catch {
        payload = {};
      }

      if (!response.ok) {
        const message =
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : `Could not generate plan (${response.status}).`;
        throw new Error(message);
      }

      const weekly = Array.isArray(payload.weekly_plan_suggestions) ? payload.weekly_plan_suggestions : [];
      const library = Array.isArray(payload.workout_library) ? payload.workout_library : [];
      const favorites = Array.isArray(payload.favorite_workouts) ? payload.favorite_workouts : [];
      setWeeklyPlanSuggestions(weekly);
      setWorkoutLibrary(library);
      setFavoriteWorkouts(favorites);
      if (weekly.length === 0 && library.length === 0) {
        setGenerateHint('No saved workout library yet. Click Generate plan.');
      } else if (typeof payload.metadata?.generation_warning === 'string' && payload.metadata.generation_warning) {
        setGenerateHint(payload.metadata.generation_warning);
      } else if (mode === 'saved' && payload.metadata?.library_source === 'saved') {
        setGenerateHint('');
      } else {
        setGenerateHint('');
      }
    } catch (e) {
      const anyErr = e as { message?: string };
      setGenerateError(
        typeof anyErr?.message === 'string' ? anyErr.message : 'Failed to generate workout suggestions.'
      );
    } finally {
      setIsGeneratingPlan(false);
    }
  }

  async function handleGeneratePlanClick() {
    await loadWorkoutsData({ mode: 'generate', startDate: weekStartIso, endDate: weekEndIso });
  }

  async function mutateWeeklyPlan(
    payload: Record<string, unknown>,
    options?: { onError?: (message: string) => void; suppressGlobalError?: boolean }
  ): Promise<WeeklyPlanSuggestion[] | null> {
    try {
      setGenerateError('');
      setIsSavingWeeklyPlan(true);
      const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
      if (!baseUrl?.trim()) throw new Error('Missing API base URL (VITE_API_BASE_URL).');
      const token = await getAuthToken();
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/workouts/weekly-plan`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      let responsePayload: WeeklyPlanUpdateResponse = {};
      try {
        responsePayload = (await response.json()) as WeeklyPlanUpdateResponse;
      } catch {
        responsePayload = {};
      }
      if (!response.ok) {
        const reconnectRequired =
          responsePayload.reconnect_required === true ||
          responsePayload.message === GOOGLE_RECONNECT_MESSAGE ||
          responsePayload.message === GOOGLE_RECONNECT_MESSAGE_NEW;
        if (reconnectRequired) {
          setGoogleCalendarStatus('reconnect_required');
          setGoogleCalendarStatusMessage(responsePayload.message || GOOGLE_RECONNECT_MESSAGE_NEW);
        }
        throw new Error(
          typeof responsePayload.message === 'string' && responsePayload.message.trim()
            ? responsePayload.message
            : `Could not update weekly plan (${response.status}).`
        );
      }
      const savedPlan = Array.isArray(responsePayload.weekly_plan_suggestions)
        ? responsePayload.weekly_plan_suggestions
        : null;
      if (!savedPlan) throw new Error('Weekly plan update returned invalid payload.');
      setWeeklyPlanSuggestions(savedPlan);
      setPlanCalendarStatusById((prev) => {
        const next: Record<string, PlanCalendarStatus> = {};
        for (const planItem of savedPlan) {
          const planId = typeof planItem.id === 'string' ? planItem.id : '';
          if (!planId) continue;
          const previous = prev[planId];
          if (previous) next[planId] = previous;
          if (typeof planItem.google_event_id === 'string' && planItem.google_event_id.trim()) {
            next[planId] = { state: 'success' };
          }
        }
        return next;
      });
      return savedPlan;
    } catch (e) {
      const anyErr = e as { message?: string };
      const message =
        typeof anyErr?.message === 'string' ? anyErr.message : 'Failed to save weekly plan.';
      if (options?.onError) options.onError(message);
      if (!options?.suppressGlobalError) setGenerateError(message);
      return null;
    } finally {
      setIsSavingWeeklyPlan(false);
    }
  }

  async function handleRemoveWeeklyWorkout(planId: string) {
    await mutateWeeklyPlan({
      action: 'remove_plan_item',
      week_start: weekStartIso,
      week_end: weekEndIso,
      plan_id: planId,
    });
  }

  async function handleAddToCalendar(planId: string) {
    setPlanCalendarStatusById((prev) => ({
      ...prev,
      [planId]: { state: 'loading', message: 'Adding...' },
    }));
    const saved = await mutateWeeklyPlan(
      {
        action: 'add_to_calendar',
        week_start: weekStartIso,
        week_end: weekEndIso,
        plan_id: planId,
      },
      { suppressGlobalError: true }
    );
    if (saved) {
      setPlanCalendarStatusById((prev) => ({
        ...prev,
        [planId]: {
          state: 'success',
        },
      }));
      return;
    }
    setPlanCalendarStatusById((prev) => ({
      ...prev,
      [planId]: { state: 'error', message: 'Could not add to calendar.' },
    }));
  }

  async function handleAddAllToCalendar() {
    if (isAddingAllToCalendar) return;
    const eligibleItems = weeklyPlanSuggestions.filter((item) => {
      const itemStatus = planCalendarStatusById[item.id];
      const alreadyAdded =
        Boolean(item.google_event_id && item.google_event_id.trim()) || itemStatus?.state === 'success';
      return !alreadyAdded;
    });
    if (eligibleItems.length === 0) return;
    setGenerateError('');
    setIsAddingAllToCalendar(true);
    let successCount = 0;
    let failCount = 0;
    for (const item of eligibleItems) {
      const planId = item.id;
      if (!planId) continue;
      setPlanCalendarStatusById((prev) => ({
        ...prev,
        [planId]: { state: 'loading', message: 'Adding...' },
      }));
      const saved = await mutateWeeklyPlan(
        {
          action: 'add_to_calendar',
          week_start: weekStartIso,
          week_end: weekEndIso,
          plan_id: planId,
        },
        { suppressGlobalError: true }
      );
      if (saved) {
        successCount += 1;
        setPlanCalendarStatusById((prev) => ({
          ...prev,
          [planId]: { state: 'success' },
        }));
      } else {
        failCount += 1;
        setPlanCalendarStatusById((prev) => ({
          ...prev,
          [planId]: { state: 'error', message: 'Could not add to calendar.' },
        }));
      }
    }
    if (failCount > 0) {
      setGenerateError(`Added ${successCount} workouts. Failed to add ${failCount}.`);
    } else {
      setGenerateError('');
    }
    setIsAddingAllToCalendar(false);
  }

  function openAddFromLibraryModal(workout: WorkoutLibraryItem) {
    setAddFromLibraryError('');
    setAddFromLibraryWorkout(workout);
    setAddFromLibraryDay(weekStartIso);
    setAddFromLibraryStartTime('18:00');
  }

  function closeAddFromLibraryModal() {
    setAddFromLibraryError('');
    setAddFromLibraryWorkout(null);
    setAddFromLibraryDay('');
    setAddFromLibraryStartTime('18:00');
  }

  async function handleAddFromLibrarySave() {
    if (!addFromLibraryWorkout || !addFromLibraryDay || !addFromLibraryStartTime) return;
    setAddFromLibraryError('');
    const saved = await mutateWeeklyPlan({
      action: 'add_library_workout',
      week_start: weekStartIso,
      week_end: weekEndIso,
      library_workout_id: addFromLibraryWorkout.id,
      recommended_day: addFromLibraryDay,
      recommended_start_time: addFromLibraryStartTime,
    }, { onError: setAddFromLibraryError, suppressGlobalError: true });
    if (saved) closeAddFromLibraryModal();
  }

  async function toggleFavorite(workout: WorkoutLibraryItem | FavoriteWorkoutItem) {
    try {
      setGenerateError('');
      setIsTogglingFavorite(true);
      const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
      if (!baseUrl?.trim()) throw new Error('Missing API base URL (VITE_API_BASE_URL).');
      const token = await getAuthToken();
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/workouts/favorites`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          workout: {
            id: workout.id,
            title: workout.title,
            workout_type: workout.workout_type,
            duration_minutes: workout.duration_minutes,
            duration_bucket:
              'duration_bucket' in workout && typeof workout.duration_bucket === 'string'
                ? workout.duration_bucket
                : getDurationBucket(workout.duration_minutes),
            intensity: workout.intensity,
            location: workout.location,
            summary_short: workout.summary_short,
            workout_flow: workout.workout_flow || {},
          },
        }),
      });
      let payload: FavoriteToggleResponse = {};
      try {
        payload = (await response.json()) as FavoriteToggleResponse;
      } catch {
        payload = {};
      }
      if (!response.ok) {
        throw new Error(
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : `Could not toggle favorite (${response.status}).`
        );
      }
      setFavoriteWorkouts(Array.isArray(payload.favorite_workouts) ? payload.favorite_workouts : []);
    } catch (e) {
      const anyErr = e as { message?: string };
      setGenerateError(typeof anyErr?.message === 'string' ? anyErr.message : 'Failed to toggle favorite.');
    } finally {
      setIsTogglingFavorite(false);
    }
  }

  function toggleTypeFilter(type: string) {
    setSelectedTypeFilters((prev) =>
      prev.includes(type) ? prev.filter((value) => value !== type) : [...prev, type]
    );
  }

  function toggleDurationFilter(bucket: string) {
    setSelectedDurationFilters((prev) =>
      prev.includes(bucket) ? prev.filter((value) => value !== bucket) : [...prev, bucket]
    );
  }

  React.useEffect(() => {
    void loadWorkoutsData({ mode: 'saved', startDate: weekStartIso, endDate: weekEndIso });
  }, [weekStartIso, weekEndIso]);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setSelectedLibraryWorkout(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  React.useEffect(() => {
    void (async () => {
      try {
        await loadProfile();
      } catch {
        // Keep username fallback when profile cannot be loaded.
      }
      await refreshGoogleCalendarConnectionState();
    })();
  }, [refreshGoogleCalendarConnectionState]);

  React.useEffect(() => {
    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.search);
    if (params.get('google_calendar_connected') === '1') {
      params.delete('google_calendar_connected');
      const nextSearch = params.toString();
      const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash || ''}`;
      window.history.replaceState({}, '', nextUrl);
      void refreshGoogleCalendarConnectionState();
    }
  }, [refreshGoogleCalendarConnectionState]);

  return (
    <section className="df-calendarPage df-workoutsPage" aria-label="DailyFlow workouts screen">
      <aside className="df-calendarLeftNav">
        <div className="df-calendarBrand">DailyFlow</div>
        <div className="df-calendarProfile">
          <div className="df-calendarProfileAvatar">
            {profileImageUrl ? (
              <img
                key={profileImageUrl}
                src={profileImageUrl}
                alt=""
                className="df-calendarProfileAvatarImg"
              />
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
          <button
            type="button"
            className={`df-calendarMenuItem${isWorkoutsRoute ? ' df-calendarMenuItemActive' : ''}`}
            onClick={() => navigate('/workouts')}
          >
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
              onClick={() => void handleGeneratePlanClick()}
              disabled={isGeneratingPlan}
            >
              {isGeneratingPlan ? 'Generating...' : 'Generate plan'}
            </button>
            <button
              type="button"
              className="df-btn"
              onClick={() => void handleAddAllToCalendar()}
              disabled={
                isAddingAllToCalendar ||
                isSavingWeeklyPlan ||
                isGeneratingPlan ||
                weeklyPlanSuggestions.every((item) => {
                  const itemStatus = planCalendarStatusById[item.id];
                  return (
                    Boolean(item.google_event_id && item.google_event_id.trim()) ||
                    itemStatus?.state === 'success'
                  );
                })
              }
            >
              {isAddingAllToCalendar ? 'Adding all...' : 'Add all to calendar'}
            </button>
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
            <button
              type="button"
              className="df-btn"
              onClick={() => void handleLogoutClick()}
              disabled={isLoggingOut}
            >
              {isLoggingOut ? 'Signing out...' : 'Log out'}
            </button>
          </div>
        </header>

        {generateError && <div className="df-errorText" style={{ padding: '6px 16px 0' }}>{generateError}</div>}
        {googleCalendarStatus === 'reconnect_required' && (
          <div className="df-calendarLegend" style={{ padding: '6px 16px 0', color: '#b45309' }} role="alert">
            {googleCalendarStatusMessage || GOOGLE_RECONNECT_MESSAGE_NEW}
          </div>
        )}
        {googleCalendarStatus === 'not_connected' && (
          <div className="df-calendarLegend" style={{ padding: '6px 16px 0', color: '#6b7280' }}>
            Connect Google Calendar to add workouts directly from Workouts.
          </div>
        )}
        {googleCalendarStatus === 'error' && googleCalendarStatusMessage && (
          <div className="df-calendarLegend" style={{ padding: '6px 16px 0', color: '#b91c1c' }} role="alert">
            {googleCalendarStatusMessage}
          </div>
        )}
        {!generateError && generateHint && (
          <div className="df-calendarLegend" style={{ padding: '6px 16px 0', color: '#6b7280' }}>
            {generateHint}
          </div>
        )}

        <div className="df-workoutsContent">
          <section className="df-workoutsSection">
            <div className="df-workoutsSectionHeader">
              <h2 className="df-workoutsTitle">Weekly Workout Plan</h2>
              <div className="df-workoutsGoal">
                {`${scheduledWorkoutCount} workouts this week`}
              </div>
            </div>
            <div className="df-workoutWeekGrid">
              {weekCards.map((card) => {
                const daySuggestions = suggestionsByDay.get(card.dateIso) || [];
                const item = daySuggestions[0];
                const libraryWorkout = item ? libraryById.get(item.library_workout_id) : undefined;
                const canOpenWeeklyDetails = Boolean(item && libraryWorkout);
                const itemCalendarStatus = item ? planCalendarStatusById[item.id] : undefined;
                const isItemAddLoading = itemCalendarStatus?.state === 'loading';
                const isItemAdded =
                  Boolean(item?.google_event_id) || itemCalendarStatus?.state === 'success';
                return (
                  <article
                    key={card.dateIso}
                    className={`df-workoutDayCard${canOpenWeeklyDetails ? ' df-workoutLibraryCardClickable' : ''}`}
                    onClick={() => {
                      if (libraryWorkout) setSelectedLibraryWorkout(libraryWorkout);
                    }}
                    role={canOpenWeeklyDetails ? 'button' : undefined}
                    tabIndex={canOpenWeeklyDetails ? 0 : undefined}
                    onKeyDown={(event) => {
                      if (!canOpenWeeklyDetails) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        if (libraryWorkout) setSelectedLibraryWorkout(libraryWorkout);
                      }
                    }}
                    aria-label={
                      canOpenWeeklyDetails
                        ? `Open details for ${libraryWorkout?.title || 'workout'}`
                        : undefined
                    }
                  >
                    <h3 className="df-workoutDay">{card.dayLabel}</h3>
                    {!item ? (
                      <div className="df-workoutRestDay">{isGeneratingPlan ? 'Loading...' : 'Rest day'}</div>
                    ) : (
                      <>
                        <div className="df-workoutTypePill">
                          {libraryWorkout?.workout_type || 'Workout'}
                        </div>
                        <div className="df-workoutMeta">
                          {libraryWorkout ? `${libraryWorkout.duration_minutes} min` : 'Duration'}
                        </div>
                        <div className="df-workoutMeta">
                          {libraryWorkout?.intensity || item.recommended_time_label}
                        </div>
                        <div className="df-workoutSlot">
                          {item.recommended_day} {item.recommended_start_time}-{item.recommended_end_time}
                        </div>
                        <div className="df-weeklyPlanControls">
                          <button
                            type="button"
                            className="df-weeklyPlanControlBtn df-weeklyPlanControlAdd"
                            title="Add to calendar"
                            aria-label="Add to calendar"
                            disabled={!item || isItemAddLoading || isItemAdded}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (!item) return;
                              void handleAddToCalendar(item.id);
                            }}
                          >
                            {isItemAddLoading ? '…' : isItemAdded ? '✓' : '+'}
                          </button>
                          <button
                            type="button"
                            className="df-weeklyPlanControlBtn df-weeklyPlanControlRemove"
                            disabled={isSavingWeeklyPlan}
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleRemoveWeeklyWorkout(item.id);
                            }}
                            aria-label={`Remove ${libraryWorkout?.title || 'workout'} from weekly plan`}
                            title="Remove"
                          >
                            🗑
                          </button>
                        </div>
                        {daySuggestions.length > 1 && (
                          <button
                            type="button"
                            className="df-btn"
                            style={{ width: '100%', marginTop: 4 }}
                            onClick={(event) => {
                              event.stopPropagation();
                              setDayPlanModal({ dayIso: card.dateIso, dayLabel: card.dayLabel });
                            }}
                          >
                            +{daySuggestions.length - 1} more options
                          </button>
                        )}
                        {itemCalendarStatus?.state === 'error' && (
                          <div className="df-errorText">{itemCalendarStatus.message || 'Could not add to calendar.'}</div>
                        )}
                      </>
                    )}
                  </article>
                );
              })}
            </div>
            {!isGeneratingPlan && weeklyPlanSuggestions.length === 0 && (
              <div className="df-calendarLegend" style={{ color: '#6b7280', marginBottom: 0 }}>
                Generate a plan to see weekly workout suggestions.
              </div>
            )}
          </section>

          <section className="df-workoutsSection">
            <div className="df-workoutsSectionHeader">
              <h2 className="df-workoutsTitle">Workout Library</h2>
              <button
                type="button"
                className={`df-workoutFavoriteToggle${isFavoritesMode ? ' df-workoutFavoriteToggleActive' : ''}`}
                onClick={() => setIsFavoritesMode((prev) => !prev)}
                aria-label={isFavoritesMode ? 'Show all workouts' : 'Show favorite workouts only'}
                title={isFavoritesMode ? 'Showing favorites' : 'Show favorites'}
              >
                ❤
              </button>
            </div>
            <div className="df-workoutFilters">
              <div className="df-workoutFilterGroup">
                <span className="df-workoutFilterLabel">Type</span>
                {availableWorkoutTypes.length > 0 ? (
                  availableWorkoutTypes.map((type) => (
                    <button
                      key={type}
                      type="button"
                      className={`df-workoutFilterChip${
                        selectedTypeFilters.includes(type) ? ' df-workoutFilterChipActive' : ''
                      }`}
                      onClick={() => toggleTypeFilter(type)}
                    >
                      {type.replace(/_/g, ' ')}
                    </button>
                  ))
                ) : (
                  <button type="button" className="df-workoutFilterChip">No types yet</button>
                )}
              </div>
              <div className="df-workoutFilterGroup">
                <span className="df-workoutFilterLabel">Duration</span>
                {availableDurationBuckets.length > 0 ? (
                  availableDurationBuckets.map((bucket) => (
                    <button
                      key={bucket}
                      type="button"
                      className={`df-workoutFilterChip${
                        selectedDurationFilters.includes(bucket) ? ' df-workoutFilterChipActive' : ''
                      }`}
                      onClick={() => toggleDurationFilter(bucket)}
                    >
                      {bucket.replace('_', '-')} min
                    </button>
                  ))
                ) : (
                  <button type="button" className="df-workoutFilterChip">No ranges yet</button>
                )}
              </div>
            </div>
            <div className="df-workoutLibraryGrid">
              {displayedLibrary.map((item) => (
                <article
                  key={item.id}
                  className="df-workoutLibraryCard df-workoutLibraryCardClickable"
                  onClick={() => setSelectedLibraryWorkout(item)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelectedLibraryWorkout(item);
                    }
                  }}
                  aria-label={`Open details for ${item.title}`}
                >
                  <div className="df-workoutLibraryCardTop">
                    <h3 className="df-workoutLibraryTitle">{item.title}</h3>
                    <button
                      type="button"
                      className={`df-workoutFavoriteBtn${
                        favoriteKeySet.has((item as FavoriteWorkoutItem).favorite_key) ||
                        favoriteSignatureSet.has(favoriteSignature(item))
                          ? ' df-workoutFavoriteBtnActive'
                          : ''
                      }`}
                      aria-label={`Toggle favorite for ${item.title}`}
                      title={
                        favoriteKeySet.has((item as FavoriteWorkoutItem).favorite_key) ||
                        favoriteSignatureSet.has(favoriteSignature(item))
                          ? 'Unfavorite'
                          : 'Favorite'
                      }
                      disabled={isTogglingFavorite}
                      onClick={(event) => {
                        event.stopPropagation();
                        void toggleFavorite(item);
                      }}
                    >
                      ❤
                    </button>
                    <button
                      type="button"
                      className="df-workoutLibraryAdd"
                      aria-label={`Add ${item.title} to weekly plan`}
                      title="Add to weekly plan"
                      disabled={isSavingWeeklyPlan}
                      onClick={(event) => {
                        event.stopPropagation();
                        openAddFromLibraryModal(item);
                      }}
                    >
                      +
                    </button>
                  </div>
                  <div className="df-workoutTypePill">{item.workout_type}</div>
                  <div className="df-workoutMeta">
                    {item.duration_minutes} min
                  </div>
                  <div className="df-workoutMeta">{item.intensity} · {item.location}</div>
                  <div className="df-workoutMeta">{item.summary_short}</div>
                </article>
              ))}
            </div>
            {!isGeneratingPlan && displayedLibrary.length === 0 && (
              <div className="df-calendarLegend" style={{ color: '#6b7280', marginBottom: 0 }}>
                {isFavoritesMode
                  ? 'No favorite workouts match the current filters.'
                  : 'No workouts match the current filters.'}
              </div>
            )}
          </section>
        </div>

        {isGeneratingPlan && (
          <div className="df-workoutsLoadingOverlay" role="status" aria-live="polite" aria-label="Generating workout plan">
            <div className="df-workoutsLoadingShade" aria-hidden />
            <div className="df-workoutsLoadingCenter">
              <div className="df-workoutsLoadingCard">
                <div className="df-workoutsBasicSpinner" aria-hidden />
                <div className="df-workoutsLoadingText">Generating new workout plan...</div>
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

      {selectedLibraryWorkout && (
        <div
          className="df-modalBackdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelectedLibraryWorkout(null);
          }}
        >
          <div className="df-modalPanel" role="dialog" aria-modal="true" aria-label="Workout details">
            <div className="df-modalHeader">
              <div className="df-modalTitle">{selectedLibraryWorkout.title}</div>
              <button
                type="button"
                className="df-iconBtn"
                onClick={() => setSelectedLibraryWorkout(null)}
                aria-label="Close workout details"
              >
                ✕
              </button>
            </div>

            <div className="df-settingsContent" style={{ display: 'grid', gap: 12, maxHeight: '70vh', overflowY: 'auto' }}>
              <div className="df-workoutTypePill">{selectedLibraryWorkout.workout_type}</div>
              <div className="df-workoutMeta">
                {selectedLibraryWorkout.duration_minutes} min · {selectedLibraryWorkout.intensity} ·{' '}
                {selectedLibraryWorkout.location}
              </div>
              <div className="df-workoutMeta">{selectedLibraryWorkout.summary_short}</div>

              {selectedLibraryWorkout.workout_flow?.summary && (
                <div className="df-field">
                  <div className="df-fieldLabel" style={{ textAlign: 'start' }}>Overview</div>
                  <div>{selectedLibraryWorkout.workout_flow.summary}</div>
                </div>
              )}

              {Array.isArray(selectedLibraryWorkout.workout_flow?.warmup_steps) &&
                selectedLibraryWorkout.workout_flow?.warmup_steps.length > 0 && (
                  <div className="df-field">
                    <div className="df-fieldLabel" style={{ textAlign: 'start' }}>Warmup</div>
                    <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                      {selectedLibraryWorkout.workout_flow.warmup_steps.map((step, idx) => (
                        <li key={`warmup-${idx}`}>{step}</li>
                      ))}
                    </ul>
                  </div>
                )}

              {Array.isArray(selectedLibraryWorkout.workout_flow?.main_steps) &&
                selectedLibraryWorkout.workout_flow?.main_steps.length > 0 && (
                  <div className="df-field">
                    <div className="df-fieldLabel" style={{ textAlign: 'start' }}>Main steps</div>
                    <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                      {selectedLibraryWorkout.workout_flow.main_steps.map((step, idx) => (
                        <li key={`main-${idx}`}>{step}</li>
                      ))}
                    </ul>
                  </div>
                )}

              {Array.isArray(selectedLibraryWorkout.workout_flow?.cooldown_steps) &&
                selectedLibraryWorkout.workout_flow?.cooldown_steps.length > 0 && (
                  <div className="df-field">
                    <div className="df-fieldLabel" style={{ textAlign: 'start' }}>Cooldown</div>
                    <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                      {selectedLibraryWorkout.workout_flow.cooldown_steps.map((step, idx) => (
                        <li key={`cooldown-${idx}`}>{step}</li>
                      ))}
                    </ul>
                  </div>
                )}

              {Array.isArray(selectedLibraryWorkout.workout_flow?.notes) &&
                selectedLibraryWorkout.workout_flow?.notes.length > 0 && (
                  <div className="df-field">
                    <div className="df-fieldLabel" style={{ textAlign: 'start' }}>Notes</div>
                    <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                      {selectedLibraryWorkout.workout_flow.notes.map((note, idx) => (
                        <li key={`note-${idx}`}>{note}</li>
                      ))}
                    </ul>
                  </div>
                )}
            </div>
          </div>
        </div>
      )}

      {addFromLibraryWorkout && (
        <div
          className="df-modalBackdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeAddFromLibraryModal();
          }}
        >
          <div className="df-modalPanel df-addWeeklyModal" role="dialog" aria-modal="true" aria-label="Add workout to weekly plan">
            <div className="df-modalHeader">
              <div className="df-modalTitle">Add to Weekly Plan</div>
              <button
                type="button"
                className="df-iconBtn"
                onClick={closeAddFromLibraryModal}
                aria-label="Close add workout dialog"
              >
                ✕
              </button>
            </div>
            <div className="df-settingsContent" style={{ display: 'grid', gap: 12 }}>
              <div className="df-workoutMeta">
                {addFromLibraryWorkout.title} · {addFromLibraryWorkout.duration_minutes} min
              </div>
              <label className="df-field">
                <div className="df-fieldLabel" style={{ textAlign: 'start' }}>Day</div>
                <select
                  className="df-select"
                  value={addFromLibraryDay}
                  onChange={(event) => {
                    setAddFromLibraryDay(event.target.value);
                    setAddFromLibraryError('');
                  }}
                >
                  {weekCards.map((card) => (
                    <option key={card.dateIso} value={card.dateIso}>
                      {card.dayLabel} ({card.dateIso})
                    </option>
                  ))}
                </select>
              </label>
              <label className="df-field">
                <div className="df-fieldLabel" style={{ textAlign: 'start' }}>Start time</div>
                <input
                  className="df-input"
                  type="time"
                  value={addFromLibraryStartTime}
                  onChange={(event) => {
                    setAddFromLibraryStartTime(event.target.value);
                    setAddFromLibraryError('');
                  }}
                />
              </label>
              {addFromLibraryError && (
                <div className="df-errorText" style={{ marginTop: -2 }}>{addFromLibraryError}</div>
              )}
              <div className="df-weeklyPlanActions">
                <button
                  type="button"
                  className="df-weeklyPlanActionBtn"
                  disabled={!addFromLibraryDay || !addFromLibraryStartTime || isSavingWeeklyPlan}
                  onClick={() => void handleAddFromLibrarySave()}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="df-weeklyPlanActionBtn"
                  disabled={isSavingWeeklyPlan}
                  onClick={closeAddFromLibraryModal}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {dayPlanModal && (
        <div
          className="df-modalBackdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDayPlanModal(null);
          }}
        >
          <div className="df-modalPanel" role="dialog" aria-modal="true" aria-label="Day workouts">
            <div className="df-modalHeader">
              <div className="df-modalTitle">{dayPlanModal.dayLabel} workouts</div>
              <button
                type="button"
                className="df-iconBtn"
                onClick={() => setDayPlanModal(null)}
                aria-label="Close day workouts dialog"
              >
                ✕
              </button>
            </div>
            <div className="df-settingsContent" style={{ display: 'grid', gap: 10, maxHeight: '70vh', overflowY: 'auto' }}>
              {dayPlanModalSuggestions.map((planItem) => {
                const planWorkout = libraryById.get(planItem.library_workout_id);
                const itemCalendarStatus = planCalendarStatusById[planItem.id];
                const isItemAddLoading = itemCalendarStatus?.state === 'loading';
                const isItemAdded =
                  Boolean(planItem.google_event_id) || itemCalendarStatus?.state === 'success';
                return (
                  <article key={planItem.id} className="df-workoutLibraryCard">
                    <div className="df-workoutLibraryCardTop">
                      <h3 className="df-workoutLibraryTitle">{planWorkout?.title || 'Workout'}</h3>
                      <div className="df-weeklyPlanControls">
                        <button
                          type="button"
                          className="df-weeklyPlanControlBtn df-weeklyPlanControlAdd"
                          title="Add to calendar"
                          aria-label="Add to calendar"
                          disabled={isItemAddLoading || isItemAdded}
                          onClick={() => void handleAddToCalendar(planItem.id)}
                        >
                          {isItemAddLoading ? '…' : isItemAdded ? '✓' : '+'}
                        </button>
                        <button
                          type="button"
                          className="df-weeklyPlanControlBtn df-weeklyPlanControlRemove"
                          disabled={isSavingWeeklyPlan}
                          onClick={() => void handleRemoveWeeklyWorkout(planItem.id)}
                          aria-label={`Remove ${planWorkout?.title || 'workout'} from weekly plan`}
                          title="Remove"
                        >
                          🗑
                        </button>
                      </div>
                    </div>
                    <div className="df-workoutTypePill">{planWorkout?.workout_type || 'Workout'}</div>
                    <div className="df-workoutMeta">
                      {(planWorkout ? `${planWorkout.duration_minutes} min` : 'Duration')} ·{' '}
                      {planWorkout?.intensity || planItem.recommended_time_label}
                    </div>
                    <div className="df-workoutMeta">
                      {planItem.recommended_start_time}-{planItem.recommended_end_time}
                    </div>
                    {itemCalendarStatus?.state === 'error' && (
                      <div className="df-errorText">{itemCalendarStatus.message || 'Could not add to calendar.'}</div>
                    )}
                  </article>
                );
              })}
              {dayPlanModalSuggestions.length === 0 && (
                <div className="df-calendarLegend" style={{ color: '#6b7280' }}>
                  No workouts for this day.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
