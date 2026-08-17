import React from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchAuthSession } from 'aws-amplify/auth';
import ProfileSettingsModal from '../Home/ProfileSettingsModal';
import AppSidebar, { ClockIcon, useSidebarCollapsed } from '../Sidebar/AppSidebar';
import { buildApiUrl } from '../../services/api';

type OverviewScreenProps = {
  username?: string;
  onLogout?: () => Promise<void>;
};

type OverviewTab = 'summary' | 'insights';

type ScheduledWorkoutItem = {
  id: string;
  title: string;
  date: string;
  start_time: string;
  completed: boolean;
};

type BusyDay = {
  date: string;
  day_label: string;
};

type InsightKind = 'observation' | 'progress' | 'suggestion';

type WeeklyInsight = {
  id: string;
  kind: InsightKind;
  text: string;
};

type InsightsResponse = {
  week_start?: string;
  week_end?: string;
  insights?: WeeklyInsight[];
  message?: string;
};

const INSIGHT_KIND_LABELS: Record<InsightKind, string> = {
  observation: 'Observation',
  progress: 'Progress',
  suggestion: 'Suggestion',
};

type OverviewResponse = {
  week_start?: string;
  week_end?: string;
  workouts?: {
    weekly_goal?: number;
    scheduled_count?: number;
    scheduled_items?: ScheduledWorkoutItem[];
  };
  meals?: {
    scheduled_count?: number;
  };
  stress_breaks?: {
    scheduled_count?: number;
    busy_days?: BusyDay[];
  };
  message?: string;
};

const ENGLISH_DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

function formatIsoDayLabel(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const parsed = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return `${ENGLISH_DAY_NAMES[parsed.getDay()]} ${parsed.getDate()}.${parsed.getMonth() + 1}`;
}

function formatWeekRangeLabel(weekStartIso: string, weekEndIso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStartIso) || !/^\d{4}-\d{2}-\d{2}$/.test(weekEndIso)) return '';
  const start = new Date(`${weekStartIso}T00:00:00`);
  const end = new Date(`${weekEndIso}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
  return `${start.getDate()}.${start.getMonth() + 1}-${end.getDate()}.${end.getMonth() + 1}`;
}

function formatHHmm(value: string): string {
  const raw = value.trim();
  if (raw.length >= 5 && raw[2] === ':') return raw.slice(0, 5);
  return raw;
}

function OverviewWorkoutsGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.5" y="9" width="3" height="6" rx="1" />
      <rect x="18.5" y="9" width="3" height="6" rx="1" />
      <rect x="5.5" y="7" width="3" height="10" rx="1.2" />
      <rect x="15.5" y="7" width="3" height="10" rx="1.2" />
      <line x1="8.5" y1="12" x2="15.5" y2="12" />
    </svg>
  );
}

function OverviewMealsGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <ellipse cx="7.5" cy="6.5" rx="2.5" ry="3" />
      <line x1="7.5" y1="9.5" x2="7.5" y2="20" />
      <line x1="14" y1="4" x2="14" y2="8" />
      <line x1="16.5" y1="4" x2="16.5" y2="8" />
      <line x1="19" y1="4" x2="19" y2="8" />
      <path d="M14 8h5v2a2.5 2.5 0 0 1-2.5 2.5L16.5 20" />
    </svg>
  );
}

function OverviewStressGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3c2.5 2.2 4 4.5 4 7a4 4 0 1 1-8 0c0-2.5 1.5-4.8 4-7z" />
      <path d="M9 17c.6.9 1.7 1.5 3 1.5s2.4-.6 3-1.5" />
    </svg>
  );
}

function RefreshIcon(props: { size?: number; spinning?: boolean }) {
  const size = props.size ?? 16;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={props.spinning ? 'df-stressRefreshIconSpin' : undefined}
    >
      <path d="M21 12a9 9 0 1 1-3.2-6.8" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}

function asScheduledItems(raw: unknown): ScheduledWorkoutItem[] {
  if (!Array.isArray(raw)) return [];
  const items: ScheduledWorkoutItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const date = typeof o.date === 'string' ? o.date.trim() : '';
    const startTime = typeof o.start_time === 'string' ? o.start_time.trim() : '';
    if (!id || !date) continue;
    items.push({
      id,
      title: title || 'Workout',
      date,
      start_time: startTime,
      completed: o.completed === true,
    });
  }
  return items;
}

function asBusyDays(raw: unknown): BusyDay[] {
  if (!Array.isArray(raw)) return [];
  const days: BusyDay[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const date = typeof o.date === 'string' ? o.date.trim() : '';
    const dayLabel = typeof o.day_label === 'string' ? o.day_label.trim() : '';
    if (!date || seen.has(date)) continue;
    seen.add(date);
    days.push({ date, day_label: dayLabel || formatIsoDayLabel(date) });
  }
  return days;
}

function asInsightKind(value: unknown): InsightKind {
  return value === 'progress' || value === 'suggestion' || value === 'observation' ? value : 'observation';
}

function asWeeklyInsights(raw: unknown): WeeklyInsight[] {
  if (!Array.isArray(raw)) return [];
  const insights: WeeklyInsight[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    insights.push({
      id: typeof o.id === 'string' && o.id.trim() ? o.id.trim() : `insight_${insights.length + 1}`,
      kind: asInsightKind(o.kind),
      text,
    });
    if (insights.length >= 7) break;
  }
  return insights;
}

export default function OverviewScreen(props: OverviewScreenProps) {
  const { username, onLogout } = props;
  const navigate = useNavigate();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useSidebarCollapsed();
  const [isProfileSettingsOpen, setIsProfileSettingsOpen] = React.useState<boolean>(false);
  const [isLoggingOut, setIsLoggingOut] = React.useState<boolean>(false);
  const [displayName, setDisplayName] = React.useState<string>('');
  const [profileImageUrl, setProfileImageUrl] = React.useState<string>('');
  const [savedQuestionnaire, setSavedQuestionnaire] = React.useState<Record<string, unknown> | null>(null);
  const [activeTab, setActiveTab] = React.useState<OverviewTab>('summary');
  const [isLoading, setIsLoading] = React.useState<boolean>(true);
  const [loadError, setLoadError] = React.useState<string>('');
  const [completionError, setCompletionError] = React.useState<string>('');
  const [weekStart, setWeekStart] = React.useState<string>('');
  const [weekEnd, setWeekEnd] = React.useState<string>('');
  const [weeklyGoal, setWeeklyGoal] = React.useState<number>(0);
  const [scheduledWorkouts, setScheduledWorkouts] = React.useState<ScheduledWorkoutItem[]>([]);
  const [mealsCount, setMealsCount] = React.useState<number>(0);
  const [breaksCount, setBreaksCount] = React.useState<number>(0);
  const [busyDays, setBusyDays] = React.useState<BusyDay[]>([]);
  const [savingCompletedIds, setSavingCompletedIds] = React.useState<Record<string, boolean>>({});
  const [insights, setInsights] = React.useState<WeeklyInsight[]>([]);
  const [insightsError, setInsightsError] = React.useState<string>('');
  const [isGeneratingInsights, setIsGeneratingInsights] = React.useState<boolean>(false);
  const hasRequestedInsightsRef = React.useRef(false);
  const insightsRequestIdRef = React.useRef(0);

  const effectiveName = displayName || username || 'there';

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
    const token = await getAuthToken();
    const response = await fetch(buildApiUrl('/profile'), {
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

  async function loadOverview(): Promise<void> {
    setIsLoading(true);
    setLoadError('');
    setCompletionError('');
    try {
      const token = await getAuthToken();
      const response = await fetch(buildApiUrl('/overview'), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      let payload: OverviewResponse = {};
      try {
        payload = (await response.json()) as OverviewResponse;
      } catch {
        payload = {};
      }
      if (!response.ok) {
        const message =
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : `Could not load overview (${response.status}).`;
        throw new Error(message);
      }
      setWeekStart(typeof payload.week_start === 'string' ? payload.week_start : '');
      setWeekEnd(typeof payload.week_end === 'string' ? payload.week_end : '');
      const workouts = payload.workouts && typeof payload.workouts === 'object' ? payload.workouts : {};
      setWeeklyGoal(typeof workouts.weekly_goal === 'number' ? workouts.weekly_goal : 0);
      setScheduledWorkouts(asScheduledItems(workouts.scheduled_items));
      const meals = payload.meals && typeof payload.meals === 'object' ? payload.meals : {};
      setMealsCount(typeof meals.scheduled_count === 'number' ? meals.scheduled_count : 0);
      const stress = payload.stress_breaks && typeof payload.stress_breaks === 'object' ? payload.stress_breaks : {};
      setBreaksCount(typeof stress.scheduled_count === 'number' ? stress.scheduled_count : 0);
      setBusyDays(asBusyDays(stress.busy_days));
    } catch (e) {
      const anyErr = e as { message?: string };
      setLoadError(
        typeof anyErr?.message === 'string' && anyErr.message.trim()
          ? anyErr.message
          : 'Could not load overview.'
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function loadInsights(): Promise<void> {
    const requestId = insightsRequestIdRef.current + 1;
    insightsRequestIdRef.current = requestId;
    hasRequestedInsightsRef.current = true;
    setIsGeneratingInsights(true);
    setInsightsError('');
    try {
      const token = await getAuthToken();
      const response = await fetch(buildApiUrl('/overview/insights'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ refresh: true }),
      });
      let payload: InsightsResponse = {};
      try {
        payload = (await response.json()) as InsightsResponse;
      } catch {
        payload = {};
      }
      if (insightsRequestIdRef.current !== requestId) return;
      if (!response.ok) {
        const message =
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : `Could not generate insights (${response.status}).`;
        throw new Error(message);
      }
      const nextInsights = asWeeklyInsights(payload.insights);
      if (nextInsights.length < 3) {
        throw new Error('Insights are currently unavailable. Please try again.');
      }
      setInsights(nextInsights);
    } catch (e) {
      if (insightsRequestIdRef.current !== requestId) return;
      const anyErr = e as { message?: string };
      setInsightsError(
        typeof anyErr?.message === 'string' && anyErr.message.trim()
          ? anyErr.message
          : 'Could not generate insights.'
      );
    } finally {
      if (insightsRequestIdRef.current === requestId) {
        setIsGeneratingInsights(false);
      }
    }
  }

  async function handleToggleCompleted(workoutId: string, nextCompleted: boolean): Promise<void> {
    if (savingCompletedIds[workoutId]) return;
    const previous = scheduledWorkouts;
    setCompletionError('');
    setScheduledWorkouts((items) =>
      items.map((item) => (item.id === workoutId ? { ...item, completed: nextCompleted } : item))
    );
    setSavingCompletedIds((current) => ({ ...current, [workoutId]: true }));
    try {
      const token = await getAuthToken();
      const response = await fetch(buildApiUrl('/overview'), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ workout_id: workoutId, completed: nextCompleted }),
      });
      let payload: { message?: string } = {};
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        payload = {};
      }
      if (!response.ok) {
        throw new Error(
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : `Could not save completion (${response.status}).`
        );
      }
    } catch (e) {
      setScheduledWorkouts(previous);
      const anyErr = e as { message?: string };
      setCompletionError(
        typeof anyErr?.message === 'string' && anyErr.message.trim()
          ? anyErr.message
          : 'Could not save completion.'
      );
    } finally {
      setSavingCompletedIds((current) => {
        const next = { ...current };
        delete next[workoutId];
        return next;
      });
    }
  }

  function isCardNavigationEvent(event: { target: EventTarget | null }): boolean {
    const target = event.target as HTMLElement | null;
    return !target?.closest('label, input, button');
  }

  async function handleLogoutClick() {
    setIsLoggingOut(true);
    try {
      if (onLogout) await onLogout();
    } catch (e) {
      const anyErr = e as { message?: string };
      setLoadError(
        anyErr && typeof anyErr.message === 'string' ? anyErr.message : 'Failed to sign out. Please try again.'
      );
    } finally {
      setIsLoggingOut(false);
    }
  }

  React.useEffect(() => {
    void (async () => {
      try {
        await loadProfile();
      } catch {
        // Keep username fallback when profile cannot be loaded.
      }
      await loadOverview();
    })();
  }, []);

  React.useEffect(() => {
    if (activeTab !== 'insights' || hasRequestedInsightsRef.current) return;
    void loadInsights();
  }, [activeTab]);

  const weekRangeLabel = weekStart && weekEnd ? formatWeekRangeLabel(weekStart, weekEnd) : '';
  const scheduledCount = scheduledWorkouts.length;
  const busyDayLabels = busyDays.map((day) => day.day_label).join(', ');

  return (
    <section
      className={`df-calendarPage df-workoutsPage${isSidebarCollapsed ? ' df-calendarPageNavCollapsed' : ''}`}
      aria-label="DailyFlow overview screen"
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
            {weekRangeLabel ? (
              <h1 className="df-overviewPageTitle">This week {weekRangeLabel}</h1>
            ) : null}
          </div>
          <div className="df-calendarTopbarRight">
            <button type="button" className="df-btn" onClick={() => void handleLogoutClick()} disabled={isLoggingOut}>
              {isLoggingOut ? 'Signing out...' : 'Log out'}
            </button>
          </div>
        </header>

        <div className="df-workoutsContent">
          <div className="df-overviewTabs" role="tablist" aria-label="Overview sections">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'summary'}
              className={`df-workoutFilterChip${activeTab === 'summary' ? ' df-workoutFilterChipActive' : ''}`}
              onClick={() => setActiveTab('summary')}
            >
              Summary
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'insights'}
              className={`df-workoutFilterChip${activeTab === 'insights' ? ' df-workoutFilterChipActive' : ''}`}
              onClick={() => {
                if (!hasRequestedInsightsRef.current) setIsGeneratingInsights(true);
                setActiveTab('insights');
              }}
            >
              Insights
            </button>
          </div>

          {activeTab === 'summary' && (
            <section className="df-workoutsSection" role="tabpanel" aria-label="Summary">
              {isLoading && <div className="df-calendarLegend">Loading current week…</div>}
              {loadError && (
                <div className="df-errorText" role="alert">
                  {loadError}
                </div>
              )}
              {!isLoading && !loadError && (
                <div className="df-overviewCardGrid">
                  <article
                    className="df-overviewCard df-overviewCardWorkouts"
                    role="link"
                    tabIndex={0}
                    aria-label="Open Workouts"
                    onClick={(event) => {
                      if (isCardNavigationEvent(event)) navigate('/workouts');
                    }}
                    onKeyDown={(event) => {
                      if (!isCardNavigationEvent(event)) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        navigate('/workouts');
                      }
                    }}
                  >
                    <div className="df-overviewCardHeader">
                      <span className="df-overviewCardIcon" aria-hidden>
                        <OverviewWorkoutsGlyph />
                      </span>
                      <h2 className="df-overviewCardTitle">Workouts</h2>
                    </div>
                    <p className="df-overviewCardMetric">
                      {scheduledCount} / {weeklyGoal} scheduled
                    </p>
                    {completionError && (
                      <div className="df-errorText" role="alert">
                        {completionError}
                      </div>
                    )}
                    {scheduledWorkouts.length === 0 ? (
                      <p className="df-overviewCardEmpty">No workouts added to Google Calendar this week.</p>
                    ) : (
                      <ul className="df-overviewWorkoutList">
                        {scheduledWorkouts.map((item) => (
                          <li key={item.id} className="df-overviewWorkoutRow">
                            <label className="df-overviewCompleted">
                              <input
                                type="checkbox"
                                checked={item.completed}
                                disabled={Boolean(savingCompletedIds[item.id])}
                                aria-label={`Mark ${item.title} completed`}
                                onChange={(event) => {
                                  void handleToggleCompleted(item.id, event.target.checked);
                                }}
                              />
                            </label>
                            <div className="df-overviewWorkoutMain">
                              <div className="df-overviewWorkoutTitleRow">
                                <span className="df-overviewWorkoutName">{item.title}</span>
                              </div>
                              <span className="df-overviewWorkoutMeta">
                                {formatIsoDayLabel(item.date)}
                                {item.start_time ? (
                                  <>
                                    <span className="df-inlineIcon" aria-hidden>
                                      <ClockIcon size={13} />
                                    </span>
                                    {formatHHmm(item.start_time)}
                                  </>
                                ) : null}
                              </span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </article>

                  <article
                    className="df-overviewCard df-overviewCardMeals"
                    role="link"
                    tabIndex={0}
                    aria-label="Open Meals & Grocery"
                    onClick={() => navigate('/meals')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        navigate('/meals');
                      }
                    }}
                  >
                    <div className="df-overviewCardHeader">
                      <span className="df-overviewCardIcon" aria-hidden>
                        <OverviewMealsGlyph />
                      </span>
                      <h2 className="df-overviewCardTitle">Meals</h2>
                    </div>
                    <p className="df-overviewCardMetric">
                      {mealsCount} {mealsCount === 1 ? 'meal' : 'meals'} scheduled
                    </p>
                  </article>

                  <article
                    className="df-overviewCard df-overviewCardStress"
                    role="link"
                    tabIndex={0}
                    aria-label="Open Stress & Breaks"
                    onClick={() => navigate('/stress')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        navigate('/stress');
                      }
                    }}
                  >
                    <div className="df-overviewCardHeader">
                      <span className="df-overviewCardIcon" aria-hidden>
                        <OverviewStressGlyph />
                      </span>
                      <h2 className="df-overviewCardTitle">Stress & Breaks</h2>
                    </div>
                    <p className="df-overviewCardMetric">
                      {breaksCount} {breaksCount === 1 ? 'break' : 'breaks'} scheduled
                    </p>
                    <p className="df-overviewCardBusy">
                      Busy days: {busyDayLabels || 'none identified'}
                    </p>
                  </article>
                </div>
              )}
            </section>
          )}

          {activeTab === 'insights' && (
            <section className="df-workoutsSection" role="tabpanel" aria-label="Insights">
              <div className="df-overviewInsightsHeader">
                <h2 className="df-workoutsTitle">Weekly Insights</h2>
                <button
                  type="button"
                  className="df-iconBtn df-stressRefreshBtn"
                  onClick={() => void loadInsights()}
                  disabled={isGeneratingInsights}
                  aria-label="Refresh insights"
                  title="Refresh insights"
                >
                  <RefreshIcon size={16} spinning={isGeneratingInsights} />
                </button>
              </div>
              {insightsError ? (
                <div className="df-errorText" role="alert">
                  {insightsError}
                </div>
              ) : null}
              {!isGeneratingInsights && !insightsError && insights.length === 0 ? (
                <div className="df-overviewInsightsEmpty" role="status">
                  Weekly insights will appear here after they are generated.
                </div>
              ) : null}
              {insights.length > 0 ? (
                <ul className="df-overviewInsightList">
                  {insights.map((insight) => (
                    <li key={insight.id} className={`df-overviewInsightCard df-overviewInsightCard-${insight.kind}`}>
                      <span className="df-overviewInsightKind">{INSIGHT_KIND_LABELS[insight.kind]}</span>
                      <p className="df-overviewInsightText">{insight.text}</p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          )}
        </div>

        {isGeneratingInsights && (
          <div className="df-workoutsLoadingOverlay" role="status" aria-live="polite" aria-label="Generating insights">
            <div className="df-workoutsLoadingShade" aria-hidden />
            <div className="df-workoutsLoadingCenter">
              <div className="df-workoutsLoadingCard">
                <div className="df-workoutsBasicSpinner" aria-hidden />
                <div className="df-workoutsLoadingText">Generating insights...</div>
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
    </section>
  );
}
