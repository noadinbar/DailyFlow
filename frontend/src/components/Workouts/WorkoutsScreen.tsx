import React from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useLocation, useNavigate } from 'react-router-dom';
import ProfileSettingsModal from '../Home/ProfileSettingsModal';

type WorkoutsScreenProps = {
  username?: string;
};

type WeeklyPlanSuggestion = {
  id: string;
  title: string;
  workout_type: string;
  duration_minutes: number;
  intensity: string;
  recommended_day: string;
  recommended_start_time: string;
  recommended_end_time: string;
  recommended_time_label: string;
  reason_short: string;
};

type WorkoutLibraryItem = {
  id: string;
  title: string;
  workout_type: string;
  duration_bucket: string;
  duration_min_minutes: number;
  duration_max_minutes: number;
  intensity: string;
  summary_short: string;
};

type SuggestionsResponse = {
  period?: { start_date?: string; end_date?: string };
  weekly_plan_suggestions?: WeeklyPlanSuggestion[];
  workout_library?: WorkoutLibraryItem[];
  metadata?: { generation_warning?: string };
  message?: string;
};

type WeekDayCard = { dayLabel: string; dateIso: string };

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
  const { username } = props;
  const navigate = useNavigate();
  const location = useLocation();
  const [isProfileSettingsOpen, setIsProfileSettingsOpen] = React.useState<boolean>(false);
  const [weekStartDate, setWeekStartDate] = React.useState<Date>(() => startOfWeek(new Date()));
  const [weeklyPlanSuggestions, setWeeklyPlanSuggestions] = React.useState<WeeklyPlanSuggestion[]>([]);
  const [workoutLibrary, setWorkoutLibrary] = React.useState<WorkoutLibraryItem[]>([]);
  const [isGeneratingPlan, setIsGeneratingPlan] = React.useState<boolean>(false);
  const [generateError, setGenerateError] = React.useState<string>('');
  const [generateHint, setGenerateHint] = React.useState<string>('Click Generate plan to load suggestions.');

  const displayName = (username || 'Noa Levi').trim();
  const initials = (displayName || 'N').slice(0, 2).toUpperCase();
  const isWorkoutsRoute = location.pathname.startsWith('/workouts');
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
  const selectedWorkoutTypes = React.useMemo(() => {
    return Array.from(new Set(workoutLibrary.map((item) => item.workout_type))).slice(0, 6);
  }, [workoutLibrary]);
  const selectedDurationBuckets = React.useMemo(() => {
    return Array.from(new Set(workoutLibrary.map((item) => item.duration_bucket))).slice(0, 6);
  }, [workoutLibrary]);

  async function getAuthToken(): Promise<string> {
    const session = await fetchAuthSession();
    const accessToken = session.tokens?.accessToken?.toString();
    const idToken = session.tokens?.idToken?.toString();
    const token = accessToken || idToken;
    if (!token) throw new Error('You need to be signed in.');
    return token;
  }

  async function handleGeneratePlanClick() {
    setGenerateError('');
    setGenerateHint('');
    setIsGeneratingPlan(true);
    try {
      const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
      if (!baseUrl?.trim()) throw new Error('Missing API base URL (VITE_API_BASE_URL).');
      const token = await getAuthToken();
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/workouts/suggestions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          start_date: weekStartIso,
          end_date: weekEndIso,
        }),
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
      setWeeklyPlanSuggestions(weekly);
      setWorkoutLibrary(library);
      if (weekly.length === 0 && library.length === 0) {
        setGenerateHint('No suggestions were returned for this week.');
      } else if (typeof payload.metadata?.generation_warning === 'string' && payload.metadata.generation_warning) {
        setGenerateHint(payload.metadata.generation_warning);
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

  function handleThisWeekClick() {
    const next = startOfWeek(new Date());
    setWeekStartDate(next);
    setGenerateHint('Week reset to current week. Click Generate plan to refresh suggestions.');
  }

  return (
    <section className="df-calendarPage df-workoutsPage" aria-label="DailyFlow workouts screen">
      <aside className="df-calendarLeftNav">
        <div className="df-calendarBrand">DailyFlow</div>
        <div className="df-calendarProfile">
          <div className="df-calendarProfileAvatar">{initials}</div>
          <div>
            <div className="df-calendarProfileName">{displayName}</div>
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
          <button type="button" className="df-calendarMenuItem" disabled>
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

      <div className="df-calendarMain">
        <header className="df-calendarTopbar">
          <div className="df-calendarTopbarLeft">
            <button type="button" className="df-btn" onClick={handleThisWeekClick}>
              This week
            </button>
            <button
              type="button"
              className="df-btn df-btnPrimary"
              onClick={() => void handleGeneratePlanClick()}
              disabled={isGeneratingPlan}
            >
              {isGeneratingPlan ? 'Generating...' : 'Generate plan'}
            </button>
            <button type="button" className="df-btn">
              Add all to calendar
            </button>
          </div>
          <div className="df-calendarTopbarRight">
            <div className="df-workoutsTopbarUser">{displayName}</div>
            <div className="df-workoutsAvatar">{initials}</div>
            <button
              type="button"
              className="df-iconBtn"
              onClick={() => setIsProfileSettingsOpen(true)}
              aria-label="Open profile settings"
              title="Settings"
            >
              ⚙️
            </button>
          </div>
        </header>

        {generateError && <div className="df-errorText" style={{ padding: '6px 16px 0' }}>{generateError}</div>}
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
                {weeklyPlanSuggestions.length > 0
                  ? `Goal: ${weeklyPlanSuggestions.length} workouts/week`
                  : 'Goal: workouts/week'}
              </div>
            </div>
            <div className="df-workoutWeekGrid">
              {weekCards.map((card) => {
                const daySuggestions = suggestionsByDay.get(card.dateIso) || [];
                const item = daySuggestions[0];
                return (
                  <article key={card.dateIso} className="df-workoutDayCard">
                    <h3 className="df-workoutDay">{card.dayLabel}</h3>
                    {!item ? (
                      <div className="df-workoutRestDay">{isGeneratingPlan ? 'Loading...' : 'Rest day'}</div>
                    ) : (
                      <>
                        <div className="df-workoutTypePill">{item.workout_type}</div>
                        <div className="df-workoutMeta">{item.duration_minutes} min</div>
                        <div className="df-workoutMeta">{item.intensity}</div>
                        <div className="df-workoutSlot">
                          {item.recommended_day} {item.recommended_start_time}-{item.recommended_end_time}
                        </div>
                        <button type="button" className="df-workoutAddBtn">
                          + Add
                        </button>
                        {daySuggestions.length > 1 && (
                          <div className="df-workoutMeta">+{daySuggestions.length - 1} more options</div>
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
            <h2 className="df-workoutsTitle">Workout Library</h2>
            <div className="df-workoutFilters">
              <div className="df-workoutFilterGroup">
                <span className="df-workoutFilterLabel">Type</span>
                {selectedWorkoutTypes.length > 0 ? (
                  selectedWorkoutTypes.map((type) => (
                    <button key={type} type="button" className="df-workoutFilterChip">
                      {type.replace(/_/g, ' ')}
                    </button>
                  ))
                ) : (
                  <button type="button" className="df-workoutFilterChip">No types yet</button>
                )}
              </div>
              <div className="df-workoutFilterGroup">
                <span className="df-workoutFilterLabel">Duration</span>
                {selectedDurationBuckets.length > 0 ? (
                  selectedDurationBuckets.map((bucket) => (
                    <button key={bucket} type="button" className="df-workoutFilterChip">
                      {bucket.replace('_', '-')} min
                    </button>
                  ))
                ) : (
                  <button type="button" className="df-workoutFilterChip">No ranges yet</button>
                )}
              </div>
            </div>
            <div className="df-workoutLibraryGrid">
              {workoutLibrary.map((item) => (
                <article key={item.id} className="df-workoutLibraryCard">
                  <div className="df-workoutLibraryCardTop">
                    <h3 className="df-workoutLibraryTitle">{item.title}</h3>
                    <button type="button" className="df-workoutLibraryAdd" aria-label={`Add ${item.title}`}>
                      +
                    </button>
                  </div>
                  <div className="df-workoutTypePill">{item.workout_type}</div>
                  <div className="df-workoutMeta">
                    {item.duration_min_minutes}-{item.duration_max_minutes} min
                  </div>
                  <div className="df-workoutMeta">{item.intensity}</div>
                  <div className="df-workoutMeta">{item.summary_short}</div>
                </article>
              ))}
            </div>
            {!isGeneratingPlan && workoutLibrary.length === 0 && (
              <div className="df-calendarLegend" style={{ color: '#6b7280', marginBottom: 0 }}>
                Generate a plan to see workout library suggestions.
              </div>
            )}
          </section>
        </div>
      </div>

      <ProfileSettingsModal
        isOpen={isProfileSettingsOpen}
        initialName={displayName}
        onClose={() => setIsProfileSettingsOpen(false)}
      />
    </section>
  );
}
