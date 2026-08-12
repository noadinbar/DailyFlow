import React from 'react';
import {
  BREAK_DURATIONS_OPTIONS,
  BUSIEST_DAYS_OPTIONS,
  BUSIEST_TIMES_OPTIONS,
  BUSY_DAY_FACTORS_OPTIONS,
  EMPTY_STRESS_BREAKS_FORM,
  EXCLUSIVE_BUSIEST_DAYS,
  EXCLUSIVE_BUSIEST_TIMES,
  EXCLUSIVE_BUSY_DAY_FACTORS,
  EXCLUSIVE_DURATIONS,
  PREFERRED_ACTIVITIES_OPTIONS,
  buildStressBreaksPreferencesPatchPayload,
  isStressBreaksFormComplete,
  stressBreaksFormFromApi,
  toggleExclusiveMulti,
  togglePlainMulti,
  type StressBreaksForm,
  type StressBreaksPreferences,
} from './stressBreaksPreferences';

type StressBreaksPreferencesModalProps = {
  isOpen: boolean;
  savedPreferences: StressBreaksPreferences | null;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => Promise<StressBreaksPreferences>;
};

export default function StressBreaksPreferencesModal(props: StressBreaksPreferencesModalProps) {
  const { isOpen, savedPreferences, onClose, onSave } = props;

  const [form, setForm] = React.useState<StressBreaksForm>(() => ({ ...EMPTY_STRESS_BREAKS_FORM }));
  const [errorMessage, setErrorMessage] = React.useState('');
  const [isSaving, setIsSaving] = React.useState(false);
  const hasInitializedForOpenRef = React.useRef(false);

  React.useEffect(() => {
    if (!isOpen) {
      hasInitializedForOpenRef.current = false;
      setErrorMessage('');
      setIsSaving(false);
      return;
    }
    if (hasInitializedForOpenRef.current) return;
    hasInitializedForOpenRef.current = true;
    setForm(stressBreaksFormFromApi(savedPreferences));
    setErrorMessage('');
  }, [isOpen, savedPreferences]);

  function handleBackdropMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !isSaving) onClose();
  }

  function handleCancel() {
    if (isSaving) return;
    onClose();
  }

  function handleSave() {
    if (!isStressBreaksFormComplete(form)) {
      setErrorMessage('Please answer all five questions before saving.');
      return;
    }
    void (async () => {
      setIsSaving(true);
      setErrorMessage('');
      try {
        const payload = buildStressBreaksPreferencesPatchPayload(form);
        await onSave(payload);
        onClose();
      } catch (e) {
        const anyErr = e as { message?: string };
        setErrorMessage(
          typeof anyErr?.message === 'string' && anyErr.message.trim()
            ? anyErr.message
            : 'Could not save Stress & Breaks preferences.'
        );
      } finally {
        setIsSaving(false);
      }
    })();
  }

  if (!isOpen) return null;

  return (
    <div className="df-modalBackdrop" role="presentation" onMouseDown={handleBackdropMouseDown}>
      <div
        className="df-modalPanel df-stressPreferencesModal"
        role="dialog"
        aria-modal="true"
        aria-label="Stress and Breaks preferences"
      >
        <div className="df-modalHeader">
          <div className="df-modalTitle">Stress &amp; Breaks preferences</div>
          <button
            type="button"
            className="df-iconBtn"
            onClick={handleCancel}
            aria-label="Close preferences"
            disabled={isSaving}
          >
            ✕
          </button>
        </div>

        <div className="df-settingsContent df-stressPreferencesContent" aria-label="Stress and Breaks preferences form">
          <div className="df-settingsSection df-preferencesSection">
            <div className="df-field">
              <span className="df-fieldLabel">When do you usually feel the busiest during the day?</span>
              <div className="df-prefOptionsWrap" role="group" aria-label="Busiest times of day">
                {BUSIEST_TIMES_OPTIONS.map((o) => {
                  const active = form.busiest_times.includes(o.id);
                  return (
                    <label key={o.id} className={`df-prefOption df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}>
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() =>
                          setForm((f) => ({
                            ...f,
                            busiest_times: toggleExclusiveMulti(f.busiest_times, o.id, EXCLUSIVE_BUSIEST_TIMES),
                          }))
                        }
                        disabled={isSaving}
                        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                      />
                      <div className="df-optionBtnTitle">{o.label}</div>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="df-field">
              <span className="df-fieldLabel">Which days usually feel the busiest for you?</span>
              <div className="df-prefOptionsWrap" role="group" aria-label="Busiest days">
                {BUSIEST_DAYS_OPTIONS.map((o) => {
                  const active = form.busiest_days.includes(o.id);
                  return (
                    <label key={o.id} className={`df-prefOption df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}>
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() =>
                          setForm((f) => ({
                            ...f,
                            busiest_days: toggleExclusiveMulti(f.busiest_days, o.id, EXCLUSIVE_BUSIEST_DAYS),
                          }))
                        }
                        disabled={isSaving}
                        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                      />
                      <div className="df-optionBtnTitle">{o.label}</div>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="df-field">
              <span className="df-fieldLabel">What usually makes a day feel particularly busy for you?</span>
              <div className="df-prefOptionsWrap" role="group" aria-label="Busy day factors">
                {BUSY_DAY_FACTORS_OPTIONS.map((o) => {
                  const active = form.busy_day_factors.includes(o.id);
                  return (
                    <label key={o.id} className={`df-prefOption df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}>
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() =>
                          setForm((f) => ({
                            ...f,
                            busy_day_factors: toggleExclusiveMulti(
                              f.busy_day_factors,
                              o.id,
                              EXCLUSIVE_BUSY_DAY_FACTORS
                            ),
                          }))
                        }
                        disabled={isSaving}
                        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                      />
                      <div className="df-optionBtnTitle">{o.label}</div>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="df-field">
              <span className="df-fieldLabel">What types of breaks or calming activities do you enjoy?</span>
              <div className="df-prefOptionsWrap" role="group" aria-label="Preferred break activities">
                {PREFERRED_ACTIVITIES_OPTIONS.map((o) => {
                  const active = form.preferred_activities.includes(o.id);
                  return (
                    <label key={o.id} className={`df-prefOption df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}>
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() =>
                          setForm((f) => ({
                            ...f,
                            preferred_activities: togglePlainMulti(f.preferred_activities, o.id),
                          }))
                        }
                        disabled={isSaving}
                        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                      />
                      <div className="df-optionBtnTitle">{o.label}</div>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="df-field">
              <span className="df-fieldLabel">How much time do you usually like to spend on a break?</span>
              <div className="df-prefOptionsWrap" role="group" aria-label="Preferred break durations">
                {BREAK_DURATIONS_OPTIONS.map((o) => {
                  const active = form.durations.includes(o.id);
                  return (
                    <label key={o.id} className={`df-prefOption df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}>
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() =>
                          setForm((f) => ({
                            ...f,
                            durations: toggleExclusiveMulti(f.durations, o.id, EXCLUSIVE_DURATIONS),
                          }))
                        }
                        disabled={isSaving}
                        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                      />
                      <div className="df-optionBtnTitle">{o.label}</div>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="df-settingsActionsRow">
              <button type="button" className="df-btn" onClick={handleCancel} disabled={isSaving}>
                Cancel
              </button>
              <button
                type="button"
                className="df-btn df-btnPrimary"
                onClick={handleSave}
                disabled={isSaving || !isStressBreaksFormComplete(form)}
              >
                {isSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
            {errorMessage ? (
              <div className="df-errorText" role="alert">
                {errorMessage}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
