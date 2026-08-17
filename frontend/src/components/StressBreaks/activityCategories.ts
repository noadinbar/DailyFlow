/** Central Timed / Flexible preference mapping for Stress & Breaks Activity Library. */

export const TIMED_ACTIVITY_IDS = ['breathing', 'meditation', 'stretching'] as const;
export const FLEXIBLE_ACTIVITY_IDS = [
  'walking',
  'reading',
  'journaling',
  'music',
  'screen_free',
] as const;

export type TimedActivityId = (typeof TIMED_ACTIVITY_IDS)[number];
export type FlexibleActivityId = (typeof FLEXIBLE_ACTIVITY_IDS)[number];

export type ActivityKind = 'timed' | 'flexible';

export type StressActivity = {
  id: string;
  kind: ActivityKind;
  title: string;
  category: string;
  category_label?: string;
  duration_minutes: number | null;
  summary_short: string;
  instructions?: string[];
  favorite_key?: string;
};

export type StressActivitiesResponse = {
  timed_activities?: StressActivity[];
  flexible_activities?: StressActivity[];
  favorite_activities?: StressActivity[];
  weekly_break_plan?: unknown[];
  stressful_periods?: unknown;
  has_library?: boolean;
  generated_at?: string | null;
  updated_at?: string | null;
  week_start?: string | null;
  week_end?: string | null;
  message?: string;
  metadata?: {
    timed_categories?: string[];
    flexible_categories?: string[];
    timed_count?: number;
    flexible_count?: number;
  };
};

const TIMED_SET = new Set<string>(TIMED_ACTIVITY_IDS);
const FLEXIBLE_SET = new Set<string>(FLEXIBLE_ACTIVITY_IDS);

export function splitPreferredActivities(preferred: string[]): {
  timed: string[];
  flexible: string[];
} {
  const timed: string[] = [];
  const flexible: string[] = [];
  const seen = new Set<string>();
  for (const raw of preferred) {
    const key = raw.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (TIMED_SET.has(key)) timed.push(key);
    else if (FLEXIBLE_SET.has(key)) flexible.push(key);
  }
  return { timed, flexible };
}

export function categoryDisplayLabel(category: string, fallback?: string): string {
  if (fallback && fallback.trim()) return fallback.trim();
  const labels: Record<string, string> = {
    breathing: 'Breathing',
    meditation: 'Meditation',
    stretching: 'Stretching',
    walking: 'Walking',
    reading: 'Reading',
    journaling: 'Journaling',
    music: 'Music',
    screen_free: 'Screen-free',
  };
  return labels[category] || category.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function activityMatchSignature(item: StressActivity): string {
  if (item.kind === 'flexible') return `flexible|${item.id.trim().toLowerCase()}`;
  return [
    'timed',
    item.title.trim().toLowerCase(),
    item.category.trim().toLowerCase().replace(/\s+/g, '_'),
    String(item.duration_minutes ?? 0),
  ].join('|');
}

export function activityFavoriteKey(item: StressActivity): string {
  if (item.favorite_key && item.favorite_key.trim()) return item.favorite_key.trim();
  return activityMatchSignature(item);
}

export function normalizeActivity(raw: unknown): StressActivity | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const category = typeof o.category === 'string' ? o.category.trim() : '';
  if (!id || !title || !category) return null;
  const kindRaw = typeof o.kind === 'string' ? o.kind.trim().toLowerCase() : '';
  const kind: ActivityKind =
    kindRaw === 'flexible' || id.startsWith('flex_') ? 'flexible' : 'timed';
  const duration =
    kind === 'flexible'
      ? null
      : typeof o.duration_minutes === 'number' && Number.isFinite(o.duration_minutes)
        ? Math.max(1, Math.ceil(o.duration_minutes))
        : null;
  if (kind === 'timed' && (duration === null || duration <= 0)) return null;
  const summary =
    typeof o.summary_short === 'string' && o.summary_short.trim()
      ? o.summary_short.trim()
      : `${title} break.`;
  const instructions = Array.isArray(o.instructions)
    ? o.instructions.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
  const favorite_key = typeof o.favorite_key === 'string' ? o.favorite_key.trim() : undefined;
  const category_label =
    typeof o.category_label === 'string' && o.category_label.trim()
      ? o.category_label.trim()
      : undefined;
  return {
    id,
    kind,
    title,
    category,
    category_label,
    duration_minutes: duration,
    summary_short: summary,
    instructions,
    favorite_key,
  };
}

export function normalizeActivityList(raw: unknown): StressActivity[] {
  if (!Array.isArray(raw)) return [];
  const out: StressActivity[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const item = normalizeActivity(entry);
    if (!item) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
