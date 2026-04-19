/** Labels and option ids aligned with onboarding + backend `shared_fields.py`. */

export type QuestionnaireForm = {
  age_range: string;
  status_daily_routine: string;
  main_goal: string;
  fitness_level: string;
  activity_considerations: string[];
  workouts_per_week: string;
  preferred_workout_times: string[];
  preferred_workout_types: string[];
  dietary_preferences: string[];
  break_meditation_interest: string;
  auto_schedule_to_calendar: string;
};

export const EMPTY_QUESTIONNAIRE: QuestionnaireForm = {
  age_range: '',
  status_daily_routine: '',
  main_goal: '',
  fitness_level: '',
  activity_considerations: [],
  workouts_per_week: '',
  preferred_workout_times: [],
  preferred_workout_types: [],
  dietary_preferences: [],
  break_meditation_interest: '',
  auto_schedule_to_calendar: '',
};

export const AGE_RANGE_OPTIONS: { id: string; label: string }[] = [
  { id: 'under_18', label: 'Under 18' },
  { id: 'age_18_24', label: 'Ages 18–24' },
  { id: 'age_25_34', label: 'Ages 25–34' },
  { id: 'age_35_44', label: 'Ages 35–44' },
  { id: 'age_45_plus', label: 'Ages 45+' },
];

export const STATUS_OPTIONS: { id: string; label: string }[] = [
  { id: 'student', label: 'Student' },
  { id: 'full_time_job', label: 'Full-time job' },
  { id: 'part_time_job', label: 'Part-time job' },
  { id: 'shift_worker', label: 'Shift worker' },
  { id: 'currently_not_working', label: 'Not currently working' },
];

export const MAIN_GOAL_OPTIONS: { id: string; label: string }[] = [
  { id: 'improve_fitness', label: 'Improve fitness' },
  { id: 'lose_weight', label: 'Lose weight' },
  { id: 'build_strength', label: 'Build strength' },
  { id: 'reduce_stress', label: 'Reduce stress' },
  { id: 'improve_energy', label: 'Improve energy' },
  { id: 'maintain_routine', label: 'Maintain routine' },
];

export const FITNESS_OPTIONS: { id: string; label: string }[] = [
  { id: 'beginner', label: 'Beginner' },
  { id: 'intermediate', label: 'Intermediate' },
  { id: 'advanced', label: 'Advanced' },
];

export const ACTIVITY_OPTIONS: { id: string; label: string }[] = [
  { id: 'knee_sensitivity', label: 'Knee sensitivity' },
  { id: 'back_sensitivity', label: 'Back sensitivity' },
  { id: 'avoid_high_intensity', label: 'Avoid high intensity' },
  { id: 'avoid_high_heart_rate', label: 'Avoid high heart rate' },
  { id: 'prefer_low_impact', label: 'Prefer low impact' },
  { id: 'none', label: 'None' },
];

export const WORKOUT_TIME_OPTIONS: { id: string; label: string }[] = [
  { id: 'morning', label: 'Morning' },
  { id: 'noon', label: 'Noon' },
  { id: 'afternoon', label: 'Afternoon' },
  { id: 'evening', label: 'Evening' },
  { id: 'any_time', label: 'Any time' },
];

export const WORKOUT_TYPE_OPTIONS: { id: string; label: string }[] = [
  { id: 'walking', label: 'Walking' },
  { id: 'gym', label: 'Gym' },
  { id: 'strength', label: 'Strength' },
  { id: 'yoga', label: 'Yoga' },
  { id: 'pilates', label: 'Pilates' },
  { id: 'running', label: 'Running' },
  { id: 'stretching', label: 'Stretching' },
  { id: 'home_workouts', label: 'Home workouts' },
];

export const DIETARY_OPTIONS: { id: string; label: string }[] = [
  { id: 'vegan', label: 'Vegan' },
  { id: 'vegetarian', label: 'Vegetarian' },
  { id: 'gluten_free', label: 'Gluten-free' },
  { id: 'keto', label: 'Keto' },
  { id: 'lactose_intolerant', label: 'Lactose intolerant' },
  { id: 'kosher', label: 'Kosher' },
  { id: 'no_preferences', label: 'No preferences' },
];

export const BREAK_MEDITATION_OPTIONS: { id: string; label: string }[] = [
  { id: 'break_suggestions', label: 'Break suggestions' },
  { id: 'meditation_suggestions', label: 'Meditation suggestions' },
  { id: 'both', label: 'Both' },
  { id: 'not_interested', label: 'Not interested' },
];

export const AUTO_SCHEDULE_OPTIONS: { id: string; label: string }[] = [
  { id: 'yes', label: 'Yes' },
  { id: 'no', label: 'No' },
  { id: 'ask_me_first', label: 'Ask me first' },
];

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v) return [v];
  return [];
}

/** GET /profile uses scalars for status_daily_routine and main_goal; tolerate legacy arrays. */
function scalarFromApi(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0];
  return '';
}

export function questionnaireFromApi(raw: unknown): QuestionnaireForm {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_QUESTIONNAIRE };
  const o = raw as Record<string, unknown>;
  const workouts =
    typeof o.workouts_per_week === 'number' && Number.isFinite(o.workouts_per_week)
      ? String(o.workouts_per_week)
      : typeof o.workouts_per_week === 'string'
        ? o.workouts_per_week
        : '';
  return {
    age_range: typeof o.age_range === 'string' ? o.age_range : '',
    status_daily_routine: scalarFromApi(o.status_daily_routine),
    main_goal: scalarFromApi(o.main_goal),
    fitness_level: typeof o.fitness_level === 'string' ? o.fitness_level : '',
    activity_considerations: asStringArray(o.activity_considerations),
    workouts_per_week: workouts,
    preferred_workout_times: asStringArray(o.preferred_workout_times),
    preferred_workout_types: asStringArray(o.preferred_workout_types),
    dietary_preferences: asStringArray(o.dietary_preferences),
    break_meditation_interest:
      typeof o.break_meditation_interest === 'string' ? o.break_meditation_interest : '',
    auto_schedule_to_calendar:
      typeof o.auto_schedule_to_calendar === 'string' ? o.auto_schedule_to_calendar : '',
  };
}

export function toggleExclusiveNoneMulti<T extends string>(
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

/** For `<select multiple>`: if exclusive option is among multiple selections, keep only that option. */
export function coerceExclusiveMultiSelect(selected: string[], exclusive: string): string[] {
  if (selected.includes(exclusive) && selected.length > 1) return [exclusive];
  return selected;
}

export function parseNonNegativeIntegerInput(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

/** Build PATCH body for /profile; only includes present valid fields (partial updates). */
export function buildQuestionnairePatchPayload(form: QuestionnaireForm): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (form.age_range) out.age_range = form.age_range;
  if (form.status_daily_routine) out.status_daily_routine = form.status_daily_routine;
  if (form.main_goal) out.main_goal = form.main_goal;
  if (form.fitness_level) out.fitness_level = form.fitness_level;
  if (form.activity_considerations.length > 0) {
    out.activity_considerations = form.activity_considerations;
  }
  const w = parseNonNegativeIntegerInput(form.workouts_per_week);
  if (w !== null) out.workouts_per_week = w;
  if (form.preferred_workout_times.length > 0) {
    out.preferred_workout_times = form.preferred_workout_times;
  }
  if (form.preferred_workout_types.length > 0) {
    out.preferred_workout_types = form.preferred_workout_types;
  }
  if (form.dietary_preferences.length > 0) out.dietary_preferences = form.dietary_preferences;
  if (form.break_meditation_interest) out.break_meditation_interest = form.break_meditation_interest;
  if (form.auto_schedule_to_calendar) out.auto_schedule_to_calendar = form.auto_schedule_to_calendar;
  return out;
}

export function validateQuestionnaireFormComplete(form: QuestionnaireForm): boolean {
  if (!form.age_range) return false;
  if (!form.status_daily_routine) return false;
  if (!form.main_goal) return false;
  if (!form.fitness_level) return false;
  if (form.activity_considerations.length === 0) return false;
  if (parseNonNegativeIntegerInput(form.workouts_per_week) === null) return false;
  if (form.preferred_workout_times.length === 0) return false;
  if (form.preferred_workout_types.length === 0) return false;
  if (form.dietary_preferences.length === 0) return false;
  if (!form.break_meditation_interest) return false;
  if (!form.auto_schedule_to_calendar) return false;
  return true;
}
