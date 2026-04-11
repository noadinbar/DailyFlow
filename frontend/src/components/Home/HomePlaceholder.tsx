import React from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';

type HomePlaceholderProps = {
  username?: string;
  onLogout?: () => Promise<void>;
};

const GOOGLE_CALENDAR_CONNECTED_FLAG = 'dailyflow_google_calendar_connected';

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
  const [calendarsLoadState, setCalendarsLoadState] = React.useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [calendarsListError, setCalendarsListError] = React.useState<string>('');
  const [googleCalendars, setGoogleCalendars] = React.useState<GoogleCalendarItem[]>([]);
  const [selectedCalendarIds, setSelectedCalendarIds] = React.useState<string[]>([]);

  async function handleLogoutClick() {
    setErrorMessage('');
    setIsLoggingOut(true);
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(GOOGLE_CALENDAR_CONNECTED_FLAG);
      }
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
        const startUrl = `${baseUrl.replace(/\/$/, '')}/auth/google/start?access_token=${encodeURIComponent(accessToken)}`;
        const form = document.createElement('form');
        form.method = 'GET';
        form.action = startUrl;
        form.style.display = 'none';
        document.body.appendChild(form);
        form.submit();
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

  const loadGoogleCalendars = React.useCallback(async () => {
    setCalendarsLoadState('loading');
    setCalendarsListError('');
    setGoogleCalendars([]);

    try {
      const session = await fetchAuthSession();
      const accessToken = session.tokens?.accessToken?.toString();
      const idToken = session.tokens?.idToken?.toString();
      const token = accessToken || idToken;
      if (!token) {
        setCalendarsListError('You need to be signed in to load calendars.');
        setCalendarsLoadState('error');
        return;
      }

      const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
      if (!baseUrl?.trim()) {
        setCalendarsListError('Missing API base URL (VITE_API_BASE_URL).');
        setCalendarsLoadState('error');
        return;
      }

      const endpointUrl = `${baseUrl.replace(/\/$/, '')}/auth/google/calendars`;
      const response = await fetch(endpointUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      let payload: { message?: string; calendars?: GoogleCalendarItem[] } = {};
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        payload = {};
      }

      if (!response.ok) {
        const message =
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : `Could not load calendars (${response.status}).`;
        setCalendarsListError(message);
        setCalendarsLoadState('error');
        return;
      }

      const calendars = Array.isArray(payload.calendars) ? payload.calendars : [];
      setGoogleCalendars(calendars);
      setSelectedCalendarIds(
        calendars
          .filter((calendar) => calendar.selected !== false)
          .map((calendar) => calendar.id)
          .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      );
      setCalendarsLoadState('ready');
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(GOOGLE_CALENDAR_CONNECTED_FLAG, '1');
      }
    } catch (e) {
      const anyErr = e as { message?: string };
      setCalendarsListError(
        typeof anyErr?.message === 'string' ? anyErr.message : 'Failed to load calendars.'
      );
      setCalendarsLoadState('error');
    }
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    const fromCallback = params.get('google_calendar_connected') === '1';
    if (fromCallback) {
      window.localStorage.setItem(GOOGLE_CALENDAR_CONNECTED_FLAG, '1');
      params.delete('google_calendar_connected');
      const nextSearch = params.toString();
      const next = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', next);
    }

    const shouldLoad =
      fromCallback || window.localStorage.getItem(GOOGLE_CALENDAR_CONNECTED_FLAG) === '1';

    if (shouldLoad) {
      void loadGoogleCalendars();
    } else {
      setCalendarsLoadState('idle');
    }
  }, [loadGoogleCalendars]);

  function toggleCalendarSelection(calendarId: string) {
    setSelectedCalendarIds((current) => {
      if (current.includes(calendarId)) return current.filter((id) => id !== calendarId);
      return [...current, calendarId];
    });
  }

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
            <button
              type="button"
              className="df-btn df-btnPrimary"
              onClick={handleConnectGoogleCalendarClick}
              disabled={isConnectingGoogleCalendar}
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

            <div className="df-calendarsList" aria-busy={calendarsLoadState === 'loading'}>
              <h2>Calendars</h2>
              {calendarsLoadState === 'idle' && (
                <div className="df-calendarLegend" style={{ color: '#6b7280' }}>
                  Connect Google Calendar to load your calendar list.
                </div>
              )}
              {calendarsLoadState === 'loading' && (
                <div className="df-calendarLegend" style={{ color: '#6b7280' }}>
                  Loading calendars...
                </div>
              )}
              {calendarsLoadState === 'error' && (
                <div className="df-calendarLegend" style={{ color: '#b91c1c' }} role="alert">
                  {calendarsListError}
                </div>
              )}
              {calendarsLoadState === 'ready' && googleCalendars.length === 0 && (
                <div className="df-calendarLegend" style={{ color: '#6b7280' }}>
                  No calendars returned for this account.
                </div>
              )}
              {calendarsLoadState === 'ready' &&
                googleCalendars.map((calendar) => {
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

