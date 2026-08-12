import React from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import ProfileSettingsModal from '../Home/ProfileSettingsModal';
import AppSidebar, { useSidebarCollapsed } from '../Sidebar/AppSidebar';
import { buildApiUrl } from '../../services/api';
import StressBreaksQuestionnaireWizard from './StressBreaksQuestionnaireWizard';
import StressBreaksPreferencesModal from './StressBreaksPreferencesModal';
import {
  EMPTY_STRESS_BREAKS_FORM,
  stressBreaksPreferencesFromApi,
  type StressBreaksPreferences,
} from './stressBreaksPreferences';

type StressBreaksScreenProps = {
  username?: string;
  onLogout?: () => Promise<void>;
};

type PreferencesLoadState = 'loading' | 'ready' | 'error';

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

  const effectiveName = displayName.trim() || username || 'User';
  const questionnaireCompleted = stressBreaks?.questionnaire_completed === true;
  const showQuestionnaire =
    preferencesLoadState === 'ready' && !questionnaireCompleted;

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

  React.useEffect(() => {
    let cancelled = false;
    setPreferencesLoadState('loading');
    setPreferencesLoadError('');
    void (async () => {
      try {
        await loadProfile();
        if (!cancelled) {
          setPreferencesLoadState('ready');
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
        await loadProfile();
        setPreferencesLoadState('ready');
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
            <h1 className="df-workoutsTitle" style={{ margin: 0, fontSize: 22 }}>
              Stress &amp; Breaks
            </h1>
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
            <section className="df-workoutsSection">
              <div className="df-workoutsSectionHeader">
                <h2 className="df-workoutsTitle" style={{ fontSize: 20, margin: 0 }}>
                  Preferences saved
                </h2>
              </div>
              <p className="df-subtitle" style={{ marginTop: 8 }}>
                Your Stress &amp; Breaks preferences are ready. Use Edit Preferences anytime to update them.
              </p>
            </section>
          )}
        </div>
      </div>

      {showQuestionnaire && (
        <StressBreaksQuestionnaireWizard
          onSave={saveStressBreaksPreferences}
          onCompleted={(saved) => {
            setStressBreaks(saved);
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
