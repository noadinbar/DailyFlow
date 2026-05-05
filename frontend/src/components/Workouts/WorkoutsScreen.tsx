import React from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useLocation, useNavigate } from 'react-router-dom';
import ProfileSettingsModal from '../Home/ProfileSettingsModal';

type WorkoutsScreenProps = {
  username?: string;
};

type WeeklyPlanSuggestion = {
  id: string;
  library_workout_id: string;
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
  message?: string;
};

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
  const { username } = props;
  const navigate = useNavigate();
  const location = useLocation();
  const [isProfileSettingsOpen, setIsProfileSettingsOpen] = React.useState<boolean>(false);
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
  const [replaceTargetPlanId, setReplaceTargetPlanId] = React.useState<string>('');
  const [replaceLibraryWorkoutId, setReplaceLibraryWorkoutId] = React.useState<string>('');
  const [generateError, setGenerateError] = React.useState<string>('');
  const [generateHint, setGenerateHint] = React.useState<string>('Click Generate plan to load suggestions.');
  const [selectedLibraryWorkout, setSelectedLibraryWorkout] = React.useState<WorkoutLibraryItem | null>(null);

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
    return Array.from(
      new Set(
        all.map((item) =>
          'duration_bucket' in item && typeof item.duration_bucket === 'string'
            ? item.duration_bucket
            : getDurationBucket(item.duration_minutes)
        )
      )
    ).slice(0, 3);
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

  async function getAuthToken(): Promise<string> {
    const session = await fetchAuthSession();
    const accessToken = session.tokens?.accessToken?.toString();
    const idToken = session.tokens?.idToken?.toString();
    const token = accessToken || idToken;
    if (!token) throw new Error('You need to be signed in.');
    return token;
  }

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

  async function persistWeeklyPlan(nextWeeklyPlan: WeeklyPlanSuggestion[]): Promise<WeeklyPlanSuggestion[] | null> {
    try {
      setGenerateError('');
      setIsSavingWeeklyPlan(true);
      const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
      if (!baseUrl?.trim()) throw new Error('Missing API base URL (VITE_API_BASE_URL).');
      const token = await getAuthToken();
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/workouts/weekly-plan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          start_date: weekStartIso,
          end_date: weekEndIso,
          weekly_plan_suggestions: nextWeeklyPlan,
        }),
      });
      let payload: WeeklyPlanUpdateResponse = {};
      try {
        payload = (await response.json()) as WeeklyPlanUpdateResponse;
      } catch {
        payload = {};
      }
      if (!response.ok) {
        throw new Error(
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : `Could not save weekly plan (${response.status}).`
        );
      }
      const savedPlan = Array.isArray(payload.weekly_plan_suggestions)
        ? payload.weekly_plan_suggestions
        : nextWeeklyPlan;
      setWeeklyPlanSuggestions(savedPlan);
      return savedPlan;
    } catch (e) {
      const anyErr = e as { message?: string };
      setGenerateError(typeof anyErr?.message === 'string' ? anyErr.message : 'Failed to save weekly plan.');
      return null;
    } finally {
      setIsSavingWeeklyPlan(false);
    }
  }

  async function handleRemoveWeeklyWorkout(planId: string) {
    const next = weeklyPlanSuggestions.filter((item) => item.id !== planId);
    await persistWeeklyPlan(next);
  }

  function openReplaceChooser(planId: string, currentLibraryWorkoutId: string) {
    setReplaceTargetPlanId(planId);
    setReplaceLibraryWorkoutId(currentLibraryWorkoutId);
  }

  function cancelReplaceChooser() {
    setReplaceTargetPlanId('');
    setReplaceLibraryWorkoutId('');
  }

  async function confirmReplaceWeeklyWorkout(planId: string) {
    if (!replaceLibraryWorkoutId) return;
    const next = weeklyPlanSuggestions.map((item) =>
      item.id === planId ? { ...item, library_workout_id: replaceLibraryWorkoutId } : item
    );
    const saved = await persistWeeklyPlan(next);
    if (saved) cancelReplaceChooser();
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

  function handleThisWeekClick() {
    const next = startOfWeek(new Date());
    setWeekStartDate(next);
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

      <div className="df-calendarMain" style={{ position: 'relative' }}>
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
                {`${scheduledWorkoutCount} workouts a week`}
              </div>
            </div>
            <div className="df-workoutWeekGrid">
              {weekCards.map((card) => {
                const daySuggestions = suggestionsByDay.get(card.dateIso) || [];
                const item = daySuggestions[0];
                const libraryWorkout = item ? libraryById.get(item.library_workout_id) : undefined;
                const canOpenWeeklyDetails = Boolean(item && libraryWorkout);
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
                        <button type="button" className="df-workoutAddBtn">
                          + Add
                        </button>
                        <div className="df-weeklyPlanActions">
                          <button
                            type="button"
                            className="df-weeklyPlanActionBtn"
                            disabled={isSavingWeeklyPlan}
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleRemoveWeeklyWorkout(item.id);
                            }}
                            aria-label={`Remove ${libraryWorkout?.title || 'workout'} from weekly plan`}
                          >
                            Remove
                          </button>
                          <button
                            type="button"
                            className="df-weeklyPlanActionBtn"
                            disabled={isSavingWeeklyPlan || workoutLibrary.length === 0}
                            onClick={(event) => {
                              event.stopPropagation();
                              openReplaceChooser(item.id, item.library_workout_id);
                            }}
                            aria-label={`Replace ${libraryWorkout?.title || 'workout'} in weekly plan`}
                          >
                            Replace
                          </button>
                        </div>
                        {replaceTargetPlanId === item.id && (
                          <div className="df-weeklyPlanReplaceRow" onClick={(event) => event.stopPropagation()}>
                            <select
                              className="df-select"
                              value={replaceLibraryWorkoutId}
                              onChange={(event) => setReplaceLibraryWorkoutId(event.target.value)}
                            >
                              {workoutLibrary.map((libItem) => (
                                <option key={libItem.id} value={libItem.id}>
                                  {libItem.title} ({libItem.duration_minutes} min)
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="df-weeklyPlanActionBtn"
                              disabled={!replaceLibraryWorkoutId || isSavingWeeklyPlan}
                              onClick={() => void confirmReplaceWeeklyWorkout(item.id)}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              className="df-weeklyPlanActionBtn"
                              disabled={isSavingWeeklyPlan}
                              onClick={cancelReplaceChooser}
                            >
                              Cancel
                            </button>
                          </div>
                        )}
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
        initialName={displayName}
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
    </section>
  );
}
