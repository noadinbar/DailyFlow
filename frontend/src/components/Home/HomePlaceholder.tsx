import React from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';

type HomePlaceholderProps = {
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

export default function HomePlaceholder(props: HomePlaceholderProps) {
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
  }, [refreshGoogleCalendarFromBackend]);

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
            <button type="button" className="df-btn">
              Today
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
              <div>Mon 15</div>
              <div>Tue 16</div>
              <div>Wed 17</div>
              <div>Thu 18</div>
              <div>Fri 19</div>
              <div>Sat 20</div>
              <div>Sun 21</div>
            </div>

            <div className="df-weekColumns">
              <div className="df-weekColumn">
                <div className="df-eventBlock df-eventGreen">
                  <strong>University Lecture</strong>
                  <span>10:00 - 12:00</span>
                </div>
                <div className="df-eventBlock df-eventPurple">
                  <strong>Study Session</strong>
                  <span>14:00 - 16:00</span>
                </div>
              </div>
              <div className="df-weekColumn">
                <div className="df-eventBlock df-eventGreen">
                  <strong>University Lecture</strong>
                  <span>09:00 - 11:00</span>
                </div>
                <div className="df-eventBlock df-eventGreen">
                  <strong>University Lecture</strong>
                  <span>12:00 - 14:00</span>
                </div>
                <div className="df-eventBlock df-eventPurple">
                  <strong>Study Session</strong>
                  <span>15:00 - 16:00</span>
                </div>
              </div>
              <div className="df-weekColumn">
                <div className="df-eventBlock df-eventBlue">
                  <strong>Work</strong>
                  <span>09:00 - 14:00</span>
                </div>
              </div>
              <div className="df-weekColumn">
                <div className="df-eventBlock df-eventGreen">
                  <strong>University Lecture</strong>
                  <span>10:00 - 12:00</span>
                </div>
                <div className="df-eventBlock df-eventPurple">
                  <strong>Study Session</strong>
                  <span>13:00 - 15:00</span>
                </div>
              </div>
              <div className="df-weekColumn">
                <div className="df-eventBlock df-eventBlue">
                  <strong>Work</strong>
                  <span>09:00 - 14:00</span>
                </div>
                <div className="df-eventBlock df-eventGreen">
                  <strong>University Lecture</strong>
                  <span>15:00 - 16:00</span>
                </div>
              </div>
              <div className="df-weekColumn">
                <div className="df-eventBlock df-eventPurple">
                  <strong>45 min workout</strong>
                  <span>10:00 - 11:15</span>
                </div>
                <div className="df-eventBlock df-eventPurple">
                  <strong>Study Session</strong>
                  <span>14:00 - 16:00</span>
                </div>
              </div>
              <div className="df-weekColumn">
                <div className="df-eventBlock df-eventPurple">
                  <strong>Meditation</strong>
                  <span>09:00 - 09:30</span>
                </div>
                <div className="df-eventBlock df-eventPurple">
                  <strong>Meal prep</strong>
                  <span>11:00 - 13:00</span>
                </div>
                <div className="df-eventBlock df-eventPurple">
                  <strong>Study Session</strong>
                  <span>15:00 - 17:00</span>
                </div>
              </div>
            </div>
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
                  >
                    {isSavingCalendarSelection ? 'Saving...' : 'Save'}
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

