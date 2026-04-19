import React from 'react';

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
  onLoadProfile?: () => Promise<{ displayName: string; profileImageUrl: string }>;
  onSaveDisplayName?: (nextName: string) => Promise<void>;
  onRequestProfileImageUploadUrl?: (args: { contentType: string }) => Promise<{
    uploadUrl: string;
    objectKey: string;
  }>;
  onSaveProfileImageKey?: (objectKey: string) => Promise<void>;
  onClose: () => void;
};

export default function ProfileSettingsModal(props: ProfileSettingsModalProps) {
  const {
    isOpen,
    initialName,
    savedProfileImageUrl = '',
    onClose,
    onLoadProfile,
    onSaveDisplayName,
    onRequestProfileImageUploadUrl,
    onSaveProfileImageKey,
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
              <div className="df-settingsSection">
                <div className="df-calendarLegend" style={{ color: '#6b7280' }}>
                  Preferences placeholder (UI only for now).
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

