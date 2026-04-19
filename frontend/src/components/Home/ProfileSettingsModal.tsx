import React from 'react';
import {
  ACTIVITY_OPTIONS,
  AGE_RANGE_OPTIONS,
  AUTO_SCHEDULE_OPTIONS,
  BREAK_MEDITATION_OPTIONS,
  DIETARY_OPTIONS,
  type QuestionnaireForm,
  EMPTY_QUESTIONNAIRE,
  FITNESS_OPTIONS,
  MAIN_GOAL_OPTIONS,
  STATUS_OPTIONS,
  WORKOUT_TIME_OPTIONS,
  WORKOUT_TYPE_OPTIONS,
  buildQuestionnairePatchPayload,
  coerceExclusiveMultiSelect,
  questionnaireFromApi,
  validateQuestionnaireFormComplete,
} from './questionnairePreferences';

// Matches backend/profile/profile_image_upload_url.py allowed types.
const PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const PROFILE_IMAGE_ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function validateProfileImageFile(file: File): string | null {
  const type = (file.type || '').toLowerCase().trim();
  if (!type || !PROFILE_IMAGE_ALLOWED_TYPES.has(type)) {
    return 'Please choose a JPEG, PNG, WebP, or GIF image.';
  }
  if (file.size > PROFILE_IMAGE_MAX_BYTES) {
    return `Image must be ${PROFILE_IMAGE_MAX_BYTES / (1024 * 1024)} MB or smaller.`;
  }
  return null;
}

type SettingsTab = 'profile' | 'preferences';

type ProfileSettingsModalProps = {
  isOpen: boolean;
  initialName: string;
  /** Presigned GET URL from GET /profile; updates when parent loads profile. */
  savedProfileImageUrl?: string;
  /** Questionnaire fields from GET /profile `questionnaire` (optional). */
  savedQuestionnaire?: Record<string, unknown> | null;
  onLoadProfile?: () => Promise<{
    displayName: string;
    profileImageUrl: string;
    questionnaire?: Record<string, unknown> | null;
  }>;
  onSaveDisplayName?: (nextName: string) => Promise<void>;
  onRequestProfileImageUploadUrl?: (args: { contentType: string }) => Promise<{
    uploadUrl: string;
    objectKey: string;
  }>;
  onSaveProfileImageKey?: (objectKey: string) => Promise<void>;
  /** PATCH /profile with questionnaire keys only (validated server-side). */
  onSaveQuestionnaire?: (patch: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
};

export default function ProfileSettingsModal(props: ProfileSettingsModalProps) {
  const {
    isOpen,
    initialName,
    savedProfileImageUrl = '',
    savedQuestionnaire = null,
    onClose,
    onLoadProfile,
    onSaveDisplayName,
    onRequestProfileImageUploadUrl,
    onSaveProfileImageKey,
    onSaveQuestionnaire,
  } = props;

  const [activeTab, setActiveTab] = React.useState<SettingsTab>('profile');
  const [name, setName] = React.useState<string>(initialName);
  const [localImageUrl, setLocalImageUrl] = React.useState<string>('');
  const [selectedImageFile, setSelectedImageFile] = React.useState<File | null>(null);
  const [isLoadingName, setIsLoadingName] = React.useState<boolean>(false);
  const [isSavingProfile, setIsSavingProfile] = React.useState<boolean>(false);
  const [saveError, setSaveError] = React.useState<string>('');
  const [saveSuccess, setSaveSuccess] = React.useState<string>('');
  const [imagePickError, setImagePickError] = React.useState<string>('');
  const [qForm, setQForm] = React.useState<QuestionnaireForm>(() => ({ ...EMPTY_QUESTIONNAIRE }));
  const [preferencesError, setPreferencesError] = React.useState<string>('');
  const [preferencesSuccess, setPreferencesSuccess] = React.useState<string>('');
  const [isSavingPreferences, setIsSavingPreferences] = React.useState<boolean>(false);

  const fileInputId = React.useId();
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (!isOpen) return;
    setActiveTab('profile');
    setName(initialName);
    setSaveError('');
    setSaveSuccess('');
    setSelectedImageFile(null);
    setImagePickError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    setQForm({ ...EMPTY_QUESTIONNAIRE });
    setPreferencesError('');
    setPreferencesSuccess('');
  }, [isOpen, initialName]);

  React.useEffect(() => {
    if (!isOpen) return;
    if (!onLoadProfile) return;

    let cancelled = false;
    setIsLoadingName(true);
    void (async () => {
      try {
        const loaded = await onLoadProfile();
        if (cancelled) return;
        const clean = typeof loaded.displayName === 'string' ? loaded.displayName.trim() : '';
        if (clean) setName(clean);
        if (loaded.questionnaire != null) {
          setQForm(questionnaireFromApi(loaded.questionnaire));
        }
      } finally {
        if (!cancelled) setIsLoadingName(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, onLoadProfile]);

  React.useEffect(() => {
    if (!isOpen) return;
    if (savedQuestionnaire != null) {
      setQForm(questionnaireFromApi(savedQuestionnaire));
    }
  }, [isOpen, savedQuestionnaire]);

  React.useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  React.useEffect(() => {
    if (!saveSuccess) return;
    const t = window.setTimeout(() => setSaveSuccess(''), 4500);
    return () => window.clearTimeout(t);
  }, [saveSuccess]);

  React.useEffect(() => {
    if (!preferencesSuccess) return;
    const t = window.setTimeout(() => setPreferencesSuccess(''), 4500);
    return () => window.clearTimeout(t);
  }, [preferencesSuccess]);

  React.useEffect(() => {
    return () => {
      if (localImageUrl) URL.revokeObjectURL(localImageUrl);
    };
  }, [localImageUrl]);

  function handleBackdropMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  function handleImageFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const validationError = validateProfileImageFile(file);
    if (validationError) {
      setImagePickError(validationError);
      e.target.value = '';
      return;
    }

    setImagePickError('');
    if (localImageUrl) URL.revokeObjectURL(localImageUrl);
    setLocalImageUrl(URL.createObjectURL(file));
    setSelectedImageFile(file);
    setSaveSuccess('');
  }

  async function handleSaveChangesClick() {
    if (!onSaveDisplayName) return;
    setSaveError('');
    setSaveSuccess('');
    setImagePickError('');
    setIsSavingProfile(true);
    try {
      await onSaveDisplayName(name);

      if (selectedImageFile && onRequestProfileImageUploadUrl && onSaveProfileImageKey) {
        const validationError = validateProfileImageFile(selectedImageFile);
        if (validationError) {
          setImagePickError(validationError);
          return;
        }

        const contentType = selectedImageFile.type;
        const { uploadUrl, objectKey } = await onRequestProfileImageUploadUrl({ contentType });

        const putResponse = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': contentType },
          body: selectedImageFile,
        });
        if (!putResponse.ok) {
          throw new Error(`Upload failed (${putResponse.status}).`);
        }

        await onSaveProfileImageKey(objectKey);
        setSelectedImageFile(null);
        if (localImageUrl) URL.revokeObjectURL(localImageUrl);
        setLocalImageUrl('');
        if (fileInputRef.current) fileInputRef.current.value = '';
      }

      setSaveSuccess('Changes saved.');
    } catch (e) {
      const anyErr = e as { message?: string };
      setSaveError(typeof anyErr?.message === 'string' ? anyErr.message : 'Could not save changes.');
    } finally {
      setIsSavingProfile(false);
    }
  }

  async function handleSavePreferencesClick() {
    if (!onSaveQuestionnaire) return;
    setPreferencesError('');
    setPreferencesSuccess('');
    if (!validateQuestionnaireFormComplete(qForm)) {
      setPreferencesError('Please fill every field before saving.');
      return;
    }
    const patch = buildQuestionnairePatchPayload(qForm);
    if (Object.keys(patch).length === 0) {
      setPreferencesError('Nothing to save.');
      return;
    }
    setIsSavingPreferences(true);
    try {
      await onSaveQuestionnaire(patch);
      setPreferencesSuccess('Preferences saved.');
    } catch (e) {
      const anyErr = e as { message?: string };
      setPreferencesError(
        typeof anyErr?.message === 'string' ? anyErr.message : 'Could not save preferences.'
      );
    } finally {
      setIsSavingPreferences(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div
      className="df-modalBackdrop"
      role="presentation"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className="df-modalPanel"
        role="dialog"
        aria-modal="true"
        aria-label="Profile settings"
      >
        <div className="df-modalHeader">
          <div className="df-modalTitle">Settings</div>
          <button type="button" className="df-iconBtn" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </div>

        <div className="df-settingsLayout">
          <nav className="df-settingsMenu" aria-label="Settings sections">
            <button
              type="button"
              className={`df-settingsMenuItem${activeTab === 'profile' ? ' df-settingsMenuItemActive' : ''}`}
              onClick={() => setActiveTab('profile')}
            >
              Profile
            </button>
            <button
              type="button"
              className={`df-settingsMenuItem${activeTab === 'preferences' ? ' df-settingsMenuItemActive' : ''}`}
              onClick={() => setActiveTab('preferences')}
            >
              Preferences
            </button>
          </nav>

          <section className="df-settingsContent" aria-label="Settings content">
            {activeTab === 'profile' && (
              <div className="df-settingsSection">
                <div className="df-settingsRow">
                  <div className="df-settingsAvatarPreview" aria-label="Profile image preview">
                    {localImageUrl ? (
                      <img src={localImageUrl} alt="Preview" className="df-settingsAvatarImg" />
                    ) : savedProfileImageUrl ? (
                      <img
                        key={savedProfileImageUrl}
                        src={savedProfileImageUrl}
                        alt=""
                        className="df-settingsAvatarImg"
                      />
                    ) : (
                      <span className="df-settingsAvatarInitial" aria-hidden>
                        {(name || 'U').trim().slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </div>

                  <div className="df-settingsRowBody">
                    <label className="df-field">
                      <span className="df-fieldLabel" style={{ textAlign: 'start' }}>
                        Name
                      </span>
                      <input
                        className="df-input"
                        value={name}
                        onChange={(e) => {
                          setName(e.target.value);
                          setSaveSuccess('');
                        }}
                        placeholder="Your name"
                        autoComplete="name"
                        disabled={isLoadingName || isSavingProfile}
                      />
                    </label>
                    {isLoadingName && (
                      <div className="df-settingsHint" role="status">
                        Loading profile...
                      </div>
                    )}

                    <div className="df-settingsFileRow">
                      <input
                        ref={fileInputRef}
                        id={fileInputId}
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif"
                        onChange={handleImageFileChange}
                        className="df-settingsFileInput"
                        disabled={isSavingProfile}
                      />
                      <label
                        htmlFor={fileInputId}
                        className="df-btn"
                        style={{ width: 'fit-content', opacity: isSavingProfile ? 0.55 : 1 }}
                      >
                        Choose image
                      </label>
                      <span className="df-settingsHint">JPEG, PNG, WebP, or GIF · max 5 MB</span>
                    </div>
                    {imagePickError && (
                      <div className="df-errorText" role="alert" style={{ marginTop: 0 }}>
                        {imagePickError}
                      </div>
                    )}

                    <div className="df-settingsActionsRow">
                      <button
                        type="button"
                        className="df-btn df-btnPrimary"
                        onClick={() => void handleSaveChangesClick()}
                        disabled={!onSaveDisplayName || isLoadingName || isSavingProfile}
                      >
                        {isSavingProfile ? 'Saving...' : 'Save changes'}
                      </button>
                      {saveSuccess && (
                        <div className="df-successText" role="status" style={{ marginTop: 0 }}>
                          {saveSuccess}
                        </div>
                      )}
                      {saveError && (
                        <div className="df-errorText" role="alert" style={{ marginTop: 0 }}>
                          {saveError}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'preferences' && (
              <div className="df-settingsSection df-preferencesSection">
                <p className="df-settingsHint" style={{ marginTop: 0 }}>
                  Your onboarding answers. For multi-select fields, use Ctrl/Cmd or Shift to choose
                  several options.
                </p>

                <label className="df-field">
                  <span className="df-fieldLabel">Age range</span>
                  <select
                    className="df-input"
                    value={qForm.age_range}
                    onChange={(e) =>
                      setQForm((f) => ({ ...f, age_range: e.target.value }))
                    }
                    disabled={isSavingPreferences}
                  >
                    <option value="">Select…</option>
                    {AGE_RANGE_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="df-field">
                  <span className="df-fieldLabel">Daily routine</span>
                  <select
                    className="df-input"
                    value={qForm.status_daily_routine}
                    onChange={(e) =>
                      setQForm((f) => ({ ...f, status_daily_routine: e.target.value }))
                    }
                    disabled={isSavingPreferences}
                  >
                    <option value="">Select…</option>
                    {STATUS_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="df-field">
                  <span className="df-fieldLabel">Main goal</span>
                  <select
                    className="df-input"
                    value={qForm.main_goal}
                    onChange={(e) => setQForm((f) => ({ ...f, main_goal: e.target.value }))}
                    disabled={isSavingPreferences}
                  >
                    <option value="">Select…</option>
                    {MAIN_GOAL_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="df-field">
                  <span className="df-fieldLabel">Fitness level</span>
                  <select
                    className="df-input"
                    value={qForm.fitness_level}
                    onChange={(e) =>
                      setQForm((f) => ({ ...f, fitness_level: e.target.value }))
                    }
                    disabled={isSavingPreferences}
                  >
                    <option value="">Select…</option>
                    {FITNESS_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="df-field">
                  <span className="df-fieldLabel">Activity considerations</span>
                  <span className="df-settingsHint" style={{ display: 'block', marginBottom: 6 }}>
                    &quot;None&quot; cannot combine with other options.
                  </span>
                  <select
                    multiple
                    className="df-input df-selectMulti"
                    size={Math.min(6, ACTIVITY_OPTIONS.length)}
                    value={qForm.activity_considerations}
                    onChange={(e) => {
                      const raw = Array.from(e.target.selectedOptions).map((o) => o.value);
                      const next = coerceExclusiveMultiSelect(raw, 'none');
                      setQForm((f) => ({ ...f, activity_considerations: next }));
                    }}
                    disabled={isSavingPreferences}
                  >
                    {ACTIVITY_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="df-field">
                  <span className="df-fieldLabel">Workouts per week</span>
                  <input
                    className="df-input"
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    value={qForm.workouts_per_week}
                    onChange={(e) =>
                      setQForm((f) => ({ ...f, workouts_per_week: e.target.value }))
                    }
                    placeholder="e.g. 3"
                    disabled={isSavingPreferences}
                  />
                </label>

                <label className="df-field">
                  <span className="df-fieldLabel">Preferred workout times</span>
                  <span className="df-settingsHint" style={{ display: 'block', marginBottom: 6 }}>
                    &quot;Any time&quot; cannot combine with other times.
                  </span>
                  <select
                    multiple
                    className="df-input df-selectMulti"
                    size={Math.min(5, WORKOUT_TIME_OPTIONS.length)}
                    value={qForm.preferred_workout_times}
                    onChange={(e) => {
                      const raw = Array.from(e.target.selectedOptions).map((o) => o.value);
                      const next = coerceExclusiveMultiSelect(raw, 'any_time');
                      setQForm((f) => ({ ...f, preferred_workout_times: next }));
                    }}
                    disabled={isSavingPreferences}
                  >
                    {WORKOUT_TIME_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="df-field">
                  <span className="df-fieldLabel">Preferred workout types</span>
                  <select
                    multiple
                    className="df-input df-selectMulti"
                    size={Math.min(6, WORKOUT_TYPE_OPTIONS.length)}
                    value={qForm.preferred_workout_types}
                    onChange={(e) => {
                      const raw = Array.from(e.target.selectedOptions).map((o) => o.value);
                      setQForm((f) => ({ ...f, preferred_workout_types: raw }));
                    }}
                    disabled={isSavingPreferences}
                  >
                    {WORKOUT_TYPE_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="df-field">
                  <span className="df-fieldLabel">Dietary preferences</span>
                  <span className="df-settingsHint" style={{ display: 'block', marginBottom: 6 }}>
                    &quot;No preferences&quot; cannot combine with other options.
                  </span>
                  <select
                    multiple
                    className="df-input df-selectMulti"
                    size={Math.min(7, DIETARY_OPTIONS.length)}
                    value={qForm.dietary_preferences}
                    onChange={(e) => {
                      const raw = Array.from(e.target.selectedOptions).map((o) => o.value);
                      const next = coerceExclusiveMultiSelect(raw, 'no_preferences');
                      setQForm((f) => ({ ...f, dietary_preferences: next }));
                    }}
                    disabled={isSavingPreferences}
                  >
                    {DIETARY_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="df-field">
                  <span className="df-fieldLabel">Break &amp; meditation</span>
                  <select
                    className="df-input"
                    value={qForm.break_meditation_interest}
                    onChange={(e) =>
                      setQForm((f) => ({ ...f, break_meditation_interest: e.target.value }))
                    }
                    disabled={isSavingPreferences}
                  >
                    <option value="">Select…</option>
                    {BREAK_MEDITATION_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="df-field">
                  <span className="df-fieldLabel">Auto-schedule to calendar</span>
                  <select
                    className="df-input"
                    value={qForm.auto_schedule_to_calendar}
                    onChange={(e) =>
                      setQForm((f) => ({ ...f, auto_schedule_to_calendar: e.target.value }))
                    }
                    disabled={isSavingPreferences}
                  >
                    <option value="">Select…</option>
                    {AUTO_SCHEDULE_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="df-settingsActionsRow">
                  <button
                    type="button"
                    className="df-btn df-btnPrimary"
                    onClick={() => void handleSavePreferencesClick()}
                    disabled={!onSaveQuestionnaire || isSavingPreferences}
                  >
                    {isSavingPreferences ? 'Saving…' : 'Save preferences'}
                  </button>
                  {preferencesSuccess && (
                    <div className="df-successText" role="status" style={{ marginTop: 0 }}>
                      {preferencesSuccess}
                    </div>
                  )}
                  {preferencesError && (
                    <div className="df-errorText" role="alert" style={{ marginTop: 0 }}>
                      {preferencesError}
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

