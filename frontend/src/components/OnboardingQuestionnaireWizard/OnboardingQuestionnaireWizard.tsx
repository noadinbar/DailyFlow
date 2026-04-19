import React, { useEffect, useMemo, useState } from 'react';
import ProgressBar from './ProgressBar';
import { fetchAuthSession } from 'aws-amplify/auth';
import { configureAmplify } from '../../services/auth/amplifyConfig';
import { setOnboardingCompletedTrue } from '../../services/auth/cognitoPlaceholders';

type AgeRange =
  | 'under_18'
  | 'age_18_24'
  | 'age_25_34'
  | 'age_35_44'
  | 'age_45_plus'
  | '';

type StatusDailyRoutine =
  | 'student'
  | 'full_time_job'
  | 'part_time_job'
  | 'shift_worker'
  | 'currently_not_working'
  | '';

type MainGoal =
  | 'improve_fitness'
  | 'lose_weight'
  | 'build_strength'
  | 'reduce_stress'
  | 'improve_energy'
  | 'maintain_routine'
  | '';

type FitnessLevel = 'beginner' | 'intermediate' | 'advanced' | '';

type ActivityConsideration =
  | 'knee_sensitivity'
  | 'back_sensitivity'
  | 'avoid_high_intensity'
  | 'avoid_high_heart_rate'
  | 'prefer_low_impact'
  | 'none';

type PreferredWorkoutTime = 'morning' | 'noon' | 'afternoon' | 'evening' | 'any_time';

type PreferredWorkoutType =
  | 'walking'
  | 'gym'
  | 'strength'
  | 'yoga'
  | 'pilates'
  | 'running'
  | 'stretching'
  | 'home_workouts';

type DietaryPreference =
  | 'vegan'
  | 'vegetarian'
  | 'gluten_free'
  | 'keto'
  | 'lactose_intolerant'
  | 'kosher'
  | 'no_preferences';

type BreakMeditationInterest =
  | 'break_suggestions'
  | 'meditation_suggestions'
  | 'both'
  | 'not_interested'
  | '';

type AutoScheduleToCalendar = 'yes' | 'no' | 'ask_me_first' | '';

const TOTAL_STEPS = 11;

function formatStepText(stepIndex1Based: number, totalSteps: number) {
  return `Step ${stepIndex1Based} of ${totalSteps}`;
}

type OnboardingQuestionnaireWizardProps = {
  onSubmittedSuccess?: () => void;
  onUnauthorized?: () => void;
};

/** Parses the workouts-per-week field: required non-negative integer only (rejects 3.7, etc.). */
function parseNonNegativeIntegerInput(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

function toggleExclusiveNoneMulti<T extends string>(
  current: T[],
  id: T,
  exclusiveValue: T
): T[] {
  if (id === exclusiveValue) {
    return current.includes(exclusiveValue) ? [] : [exclusiveValue];
  }
  const without = current.filter((x) => x !== exclusiveValue);
  if (without.includes(id)) return without.filter((x) => x !== id);
  return [...without, id];
}

export default function OnboardingQuestionnaireWizard(props: OnboardingQuestionnaireWizardProps) {
  const { onSubmittedSuccess, onUnauthorized } = props;

  const [stepIndex, setStepIndex] = useState<number>(0);

  const [ageRange, setAgeRange] = useState<AgeRange>('');
  const [statusDailyRoutine, setStatusDailyRoutine] = useState<StatusDailyRoutine>('');
  const [mainGoal, setMainGoal] = useState<MainGoal>('');
  const [fitnessLevel, setFitnessLevel] = useState<FitnessLevel>('');
  const [activityConsiderations, setActivityConsiderations] = useState<ActivityConsideration[]>([]);
  const [workoutsPerWeek, setWorkoutsPerWeek] = useState<string>('');
  const [preferredWorkoutTimes, setPreferredWorkoutTimes] = useState<PreferredWorkoutTime[]>([]);
  const [preferredWorkoutTypes, setPreferredWorkoutTypes] = useState<PreferredWorkoutType[]>([]);
  const [dietaryPreferences, setDietaryPreferences] = useState<DietaryPreference[]>([]);
  const [breakMeditationInterest, setBreakMeditationInterest] = useState<BreakMeditationInterest>('');
  const [autoScheduleToCalendar, setAutoScheduleToCalendar] = useState<AutoScheduleToCalendar>('');

  const stepIndex1Based = stepIndex + 1;

  const collectedData = useMemo(
    () => ({
      age_range: ageRange,
      status_daily_routine: statusDailyRoutine,
      main_goal: mainGoal,
      fitness_level: fitnessLevel,
      activity_considerations: activityConsiderations,
      workouts_per_week: parseNonNegativeIntegerInput(workoutsPerWeek),
      preferred_workout_times: preferredWorkoutTimes,
      preferred_workout_types: preferredWorkoutTypes,
      dietary_preferences: dietaryPreferences,
      break_meditation_interest: breakMeditationInterest,
      auto_schedule_to_calendar: autoScheduleToCalendar,
    }),
    [
      activityConsiderations,
      ageRange,
      autoScheduleToCalendar,
      breakMeditationInterest,
      dietaryPreferences,
      fitnessLevel,
      mainGoal,
      preferredWorkoutTimes,
      preferredWorkoutTypes,
      statusDailyRoutine,
      workoutsPerWeek,
    ]
  );

  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submissionError, setSubmissionError] = useState<string>('');

  const isNextDisabled = useMemo(() => {
    if (stepIndex === 0) return ageRange === '';
    if (stepIndex === 1) return statusDailyRoutine === '';
    if (stepIndex === 2) return mainGoal === '';
    if (stepIndex === 3) return fitnessLevel === '';
    if (stepIndex === 4) return activityConsiderations.length === 0;
    if (stepIndex === 5) return parseNonNegativeIntegerInput(workoutsPerWeek) === null;
    if (stepIndex === 6) return preferredWorkoutTimes.length === 0;
    if (stepIndex === 7) return preferredWorkoutTypes.length === 0;
    if (stepIndex === 8) return dietaryPreferences.length === 0;
    if (stepIndex === 9) return breakMeditationInterest === '';
    if (stepIndex === 10) return autoScheduleToCalendar === '';
    return true;
  }, [
    activityConsiderations.length,
    ageRange,
    autoScheduleToCalendar,
    breakMeditationInterest,
    dietaryPreferences.length,
    fitnessLevel,
    mainGoal,
    preferredWorkoutTimes.length,
    preferredWorkoutTypes.length,
    statusDailyRoutine,
    stepIndex,
    workoutsPerWeek,
  ]);

  useEffect(() => {
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
    setPreferredWorkoutTimes((current) =>
      toggleExclusiveNoneMulti(current, time, 'any_time')
    );
  }

  function toggleDietaryPreference(pref: DietaryPreference) {
    setDietaryPreferences((current) =>
      toggleExclusiveNoneMulti(current, pref, 'no_preferences')
    );
  }

  function toggleActivityConsideration(item: ActivityConsideration) {
    setActivityConsiderations((current) =>
      toggleExclusiveNoneMulti(current, item, 'none')
    );
  }

  function togglePreferredWorkoutType(t: PreferredWorkoutType) {
    setPreferredWorkoutTypes((current) => {
      if (current.includes(t)) return current.filter((x) => x !== t);
      return [...current, t];
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
          age_range: collectedData.age_range,
          status_daily_routine: collectedData.status_daily_routine,
          main_goal: collectedData.main_goal,
          fitness_level: collectedData.fitness_level,
          activity_considerations: collectedData.activity_considerations,
          workouts_per_week: collectedData.workouts_per_week,
          preferred_workout_times: collectedData.preferred_workout_times,
          preferred_workout_types: collectedData.preferred_workout_types,
          dietary_preferences: collectedData.dietary_preferences,
          break_meditation_interest: collectedData.break_meditation_interest,
          auto_schedule_to_calendar: collectedData.auto_schedule_to_calendar,
        };

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
          await setOnboardingCompletedTrue();
          console.debug('[DailyFlow][Questionnaire] Cognito onboardingCompleted updated successfully');

          console.debug('[DailyFlow][Questionnaire] Navigating to next screen now');
          onSubmittedSuccess?.();
        } catch (err) {
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
        <div className="df-question" role="group" aria-label="Age range question">
          <div className="df-questionLabel">1. Age range</div>
          <div className="df-optionsGrid">
            {(
              [
                { id: 'under_18' as const, title: 'Under 18', hint: '' },
                { id: 'age_18_24' as const, title: 'Ages 18–24', hint: '' },
                { id: 'age_25_34' as const, title: 'Ages 25–34', hint: '' },
                { id: 'age_35_44' as const, title: 'Ages 35–44', hint: '' },
                { id: 'age_45_plus' as const, title: 'Ages 45+', hint: '' },
              ] as const
            ).map((option) => {
              const active = ageRange === option.id;
              return (
                <label
                  key={option.id}
                  className={`df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}
                >
                  <input
                    type="radio"
                    name="ageRange"
                    value={option.id}
                    checked={active}
                    onChange={() => setAgeRange(option.id)}
                    style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                  />
                  <div className="df-optionBtnTitle">{option.title}</div>
                  {option.hint ? <div className="df-optionBtnHint">{option.hint}</div> : null}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {stepIndex === 1 && (
        <div className="df-question" role="group" aria-label="Daily routine status question">
          <div className="df-questionLabel">2. What best describes your daily routine?</div>
          <div className="df-optionsGrid">
            {(
              [
                { id: 'student' as const, title: 'Student', hint: '' },
                { id: 'full_time_job' as const, title: 'Full-time job', hint: '' },
                { id: 'part_time_job' as const, title: 'Part-time job', hint: '' },
                { id: 'shift_worker' as const, title: 'Shift worker', hint: '' },
                { id: 'currently_not_working' as const, title: 'Not currently working', hint: '' },
              ] as const
            ).map((option) => {
              const active = statusDailyRoutine === option.id;
              return (
                <label
                  key={option.id}
                  className={`df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}
                >
                  <input
                    type="radio"
                    name="statusDailyRoutine"
                    value={option.id}
                    checked={active}
                    onChange={() => setStatusDailyRoutine(option.id)}
                    style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                  />
                  <div className="df-optionBtnTitle">{option.title}</div>
                  {option.hint ? <div className="df-optionBtnHint">{option.hint}</div> : null}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {stepIndex === 2 && (
        <div className="df-question" role="group" aria-label="Main goal question">
          <div className="df-questionLabel">3. Main goal</div>
          <div className="df-optionsGrid">
            {(
              [
                { id: 'improve_fitness' as const, title: 'Improve fitness', hint: '' },
                { id: 'lose_weight' as const, title: 'Lose weight', hint: '' },
                { id: 'build_strength' as const, title: 'Build strength', hint: '' },
                { id: 'reduce_stress' as const, title: 'Reduce stress', hint: '' },
                { id: 'improve_energy' as const, title: 'Improve energy', hint: '' },
                { id: 'maintain_routine' as const, title: 'Maintain routine', hint: '' },
              ] as const
            ).map((option) => {
              const active = mainGoal === option.id;
              return (
                <label
                  key={option.id}
                  className={`df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}
                >
                  <input
                    type="radio"
                    name="mainGoal"
                    value={option.id}
                    checked={active}
                    onChange={() => setMainGoal(option.id)}
                    style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                  />
                  <div className="df-optionBtnTitle">{option.title}</div>
                  {option.hint ? <div className="df-optionBtnHint">{option.hint}</div> : null}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {stepIndex === 3 && (
        <div className="df-question" role="group" aria-label="Fitness level question">
          <div className="df-questionLabel">4. Fitness level</div>
          <div className="df-optionsGrid">
            {(
              [
                { id: 'beginner' as const, title: 'Beginner', hint: '' },
                { id: 'intermediate' as const, title: 'Intermediate', hint: '' },
                { id: 'advanced' as const, title: 'Advanced', hint: '' },
              ] as const
            ).map((option) => {
              const active = fitnessLevel === option.id;
              return (
                <label
                  key={option.id}
                  className={`df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}
                >
                  <input
                    type="radio"
                    name="fitnessLevel"
                    value={option.id}
                    checked={active}
                    onChange={() => setFitnessLevel(option.id)}
                    style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                  />
                  <div className="df-optionBtnTitle">{option.title}</div>
                  {option.hint ? <div className="df-optionBtnHint">{option.hint}</div> : null}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {stepIndex === 4 && (
        <div className="df-question" role="group" aria-label="Activity considerations question">
          <div className="df-questionLabel">5. Activity considerations</div>
          <p className="df-subtitle" style={{ marginTop: 0, marginBottom: 12 }}>
            Select all that apply. &quot;None&quot; clears your other selections.
          </p>
          <div className="df-optionsGrid">
            {(
              [
                { id: 'knee_sensitivity' as const, title: 'Knee sensitivity', hint: '' },
                { id: 'back_sensitivity' as const, title: 'Back sensitivity', hint: '' },
                { id: 'avoid_high_intensity' as const, title: 'Avoid high intensity', hint: '' },
                { id: 'avoid_high_heart_rate' as const, title: 'Avoid high heart rate', hint: '' },
                { id: 'prefer_low_impact' as const, title: 'Prefer low impact', hint: '' },
                { id: 'none' as const, title: 'None', hint: 'No specific considerations' },
              ] as const
            ).map((option) => {
              const active = activityConsiderations.includes(option.id);
              return (
                <label
                  key={option.id}
                  className={`df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}
                >
                  <input
                    type="checkbox"
                    name="activityConsiderations"
                    value={option.id}
                    checked={active}
                    onChange={() => toggleActivityConsideration(option.id)}
                    style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                  />
                  <div className="df-optionBtnTitle">{option.title}</div>
                  {option.hint ? <div className="df-optionBtnHint">{option.hint}</div> : null}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {stepIndex === 5 && (
        <div className="df-question" role="group" aria-label="Workouts per week question">
          <div className="df-questionLabel">6. Desired number of workouts per week</div>
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

      {stepIndex === 6 && (
        <div className="df-question" role="group" aria-label="Preferred workout times question">
          <div className="df-questionLabel">7. Preferred workout times</div>
          <p className="df-subtitle" style={{ marginTop: 0, marginBottom: 12 }}>
            &quot;Any time&quot; clears your other time selections.
          </p>
          <div className="df-optionsGrid">
            {(
              [
                { id: 'morning' as const, title: 'Morning', hint: 'Morning workouts' },
                { id: 'noon' as const, title: 'Noon', hint: 'Lunch-time workouts' },
                { id: 'afternoon' as const, title: 'Afternoon', hint: 'Afternoon workouts' },
                { id: 'evening' as const, title: 'Evening', hint: 'Evening workouts' },
                { id: 'any_time' as const, title: 'Any time', hint: 'No specific preference' },
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

      {stepIndex === 7 && (
        <div className="df-question" role="group" aria-label="Preferred workout types question">
          <div className="df-questionLabel">8. Preferred workout types</div>
          <div className="df-optionsGrid">
            {(
              [
                { id: 'walking' as const, title: 'Walking', hint: '' },
                { id: 'gym' as const, title: 'Gym', hint: '' },
                { id: 'strength' as const, title: 'Strength', hint: '' },
                { id: 'yoga' as const, title: 'Yoga', hint: '' },
                { id: 'pilates' as const, title: 'Pilates', hint: '' },
                { id: 'running' as const, title: 'Running', hint: '' },
                { id: 'stretching' as const, title: 'Stretching', hint: '' },
                { id: 'home_workouts' as const, title: 'Home workouts', hint: '' },
              ] as const
            ).map((option) => {
              const active = preferredWorkoutTypes.includes(option.id);
              return (
                <label
                  key={option.id}
                  className={`df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}
                >
                  <input
                    type="checkbox"
                    name="preferredWorkoutTypes"
                    value={option.id}
                    checked={active}
                    onChange={() => togglePreferredWorkoutType(option.id)}
                    style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                  />
                  <div className="df-optionBtnTitle">{option.title}</div>
                  {option.hint ? <div className="df-optionBtnHint">{option.hint}</div> : null}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {stepIndex === 8 && (
        <div className="df-question" role="group" aria-label="Dietary preferences question">
          <div className="df-questionLabel">9. Dietary preferences</div>
          <p className="df-subtitle" style={{ marginTop: 0, marginBottom: 12 }}>
            Select all that apply. &quot;No preferences&quot; clears other selections.
          </p>
          <div className="df-optionsGrid">
            {(
              [
                { id: 'vegan' as const, title: 'Vegan', hint: 'I follow a vegan diet' },
                { id: 'vegetarian' as const, title: 'Vegetarian', hint: 'I follow a vegetarian diet' },
                { id: 'gluten_free' as const, title: 'Gluten-free', hint: 'I avoid gluten' },
                { id: 'keto' as const, title: 'Keto', hint: 'I follow a keto diet' },
                {
                  id: 'lactose_intolerant' as const,
                  title: 'Lactose intolerant',
                  hint: 'I avoid lactose/dairy',
                },
                { id: 'kosher' as const, title: 'Kosher', hint: 'I follow kosher guidelines' },
                {
                  id: 'no_preferences' as const,
                  title: 'No preferences',
                  hint: 'No specific dietary preferences',
                },
              ] as const
            ).map((option) => {
              const active = dietaryPreferences.includes(option.id);
              return (
                <label
                  key={option.id}
                  className={`df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}
                >
                  <input
                    type="checkbox"
                    name="dietaryPreferences"
                    value={option.id}
                    checked={active}
                    onChange={() => toggleDietaryPreference(option.id)}
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

      {stepIndex === 9 && (
        <div className="df-question" role="group" aria-label="Break and meditation interest question">
          <div className="df-questionLabel">10. Break and meditation suggestions</div>
          <div className="df-optionsGrid">
            {(
              [
                { id: 'break_suggestions' as const, title: 'Break suggestions', hint: '' },
                { id: 'meditation_suggestions' as const, title: 'Meditation suggestions', hint: '' },
                { id: 'both' as const, title: 'Both', hint: '' },
                { id: 'not_interested' as const, title: 'Not interested', hint: '' },
              ] as const
            ).map((option) => {
              const active = breakMeditationInterest === option.id;
              return (
                <label
                  key={option.id}
                  className={`df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}
                >
                  <input
                    type="radio"
                    name="breakMeditationInterest"
                    value={option.id}
                    checked={active}
                    onChange={() => setBreakMeditationInterest(option.id)}
                    style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                  />
                  <div className="df-optionBtnTitle">{option.title}</div>
                  {option.hint ? <div className="df-optionBtnHint">{option.hint}</div> : null}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {stepIndex === 10 && (
        <div className="df-question" role="group" aria-label="Auto schedule to calendar question">
          <div className="df-questionLabel">11. Add workouts to your calendar automatically?</div>
          <div className="df-optionsGrid">
            {(
              [
                { id: 'yes' as const, title: 'Yes', hint: 'Schedule automatically' },
                { id: 'no' as const, title: 'No', hint: 'Do not add to calendar' },
                { id: 'ask_me_first' as const, title: 'Ask me first', hint: 'Confirm before scheduling' },
              ] as const
            ).map((option) => {
              const active = autoScheduleToCalendar === option.id;
              return (
                <label
                  key={option.id}
                  className={`df-optionBtn ${active ? 'df-optionBtnActive' : ''}`}
                >
                  <input
                    type="radio"
                    name="autoScheduleToCalendar"
                    value={option.id}
                    checked={active}
                    onChange={() => setAutoScheduleToCalendar(option.id)}
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
