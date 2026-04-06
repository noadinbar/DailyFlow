import React from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';

type HomePlaceholderProps = {
  username?: string;
  onLogout?: () => Promise<void>;
};

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
  const [isLoadingCalendars, setIsLoadingCalendars] = React.useState<boolean>(false);
  const [googleCalendars, setGoogleCalendars] = React.useState<GoogleCalendarItem[]>([]);
  const [selectedCalendarIds, setSelectedCalendarIds] = React.useState<string[]>([]);

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
    try {
      const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
      if (!baseUrl) {
        setErrorMessage('Missing API base URL configuration (VITE_API_BASE_URL).');
        setIsConnectingGoogleCalendar(false);
        return;
      }

      const endpointUrl = `${baseUrl.replace(/\/$/, '')}/auth/google/start`;
      window.location.assign(endpointUrl);
    } catch (e) {
      const anyErr = e as any;
      const message =
        anyErr && typeof anyErr.message === 'string'
          ? anyErr.message
          : 'Failed to start Google Calendar connection.';
      setErrorMessage(message);
      setIsConnectingGoogleCalendar(false);
    }
  }

  React.useEffect(() => {
    void (async () => {
      setIsLoadingCalendars(true);
      try {
        const session = await fetchAuthSession();
        const accessToken = session.tokens?.accessToken?.toString();
        const idToken = session.tokens?.idToken?.toString();
        const token = accessToken || idToken;
        if (!token) return;

        const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
        if (!baseUrl) return;

        const endpointUrl = `${baseUrl.replace(/\/$/, '')}/auth/google/calendars`;
        const response = await fetch(endpointUrl, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        if (!response.ok) return;

        const payload = (await response.json()) as { calendars?: GoogleCalendarItem[] };
        const calendars = Array.isArray(payload.calendars) ? payload.calendars : [];
        setGoogleCalendars(calendars);
        setSelectedCalendarIds(
          calendars
            .filter((calendar) => calendar.selected)
            .map((calendar) => calendar.id)
            .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
        );
      } catch {
        // Keep calendar screen usable even if calendar list fetch fails.
      } finally {
        setIsLoadingCalendars(false);
      }
    })();
  }, []);

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

            <div className="df-calendarsList">
              <h2>Calendars</h2>
              {isLoadingCalendars && (
                <div className="df-calendarLegend" style={{ color: '#6b7280' }}>
                  Loading calendars...
                </div>
              )}
              {!isLoadingCalendars && googleCalendars.length === 0 && (
                <div className="df-calendarLegend" style={{ color: '#6b7280' }}>
                  No connected calendars yet.
                </div>
              )}
              {!isLoadingCalendars &&
                googleCalendars.map((calendar) => {
                  const calendarId = calendar.id || '';
                  if (!calendarId) return null;
                  const isSelected = selectedCalendarIds.includes(calendarId);
                  return (
                    <label key={calendarId} className="df-calendarLegend">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleCalendarSelection(calendarId)}
                      />
                      <span
                        className="df-dot"
                        style={{ background: calendar.backgroundColor || '#3b82f6' }}
                      />
                      {calendar.summary || calendarId}
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

