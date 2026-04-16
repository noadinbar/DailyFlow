import React from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';

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

type TimedWeekEvent = {
  block: BusyBlockItem;
  top: number;
  height: number;
};

const HOUR_HEIGHT_PX = 44;
const DAY_HEIGHT_PX = HOUR_HEIGHT_PX * 24;
const MIN_EVENT_HEIGHT_PX = 16;

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

function parseTimeToMinutes(value: string): number | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  const parts = trimmed.split(':');
  if (parts.length < 2) return null;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
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

function mapBlockToTimedWeekEvent(block: BusyBlockItem): TimedWeekEvent | null {
  const startMinutes = parseTimeToMinutes(block.start_time);
  const endMinutes = parseTimeToMinutes(block.end_time);
  if (startMinutes === null || endMinutes === null) return null;
  if (endMinutes <= startMinutes) return null;
  const boundedStart = Math.max(0, Math.min(startMinutes, 24 * 60));
  const boundedEnd = Math.max(0, Math.min(endMinutes, 24 * 60));
  if (boundedEnd <= boundedStart) return null;
  const durationMinutes = boundedEnd - boundedStart;
  return {
    block,
    top: (boundedStart / 60) * HOUR_HEIGHT_PX,
    height: Math.max(MIN_EVENT_HEIGHT_PX, (durationMinutes / 60) * HOUR_HEIGHT_PX),
  };
}

export default function HomeScreen(props: HomeScreenProps) {
  const { username, onLogout } = props;
  const [errorMessage, setErrorMessage] = React.useState<string>('');
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
  const [weekStartDate, setWeekStartDate] = React.useState<Date>(() => startOfWeek(new Date()));

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
    if (typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    if (params.get('google_calendar_connected') === '1') {
      params.delete('google_calendar_connected');
      const nextSearch = params.toString();
      const next = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', next);
    }

    void refreshGoogleCalendarFromBackend(false);
    void syncAndRefreshBusyBlocks();
  }, [refreshGoogleCalendarFromBackend, syncAndRefreshBusyBlocks]);

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
  const timedWeekEventsByDate = React.useMemo(() => {
    const grouped = new Map<string, TimedWeekEvent[]>();
    for (const day of weekDates) {
      const dayKey = toIsoDateLocal(day);
      const dayBlocks = busyBlocksByDate.get(dayKey) || [];
      const timedEvents = dayBlocks
        .map((block) => mapBlockToTimedWeekEvent(block))
        .filter((event): event is TimedWeekEvent => event !== null)
        .sort((a, b) => {
          if (a.top !== b.top) return a.top - b.top;
          if (a.height !== b.height) return a.height - b.height;
          return a.block.block_key.localeCompare(b.block.block_key);
        });
      grouped.set(dayKey, timedEvents);
    }
    return grouped;
  }, [busyBlocksByDate, weekDates]);
  const windowStartDate = busyBlocksWindow?.startDate || null;
  const windowEndDate = busyBlocksWindow?.endDate || null;
  const canGoToPreviousWeek = React.useMemo(() => {
    if (!windowStartDate) return true;
    return toIsoDateLocal(shiftWeekDate(weekStartDate, -1)) >= windowStartDate;
  }, [weekStartDate, windowStartDate]);
  const canGoToNextWeek = React.useMemo(() => {
    if (!windowEndDate) return true;
    const nextWeekStart = shiftWeekDate(weekStartDate, 1);
    const nextWeekEnd = shiftWeekDate(weekStartDate, 1);
    nextWeekEnd.setDate(nextWeekEnd.getDate() + 6);
    return toIsoDateLocal(nextWeekStart) <= windowEndDate || toIsoDateLocal(nextWeekEnd) <= windowEndDate;
  }, [weekStartDate, windowEndDate]);
  const weekRangeLabel = React.useMemo(() => {
    const firstDay = weekDates[0];
    const lastDay = weekDates[6];
    if (!firstDay || !lastDay) return '';
    const firstLabel = firstDay.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const lastLabel = lastDay.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${firstLabel} - ${lastLabel}`;
  }, [weekDates]);

  return (
    <section className="df-calendarPage" aria-label="DailyFlow calendar screen">
      <aside className="df-calendarLeftNav">
        <div className="df-calendarBrand">DailyFlow</div>
        <div className="df-calendarProfile">
          <div className="df-calendarProfileAvatar">{(username || 'N').slice(0, 2).toUpperCase()}</div>
          <div>
            <div className="df-calendarProfileName">{username || 'Noa Levi'}</div>
            <div className="df-calendarProfileHint">Plan your week</div>
          </div>
        </div>

        <nav className="df-calendarMenu" aria-label="Main sections">
          <button type="button" className="df-calendarMenuItem df-calendarMenuItemActive">
            Calendar
          </button>
          <button type="button" className="df-calendarMenuItem" disabled>
            Meals & Grocery
          </button>
          <button type="button" className="df-calendarMenuItem" disabled>
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
              onClick={() => setWeekStartDate(startOfWeek(new Date()))}
              aria-label="Current week"
            >
              Today
            </button>
            <button
              type="button"
              className="df-btn"
              onClick={() => setWeekStartDate((current) => shiftWeekDate(current, -1))}
              disabled={!canGoToPreviousWeek}
              aria-label="Previous week"
            >
              ◀
            </button>
            <button
              type="button"
              className="df-btn"
              onClick={() => setWeekStartDate((current) => shiftWeekDate(current, 1))}
              disabled={!canGoToNextWeek}
              aria-label="Next week"
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
              <button type="button" className="df-calendarViewBtn df-calendarViewBtnActive">
                Day
              </button>
              <button type="button" className="df-calendarViewBtn">
                Week
              </button>
              <button type="button" className="df-calendarViewBtn">
                Month
              </button>
            </div>
            <span className="df-calendarLegend" style={{ marginBottom: 0 }}>
              {weekRangeLabel}
            </span>
          </div>

          <div className="df-calendarTopbarRight">
            {calendarSidebarState === 'ready' && (
              <span className="df-calendarLegend" style={{ color: '#15803d', marginRight: 12 }}>
                Google Calendar connected
              </span>
            )}
            {calendarSidebarState === 'reconnect_required' && (
              <span className="df-calendarLegend" style={{ color: '#b45309', marginRight: 12 }}>
                {GOOGLE_RECONNECT_MESSAGE}
              </span>
            )}
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
          <section className="df-weekGrid" aria-label="Weekly calendar">
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
                const dayEvents = timedWeekEventsByDate.get(dayKey) || [];
                return (
                  <div className="df-weekColumn" key={dayKey}>
                    <div className="df-weekColumnEvents" style={{ minHeight: DAY_HEIGHT_PX }}>
                      {dayEvents.map(({ block, top, height }) => (
                        <div
                          key={block.block_key}
                          className="df-eventBlock df-eventBlockTimed"
                          style={{
                            top,
                            height,
                            background: `${block.source_calendar_color || '#3b82f6'}22`,
                            border: `1px solid ${block.source_calendar_color || '#3b82f6'}`,
                          }}
                        >
                          <strong>{block.source_event_title?.trim() || 'Busy'}</strong>
                          <span>{formatTimeRange(block.start_time, block.end_time)}</span>
                        </div>
                      ))}
                    </div>
                    {dayEvents.length === 0 && (
                      <div className="df-weekColumnEmpty">
                        No busy blocks
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {isSyncingBusyBlocks && (
              <div className="df-calendarLegend" style={{ padding: '0 12px 10px', color: '#6b7280' }}>
                Syncing busy blocks...
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
              <div className="df-miniCalendarHeader">January 2026</div>
              <div className="df-miniCalendarGrid">
                <span>S</span>
                <span>M</span>
                <span>T</span>
                <span>W</span>
                <span>T</span>
                <span>F</span>
                <span>S</span>
                <span className="df-miniCalendarDay">10</span>
                <span className="df-miniCalendarDay">11</span>
                <span className="df-miniCalendarDay">12</span>
                <span className="df-miniCalendarDay">13</span>
                <span className="df-miniCalendarDay">14</span>
                <span className="df-miniCalendarDay df-miniCalendarDayActive">15</span>
                <span className="df-miniCalendarDay">16</span>
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
    </section>
  );
}
