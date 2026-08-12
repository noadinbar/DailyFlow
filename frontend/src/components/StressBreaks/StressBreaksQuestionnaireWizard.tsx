import React, { useMemo, useState } from 'react';
import ProgressBar from '../OnboardingQuestionnaireWizard/ProgressBar';
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
  buildStressBreaksCompletePayload,
  isStressBreaksFormComplete,
  toggleExclusiveMulti,
  togglePlainMulti,
  type StressBreaksForm,
  type StressBreaksPreferences,
} from './stressBreaksPreferences';

const TOTAL_STEPS = 5;

function formatStepText(stepIndex1Based: number, totalSteps: number) {
  return `${stepIndex1Based} of ${totalSteps}`;
}

type StressBreaksQuestionnaireWizardProps = {
  onSave: (payload: Record<string, unknown>) => Promise<StressBreaksPreferences>;
  onCompleted: (saved: StressBreaksPreferences) => void;
};

export default function StressBreaksQuestionnaireWizard(props: StressBreaksQuestionnaireWizardProps) {
  const { onSave, onCompleted } = props;

  const [stepIndex, setStepIndex] = useState(0);
  const [form, setForm] = useState<StressBreaksForm>(() => ({ ...EMPTY_STRESS_BREAKS_FORM }));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState('');

  const stepIndex1Based = stepIndex + 1;

  const isNextDisabled = useMemo(() => {
    if (stepIndex === 0) return form.busiest_times.length === 0;
    if (stepIndex === 1) return form.busiest_days.length === 0;
    if (stepIndex === 2) return form.busy_day_factors.length === 0;
    if (stepIndex === 3) return form.preferred_activities.length === 0;
    if (stepIndex === 4) return form.durations.length === 0;
    return true;
  }, [form, stepIndex]);

  function goBack() {
    setSubmissionError('');
    setStepIndex((s) => Math.max(0, s - 1));
  }

  function goNext() {
    if (isNextDisabled) return;
    setSubmissionError('');
    setStepIndex((s) => Math.min(TOTAL_STEPS - 1, s + 1));
  }

  function handleSaveAndContinue() {
    if (!isStressBreaksFormComplete(form) || isNextDisabled) return;
    void (async () => {
      setIsSubmitting(true);
      setSubmissionError('');
      try {
        const payload = buildStressBreaksCompletePayload(form);
        const saved = await onSave(payload);
        onCompleted(saved);
      } catch (e) {
        const anyErr = e as { message?: string };
        setSubmissionError(
          typeof anyErr?.message === 'string' && anyErr.message.trim()
            ? anyErr.message
            : 'Could not save Stress & Breaks preferences.'
        );
      } finally {
        setIsSubmitting(false);
      }
    })();
  }

  const isLastStep = stepIndex === TOTAL_STEPS - 1;

  return (
    <div className="df-stressQuestionnaireOverlay" role="dialog" aria-modal="true" aria-label="Stress and Breaks questionnaire">
      <section className="df-card df-onboardingCard df-stressQuestionnaireCard" aria-label="Stress and Breaks questionnaire wizard">
        <header>
          <h1 className="df-title">Stress &amp; Breaks preferences</h1>
          <p className="df-subtitle">Answer a few questions so DailyFlow can personalize break suggestions later.</p>
        </header>

        <div className="df-progressHeader">
          <div className="df-progressMeta">
            <div className="df-progressStepText">{formatStepText(stepIndex1Based, TOTAL_STEPS)}</div>
            <div className="df-progressStepText" aria-hidden="true">
              {Math.round((stepIndex1Based / TOTAL_STEPS) * 100)}%
            </div>
          </div>
          <ProgressBar currentStep={stepIndex1Based} totalSteps={TOTAL_STEPS} />
        </div>

        {stepIndex === 0 && (
          <div className="df-question" role="group" aria-label="Busiest times of day">
            <div className="df-questionLabel">When do you usually feel the busiest during the day?</div>
            <p className="df-subtitle" style={{ marginTop: 0, marginBottom: 12 }}>
              Select all that apply. &quot;It varies&quot; clears other selections.
            </p>
            <div className="df-optionsGrid">
              {BUSIEST_TIMES_OPTIONS.map((option) => {
                const active = form.busiest_times.includes(option.id);
                return (
                  <label key={option.id} className={`df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}>
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() =>
                        setForm((f) => ({
                          ...f,
                          busiest_times: toggleExclusiveMulti(f.busiest_times, option.id, EXCLUSIVE_BUSIEST_TIMES),
                        }))
                      }
                      disabled={isSubmitting}
                      style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                    />
                    <div className="df-optionBtnTitle">{option.label}</div>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {stepIndex === 1 && (
          <div className="df-question" role="group" aria-label="Busiest days">
            <div className="df-questionLabel">Which days usually feel the busiest for you?</div>
            <p className="df-subtitle" style={{ marginTop: 0, marginBottom: 12 }}>
              Select all that apply. &quot;It changes from week to week&quot; clears other selections.
            </p>
            <div className="df-optionsGrid">
              {BUSIEST_DAYS_OPTIONS.map((option) => {
                const active = form.busiest_days.includes(option.id);
                return (
                  <label key={option.id} className={`df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}>
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() =>
                        setForm((f) => ({
                          ...f,
                          busiest_days: toggleExclusiveMulti(f.busiest_days, option.id, EXCLUSIVE_BUSIEST_DAYS),
                        }))
                      }
                      disabled={isSubmitting}
                      style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                    />
                    <div className="df-optionBtnTitle">{option.label}</div>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {stepIndex === 2 && (
          <div className="df-question" role="group" aria-label="Busy day factors">
            <div className="df-questionLabel">What usually makes a day feel particularly busy for you?</div>
            <p className="df-subtitle" style={{ marginTop: 0, marginBottom: 12 }}>
              Select all that apply. &quot;It depends&quot; clears other selections.
            </p>
            <div className="df-optionsGrid">
              {BUSY_DAY_FACTORS_OPTIONS.map((option) => {
                const active = form.busy_day_factors.includes(option.id);
                return (
                  <label key={option.id} className={`df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}>
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() =>
                        setForm((f) => ({
                          ...f,
                          busy_day_factors: toggleExclusiveMulti(
                            f.busy_day_factors,
                            option.id,
                            EXCLUSIVE_BUSY_DAY_FACTORS
                          ),
                        }))
                      }
                      disabled={isSubmitting}
                      style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                    />
                    <div className="df-optionBtnTitle">{option.label}</div>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {stepIndex === 3 && (
          <div className="df-question" role="group" aria-label="Preferred break activities">
            <div className="df-questionLabel">What types of breaks or calming activities do you enjoy?</div>
            <p className="df-subtitle" style={{ marginTop: 0, marginBottom: 12 }}>
              Select all that apply.
            </p>
            <div className="df-optionsGrid">
              {PREFERRED_ACTIVITIES_OPTIONS.map((option) => {
                const active = form.preferred_activities.includes(option.id);
                return (
                  <label key={option.id} className={`df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}>
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() =>
                        setForm((f) => ({
                          ...f,
                          preferred_activities: togglePlainMulti(f.preferred_activities, option.id),
                        }))
                      }
                      disabled={isSubmitting}
                      style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                    />
                    <div className="df-optionBtnTitle">{option.label}</div>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {stepIndex === 4 && (
          <div className="df-question" role="group" aria-label="Preferred break durations">
            <div className="df-questionLabel">How much time do you usually like to spend on a break?</div>
            <p className="df-subtitle" style={{ marginTop: 0, marginBottom: 12 }}>
              Select all that apply. &quot;It depends on my schedule&quot; clears other selections.
            </p>
            <div className="df-optionsGrid">
              {BREAK_DURATIONS_OPTIONS.map((option) => {
                const active = form.durations.includes(option.id);
                return (
                  <label key={option.id} className={`df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}>
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() =>
                        setForm((f) => ({
                          ...f,
                          durations: toggleExclusiveMulti(f.durations, option.id, EXCLUSIVE_DURATIONS),
                        }))
                      }
                      disabled={isSubmitting}
                      style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                    />
                    <div className="df-optionBtnTitle">{option.label}</div>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {submissionError ? (
          <div className="df-errorText" role="alert">
            {submissionError}
          </div>
        ) : null}

        <div className="df-actions">
          <button type="button" className="df-btn" onClick={goBack} disabled={stepIndex === 0 || isSubmitting}>
            Back
          </button>
          {!isLastStep ? (
            <button type="button" className="df-btn df-btnPrimary" onClick={goNext} disabled={isNextDisabled || isSubmitting}>
              Next
            </button>
          ) : (
            <button
              type="button"
              className="df-btn df-btnPrimary"
              onClick={handleSaveAndContinue}
              disabled={isNextDisabled || isSubmitting}
            >
              {isSubmitting ? 'Saving…' : 'Save & Continue'}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
