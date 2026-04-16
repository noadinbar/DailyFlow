import React from 'react';

type SettingsTab = 'profile' | 'preferences';

type ProfileSettingsModalProps = {
  isOpen: boolean;
  initialName: string;
  onLoadDisplayName?: () => Promise<string>;
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
    onClose,
    onLoadDisplayName,
    onSaveDisplayName,
    onRequestProfileImageUploadUrl,
    onSaveProfileImageKey,
  } = props;

  const [activeTab, setActiveTab] = React.useState<SettingsTab>('profile');
  const [name, setName] = React.useState<string>(initialName);
  const [localImageUrl, setLocalImageUrl] = React.useState<string>('');
  const [selectedImageFile, setSelectedImageFile] = React.useState<File | null>(null);
  const [isLoadingName, setIsLoadingName] = React.useState<boolean>(false);
  const [isSavingName, setIsSavingName] = React.useState<boolean>(false);
  const [saveError, setSaveError] = React.useState<string>('');
  const [isUploadingImage, setIsUploadingImage] = React.useState<boolean>(false);
  const [imageUploadError, setImageUploadError] = React.useState<string>('');
  const [imageUploadStatus, setImageUploadStatus] = React.useState<string>('');

  const fileInputId = React.useId();

  React.useEffect(() => {
    if (!isOpen) return;
    setActiveTab('profile');
    setName(initialName);
    setSaveError('');
    setSelectedImageFile(null);
    setImageUploadError('');
    setImageUploadStatus('');
  }, [isOpen, initialName]);

  React.useEffect(() => {
    if (!isOpen) return;
    if (!onLoadDisplayName) return;

    let cancelled = false;
    setIsLoadingName(true);
    void (async () => {
      try {
        const loaded = await onLoadDisplayName();
        if (cancelled) return;
        const clean = typeof loaded === 'string' ? loaded.trim() : '';
        if (clean) setName(clean);
      } finally {
        if (!cancelled) setIsLoadingName(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, onLoadDisplayName]);

  React.useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

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

    if (localImageUrl) URL.revokeObjectURL(localImageUrl);
    setLocalImageUrl(URL.createObjectURL(file));
    setSelectedImageFile(file);
    setImageUploadError('');
    setImageUploadStatus('');
  }

  async function handleSaveClick() {
    if (!onSaveDisplayName) return;
    setSaveError('');
    setIsSavingName(true);
    try {
      await onSaveDisplayName(name);
    } catch (e) {
      const anyErr = e as { message?: string };
      setSaveError(typeof anyErr?.message === 'string' ? anyErr.message : 'Failed to save name.');
    } finally {
      setIsSavingName(false);
    }
  }

  async function handleUploadImageClick() {
    if (!selectedImageFile) return;
    if (!onRequestProfileImageUploadUrl || !onSaveProfileImageKey) return;

    setIsUploadingImage(true);
    setImageUploadError('');
    setImageUploadStatus('');
    try {
      const contentType = selectedImageFile.type || 'application/octet-stream';
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
      setImageUploadStatus('Image uploaded (not displayed from S3 yet).');
    } catch (e) {
      const anyErr = e as { message?: string };
      setImageUploadError(typeof anyErr?.message === 'string' ? anyErr.message : 'Failed to upload image.');
    } finally {
      setIsUploadingImage(false);
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
                      <img src={localImageUrl} alt="Selected profile" className="df-settingsAvatarImg" />
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
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Your name"
                        autoComplete="name"
                      />
                    </label>
                    {isLoadingName && (
                      <div className="df-settingsHint" role="status">
                        Loading name...
                      </div>
                    )}

                    <div className="df-settingsFileRow">
                      <input
                        id={fileInputId}
                        type="file"
                        accept="image/*"
                        onChange={handleImageFileChange}
                        className="df-settingsFileInput"
                      />
                      <label htmlFor={fileInputId} className="df-btn" style={{ width: 'fit-content' }}>
                        Choose image
                      </label>
                      <button
                        type="button"
                        className="df-btn"
                        onClick={() => void handleUploadImageClick()}
                        disabled={!selectedImageFile || !onRequestProfileImageUploadUrl || !onSaveProfileImageKey || isUploadingImage}
                      >
                        {isUploadingImage ? 'Uploading...' : 'Upload'}
                      </button>
                      <span className="df-settingsHint">Upload foundation only (no public URLs yet)</span>
                    </div>
                    {imageUploadStatus && (
                      <div className="df-successText" role="status" style={{ marginTop: 0 }}>
                        {imageUploadStatus}
                      </div>
                    )}
                    {imageUploadError && (
                      <div className="df-errorText" role="alert" style={{ marginTop: 0 }}>
                        {imageUploadError}
                      </div>
                    )}

                    <div className="df-settingsActionsRow">
                      <button
                        type="button"
                        className="df-btn df-btnPrimary"
                        onClick={() => void handleSaveClick()}
                        disabled={!onSaveDisplayName || isSavingName}
                      >
                        {isSavingName ? 'Saving...' : 'Save'}
                      </button>
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

