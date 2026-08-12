import React from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import ProfileSettingsModal from '../Home/ProfileSettingsModal';
import AppSidebar, { useSidebarCollapsed } from '../Sidebar/AppSidebar';
import { buildApiUrl } from '../../services/api';
import { pastelTagStyle } from '../shared/pastelTags';
import StressBreaksQuestionnaireWizard from './StressBreaksQuestionnaireWizard';
import StressBreaksPreferencesModal from './StressBreaksPreferencesModal';
import ActivityLibrarySection from './ActivityLibrarySection';
import {
  EMPTY_STRESS_BREAKS_FORM,
  stressBreaksPreferencesFromApi,
  type StressBreaksPreferences,
} from './stressBreaksPreferences';
import {
  activityFavoriteKey,
  activityMatchSignature,
  categoryDisplayLabel,
  normalizeActivityList,
  type StressActivitiesResponse,
  type StressActivity,
} from './activityCategories';

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

  const [timedActivities, setTimedActivities] = React.useState<StressActivity[]>([]);
  const [flexibleActivities, setFlexibleActivities] = React.useState<StressActivity[]>([]);
  const [favoriteActivities, setFavoriteActivities] = React.useState<StressActivity[]>([]);
  const [hasLibrary, setHasLibrary] = React.useState(false);
  const [isLoadingLibrary, setIsLoadingLibrary] = React.useState(false);
  const [libraryLoadError, setLibraryLoadError] = React.useState('');
  const [isGenerating, setIsGenerating] = React.useState(false);
  const [generateError, setGenerateError] = React.useState('');
  const [favoriteError, setFavoriteError] = React.useState('');
  const [isTogglingFavorite, setIsTogglingFavorite] = React.useState(false);
  const [selectedActivity, setSelectedActivity] = React.useState<StressActivity | null>(null);

  const effectiveName = displayName.trim() || username || 'User';
  const questionnaireCompleted = stressBreaks?.questionnaire_completed === true;
  const showQuestionnaire =
    preferencesLoadState === 'ready' && !questionnaireCompleted;

  const favoriteKeySet = React.useMemo(() => {
    const keys = new Set<string>();
    for (const item of favoriteActivities) {
      const key = activityFavoriteKey(item);
      if (key) keys.add(key);
    }
    return keys;
  }, [favoriteActivities]);

  const favoriteSignatureSet = React.useMemo(() => {
    const keys = new Set<string>();
    for (const item of favoriteActivities) {
      keys.add(activityMatchSignature(item));
    }
    return keys;
  }, [favoriteActivities]);

  function applyLibraryPayload(payload: StressActivitiesResponse) {
    const timed = normalizeActivityList(payload.timed_activities);
    const flexible = normalizeActivityList(payload.flexible_activities);
    const favorites = normalizeActivityList(payload.favorite_activities);
    setTimedActivities(timed);
    setFlexibleActivities(flexible);
    setFavoriteActivities(favorites);
    setHasLibrary(
      payload.has_library === true || timed.length > 0 || flexible.length > 0
    );
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

  async function loadActivityLibrary(): Promise<void> {
    const token = await getAuthToken();
    const response = await fetch(buildApiUrl('/stress/activities'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    let payload: StressActivitiesResponse = {};
    try {
      payload = (await response.json()) as StressActivitiesResponse;
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const message =
        typeof payload.message === 'string' && payload.message.trim()
          ? payload.message
          : `Could not load activity library (${response.status}).`;
      throw new Error(message);
    }
    applyLibraryPayload(payload);
  }

  async function generateActivities(): Promise<void> {
    setIsGenerating(true);
    setGenerateError('');
    setFavoriteError('');
    try {
      const token = await getAuthToken();
      const response = await fetch(buildApiUrl('/stress/activities/generate'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      let payload: StressActivitiesResponse = {};
      try {
        payload = (await response.json()) as StressActivitiesResponse;
      } catch {
        payload = {};
      }
      if (!response.ok) {
        const message =
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : `Could not generate activities (${response.status}).`;
        throw new Error(message);
      }
      applyLibraryPayload(payload);
    } catch (e) {
      const anyErr = e as { message?: string };
      setGenerateError(
        typeof anyErr?.message === 'string' && anyErr.message.trim()
          ? anyErr.message
          : 'Could not generate activities.'
      );
    } finally {
      setIsGenerating(false);
    }
  }

  async function toggleFavorite(activity: StressActivity): Promise<void> {
    setIsTogglingFavorite(true);
    setFavoriteError('');
    try {
      const token = await getAuthToken();
      const response = await fetch(buildApiUrl('/stress/activities'), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: 'toggle_favorite',
          activity,
        }),
      });
      let payload: { favorite_activities?: unknown; message?: string } = {};
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        payload = {};
      }
      if (!response.ok) {
        const message =
          typeof payload.message === 'string' && payload.message.trim()
            ? payload.message
            : `Could not update favorite (${response.status}).`;
        throw new Error(message);
      }
      setFavoriteActivities(normalizeActivityList(payload.favorite_activities));
    } catch (e) {
      const anyErr = e as { message?: string };
      setFavoriteError(
        typeof anyErr?.message === 'string' && anyErr.message.trim()
          ? anyErr.message
          : 'Could not update favorite.'
      );
    } finally {
      setIsTogglingFavorite(false);
    }
  }

  React.useEffect(() => {
    let cancelled = false;
    setPreferencesLoadState('loading');
    setPreferencesLoadError('');
    void (async () => {
      try {
        const loaded = await loadProfile();
        if (cancelled) return;
        setPreferencesLoadState('ready');
        if (loaded.stressBreaks?.questionnaire_completed === true) {
          setIsLoadingLibrary(true);
          setLibraryLoadError('');
          try {
            await loadActivityLibrary();
          } catch (e) {
            const anyErr = e as { message?: string };
            if (!cancelled) {
              setLibraryLoadError(
                typeof anyErr?.message === 'string' && anyErr.message.trim()
                  ? anyErr.message
                  : 'Could not load activity library.'
              );
            }
          } finally {
            if (!cancelled) setIsLoadingLibrary(false);
          }
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
        const loaded = await loadProfile();
        setPreferencesLoadState('ready');
        if (loaded.stressBreaks?.questionnaire_completed === true) {
          setIsLoadingLibrary(true);
          setLibraryLoadError('');
          try {
            await loadActivityLibrary();
          } catch (e) {
            const anyErr = e as { message?: string };
            setLibraryLoadError(
              typeof anyErr?.message === 'string' && anyErr.message.trim()
                ? anyErr.message
                : 'Could not load activity library.'
            );
          } finally {
            setIsLoadingLibrary(false);
          }
        }
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

  function handleRetryLibraryLoad() {
    setIsLoadingLibrary(true);
    setLibraryLoadError('');
    void (async () => {
      try {
        await loadActivityLibrary();
      } catch (e) {
        const anyErr = e as { message?: string };
        setLibraryLoadError(
          typeof anyErr?.message === 'string' && anyErr.message.trim()
            ? anyErr.message
            : 'Could not load activity library.'
        );
      } finally {
        setIsLoadingLibrary(false);
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
            <ActivityLibrarySection
              timedActivities={timedActivities}
              flexibleActivities={flexibleActivities}
              favoriteKeySet={favoriteKeySet}
              favoriteSignatureSet={favoriteSignatureSet}
              hasLibrary={hasLibrary}
              isLoadingLibrary={isLoadingLibrary}
              libraryLoadError={libraryLoadError}
              isGenerating={isGenerating}
              generateError={generateError}
              favoriteError={favoriteError}
              isTogglingFavorite={isTogglingFavorite}
              onGenerate={() => void generateActivities()}
              onRetryLoad={handleRetryLibraryLoad}
              onToggleFavorite={(activity) => void toggleFavorite(activity)}
              onOpenDetail={setSelectedActivity}
            />
          )}
        </div>
      </div>

      {showQuestionnaire && (
        <StressBreaksQuestionnaireWizard
          onSave={saveStressBreaksPreferences}
          onCompleted={(saved) => {
            setStressBreaks(saved);
            setHasLibrary(false);
            setTimedActivities([]);
            setFlexibleActivities([]);
            setLibraryLoadError('');
            setIsLoadingLibrary(true);
            void (async () => {
              try {
                await loadActivityLibrary();
              } catch (e) {
                const anyErr = e as { message?: string };
                setLibraryLoadError(
                  typeof anyErr?.message === 'string' && anyErr.message.trim()
                    ? anyErr.message
                    : 'Could not load activity library.'
                );
              } finally {
                setIsLoadingLibrary(false);
              }
            })();
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

      {selectedActivity && (
        <div
          className="df-modalBackdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelectedActivity(null);
          }}
        >
          <div
            className="df-modalPanel"
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedActivity.title} details`}
          >
            <div className="df-modalHeader">
              <div className="df-modalTitle">{selectedActivity.title}</div>
              <button
                type="button"
                className="df-iconBtn"
                onClick={() => setSelectedActivity(null)}
                aria-label="Close activity details"
              >
                ✕
              </button>
            </div>
            <div className="df-settingsContent" style={{ display: 'grid', gap: 12, maxHeight: '70vh', overflowY: 'auto' }}>
              <div>
                <span
                  className="df-workoutTypePill"
                  style={pastelTagStyle(
                    categoryDisplayLabel(selectedActivity.category, selectedActivity.category_label)
                  )}
                >
                  {categoryDisplayLabel(selectedActivity.category, selectedActivity.category_label)}
                </span>
              </div>
              <div className="df-workoutMeta">
                {selectedActivity.kind === 'flexible' || selectedActivity.duration_minutes == null
                  ? 'Flexible'
                  : `${selectedActivity.duration_minutes} min`}
              </div>
              <p className="df-subtitle" style={{ margin: 0 }}>
                {selectedActivity.summary_short}
              </p>
              {selectedActivity.instructions && selectedActivity.instructions.length > 0 ? (
                <div>
                  <div className="df-fieldLabel" style={{ marginBottom: 8 }}>
                    Instructions
                  </div>
                  <ol style={{ margin: 0, paddingInlineStart: 18, display: 'grid', gap: 6 }}>
                    {selectedActivity.instructions.map((step, idx) => (
                      <li key={`${selectedActivity.id}-step-${idx}`}>{step}</li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

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
