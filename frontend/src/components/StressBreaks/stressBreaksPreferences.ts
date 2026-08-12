/** Stress & Breaks preferences — option ids aligned with backend stress_breaks_fields.py. */

export type StressBreaksForm = {
  busiest_times: string[];
  busiest_days: string[];
  busy_day_factors: string[];
  preferred_activities: string[];
  durations: string[];
};

export type StressBreaksPreferences = StressBreaksForm & {
  questionnaire_completed: boolean;
};

export const EMPTY_STRESS_BREAKS_FORM: StressBreaksForm = {
  busiest_times: [],
  busiest_days: [],
  busy_day_factors: [],
  preferred_activities: [],
  durations: [],
};

export const BUSIEST_TIMES_OPTIONS: { id: string; label: string }[] = [
  { id: 'morning', label: 'Morning' },
  { id: 'midday', label: 'Midday' },
  { id: 'afternoon', label: 'Afternoon' },
  { id: 'evening', label: 'Evening' },
  { id: 'varies', label: 'It varies' },
];

export const BUSIEST_DAYS_OPTIONS: { id: string; label: string }[] = [
  { id: 'monday', label: 'Monday' },
  { id: 'tuesday', label: 'Tuesday' },
  { id: 'wednesday', label: 'Wednesday' },
  { id: 'thursday', label: 'Thursday' },
  { id: 'friday', label: 'Friday' },
  { id: 'saturday', label: 'Saturday' },
  { id: 'sunday', label: 'Sunday' },
  { id: 'changes_weekly', label: 'It changes from week to week' },
];

export const BUSY_DAY_FACTORS_OPTIONS: { id: string; label: string }[] = [
  { id: 'many_activities', label: 'Many activities in one day' },
  { id: 'long_continuous', label: 'Long continuous activities' },
  { id: 'back_to_back', label: 'Back-to-back activities' },
  { id: 'few_free_gaps', label: 'Very few free gaps' },
  { id: 'early_mornings', label: 'Early mornings' },
  { id: 'late_evenings', label: 'Late evenings' },
  { id: 'depends', label: 'It depends' },
];

export const PREFERRED_ACTIVITIES_OPTIONS: { id: string; label: string }[] = [
  { id: 'breathing', label: 'Breathing exercises' },
  { id: 'meditation', label: 'Meditation / mindfulness' },
  { id: 'walking', label: 'Walking' },
  { id: 'stretching', label: 'Stretching / light movement' },
  { id: 'reading', label: 'Reading' },
  { id: 'journaling', label: 'Journaling' },
  { id: 'music', label: 'Listening to music' },
  { id: 'screen_free', label: 'Screen-free time' },
];

export const BREAK_DURATIONS_OPTIONS: { id: string; label: string }[] = [
  { id: '3_5', label: '3–5 minutes' },
  { id: '5_10', label: '5–10 minutes' },
  { id: '10_15', label: '10–15 minutes' },
  { id: '15_20', label: '15–20 minutes' },
  { id: 'depends_on_schedule', label: 'It depends on my schedule' },
];

export const EXCLUSIVE_BUSIEST_TIMES = 'varies';
export const EXCLUSIVE_BUSIEST_DAYS = 'changes_weekly';
export const EXCLUSIVE_BUSY_DAY_FACTORS = 'depends';
export const EXCLUSIVE_DURATIONS = 'depends_on_schedule';

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v) return [v];
  return [];
}

/** Exclusive multi-select helper (same behavior as onboarding preferences). */
export function toggleExclusiveMulti(current: string[], id: string, exclusiveValue: string): string[] {
  if (id === exclusiveValue) {
    return current.includes(exclusiveValue) ? [] : [exclusiveValue];
  }
  const without = current.filter((x) => x !== exclusiveValue);
  if (without.includes(id)) return without.filter((x) => x !== id);
  return [...without, id];
}

export function togglePlainMulti(current: string[], id: string): string[] {
  if (current.includes(id)) return current.filter((x) => x !== id);
  return [...current, id];
}

export function stressBreaksFormFromApi(raw: unknown): StressBreaksForm {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_STRESS_BREAKS_FORM };
  const o = raw as Record<string, unknown>;
  return {
    busiest_times: asStringArray(o.busiest_times),
    busiest_days: asStringArray(o.busiest_days),
    busy_day_factors: asStringArray(o.busy_day_factors),
    preferred_activities: asStringArray(o.preferred_activities),
    durations: asStringArray(o.durations),
  };
}

export function stressBreaksPreferencesFromApi(raw: unknown): StressBreaksPreferences | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return {
    questionnaire_completed: o.questionnaire_completed === true,
    ...stressBreaksFormFromApi(o),
  };
}

export function isStressBreaksFormComplete(form: StressBreaksForm): boolean {
  return (
    form.busiest_times.length > 0 &&
    form.busiest_days.length > 0 &&
    form.busy_day_factors.length > 0 &&
    form.preferred_activities.length > 0 &&
    form.durations.length > 0
  );
}

/** PATCH body for completing the first-time questionnaire (answers + completion flag). */
export function buildStressBreaksCompletePayload(form: StressBreaksForm): {
  stress_breaks: StressBreaksPreferences;
} {
  return {
    stress_breaks: {
      questionnaire_completed: true,
      busiest_times: [...form.busiest_times],
      busiest_days: [...form.busiest_days],
      busy_day_factors: [...form.busy_day_factors],
      preferred_activities: [...form.preferred_activities],
      durations: [...form.durations],
    },
  };
}

/** PATCH body for editing preferences after completion (answers only; completion stays on the item). */
export function buildStressBreaksPreferencesPatchPayload(form: StressBreaksForm): {
  stress_breaks: StressBreaksForm;
} {
  return {
    stress_breaks: {
      busiest_times: [...form.busiest_times],
      busiest_days: [...form.busiest_days],
      busy_day_factors: [...form.busy_day_factors],
      preferred_activities: [...form.preferred_activities],
      durations: [...form.durations],
    },
  };
}
