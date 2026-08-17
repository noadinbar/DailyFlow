import React from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import ProfileSettingsModal from '../Home/ProfileSettingsModal';
import AppSidebar, { useSidebarCollapsed } from '../Sidebar/AppSidebar';
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
};

type BusyDay = {
  date: string;
  day_label: string;
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

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatIsoDayLabel(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const parsed = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return `${ENGLISH_DAY_NAMES[parsed.getDay()]} ${pad2(parsed.getDate())}.${pad2(parsed.getMonth() + 1)}`;
}

function formatWeekRangeLabel(weekStartIso: string, weekEndIso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStartIso) || !/^\d{4}-\d{2}-\d{2}$/.test(weekEndIso)) return '';
  const start = new Date(`${weekStartIso}T00:00:00`);
  const end = new Date(`${weekEndIso}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
  const startDay = start.getDate();
  const endDay = end.getDate();
  const startMonth = start.getMonth() + 1;
  const endMonth = end.getMonth() + 1;
  if (startMonth === endMonth) return `${startDay}-${endDay}.${endMonth}`;
  return `${startDay}.${startMonth}-${endDay}.${endMonth}`;
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
    items.push({ id, title: title || 'Workout', date, start_time: startTime });
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

export default function OverviewScreen(props: OverviewScreenProps) {
  const { username, onLogout } = props;
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useSidebarCollapsed();
  const [isProfileSettingsOpen, setIsProfileSettingsOpen] = React.useState<boolean>(false);
  const [isLoggingOut, setIsLoggingOut] = React.useState<boolean>(false);
  const [displayName, setDisplayName] = React.useState<string>('');
  const [profileImageUrl, setProfileImageUrl] = React.useState<string>('');
  const [savedQuestionnaire, setSavedQuestionnaire] = React.useState<Record<string, unknown> | null>(null);
  const [activeTab, setActiveTab] = React.useState<OverviewTab>('summary');
  const [isLoading, setIsLoading] = React.useState<boolean>(true);
  const [loadError, setLoadError] = React.useState<string>('');
  const [weekStart, setWeekStart] = React.useState<string>('');
  const [weekEnd, setWeekEnd] = React.useState<string>('');
  const [weeklyGoal, setWeeklyGoal] = React.useState<number>(0);
  const [scheduledWorkouts, setScheduledWorkouts] = React.useState<ScheduledWorkoutItem[]>([]);
  const [mealsCount, setMealsCount] = React.useState<number>(0);
  const [breaksCount, setBreaksCount] = React.useState<number>(0);
  const [busyDays, setBusyDays] = React.useState<BusyDay[]>([]);

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
              onClick={() => setActiveTab('insights')}
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
                <div className="df-overviewTempGrid">
                  <article className="df-overviewTempCard">
                    <h2 className="df-overviewTempTitle">Workouts</h2>
                    <p className="df-overviewTempMetric">
                      {scheduledCount} / {weeklyGoal} scheduled
                    </p>
                    {scheduledWorkouts.length === 0 ? (
                      <p className="df-overviewTempEmpty">No current-week workouts added to Google Calendar.</p>
                    ) : (
                      <ul className="df-overviewTempList">
                        {scheduledWorkouts.map((item) => (
                          <li key={item.id}>
                            {item.title} · {formatIsoDayLabel(item.date)} · {item.start_time}
                          </li>
                        ))}
                      </ul>
                    )}
                  </article>
                  <article className="df-overviewTempCard">
                    <h2 className="df-overviewTempTitle">Meals</h2>
                    <p className="df-overviewTempMetric">{mealsCount} scheduled</p>
                  </article>
                  <article className="df-overviewTempCard">
                    <h2 className="df-overviewTempTitle">Stress & Breaks</h2>
                    <p className="df-overviewTempMetric">{breaksCount} breaks scheduled</p>
                    <p className="df-overviewTempMeta">
                      Busy days: {busyDayLabels || 'none identified'}
                    </p>
                  </article>
                </div>
              )}
            </section>
          )}

          {activeTab === 'insights' && (
            <section className="df-workoutsSection" role="tabpanel" aria-label="Insights">
              <div className="df-calendarLegend">Insights will appear here in a later phase.</div>
            </section>
          )}
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
