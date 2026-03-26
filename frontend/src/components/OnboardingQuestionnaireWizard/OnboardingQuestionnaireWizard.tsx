import React, { useEffect, useMemo, useState } from 'react';
import ProgressBar from './ProgressBar';
import { fetchAuthSession } from 'aws-amplify/auth';
import { configureAmplify } from '../../services/auth/amplifyConfig';
import { setOnboardingCompletedTrue } from '../../services/auth/cognitoPlaceholders';

type Gender = 'male' | 'female' | 'non_binary' | 'prefer_not_to_say' | '';
type DietaryPreference =
  | 'vegan'
  | 'vegetarian'
  | 'gluten_free'
  | 'keto'
  | 'lactose_intolerant'
  | 'kosher'
  | 'no_preferences'
  | '';
type PreferredWorkoutTime = 'morning' | 'noon' | 'afternoon' | 'evening' | 'any_time';

const TOTAL_STEPS = 4;

function formatStepText(stepIndex1Based: number, totalSteps: number) {
  return `Step ${stepIndex1Based} of ${totalSteps}`;
}

type OnboardingQuestionnaireWizardProps = {
  onSubmittedSuccess?: () => void;
  onUnauthorized?: () => void;
};

export default function OnboardingQuestionnaireWizard(props: OnboardingQuestionnaireWizardProps) {
  const { onSubmittedSuccess, onUnauthorized } = props;

  const [stepIndex, setStepIndex] = useState<number>(0); // 0..TOTAL_STEPS-1

  const [gender, setGender] = useState<Gender>('');
  const [dietaryPreference, setDietaryPreference] = useState<DietaryPreference>('');
  const [workoutsPerWeek, setWorkoutsPerWeek] = useState<string>('');
  const [preferredWorkoutTimes, setPreferredWorkoutTimes] = useState<PreferredWorkoutTime[]>([]);

  const stepIndex1Based = stepIndex + 1;

  const collectedData = useMemo(
    () => ({
      gender,
      dietaryPreference,
      workoutsPerWeek: workoutsPerWeek.trim() === '' ? null : Number(workoutsPerWeek),
      preferredWorkoutTimes,
    }),
    [dietaryPreference, gender, preferredWorkoutTimes, workoutsPerWeek]
  );

  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submissionError, setSubmissionError] = useState<string>('');

  const isNextDisabled = useMemo(() => {
    if (stepIndex === 0) return gender === '';
    if (stepIndex === 1) return dietaryPreference === '';
    if (stepIndex === 2) return workoutsPerWeek.trim() === '' || Number.isNaN(Number(workoutsPerWeek));
    if (stepIndex === 3) return preferredWorkoutTimes.length === 0;
    return true;
  }, [dietaryPreference, gender, preferredWorkoutTimes.length, stepIndex, workoutsPerWeek]);

  useEffect(() => {
    // Protect the questionnaire screen entry: require a valid authenticated session.
    void (async () => {
      try {
        configureAmplify();
        const session = await fetchAuthSession();
        const accessToken = session.tokens?.accessToken?.toString();
        const idToken = session.tokens?.idToken?.toString();
        const token = accessToken || idToken;
        if (!token) {
          setSubmissionError('You are not authenticated. Please log in again.');
          onUnauthorized?.();
        }
      } catch (e) {
        setSubmissionError('You are not authenticated. Please log in again.');
        // eslint-disable-next-line no-console
        console.error(e);
        onUnauthorized?.();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function goBack() {
    setStepIndex((s) => Math.max(0, s - 1));
  }

  function goNext() {
    setStepIndex((s) => Math.min(TOTAL_STEPS - 1, s + 1));
  }

  function togglePreferredWorkoutTime(time: PreferredWorkoutTime) {
    setPreferredWorkoutTimes((current) => {
      const exists = current.includes(time);
      if (exists) return current.filter((t) => t !== time);
      return [...current, time];
    });
  }

  function handleSubmit() {
    void (async () => {
      setIsSubmitting(true);
      setSubmissionError('');

      try {
        configureAmplify();
        const session = await fetchAuthSession();
        const accessToken = session.tokens?.accessToken?.toString();
        const idToken = session.tokens?.idToken?.toString();
        const token = accessToken || idToken;

        if (!token) {
          setSubmissionError('You are not authenticated. Please log in again.');
          onUnauthorized?.();
          return;
        }

        const baseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
        if (!baseUrl) {
          setSubmissionError('Missing API base URL configuration (VITE_API_BASE_URL).');
          return;
        }

        const endpointUrl = `${baseUrl.replace(/\/$/, '')}/onboarding/questionnaire`;

        const requestBody: Record<string, unknown> = {
          gender: collectedData.gender,
          dietary_preferences: collectedData.dietaryPreference,
          workouts_per_week: collectedData.workoutsPerWeek,
          preferred_workout_times: collectedData.preferredWorkoutTimes,
        };

        // Avoid sending null/undefined values.
        for (const key of Object.keys(requestBody)) {
          if (requestBody[key] === null || requestBody[key] === undefined) {
            delete requestBody[key];
          }
        }

        console.debug('[DailyFlow][Questionnaire] Starting questionnaire save request', {
          endpointUrl,
          method: 'POST',
        });

        let response: Response;
        try {
          response = await fetch(endpointUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(requestBody),
          });
        } catch (fetchErr) {
          console.error('[DailyFlow][Questionnaire] Fetch failed (no response received)', fetchErr);
          setSubmissionError(
            'Network error: failed to connect to the server. Please check your API URL / connectivity and try again.'
          );
          return;
        }

        console.debug('[DailyFlow][Questionnaire] Questionnaire save request completed', {
          ok: response.ok,
          status: response.status,
        });

        if (!response.ok) {
          let message = `Request failed with status ${response.status}.`;
          try {
            const maybeJson = await response.json();
            if (maybeJson && typeof maybeJson.message === 'string') message = maybeJson.message;
          } catch {
            // keep fallback message
          }
          setSubmissionError(message);
          return;
        }

        try {
          console.debug(
            '[DailyFlow][Questionnaire] Save succeeded, updating Cognito custom:onboardingCompleted'
          );
          // Mark onboarding as completed in Cognito only after questionnaire save succeeds.
          await setOnboardingCompletedTrue();
          console.debug('[DailyFlow][Questionnaire] Cognito onboardingCompleted updated successfully');

          console.debug('[DailyFlow][Questionnaire] Navigating to next screen now');
          onSubmittedSuccess?.();
        } catch (err) {
          // Questionnaire already succeeded, but onboarding flag update failed.
          // Keep the user in place and show an error so they can retry later.
          setSubmissionError(
            'Questionnaire saved, but failed to update onboarding status. Please try again.'
          );
          // eslint-disable-next-line no-console
          console.error(err);
        }
      } catch (e) {
        const anyErr = e as any;
        const message = anyErr && typeof anyErr.message === 'string' ? anyErr.message : 'Request failed.';
        setSubmissionError(message);
      } finally {
        setIsSubmitting(false);
      }
    })();
  }

  return (
    <section className="df-card" aria-label="Onboarding questionnaire wizard">
      <header>
        <h1 className="df-title">Onboarding questionnaire</h1>
        <p className="df-subtitle">Answer a few questions to personalize your experience.</p>
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
        <div className="df-question" role="group" aria-label="Gender question">
          <div className="df-questionLabel">1. Gender</div>

          <div className="df-optionsGrid">
            {(
              [
                { id: 'male' as const, title: 'Male', hint: 'I identify as male' },
                { id: 'female' as const, title: 'Female', hint: 'I identify as female' },
                { id: 'non_binary' as const, title: 'Non-binary', hint: 'I identify as non-binary' },
                { id: 'prefer_not_to_say' as const, title: 'Prefer not to say', hint: 'I prefer not to answer' },
              ] as const
            ).map((option) => {
              const active = gender === option.id;
              return (
                <label
                  key={option.id}
                  className={`df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}
                >
                  <input
                    type="radio"
                    name="gender"
                    value={option.id}
                    checked={active}
                    onChange={() => setGender(option.id)}
                    style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                  />
                  <div className="df-optionBtnTitle">{option.title}</div>
                  <div className="df-optionBtnHint">{option.hint}</div>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {stepIndex === 1 && (
        <div className="df-question" role="group" aria-label="Dietary preferences question">
          <div className="df-questionLabel">2. Dietary preferences</div>

          <div className="df-optionsGrid">
            {(
              [
                { id: 'vegan' as const, title: 'Vegan', hint: 'I follow a vegan diet' },
                {
                  id: 'vegetarian' as const,
                  title: 'Vegeterian',
                  hint: 'I follow a vegetarian diet',
                },
                { id: 'gluten_free' as const, title: 'Gluten-free', hint: 'I avoid gluten' },
                { id: 'keto' as const, title: 'Keto', hint: 'I follow a keto diet' },
                {
                  id: 'lactose_intolerant' as const,
                  title: 'Lactose intolerent',
                  hint: 'I avoid lactose/dairy',
                },
                { id: 'kosher' as const, title: 'Kosher', hint: 'I follow kosher guidelines' },
                {
                  id: 'no_preferences' as const,
                  title: 'I dont have any preferences',
                  hint: 'No specific dietary preferences',
                },
              ] as const
            ).map((option) => {
              const active = dietaryPreference === option.id;
              return (
                <label
                  key={option.id}
                  className={`df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}
                >
                  <input
                    type="radio"
                    name="dietaryPreference"
                    value={option.id}
                    checked={active}
                    onChange={() => setDietaryPreference(option.id)}
                    style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                  />
                  <div className="df-optionBtnTitle">{option.title}</div>
                  <div className="df-optionBtnHint">{option.hint}</div>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {stepIndex === 2 && (
        <div className="df-question" role="group" aria-label="Workouts per week question">
          <div className="df-questionLabel">3. Desired number of workouts per week</div>

          <div className="df-field">
            <label>
              <div className="df-progressStepText" style={{ marginBottom: 8 }}>
                Type a number
              </div>
              <input
                className="df-input"
                type="number"
                min={0}
                step={1}
                value={workoutsPerWeek}
                onChange={(e) => setWorkoutsPerWeek(e.target.value)}
                placeholder="e.g. 3"
              />
            </label>
          </div>
        </div>
      )}

      {stepIndex === 3 && (
        <div className="df-question" role="group" aria-label="Preferred workout times question">
          <div className="df-questionLabel">4. Preferred workout times</div>

          <div className="df-optionsGrid">
            {(
              [
                { id: 'morning' as const, title: 'Morning', hint: 'Morning workouts' },
                { id: 'noon' as const, title: 'Noon', hint: 'Lunch-time workouts' },
                { id: 'afternoon' as const, title: 'Afternoon', hint: 'Afternoon workouts' },
                { id: 'evening' as const, title: 'Evening', hint: 'Evening workouts' },
                { id: 'any_time' as const, title: 'Any time, I dont mind', hint: 'No preference' },
              ] as const
            ).map((option) => {
              const active = preferredWorkoutTimes.includes(option.id);
              return (
                <label
                  key={option.id}
                  className={`df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}
                >
                  <input
                    type="checkbox"
                    name="preferredWorkoutTimes"
                    value={option.id}
                    checked={active}
                    onChange={() => togglePreferredWorkoutTime(option.id)}
                    style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                  />
                  <div className="df-optionBtnTitle">{option.title}</div>
                  <div className="df-optionBtnHint">{option.hint}</div>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {submissionError && <div className="df-errorText">{submissionError}</div>}

      <nav className="df-actions" aria-label="Wizard navigation">
        <button className="df-btn" onClick={goBack} disabled={stepIndex === 0}>
          Back
        </button>

        {stepIndex < TOTAL_STEPS - 1 ? (
          <button className="df-btn df-btnPrimary" onClick={goNext} disabled={isNextDisabled}>
            Next
          </button>
        ) : (
          <button
            className="df-btn df-btnPrimary"
            onClick={handleSubmit}
            disabled={isNextDisabled || isSubmitting}
          >
            {isSubmitting ? 'Submitting...' : 'Submit'}
          </button>
        )}
      </nav>
    </section>
  );
}

