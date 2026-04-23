import React from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useLocation, useNavigate } from 'react-router-dom';
import ProfileSettingsModal from './ProfileSettingsModal';

type HomeScreenProps = {
  username?: string;
  onLogout?: () => Promise<void>;
};

/** Backend GET /auth/google/calendars: 200 connected, 404 not connected, 403 expired Google token. */
const GOOGLE_RECONNECT_MESSAGE = 'Google connection expired, reconnect required';

type CalendarSidebarState =
  | 'checking'
  | 'not_connected'
  | 'ready'
  | 'reconnect_required'
  | 'error';

type GoogleCalendarItem = {
  id: string;
  summary: string;
  primary: boolean;
  selected: boolean;
  backgroundColor?: string;
};

type BusyBlockItem = {
  block_key: string;
  date: string;
  start_time: string;
  end_time: string;
  source_calendar_id: string;
  source_calendar_color?: string;
  source_event_title?: string;
};

type BusyBlocksWindow = {
  startDate: string;
  endDate: string;
};

type CalendarViewMode = 'day' | 'week' | 'month';
const BUSY_BLOCKS_SYNC_FRESHNESS_MS = 60 * 60 * 1000;
let isAutoBusyBlocksSyncInFlight = false;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function toIsoDateLocal(value: Date): string {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

function formatDayHeader(value: Date): string {
  const weekday = value.toLocaleDateString(undefined, { weekday: 'short' });
  const day = value.getDate();
  return `${weekday} ${day}`;
}

function formatTimeRange(startTime: string, endTime: string): string {
  const start = startTime.slice(0, 5);
  const end = endTime.slice(0, 5);
  if (!start || !end) return `${startTime} - ${endTime}`;
  return `${start} - ${end}`;
}

function startOfWeek(value: Date): Date {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() - next.getDay());
  return next;
}

function buildWeekDates(weekStart: Date): Date[] {
  const days: Date[] = [];
  for (let i = 0; i < 7; i += 1) {
    const next = new Date(weekStart);
    next.setDate(weekStart.getDate() + i);
    days.push(next);
  }
  return days;
}

function shiftWeekDate(baseDate: Date, deltaWeeks: number): Date {
  const next = new Date(baseDate);
  next.setDate(next.getDate() + deltaWeeks * 7);
  return next;
}

function monthStart(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

function monthGridStart(value: Date): Date {
  const start = monthStart(value);
  return new Date(start.getFullYear(), start.getMonth(), 1 - start.getDay());
}

function isBusySyncFresh(lastBusySyncAt: string | undefined): boolean {
  if (typeof lastBusySyncAt !== 'string' || !lastBusySyncAt.trim()) return false;
  const syncTimeMs = Date.parse(lastBusySyncAt);
  if (!Number.isFinite(syncTimeMs)) return false;
  return Date.now() - syncTimeMs < BUSY_BLOCKS_SYNC_FRESHNESS_MS;
}

export default function HomeScreen(props: HomeScreenProps) {
  const { username, onLogout } = props;
  const navigate = useNavigate();
  const location = useLocation();
  const [errorMessage, setErrorMessage] = React.useState<string>('');
  const [isProfileSettingsOpen, setIsProfileSettingsOpen] = React.useState<boolean>(false);
  const [displayName, setDisplayName] = React.useState<string>('');
  const [profileImageUrl, setProfileImageUrl] = React.useState<string>('');
  const [savedQuestionnaire, setSavedQuestionnaire] = React.useState<Record<string, unknown> | null>(
    null
  );
  const [isLoggingOut, setIsLoggingOut] = React.useState<boolean>(false);
  const [isConnectingGoogleCalendar, setIsConnectingGoogleCalendar] = React.useState<boolean>(false);
  const [calendarSidebarState, setCalendarSidebarState] = React.useState<CalendarSidebarState>('checking');
  const [calendarsListError, setCalendarsListError] = React.useState<string>('');
  const [googleCalendars, setGoogleCalendars] = React.useState<GoogleCalendarItem[]>([]);
  const [selectedCalendarIds, setSelectedCalendarIds] = React.useState<string[]>([]);
  const [isEditingCalendars, setIsEditingCalendars] = React.useState<boolean>(false);
  const [isSavingCalendarSelection, setIsSavingCalendarSelection] = React.useState<boolean>(false);
  const [busyBlocks, setBusyBlocks] = React.useState<BusyBlockItem[]>([]);
  const [isSyncingBusyBlocks, setIsSyncingBusyBlocks] = React.useState<boolean>(false);
  const [busyBlocksError, setBusyBlocksError] = React.useState<string>('');
  const [busyBlocksWindow, setBusyBlocksWindow] = React.useState<BusyBlocksWindow | null>(null);
  const [viewMode, setViewMode] = React.useState<CalendarViewMode>('week');
  const [selectedDate, setSelectedDate] = React.useState<Date>(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now;
  });
  const [weekStartDate, setWeekStartDate] = React.useState<Date>(() => startOfWeek(new Date()));
  const [miniCalendarMonthDate, setMiniCalendarMonthDate] = React.useState<Date>(() =>
    monthStart(new Date())
  );

  async function handleLogoutClick() {
    setErrorMessage('');
    setIsLoggingOut(true);
    try {
      if (onLogout) await onLogout();
    } catch (e) {
      const anyErr = e as any;
      const message =
        anyErr && typeof anyErr.message === 'string'
          ? anyErr.message
          : 'Failed to sign out. Please try again.';
      setErrorMessage(message);
      // eslint-disable-next-line no-console
      console.error(e);
    } finally {
      setIsLoggingOut(false);
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

  function handleConnectGoogleCalendarClick() {
    setIsConnectingGoogleCalendar(true);
    setErrorMessage('');
    void (async () => {
      try {
        const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
        if (!baseUrl) {
          setErrorMessage('Missing API base URL configuration (VITE_API_BASE_URL).');
          setIsConnectingGoogleCalendar(false);
          return;
        }

        const session = await fetchAuthSession();
        const accessToken = session.tokens?.accessToken?.toString();
        if (!accessToken) {
          setErrorMessage('You need to be signed in to connect Google Calendar.');
          setIsConnectingGoogleCalendar(false);
          return;
        }

        // Full-page navigation only — never use fetch() here (fetch follows redirects and hits Google with CORS).
        // access_token is required so the API can resolve Cognito sub (browser navigation cannot send Authorization).
        // Do not use a GET <form action="...?access_token=...">: with no fields, browsers drop the action query and
        // navigate to /auth/google/start? only. Assign the full URL instead.
        const startUrl = `${baseUrl.replace(/\/$/, '')}/auth/google/start?access_token=${encodeURIComponent(accessToken)}`;
        window.location.assign(startUrl);
      } catch (e) {
        const anyErr = e as any;
        const message =
          anyErr && typeof anyErr.message === 'string'
            ? anyErr.message
            : 'Failed to start Google Calendar connection.';
        setErrorMessage(message);
        setIsConnectingGoogleCalendar(false);
      }
    })();
  }

  const refreshGoogleCalendarFromBackend = React.useCallback(async (enterEditMode: boolean = false) => {
    setCalendarSidebarState('checking');
    setCalendarsListError('');
    setGoogleCalendars([]);

    try {
      const session = await fetchAuthSession();
      const accessToken = session.tokens?.accessToken?.toString();
      const idToken = session.tokens?.idToken?.toString();
      const token = accessToken || idToken;
      if (!token) {
        setCalendarsListError('You need to be signed in to load calendars.');
        setCalendarSidebarState('error');
        return;
      }

      const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
      if (!baseUrl?.trim()) {
        setCalendarsListError('Missing API base URL (VITE_API_BASE_URL).');
        setCalendarSidebarState('error');
        return;
      }

      const endpointUrl = `${baseUrl.replace(/\/$/, '')}/auth/google/calendars`;
      const response = await fetch(endpointUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      let payload: {
        message?: string;
        calendars?: GoogleCalendarItem[];
        selection_configured?: boolean;
      } = {};
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        payload = {};
      }

      if (response.status === 404) {
        setGoogleCalendars([]);
        setSelectedCalendarIds([]);
        setCalendarsListError('');
        setCalendarSidebarState('not_connected');
        return;
      }

      if (
        response.status === 403 &&
        typeof payload.message === 'string' &&
        payload.message === GOOGLE_RECONNECT_MESSAGE
      ) {
        setGoogleCalendars([]);
        setSelectedCalendarIds([]);
        setCalendarsListError(GOOGLE_RECONNECT_MESSAGE);
        setCalendarSidebarState('reconnect_required');
        return;
      }

      if (!response.ok) {
        const message =
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : `Could not load calendars (${response.status}).`;
        setCalendarsListError(message);
        setCalendarSidebarState('error');
        return;
      }

      const calendars = Array.isArray(payload.calendars) ? payload.calendars : [];
      const selectionConfigured = payload.selection_configured === true;
      setGoogleCalendars(calendars);
      setSelectedCalendarIds(
        calendars
          .filter((calendar) => calendar.selected !== false)
          .map((calendar) => calendar.id)
          .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      );
      setIsEditingCalendars(enterEditMode || !selectionConfigured);
      setCalendarSidebarState('ready');
    } catch (e) {
      const anyErr = e as { message?: string };
      setCalendarsListError(
        typeof anyErr?.message === 'string' ? anyErr.message : 'Failed to load calendars.'
      );
      setCalendarSidebarState('error');
    }
  }, []);

  const syncAndRefreshBusyBlocks = React.useCallback(async () => {
    setIsSyncingBusyBlocks(true);
    setBusyBlocksError('');
    try {
      const session = await fetchAuthSession();
      const accessToken = session.tokens?.accessToken?.toString();
      const idToken = session.tokens?.idToken?.toString();
      const token = accessToken || idToken;
      if (!token) {
        setBusyBlocksError('You need to be signed in to load busy blocks.');
        return;
      }

      const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
      if (!baseUrl?.trim()) {
        setBusyBlocksError('Missing API base URL (VITE_API_BASE_URL).');
        return;
      }

      const apiBase = baseUrl.replace(/\/$/, '');
      const syncResponse = await fetch(`${apiBase}/calendar/busyblocks/sync`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      let syncPayload: { message?: string } = {};
      try {
        syncPayload = (await syncResponse.json()) as typeof syncPayload;
      } catch {
        syncPayload = {};
      }
      if (!syncResponse.ok) {
        const message =
          typeof syncPayload.message === 'string' && syncPayload.message.trim()
            ? syncPayload.message
            : `Could not sync busy blocks (${syncResponse.status}).`;
        setBusyBlocksError(message);
        return;
      }

      const response = await fetch(`${apiBase}/calendar/busyblocks`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      let payload: {
        message?: string;
        busy_blocks?: BusyBlockItem[];
        window_start_date?: string;
        window_end_date?: string;
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
            : `Could not load busy blocks (${response.status}).`;
        setBusyBlocksError(message);
        return;
      }

      const incoming = Array.isArray(payload.busy_blocks) ? payload.busy_blocks : [];
      const cleaned = incoming.filter(
        (block): block is BusyBlockItem =>
          !!block &&
          typeof block.block_key === 'string' &&
          typeof block.date === 'string' &&
          typeof block.start_time === 'string' &&
          typeof block.end_time === 'string' &&
          typeof block.source_calendar_id === 'string'
      );
      setBusyBlocks(cleaned);
      const startDate =
        typeof payload.window_start_date === 'string' ? payload.window_start_date.trim() : '';
      const endDate = typeof payload.window_end_date === 'string' ? payload.window_end_date.trim() : '';
      if (startDate && endDate) {
        setBusyBlocksWindow({ startDate, endDate });
      } else {
        setBusyBlocksWindow(null);
      }
    } catch (e) {
      const anyErr = e as { message?: string };
      setBusyBlocksError(
        typeof anyErr?.message === 'string' ? anyErr.message : 'Failed to sync busy blocks.'
      );
    } finally {
      setIsSyncingBusyBlocks(false);
    }
  }, []);

  const refreshBusyBlocksOnly = React.useCallback(async () => {
    setBusyBlocksError('');
    try {
      const session = await fetchAuthSession();
      const accessToken = session.tokens?.accessToken?.toString();
      const idToken = session.tokens?.idToken?.toString();
      const token = accessToken || idToken;
      if (!token) {
        setBusyBlocksError('You need to be signed in to load busy blocks.');
        return { lastBusySyncAt: '' };
      }

      const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
      if (!baseUrl?.trim()) {
        setBusyBlocksError('Missing API base URL (VITE_API_BASE_URL).');
        return { lastBusySyncAt: '' };
      }

      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/calendar/busyblocks`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      let payload: {
        message?: string;
        busy_blocks?: BusyBlockItem[];
        window_start_date?: string;
        window_end_date?: string;
        last_busy_sync_at?: string;
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
            : `Could not load busy blocks (${response.status}).`;
        setBusyBlocksError(message);
        return { lastBusySyncAt: '' };
      }

      const incoming = Array.isArray(payload.busy_blocks) ? payload.busy_blocks : [];
      const cleaned = incoming.filter(
        (block): block is BusyBlockItem =>
          !!block &&
          typeof block.block_key === 'string' &&
          typeof block.date === 'string' &&
          typeof block.start_time === 'string' &&
          typeof block.end_time === 'string' &&
          typeof block.source_calendar_id === 'string'
      );
      setBusyBlocks(cleaned);

      const startDate =
        typeof payload.window_start_date === 'string' ? payload.window_start_date.trim() : '';
      const endDate = typeof payload.window_end_date === 'string' ? payload.window_end_date.trim() : '';
      if (startDate && endDate) {
        setBusyBlocksWindow({ startDate, endDate });
      } else {
        setBusyBlocksWindow(null);
      }

      return {
        lastBusySyncAt:
          typeof payload.last_busy_sync_at === 'string' ? payload.last_busy_sync_at.trim() : '',
      };
    } catch (e) {
      const anyErr = e as { message?: string };
      setBusyBlocksError(
        typeof anyErr?.message === 'string' ? anyErr.message : 'Failed to load busy blocks.'
      );
      return { lastBusySyncAt: '' };
    }
  }, []);

  async function handleSaveCalendarSelectionClick() {
    setIsSavingCalendarSelection(true);
    try {
      const session = await fetchAuthSession();
      const accessToken = session.tokens?.accessToken?.toString();
      const idToken = session.tokens?.idToken?.toString();
      const token = accessToken || idToken;
      if (!token) {
        setCalendarsListError('You need to be signed in to save calendar selection.');
        setCalendarSidebarState('error');
        return;
      }

      const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
      if (!baseUrl?.trim()) {
        setCalendarsListError('Missing API base URL (VITE_API_BASE_URL).');
        setCalendarSidebarState('error');
        return;
      }

      const endpointUrl = `${baseUrl.replace(/\/$/, '')}/auth/google/calendars`;
      const response = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          selected_calendar_ids: selectedCalendarIds,
        }),
      });

      let payload: { message?: string } = {};
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        payload = {};
      }

      if (!response.ok) {
        const message =
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : `Could not save calendars (${response.status}).`;
        setCalendarsListError(message);
        setCalendarSidebarState('error');
        return;
      }

      setIsEditingCalendars(false);
      setCalendarsListError('');
      setCalendarSidebarState('ready');
      await syncAndRefreshBusyBlocks();
    } catch (e) {
      const anyErr = e as { message?: string };
      setCalendarsListError(
        typeof anyErr?.message === 'string' ? anyErr.message : 'Failed to save calendar selection.'
      );
      setCalendarSidebarState('error');
    } finally {
      setIsSavingCalendarSelection(false);
    }
  }

  function handleEditCalendarsClick() {
    void refreshGoogleCalendarFromBackend(true);
  }

  React.useEffect(() => {
    void (async () => {
      try {
        await loadProfile();
      } catch {
        // Keep initials / empty name when profile cannot be loaded.
      }
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

    void refreshGoogleCalendarFromBackend(false);
    void (async () => {
      const { lastBusySyncAt } = await refreshBusyBlocksOnly();
      if (!isBusySyncFresh(lastBusySyncAt) && !isAutoBusyBlocksSyncInFlight) {
        isAutoBusyBlocksSyncInFlight = true;
        try {
          await syncAndRefreshBusyBlocks();
        } finally {
          isAutoBusyBlocksSyncInFlight = false;
        }
      }
    })();
  }, [refreshGoogleCalendarFromBackend, refreshBusyBlocksOnly, syncAndRefreshBusyBlocks]);

  function toggleCalendarSelection(calendarId: string) {
    setSelectedCalendarIds((current) => {
      if (current.includes(calendarId)) return current.filter((id) => id !== calendarId);
      return [...current, calendarId];
    });
  }

  const visibleCalendars =
    calendarSidebarState === 'ready'
      ? isEditingCalendars
        ? googleCalendars
        : googleCalendars.filter((calendar) => selectedCalendarIds.includes(calendar.id || ''))
      : [];

  const weekDates = React.useMemo(() => buildWeekDates(weekStartDate), [weekStartDate]);
  const todayDateKey = React.useMemo(() => toIsoDateLocal(new Date()), []);
  const calendarNameById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const calendar of googleCalendars) {
      const id = typeof calendar.id === 'string' ? calendar.id.trim() : '';
      const name = typeof calendar.summary === 'string' ? calendar.summary.trim() : '';
      if (id) map.set(id, name || 'Google Calendar');
    }
    return map;
  }, [googleCalendars]);
  const busyBlocksByDate = React.useMemo(() => {
    const grouped = new Map<string, BusyBlockItem[]>();
    for (const block of busyBlocks) {
      const dateKey = block.date;
      if (!grouped.has(dateKey)) grouped.set(dateKey, []);
      grouped.get(dateKey)?.push(block);
    }
    for (const [dateKey, blocks] of grouped.entries()) {
      blocks.sort((a, b) => {
        if (a.start_time !== b.start_time) return a.start_time.localeCompare(b.start_time);
        if (a.end_time !== b.end_time) return a.end_time.localeCompare(b.end_time);
        return a.block_key.localeCompare(b.block_key);
      });
      grouped.set(dateKey, blocks);
    }
    return grouped;
  }, [busyBlocks]);
  const miniCalendarMonthLabel = React.useMemo(
    () => miniCalendarMonthDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    [miniCalendarMonthDate]
  );
  const miniCalendarDays = React.useMemo(() => {
    const start = monthGridStart(miniCalendarMonthDate);
    const items: { date: Date; inCurrentMonth: boolean }[] = [];
    for (let i = 0; i < 42; i += 1) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      items.push({ date: day, inCurrentMonth: day.getMonth() === miniCalendarMonthDate.getMonth() });
    }
    return items;
  }, [miniCalendarMonthDate]);
  const todayIso = todayDateKey;
  const selectedDateIso = React.useMemo(() => toIsoDateLocal(selectedDate), [selectedDate]);
  const dayBlocks = busyBlocksByDate.get(selectedDateIso) || [];
  const monthViewDays = React.useMemo(() => {
    const start = monthGridStart(miniCalendarMonthDate);
    const items: { date: Date; inCurrentMonth: boolean; blocks: BusyBlockItem[] }[] = [];
    for (let i = 0; i < 42; i += 1) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      const dayIso = toIsoDateLocal(day);
      items.push({
        date: day,
        inCurrentMonth: day.getMonth() === miniCalendarMonthDate.getMonth(),
        blocks: busyBlocksByDate.get(dayIso) || [],
      });
    }
    return items;
  }, [miniCalendarMonthDate, busyBlocksByDate]);

  function moveSelectedDateByDays(deltaDays: number) {
    setSelectedDate((current) => {
      const next = new Date(current);
      next.setDate(next.getDate() + deltaDays);
      return next;
    });
  }

  function handleMiniCalendarDateClick(clickedDate: Date) {
    const monthDate = monthStart(clickedDate);
    if (
      monthDate.getFullYear() !== miniCalendarMonthDate.getFullYear() ||
      monthDate.getMonth() !== miniCalendarMonthDate.getMonth()
    ) {
      setMiniCalendarMonthDate(monthDate);
    }
    setSelectedDate(clickedDate);
    setWeekStartDate(startOfWeek(clickedDate));
  }

  function handleGoToday() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    setSelectedDate(today);
    setWeekStartDate(startOfWeek(today));
    setMiniCalendarMonthDate(monthStart(today));
  }

  function handlePrevPeriod() {
    if (viewMode === 'day') {
      moveSelectedDateByDays(-1);
      return;
    }
    if (viewMode === 'week') {
      setWeekStartDate((current) => shiftWeekDate(current, -1));
      return;
    }
    setMiniCalendarMonthDate((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1));
  }

  function handleNextPeriod() {
    if (viewMode === 'day') {
      moveSelectedDateByDays(1);
      return;
    }
    if (viewMode === 'week') {
      setWeekStartDate((current) => shiftWeekDate(current, 1));
      return;
    }
    setMiniCalendarMonthDate((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1));
  }

  const visibleMonthLabel = React.useMemo(() => {
    const baseDate = viewMode === 'day' ? selectedDate : viewMode === 'week' ? weekStartDate : miniCalendarMonthDate;
    return baseDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }, [viewMode, selectedDate, weekStartDate, miniCalendarMonthDate]);

  const effectiveName = (displayName || username || 'Noa Levi').trim();
  const isCalendarRoute = location.pathname.startsWith('/calendar');

  return (
    <section className="df-calendarPage" aria-label="DailyFlow calendar screen">
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
              (effectiveName || 'N').slice(0, 2).toUpperCase()
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
          <button
            type="button"
            className={`df-calendarMenuItem${isCalendarRoute ? ' df-calendarMenuItemActive' : ''}`}
            onClick={() => navigate('/calendar')}
          >
            Calendar
          </button>
          <button type="button" className="df-calendarMenuItem" disabled>
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
              className="df-btn"
              onClick={handleGoToday}
              aria-label="Current week"
            >
              Today
            </button>
            <button
              type="button"
              className="df-btn"
              onClick={handlePrevPeriod}
              aria-label="Previous period"
            >
              ◀
            </button>
            <button
              type="button"
              className="df-btn"
              onClick={handleNextPeriod}
              aria-label="Next period"
            >
              ▶
            </button>
            <button
              type="button"
              className="df-btn"
              onClick={() => void syncAndRefreshBusyBlocks()}
              disabled={isSyncingBusyBlocks}
            >
              {isSyncingBusyBlocks ? 'Syncing...' : 'Refresh calendar'}
            </button>
            <div className="df-calendarViewSwitch" role="tablist" aria-label="Calendar view">
              <button
                type="button"
                className={`df-calendarViewBtn${viewMode === 'day' ? ' df-calendarViewBtnActive' : ''}`}
                onClick={() => setViewMode('day')}
              >
                Day
              </button>
              <button
                type="button"
                className={`df-calendarViewBtn${viewMode === 'week' ? ' df-calendarViewBtnActive' : ''}`}
                onClick={() => setViewMode('week')}
              >
                Week
              </button>
              <button
                type="button"
                className={`df-calendarViewBtn${viewMode === 'month' ? ' df-calendarViewBtnActive' : ''}`}
                onClick={() => setViewMode('month')}
              >
                Month
              </button>
            </div>
            <span className="df-calendarLegend" style={{ marginBottom: 0 }}>
              {visibleMonthLabel}
            </span>
          </div>

          <div className="df-calendarTopbarRight">
            <button
              type="button"
              className="df-btn df-btnPrimary"
              onClick={handleConnectGoogleCalendarClick}
              disabled={
                isConnectingGoogleCalendar ||
                calendarSidebarState === 'checking' ||
                calendarSidebarState === 'ready'
              }
              style={
                calendarSidebarState === 'ready'
                  ? { opacity: 0.55, cursor: 'not-allowed' }
                  : undefined
              }
            >
              {isConnectingGoogleCalendar
                ? 'Connecting...'
                : 'Connect Google Calendar'}
            </button>
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

        {errorMessage && <div className="df-errorText">{errorMessage}</div>}

        <div className="df-calendarBody">
          <section className="df-weekGrid" aria-label="Calendar view">
            {viewMode === 'week' && (
              <>
                <div className="df-weekHeader">
                  {weekDates.map((day) => (
                    <div
                      key={toIsoDateLocal(day)}
                      className={toIsoDateLocal(day) === todayDateKey ? 'df-weekHeaderDayToday' : undefined}
                    >
                      {formatDayHeader(day)}
                    </div>
                  ))}
                </div>

                <div className="df-weekColumns">
                  {weekDates.map((day) => {
                    const dayKey = toIsoDateLocal(day);
                    const weekDayBlocks = busyBlocksByDate.get(dayKey) || [];
                    return (
                      <div className="df-weekColumn" key={dayKey}>
                        {weekDayBlocks.map((block) => (
                          <div
                            key={block.block_key}
                            className="df-eventBlock"
                            style={{
                              background: `${block.source_calendar_color || '#3b82f6'}22`,
                              border: `1px solid ${block.source_calendar_color || '#3b82f6'}`,
                            }}
                          >
                            <strong>{block.source_event_title?.trim() || 'Busy'}</strong>
                            <span>{formatTimeRange(block.start_time, block.end_time)}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {viewMode === 'day' && (
              <div className="df-dayView">
                <div className="df-dayViewHeader">
                  {selectedDate.toLocaleDateString(undefined, {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                </div>
                <div className="df-dayViewBody">
                  {dayBlocks.map((block) => (
                    <div
                      key={block.block_key}
                      className="df-eventBlock"
                      style={{
                        background: `${block.source_calendar_color || '#3b82f6'}22`,
                        border: `1px solid ${block.source_calendar_color || '#3b82f6'}`,
                      }}
                    >
                      <strong>{block.source_event_title?.trim() || 'Busy'}</strong>
                      <span>{formatTimeRange(block.start_time, block.end_time)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {viewMode === 'month' && (
              <div className="df-monthView">
                <div className="df-weekHeader">
                  <div>S</div>
                  <div>M</div>
                  <div>T</div>
                  <div>W</div>
                  <div>T</div>
                  <div>F</div>
                  <div>S</div>
                </div>
                <div className="df-monthGrid">
                  {monthViewDays.map(({ date, inCurrentMonth, blocks }) => {
                    const dateIso = toIsoDateLocal(date);
                    return (
                      <button
                        type="button"
                        key={dateIso}
                        className={`df-monthCell${inCurrentMonth ? '' : ' df-monthCellMuted'}${dateIso === todayIso ? ' df-monthCellToday' : ''}`}
                        onClick={() => {
                          setSelectedDate(date);
                          setWeekStartDate(startOfWeek(date));
                          setViewMode('day');
                        }}
                        aria-label={`Open day ${date.toLocaleDateString()}`}
                      >
                        <span className="df-monthCellDate">{date.getDate()}</span>
                        {blocks.slice(0, 2).map((block) => (
                          <span key={block.block_key} className="df-monthCellEvent">
                            {block.start_time.slice(0, 5)} {block.source_event_title?.trim() || 'Busy'}
                          </span>
                        ))}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {!isSyncingBusyBlocks && busyBlocksError && (
              <div className="df-calendarLegend" style={{ padding: '0 12px 10px', color: '#b91c1c' }} role="alert">
                {busyBlocksError}
              </div>
            )}
            {!isSyncingBusyBlocks && !busyBlocksError && busyBlocks.length === 0 && (
              <div className="df-calendarLegend" style={{ padding: '0 12px 10px', color: '#6b7280' }}>
                No busy blocks yet. Run BusyBlocks sync to populate this calendar.
              </div>
            )}
          </section>

          <aside className="df-calendarSidebar" aria-label="Calendar details">
            <div className="df-miniCalendar">
              <div className="df-miniCalendarHeaderRow">
                <button
                  type="button"
                  className="df-btn"
                  onClick={() =>
                    setMiniCalendarMonthDate(
                      (current) => new Date(current.getFullYear(), current.getMonth() - 1, 1)
                    )
                  }
                  aria-label="Previous month"
                  style={{ padding: '4px 8px', fontSize: 12, lineHeight: 1.2 }}
                >
                  ◀
                </button>
                <div className="df-miniCalendarHeader">{miniCalendarMonthLabel}</div>
                <button
                  type="button"
                  className="df-btn"
                  onClick={() =>
                    setMiniCalendarMonthDate(
                      (current) => new Date(current.getFullYear(), current.getMonth() + 1, 1)
                    )
                  }
                  aria-label="Next month"
                  style={{ padding: '4px 8px', fontSize: 12, lineHeight: 1.2 }}
                >
                  ▶
                </button>
              </div>
              <div className="df-miniCalendarGrid">
                <span>S</span>
                <span>M</span>
                <span>T</span>
                <span>W</span>
                <span>T</span>
                <span>F</span>
                <span>S</span>
                {miniCalendarDays.map(({ date, inCurrentMonth }) => {
                  const dateIso = toIsoDateLocal(date);
                  const isToday = dateIso === todayIso;
                  return (
                    <button
                      key={dateIso}
                      type="button"
                      className={`df-miniCalendarDayButton${isToday ? ' df-miniCalendarDayActive' : ''}${!inCurrentMonth ? ' df-miniCalendarDayMuted' : ''}`}
                      onClick={() => handleMiniCalendarDateClick(date)}
                      aria-label={`Open week of ${date.toLocaleDateString()}`}
                    >
                      {date.getDate()}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="df-calendarsList" aria-busy={calendarSidebarState === 'checking'}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <h2 style={{ margin: 0 }}>Calendars</h2>
                {calendarSidebarState === 'ready' && !isEditingCalendars && (
                  <button
                    type="button"
                    className="df-btn"
                    onClick={handleEditCalendarsClick}
                    disabled={isSavingCalendarSelection}
                    aria-label="Edit calendars"
                    style={{ padding: '4px 8px', fontSize: 12, lineHeight: 1.2 }}
                  >
                    ✏️ Edit
                  </button>
                )}
                {calendarSidebarState === 'ready' && isEditingCalendars && (
                  <button
                    type="button"
                    className="df-btn"
                    onClick={() => void handleSaveCalendarSelectionClick()}
                    disabled={isSavingCalendarSelection}
                    aria-label="Save calendars"
                    style={{ padding: '4px 8px', fontSize: 12, lineHeight: 1.2 }}
                  >
                    {isSavingCalendarSelection ? 'Saving...' : '💾 Save'}
                  </button>
                )}
              </div>
              {calendarSidebarState === 'checking' && (
                <div className="df-calendarLegend" style={{ color: '#6b7280' }}>
                  Checking Google Calendar connection...
                </div>
              )}
              {calendarSidebarState === 'not_connected' && (
                <div className="df-calendarLegend" style={{ color: '#6b7280' }}>
                  Connect Google Calendar to load your calendar list.
                </div>
              )}
              {calendarSidebarState === 'reconnect_required' && (
                <div className="df-calendarLegend" style={{ color: '#b45309' }} role="alert">
                  {calendarsListError}
                </div>
              )}
              {calendarSidebarState === 'error' && (
                <div className="df-calendarLegend" style={{ color: '#b91c1c' }} role="alert">
                  {calendarsListError}
                </div>
              )}
              {calendarSidebarState === 'ready' && googleCalendars.length === 0 && (
                <div className="df-calendarLegend" style={{ color: '#6b7280' }}>
                  No calendars returned for this account.
                </div>
              )}
              {calendarSidebarState === 'ready' &&
                !isEditingCalendars &&
                googleCalendars.length > 0 &&
                visibleCalendars.length === 0 && (
                  <div className="df-calendarLegend" style={{ color: '#6b7280' }}>
                    No calendars are currently selected. Use Edit calendars to choose which calendars to show.
                  </div>
                )}
              {calendarSidebarState === 'ready' &&
                visibleCalendars.map((calendar) => {
                  const calendarId = calendar.id || '';
                  if (!calendarId) return null;
                  const displayName =
                    typeof calendar.summary === 'string' && calendar.summary.trim()
                      ? calendar.summary.trim()
                      : calendarId;
                  const isSelected = selectedCalendarIds.includes(calendarId);
                  return (
                    <label key={calendarId} className="df-calendarLegend">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={!isEditingCalendars}
                        onChange={() => toggleCalendarSelection(calendarId)}
                        aria-label={`Expose calendar ${displayName} to DailyFlow`}
                      />
                      <span
                        className="df-dot"
                        style={{ background: calendar.backgroundColor || '#3b82f6' }}
                        aria-hidden
                      />
                      <span>{displayName}</span>
                    </label>
                  );
                })}
            </div>
          </aside>
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
    </section>
  );
}
