import React from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import ProfileSettingsModal from '../Home/ProfileSettingsModal';
import AppSidebar, { useSidebarCollapsed } from '../Sidebar/AppSidebar';
import { buildApiUrl, getApiBaseUrl } from '../../services/api';
import {
  GOOGLE_RECONNECT_MESSAGE_NEW,
  googleCalendarReconnectDisplayMessage,
  isGoogleCalendarReconnectOrMissing,
} from '../../services/googleCalendarConnection';
import { pastelTagStyle } from '../shared/pastelTags';
import StressBreaksQuestionnaireWizard from './StressBreaksQuestionnaireWizard';
import StressBreaksPreferencesModal from './StressBreaksPreferencesModal';
import ActivityLibrarySection from './ActivityLibrarySection';
import WeeklyBreakPlanSection, {
  AddToWeeklyPlanModal,
  type PlanCalendarStatus,
  type WeeklyBreakPlanItem,
} from './WeeklyBreakPlanSection';
import PotentiallyStressfulPeriodsSection, {
  normalizeStressfulPeriodsPayload,
  type StressfulPeriodsPayload,
} from './PotentiallyStressfulPeriodsSection';
import {
  EMPTY_STRESS_BREAKS_FORM,
  stressBreaksPreferencesFromApi,
  type StressBreaksPreferences,
} from './stressBreaksPreferences';
import {
  activityFavoriteKey,
  activityMatchSignature,
  categoryDisplayLabel,
  normalizeActivityList,
  type StressActivitiesResponse,
  type StressActivity,
} from './activityCategories';

type StressBreaksScreenProps = {
  username?: string;
  onLogout?: () => Promise<void>;
};

type PreferencesLoadState = 'loading' | 'ready' | 'error';
type GoogleCalendarStatus = 'checking' | 'connected' | 'not_connected' | 'reconnect_required' | 'error';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function toIsoDateLocal(value: Date): string {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

function startOfWeek(value: Date): Date {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() - next.getDay());
  return next;
}

function buildWeekCards(weekStart: Date): { dayLabel: string; dateIso: string }[] {
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const cards: { dayLabel: string; dateIso: string }[] = [];
  for (let i = 0; i < 7; i += 1) {
    const day = new Date(weekStart);
    day.setDate(weekStart.getDate() + i);
    cards.push({ dayLabel: labels[i], dateIso: toIsoDateLocal(day) });
  }
  return cards;
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

function formatAddPopupDayLabel(date: Date): string {
  return `${ENGLISH_DAY_NAMES[date.getDay()]} ${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}`;
}

function buildAddPopupDayOptions(now: Date): { value: string; label: string }[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const daysUntilSaturday = 6 - today.getDay();
  const options: { value: string; label: string }[] = [];
  for (let i = 0; i <= daysUntilSaturday; i += 1) {
    const day = new Date(today);
    day.setDate(today.getDate() + i);
    options.push({ value: toIsoDateLocal(day), label: formatAddPopupDayLabel(day) });
  }
  return options;
}

function isValidHHmm(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function sanitizeHHmmTyping(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

function normalizeWeeklyBreakPlan(raw: unknown): WeeklyBreakPlanItem[] {
  if (!Array.isArray(raw)) return [];
  const out: WeeklyBreakPlanItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const o = entry as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    const libraryId = typeof o.library_activity_id === 'string' ? o.library_activity_id.trim() : '';
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const category = typeof o.category === 'string' ? o.category.trim() : '';
    const day = typeof o.recommended_day === 'string' ? o.recommended_day.trim() : '';
    const start = typeof o.recommended_start_time === 'string' ? o.recommended_start_time.trim() : '';
    const end = typeof o.recommended_end_time === 'string' ? o.recommended_end_time.trim() : '';
    const duration =
      typeof o.duration_minutes === 'number' && Number.isFinite(o.duration_minutes)
        ? Math.max(1, Math.ceil(o.duration_minutes))
        : 0;
    if (!id || !libraryId || !title || !category || !day || !start || !end || duration <= 0) continue;
    const kindRaw = typeof o.kind === 'string' ? o.kind.trim().toLowerCase() : '';
    const kind: 'timed' | 'flexible' =
      kindRaw === 'flexible' || libraryId.startsWith('flex_') ? 'flexible' : 'timed';
    const googleEventId =
      typeof o.google_event_id === 'string' && o.google_event_id.trim() ? o.google_event_id.trim() : undefined;
    const dailyflowCalendarId =
      typeof o.dailyflow_calendar_id === 'string' && o.dailyflow_calendar_id.trim()
        ? o.dailyflow_calendar_id.trim()
        : undefined;
    out.push({
      id,
      library_activity_id: libraryId,
      kind,
      title,
      category,
      category_label: typeof o.category_label === 'string' ? o.category_label : undefined,
      duration_minutes: duration,
      recommended_day: day,
      recommended_start_time: start,
      recommended_end_time: end,
      summary_short: typeof o.summary_short === 'string' ? o.summary_short : undefined,
      google_event_id: googleEventId,
      dailyflow_calendar_id: dailyflowCalendarId,
    });
  }
  return out;
}

export default function StressBreaksScreen(props: StressBreaksScreenProps) {
  const { username, onLogout } = props;
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useSidebarCollapsed();
  const [isLoggingOut, setIsLoggingOut] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState('');
  const [isProfileSettingsOpen, setIsProfileSettingsOpen] = React.useState(false);
  const [displayName, setDisplayName] = React.useState('');
  const [profileImageUrl, setProfileImageUrl] = React.useState('');
  const [savedQuestionnaire, setSavedQuestionnaire] = React.useState<Record<string, unknown> | null>(null);

  const [preferencesLoadState, setPreferencesLoadState] = React.useState<PreferencesLoadState>('loading');
  const [preferencesLoadError, setPreferencesLoadError] = React.useState('');
  const [stressBreaks, setStressBreaks] = React.useState<StressBreaksPreferences | null>(null);
  const [isPreferencesModalOpen, setIsPreferencesModalOpen] = React.useState(false);

  const [timedActivities, setTimedActivities] = React.useState<StressActivity[]>([]);
  const [flexibleActivities, setFlexibleActivities] = React.useState<StressActivity[]>([]);
  const [favoriteActivities, setFavoriteActivities] = React.useState<StressActivity[]>([]);
  const [weeklyBreakPlan, setWeeklyBreakPlan] = React.useState<WeeklyBreakPlanItem[]>([]);
  const [hasLibrary, setHasLibrary] = React.useState(false);
  const [isLoadingLibrary, setIsLoadingLibrary] = React.useState(false);
  const [libraryLoadError, setLibraryLoadError] = React.useState('');
  const [isGenerating, setIsGenerating] = React.useState(false);
  const isGeneratingRef = React.useRef(false);
  const [generateError, setGenerateError] = React.useState('');
  const [favoriteError, setFavoriteError] = React.useState('');
  const [isTogglingFavorite, setIsTogglingFavorite] = React.useState(false);
  const [selectedActivity, setSelectedActivity] = React.useState<StressActivity | null>(null);
  const [weekStartDate] = React.useState<Date>(() => startOfWeek(new Date()));
  const [isSavingWeeklyPlan, setIsSavingWeeklyPlan] = React.useState(false);
  const [weeklyPlanError, setWeeklyPlanError] = React.useState('');
  const [addFromLibraryActivity, setAddFromLibraryActivity] = React.useState<StressActivity | null>(null);
  const [addFromLibraryDay, setAddFromLibraryDay] = React.useState('');
  const [addFromLibraryStartTime, setAddFromLibraryStartTime] = React.useState('18:00');
  const [addFromLibraryDuration, setAddFromLibraryDuration] = React.useState<number | null>(10);
  const [addFromLibraryError, setAddFromLibraryError] = React.useState('');
  const [googleCalendarStatus, setGoogleCalendarStatus] = React.useState<GoogleCalendarStatus>('checking');
  const [googleCalendarStatusMessage, setGoogleCalendarStatusMessage] = React.useState('');
  const [isConnectingGoogleCalendar, setIsConnectingGoogleCalendar] = React.useState(false);
  const [isAddingAllToCalendar, setIsAddingAllToCalendar] = React.useState(false);
  const [planCalendarStatusById, setPlanCalendarStatusById] = React.useState<Record<string, PlanCalendarStatus>>(
    {}
  );
  const [stressfulPeriods, setStressfulPeriods] = React.useState<StressfulPeriodsPayload | null>(null);
  const [isLoadingInsights, setIsLoadingInsights] = React.useState(false);
  const [isRefreshingInsights, setIsRefreshingInsights] = React.useState(false);
  const [insightsError, setInsightsError] = React.useState('');

  const effectiveName = displayName.trim() || username || 'User';
  const questionnaireCompleted = stressBreaks?.questionnaire_completed === true;
  const showQuestionnaire =
    preferencesLoadState === 'ready' && !questionnaireCompleted;

  const weekCards = React.useMemo(() => buildWeekCards(weekStartDate), [weekStartDate]);
  const weekStartIso = weekCards[0]?.dateIso || toIsoDateLocal(weekStartDate);
  const weekEndIso = weekCards[6]?.dateIso || weekStartIso;
  const addFromLibraryDayOptions = React.useMemo(
    () => (addFromLibraryActivity ? buildAddPopupDayOptions(new Date()) : []),
    [addFromLibraryActivity]
  );

  const favoriteKeySet = React.useMemo(() => {
    const keys = new Set<string>();
    for (const item of favoriteActivities) {
      const key = activityFavoriteKey(item);
      if (key) keys.add(key);
    }
    return keys;
  }, [favoriteActivities]);

  const favoriteSignatureSet = React.useMemo(() => {
    const keys = new Set<string>();
    for (const item of favoriteActivities) {
      keys.add(activityMatchSignature(item));
    }
    return keys;
  }, [favoriteActivities]);

  const libraryById = React.useMemo(() => {
    const map = new Map<string, StressActivity>();
    for (const item of [...timedActivities, ...flexibleActivities]) {
      map.set(item.id, item);
    }
    return map;
  }, [timedActivities, flexibleActivities]);

  function applyLibraryPayload(payload: StressActivitiesResponse) {
    const timed = normalizeActivityList(payload.timed_activities);
    const flexible = normalizeActivityList(payload.flexible_activities);
    const favorites = normalizeActivityList(payload.favorite_activities);
    const plan = normalizeWeeklyBreakPlan(payload.weekly_break_plan);
    setTimedActivities(timed);
    setFlexibleActivities(flexible);
    setFavoriteActivities(favorites);
    setWeeklyBreakPlan(plan);
    setHasLibrary(payload.has_library === true || timed.length > 0 || flexible.length > 0);
    const insights = normalizeStressfulPeriodsPayload(payload.stressful_periods);
    if (insights) {
      setStressfulPeriods(insights);
      setInsightsError('');
    }
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
    stressBreaks: StressBreaksPreferences | null;
  }> {
    const token = await getAuthToken();
    const response = await fetch(buildApiUrl('/profile'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    let payload: {
      display_name?: string;
      profile_image_url?: string;
      questionnaire?: Record<string, unknown>;
      stress_breaks?: Record<string, unknown>;
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
    const sb = stressBreaksPreferencesFromApi(payload.stress_breaks ?? null);
    setStressBreaks(sb);
    return { displayName: name, profileImageUrl: imageUrl, questionnaire: q, stressBreaks: sb };
  }

  async function saveProfileDisplayName(nextName: string): Promise<void> {
    const token = await getAuthToken();
    const response = await fetch(buildApiUrl('/profile'), {
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
    const token = await getAuthToken();
    const response = await fetch(buildApiUrl('/profile'), {
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
    const token = await getAuthToken();
    const response = await fetch(buildApiUrl('/profile/image/upload-url'), {
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
    const token = await getAuthToken();
    const response = await fetch(buildApiUrl('/profile'), {
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

  async function saveStressBreaksPreferences(payload: Record<string, unknown>): Promise<StressBreaksPreferences> {
    const token = await getAuthToken();
    const response = await fetch(buildApiUrl('/profile'), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    let responseBody: { stress_breaks?: Record<string, unknown>; message?: string } = {};
    try {
      responseBody = (await response.json()) as typeof responseBody;
    } catch {
      responseBody = {};
    }
    if (!response.ok) {
      const message =
        typeof responseBody.message === 'string' && responseBody.message.trim()
          ? responseBody.message
          : `Could not save Stress & Breaks preferences (${response.status}).`;
      throw new Error(message);
    }

    const returned = stressBreaksPreferencesFromApi(responseBody.stress_breaks ?? null);
    const requestSb =
      payload.stress_breaks && typeof payload.stress_breaks === 'object' && !Array.isArray(payload.stress_breaks)
        ? (payload.stress_breaks as Record<string, unknown>)
        : {};

    const next: StressBreaksPreferences = {
      questionnaire_completed:
        requestSb.questionnaire_completed === true ||
        returned?.questionnaire_completed === true ||
        stressBreaks?.questionnaire_completed === true,
      busiest_times: Array.isArray(returned?.busiest_times)
        ? returned.busiest_times
        : Array.isArray(requestSb.busiest_times)
          ? (requestSb.busiest_times as string[])
          : stressBreaks?.busiest_times || [],
      busiest_days: Array.isArray(returned?.busiest_days)
        ? returned.busiest_days
        : Array.isArray(requestSb.busiest_days)
          ? (requestSb.busiest_days as string[])
          : stressBreaks?.busiest_days || [],
      busy_day_factors: Array.isArray(returned?.busy_day_factors)
        ? returned.busy_day_factors
        : Array.isArray(requestSb.busy_day_factors)
          ? (requestSb.busy_day_factors as string[])
          : stressBreaks?.busy_day_factors || [],
      preferred_activities: Array.isArray(returned?.preferred_activities)
        ? returned.preferred_activities
        : Array.isArray(requestSb.preferred_activities)
          ? (requestSb.preferred_activities as string[])
          : stressBreaks?.preferred_activities || [],
      durations: Array.isArray(returned?.durations)
        ? returned.durations
        : Array.isArray(requestSb.durations)
          ? (requestSb.durations as string[])
          : stressBreaks?.durations || [],
    };

    setStressBreaks(next);
    return next;
  }

  async function loadActivityLibrary(options?: { insightsOnlyRefresh?: boolean }): Promise<void> {
    const insightsOnlyRefresh = options?.insightsOnlyRefresh === true;
    if (insightsOnlyRefresh) {
      setIsRefreshingInsights(true);
      setInsightsError('');
    } else {
      setIsLoadingInsights(true);
      setInsightsError('');
    }
    try {
      const token = await getAuthToken();
      const response = await fetch(
        buildApiUrl(
          `/stress/activities?start_date=${encodeURIComponent(weekStartIso)}&end_date=${encodeURIComponent(weekEndIso)}`
        ),
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      let payload: StressActivitiesResponse = {};
      try {
        payload = (await response.json()) as StressActivitiesResponse;
      } catch {
        payload = {};
      }
      if (!response.ok) {
        const message =
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : `Could not load activity library (${response.status}).`;
        throw new Error(message);
      }
      if (insightsOnlyRefresh) {
        const insights = normalizeStressfulPeriodsPayload(payload.stressful_periods);
        if (!insights) {
          throw new Error('Insights response was incomplete.');
        }
        setStressfulPeriods(insights);
        setInsightsError('');
      } else {
        applyLibraryPayload(payload);
      }
    } finally {
      if (insightsOnlyRefresh) {
        setIsRefreshingInsights(false);
      } else {
        setIsLoadingInsights(false);
      }
    }
  }

  async function refreshInsights(): Promise<void> {
    try {
      await loadActivityLibrary({ insightsOnlyRefresh: true });
    } catch (e) {
      const anyErr = e as { message?: string };
      setInsightsError(
        typeof anyErr?.message === 'string' && anyErr.message.trim()
          ? anyErr.message
          : 'Could not refresh insights.'
      );
    }
  }

  async function generateActivities(): Promise<void> {
    if (isGeneratingRef.current) return;
    isGeneratingRef.current = true;
    setIsGenerating(true);
    setGenerateError('');
    setFavoriteError('');
    try {
      const token = await getAuthToken();
      const response = await fetch(buildApiUrl('/stress/activities/generate'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      let payload: StressActivitiesResponse = {};
      try {
        payload = (await response.json()) as StressActivitiesResponse;
      } catch {
        payload = {};
      }
      if (!response.ok) {
        const message =
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : `Could not generate activities (${response.status}).`;
        throw new Error(message);
      }
      applyLibraryPayload(payload);
    } catch (e) {
      const anyErr = e as { message?: string };
      setGenerateError(
        typeof anyErr?.message === 'string' && anyErr.message.trim()
          ? anyErr.message
          : 'Could not generate activities.'
      );
    } finally {
      isGeneratingRef.current = false;
      setIsGenerating(false);
    }
  }

  async function toggleFavorite(activity: StressActivity): Promise<void> {
    setIsTogglingFavorite(true);
    setFavoriteError('');
    try {
      const token = await getAuthToken();
      const response = await fetch(buildApiUrl('/stress/activities'), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: 'toggle_favorite',
          activity,
        }),
      });
      let payload: { favorite_activities?: unknown; message?: string } = {};
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        payload = {};
      }
      if (!response.ok) {
        const message =
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : `Could not update favorite (${response.status}).`;
        throw new Error(message);
      }
      setFavoriteActivities(normalizeActivityList(payload.favorite_activities));
    } catch (e) {
      const anyErr = e as { message?: string };
      setFavoriteError(
        typeof anyErr?.message === 'string' && anyErr.message.trim()
          ? anyErr.message
          : 'Could not update favorite.'
      );
    } finally {
      setIsTogglingFavorite(false);
    }
  }

  async function mutateWeeklyPlan(
    payload: Record<string, unknown>,
    options?: { onError?: (message: string) => void; suppressGlobalError?: boolean }
  ): Promise<WeeklyBreakPlanItem[] | null> {
    try {
      setWeeklyPlanError('');
      setIsSavingWeeklyPlan(true);
      const token = await getAuthToken();
      const response = await fetch(buildApiUrl('/stress/activities'), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      let responsePayload: {
        weekly_break_plan?: unknown;
        message?: string;
        reconnect_required?: boolean;
      } = {};
      try {
        responsePayload = (await response.json()) as typeof responsePayload;
      } catch {
        responsePayload = {};
      }
      if (!response.ok) {
        if (isGoogleCalendarReconnectOrMissing(responsePayload, response.status)) {
          setGoogleCalendarStatus('reconnect_required');
          setGoogleCalendarStatusMessage(googleCalendarReconnectDisplayMessage(responsePayload));
        }
        throw new Error(
          typeof responsePayload.message === 'string' && responsePayload.message.trim()
            ? responsePayload.message
            : `Could not update weekly break plan (${response.status}).`
        );
      }
      const savedPlan = normalizeWeeklyBreakPlan(responsePayload.weekly_break_plan);
      setWeeklyBreakPlan(savedPlan);
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
        typeof anyErr?.message === 'string' ? anyErr.message : 'Failed to save weekly break plan.';
      if (options?.onError) options.onError(message);
      if (!options?.suppressGlobalError) setWeeklyPlanError(message);
      return null;
    } finally {
      setIsSavingWeeklyPlan(false);
    }
  }

  function handleConnectGoogleCalendarClick() {
    setIsConnectingGoogleCalendar(true);
    void (async () => {
      try {
        const baseUrl = getApiBaseUrl();
        const session = await fetchAuthSession();
        const accessToken = session.tokens?.accessToken?.toString();
        if (!accessToken) {
          setWeeklyPlanError('You need to be signed in to connect Google Calendar.');
          setIsConnectingGoogleCalendar(false);
          return;
        }
        const startUrl = `${baseUrl}/auth/google/start?access_token=${encodeURIComponent(accessToken)}&return_to=${encodeURIComponent('/stress')}`;
        window.location.assign(startUrl);
      } catch (e) {
        const anyErr = e as { message?: string };
        setWeeklyPlanError(
          typeof anyErr?.message === 'string'
            ? anyErr.message
            : 'Failed to start Google Calendar connection.'
        );
        setIsConnectingGoogleCalendar(false);
      }
    })();
  }

  const refreshGoogleCalendarConnectionState = React.useCallback(async () => {
    try {
      setGoogleCalendarStatus('checking');
      setGoogleCalendarStatusMessage('');
      const token = await getAuthToken();
      const response = await fetch(buildApiUrl('/auth/google/calendars'), {
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
      if (!response.ok && isGoogleCalendarReconnectOrMissing(payload, response.status)) {
        setGoogleCalendarStatus('reconnect_required');
        setGoogleCalendarStatusMessage(googleCalendarReconnectDisplayMessage(payload));
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
        [planId]: { state: 'success' },
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
    const eligibleItems = weeklyBreakPlan.filter((item) => {
      const itemStatus = planCalendarStatusById[item.id];
      const alreadyAdded =
        Boolean(item.google_event_id && item.google_event_id.trim()) || itemStatus?.state === 'success';
      return !alreadyAdded;
    });
    if (eligibleItems.length === 0) return;
    setWeeklyPlanError('');
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
      setWeeklyPlanError(`Added ${successCount} activities. Failed to add ${failCount}.`);
    } else {
      setWeeklyPlanError('');
    }
    setIsAddingAllToCalendar(false);
  }

  function openAddFromLibraryModal(activity: StressActivity) {
    const options = buildAddPopupDayOptions(new Date());
    setAddFromLibraryActivity(activity);
    setAddFromLibraryDay(options[0]?.value || '');
    setAddFromLibraryStartTime('18:00');
    setAddFromLibraryDuration(activity.kind === 'flexible' ? 10 : null);
    setAddFromLibraryError('');
  }

  function closeAddFromLibraryModal() {
    if (isSavingWeeklyPlan) return;
    setAddFromLibraryActivity(null);
    setAddFromLibraryError('');
  }

  async function handleAddFromLibrarySave() {
    if (!addFromLibraryActivity || !addFromLibraryDay || !addFromLibraryStartTime) return;
    if (!isValidHHmm(addFromLibraryStartTime)) {
      setAddFromLibraryError('Please enter start time as HH:mm (00:00 to 23:59).');
      return;
    }
    if (addFromLibraryActivity.kind === 'flexible') {
      if (addFromLibraryDuration == null || ![5, 10, 15, 20, 30].includes(addFromLibraryDuration)) {
        setAddFromLibraryError('Please choose a duration.');
        return;
      }
    }
    setAddFromLibraryError('');
    const body: Record<string, unknown> = {
      action: 'add_library_activity',
      week_start: weekStartIso,
      week_end: weekEndIso,
      library_activity_id: addFromLibraryActivity.id,
      recommended_day: addFromLibraryDay,
      recommended_start_time: addFromLibraryStartTime,
    };
    if (addFromLibraryActivity.kind === 'flexible') {
      body.duration_minutes = addFromLibraryDuration;
    }
    const saved = await mutateWeeklyPlan(body, {
      onError: setAddFromLibraryError,
      suppressGlobalError: true,
    });
    if (saved) closeAddFromLibraryModal();
  }

  async function handleRemoveWeeklyPlanItem(planId: string) {
    await mutateWeeklyPlan({
      action: 'remove_plan_item',
      week_start: weekStartIso,
      week_end: weekEndIso,
      plan_id: planId,
    });
  }

  function openActivityFromPlan(libraryActivityId: string) {
    const found = libraryById.get(libraryActivityId);
    if (found) {
      setSelectedActivity(found);
      return;
    }
    const fromPlan = weeklyBreakPlan.find((item) => item.library_activity_id === libraryActivityId);
    if (!fromPlan) return;
    setSelectedActivity({
      id: fromPlan.library_activity_id,
      kind: fromPlan.kind,
      title: fromPlan.title,
      category: fromPlan.category,
      category_label: fromPlan.category_label,
      duration_minutes: fromPlan.kind === 'flexible' ? null : fromPlan.duration_minutes,
      summary_short: fromPlan.summary_short || `${fromPlan.title} break.`,
      instructions: [],
    });
  }

  React.useEffect(() => {
    let cancelled = false;
    setPreferencesLoadState('loading');
    setPreferencesLoadError('');
    void (async () => {
      try {
        const loaded = await loadProfile();
        if (cancelled) return;
        setPreferencesLoadState('ready');
        if (loaded.stressBreaks?.questionnaire_completed === true) {
          setIsLoadingLibrary(true);
          setLibraryLoadError('');
          try {
            await loadActivityLibrary();
          } catch (e) {
            const anyErr = e as { message?: string };
            if (!cancelled) {
              setLibraryLoadError(
                typeof anyErr?.message === 'string' && anyErr.message.trim()
                  ? anyErr.message
                  : 'Could not load activity library.'
              );
            }
          } finally {
            if (!cancelled) setIsLoadingLibrary(false);
          }
        }
      } catch (e) {
        const anyErr = e as { message?: string };
        const message =
          typeof anyErr?.message === 'string' && anyErr.message.trim()
            ? anyErr.message
            : 'Could not load Stress & Breaks preferences.';
        if (!cancelled) {
          setPreferencesLoadError(message);
          setPreferencesLoadState('error');
          setStressBreaks(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Initial load only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    void refreshGoogleCalendarConnectionState();
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

  async function handleLogoutClick() {
    setErrorMessage('');
    setIsLoggingOut(true);
    try {
      if (onLogout) await onLogout();
    } catch (e) {
      const anyErr = e as { message?: string };
      setErrorMessage(
        typeof anyErr?.message === 'string' ? anyErr.message : 'Failed to sign out. Please try again.'
      );
    } finally {
      setIsLoggingOut(false);
    }
  }

  function handleRetryLoad() {
    setPreferencesLoadState('loading');
    setPreferencesLoadError('');
    void (async () => {
      try {
        const loaded = await loadProfile();
        setPreferencesLoadState('ready');
        if (loaded.stressBreaks?.questionnaire_completed === true) {
          setIsLoadingLibrary(true);
          setLibraryLoadError('');
          try {
            await loadActivityLibrary();
          } catch (e) {
            const anyErr = e as { message?: string };
            setLibraryLoadError(
              typeof anyErr?.message === 'string' && anyErr.message.trim()
                ? anyErr.message
                : 'Could not load activity library.'
            );
          } finally {
            setIsLoadingLibrary(false);
          }
        }
      } catch (e) {
        const anyErr = e as { message?: string };
        setPreferencesLoadError(
          typeof anyErr?.message === 'string' && anyErr.message.trim()
            ? anyErr.message
            : 'Could not load Stress & Breaks preferences.'
        );
        setPreferencesLoadState('error');
        setStressBreaks(null);
      }
    })();
  }

  function handleRetryLibraryLoad() {
    setIsLoadingLibrary(true);
    setLibraryLoadError('');
    void (async () => {
      try {
        await loadActivityLibrary();
      } catch (e) {
        const anyErr = e as { message?: string };
        setLibraryLoadError(
          typeof anyErr?.message === 'string' && anyErr.message.trim()
            ? anyErr.message
            : 'Could not load activity library.'
        );
      } finally {
        setIsLoadingLibrary(false);
      }
    })();
  }

  return (
    <section
      className={`df-calendarPage df-stressBreaksPage${isSidebarCollapsed ? ' df-calendarPageNavCollapsed' : ''}`}
      aria-label="DailyFlow Stress and Breaks screen"
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
            {questionnaireCompleted && (
              <>
                <button
                  type="button"
                  className="df-btn df-btnPrimary"
                  onClick={() => void generateActivities()}
                  disabled={isGenerating || isLoadingLibrary || preferencesLoadState !== 'ready'}
                >
                  {isGenerating ? 'Generating...' : 'Generate Activities'}
                </button>
                <button
                  type="button"
                  className="df-btn"
                  onClick={() => void handleAddAllToCalendar()}
                  disabled={
                    isAddingAllToCalendar ||
                    isSavingWeeklyPlan ||
                    isGenerating ||
                    weeklyBreakPlan.length === 0 ||
                    weeklyBreakPlan.every((item) => {
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
              </>
            )}
          </div>
          <div className="df-calendarTopbarRight">
            {questionnaireCompleted && (
              <button
                type="button"
                className="df-btn"
                onClick={() => setIsPreferencesModalOpen(true)}
                disabled={preferencesLoadState !== 'ready'}
              >
                Edit Preferences
              </button>
            )}
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
              {isLoggingOut ? 'Signing out…' : 'Log out'}
            </button>
          </div>
        </header>

        {errorMessage ? (
          <div className="df-errorText" style={{ padding: '8px 16px 0' }} role="alert">
            {errorMessage}
          </div>
        ) : null}
        {generateError ? (
          <div className="df-errorText" style={{ padding: '6px 16px 0' }} role="alert">
            {generateError}
          </div>
        ) : null}
        {weeklyPlanError && !addFromLibraryActivity ? (
          <div className="df-errorText" style={{ padding: '6px 16px 0' }} role="alert">
            {weeklyPlanError}
          </div>
        ) : null}
        {googleCalendarStatus === 'reconnect_required' && (
          <div className="df-calendarLegend" style={{ padding: '6px 16px 0', color: '#b45309' }} role="alert">
            {googleCalendarStatusMessage || GOOGLE_RECONNECT_MESSAGE_NEW}
          </div>
        )}
        {googleCalendarStatus === 'not_connected' && questionnaireCompleted && (
          <div className="df-calendarLegend" style={{ padding: '6px 16px 0', color: '#6b7280' }}>
            Connect Google Calendar to add breaks directly from Stress &amp; Breaks.
          </div>
        )}
        {googleCalendarStatus === 'error' && googleCalendarStatusMessage && (
          <div className="df-calendarLegend" style={{ padding: '6px 16px 0', color: '#b91c1c' }} role="alert">
            {googleCalendarStatusMessage}
          </div>
        )}

        <div className="df-workoutsContent">
          {preferencesLoadState === 'loading' && (
            <section className="df-workoutsSection">
              <p className="df-subtitle" style={{ margin: 0 }} role="status" aria-live="polite">
                Loading preferences…
              </p>
            </section>
          )}

          {preferencesLoadState === 'error' && (
            <section className="df-workoutsSection">
              <div className="df-errorText" role="alert">
                {preferencesLoadError || 'Could not load Stress & Breaks preferences.'}
              </div>
              <div style={{ marginTop: 12 }}>
                <button type="button" className="df-btn df-btnPrimary" onClick={handleRetryLoad}>
                  Retry
                </button>
              </div>
            </section>
          )}

          {preferencesLoadState === 'ready' && questionnaireCompleted && (
            <>
              <PotentiallyStressfulPeriodsSection
                insightsPayload={stressfulPeriods}
                isLoading={isLoadingInsights || isLoadingLibrary}
                isRefreshing={isRefreshingInsights}
                error={insightsError}
                onRefresh={() => void refreshInsights()}
              />
              <WeeklyBreakPlanSection
                weekCards={weekCards}
                planItems={weeklyBreakPlan}
                isSaving={isSavingWeeklyPlan || isAddingAllToCalendar}
                planError=""
                planCalendarStatusById={planCalendarStatusById}
                onAddToCalendar={(planId) => void handleAddToCalendar(planId)}
                onRemove={(planId) => void handleRemoveWeeklyPlanItem(planId)}
                onOpenActivity={openActivityFromPlan}
              />
              <ActivityLibrarySection
                timedActivities={timedActivities}
                flexibleActivities={flexibleActivities}
                favoriteKeySet={favoriteKeySet}
                favoriteSignatureSet={favoriteSignatureSet}
                hasLibrary={hasLibrary}
                isLoadingLibrary={isLoadingLibrary}
                libraryLoadError={libraryLoadError}
                favoriteError={favoriteError}
                isTogglingFavorite={isTogglingFavorite}
                isSavingWeeklyPlan={isSavingWeeklyPlan}
                onRetryLoad={handleRetryLibraryLoad}
                onToggleFavorite={(activity) => void toggleFavorite(activity)}
                onOpenDetail={setSelectedActivity}
                onAddToWeeklyPlan={openAddFromLibraryModal}
              />
            </>
          )}
        </div>

        {isGenerating && (
          <div
            className="df-workoutsLoadingOverlay"
            role="status"
            aria-live="polite"
            aria-label="Generating stress break activities"
          >
            <div className="df-workoutsLoadingShade" aria-hidden />
            <div className="df-workoutsLoadingCenter">
              <div className="df-workoutsLoadingCard">
                <div className="df-workoutsBasicSpinner" aria-hidden />
                <div className="df-workoutsLoadingText">Generating new activity library...</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {showQuestionnaire && (
        <StressBreaksQuestionnaireWizard
          onSave={saveStressBreaksPreferences}
          onCompleted={(saved) => {
            setStressBreaks(saved);
            setHasLibrary(false);
            setTimedActivities([]);
            setFlexibleActivities([]);
            setWeeklyBreakPlan([]);
            setLibraryLoadError('');
            setIsLoadingLibrary(true);
            void (async () => {
              try {
                await loadActivityLibrary();
              } catch (e) {
                const anyErr = e as { message?: string };
                setLibraryLoadError(
                  typeof anyErr?.message === 'string' && anyErr.message.trim()
                    ? anyErr.message
                    : 'Could not load activity library.'
                );
              } finally {
                setIsLoadingLibrary(false);
              }
            })();
          }}
        />
      )}

      <StressBreaksPreferencesModal
        isOpen={isPreferencesModalOpen}
        savedPreferences={
          stressBreaks || {
            questionnaire_completed: false,
            ...EMPTY_STRESS_BREAKS_FORM,
          }
        }
        onClose={() => setIsPreferencesModalOpen(false)}
        onSave={saveStressBreaksPreferences}
      />

      {addFromLibraryActivity && (
        <AddToWeeklyPlanModal
          activity={addFromLibraryActivity}
          dayOptions={addFromLibraryDayOptions}
          day={addFromLibraryDay}
          startTime={addFromLibraryStartTime}
          durationMinutes={addFromLibraryDuration}
          error={addFromLibraryError}
          isSaving={isSavingWeeklyPlan}
          onDayChange={(value) => {
            setAddFromLibraryDay(value);
            setAddFromLibraryError('');
          }}
          onStartTimeChange={(value) => {
            setAddFromLibraryStartTime(sanitizeHHmmTyping(value));
            setAddFromLibraryError('');
          }}
          onDurationChange={(value) => {
            setAddFromLibraryDuration(value);
            setAddFromLibraryError('');
          }}
          onSave={() => void handleAddFromLibrarySave()}
          onClose={closeAddFromLibraryModal}
        />
      )}
      {selectedActivity && (
        <div
          className="df-modalBackdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelectedActivity(null);
          }}
        >
          <div
            className="df-modalPanel"
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedActivity.title} details`}
          >
            <div className="df-modalHeader">
              <div className="df-modalTitle">{selectedActivity.title}</div>
              <button
                type="button"
                className="df-iconBtn"
                onClick={() => setSelectedActivity(null)}
                aria-label="Close activity details"
              >
                ✕
              </button>
            </div>
            <div className="df-settingsContent" style={{ display: 'grid', gap: 12, maxHeight: '70vh', overflowY: 'auto' }}>
              <div>
                <span
                  className="df-workoutTypePill"
                  style={pastelTagStyle(
                    categoryDisplayLabel(selectedActivity.category, selectedActivity.category_label)
                  )}
                >
                  {categoryDisplayLabel(selectedActivity.category, selectedActivity.category_label)}
                </span>
              </div>
              <div className="df-workoutMeta">
                {selectedActivity.kind === 'flexible' || selectedActivity.duration_minutes == null
                  ? 'Flexible'
                  : `${selectedActivity.duration_minutes} min`}
              </div>
              <p className="df-subtitle" style={{ margin: 0 }}>
                {selectedActivity.summary_short}
              </p>
              {selectedActivity.kind === 'timed' && selectedActivity.youtube_url ? (
                <div>
                  <a
                    className="df-btn"
                    href={selectedActivity.youtube_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={
                      selectedActivity.youtube_title
                        ? `Watch video: ${selectedActivity.youtube_title}`
                        : 'Watch guidance video on YouTube'
                    }
                  >
                    Watch video
                  </a>
                  {selectedActivity.youtube_title ? (
                    <p className="df-subtitle" style={{ margin: '8px 0 0', fontSize: 13 }}>
                      {selectedActivity.youtube_title}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {selectedActivity.instructions && selectedActivity.instructions.length > 0 ? (
                <div>
                  <div className="df-fieldLabel" style={{ marginBottom: 8 }}>
                    Instructions
                  </div>
                  <ol style={{ margin: 0, paddingInlineStart: 18, display: 'grid', gap: 6 }}>
                    {selectedActivity.instructions.map((step, idx) => (
                      <li key={`${selectedActivity.id}-step-${idx}`}>{step}</li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      <ProfileSettingsModal
        isOpen={isProfileSettingsOpen}
        onClose={() => setIsProfileSettingsOpen(false)}
        initialName={effectiveName}
        savedProfileImageUrl={profileImageUrl}
        savedQuestionnaire={savedQuestionnaire}
        onLoadProfile={async () => {
          const loaded = await loadProfile();
          return {
            displayName: loaded.displayName,
            profileImageUrl: loaded.profileImageUrl,
            questionnaire: loaded.questionnaire,
          };
        }}
        onSaveDisplayName={saveProfileDisplayName}
        onSaveQuestionnaire={saveQuestionnairePreferences}
        onRequestProfileImageUploadUrl={requestProfileImageUploadUrl}
        onSaveProfileImageKey={saveProfileImageKey}
      />
    </section>
  );
}
