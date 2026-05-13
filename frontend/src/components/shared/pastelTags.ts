/**
 * Returns a soft pastel background + readable text color for a given tag.
 *
 * The same tag string always maps to the same pastel:
 * - Well-known meal/diet/workout tags use an explicit palette index so the
 *   colors look intentional (e.g. KOSHER, VEGAN, CARDIO, GYM).
 * - Unknown tags fall back to a deterministic hash so colors are stable but
 *   still vary across distinct tag names.
 *
 * Keep the palette soft and high-contrast for readability on pill chips.
 */

type PastelStyle = { backgroundColor: string; color: string };

const PASTEL_PALETTE: PastelStyle[] = [
  { backgroundColor: '#d1fae5', color: '#047857' }, // 0 mint
  { backgroundColor: '#dbeafe', color: '#1d4ed8' }, // 1 sky
  { backgroundColor: '#ede9fe', color: '#6d28d9' }, // 2 lavender
  { backgroundColor: '#fce7f3', color: '#be185d' }, // 3 blush
  { backgroundColor: '#ffedd5', color: '#c2410c' }, // 4 peach
  { backgroundColor: '#fef3c7', color: '#a16207' }, // 5 lemon
  { backgroundColor: '#ecfccb', color: '#4d7c0f' }, // 6 sage
  { backgroundColor: '#ffe4e6', color: '#be123c' }, // 7 rose
];

/**
 * Explicit indices for common app tags so they always look the same across
 * Meals and Workouts. Keys are pre-normalized (lowercase, no separators).
 */
const NAMED_TAG_INDEX: Record<string, number> = {
  // Diet tags
  kosher: 5,
  vegan: 6,
  vegetarian: 0,
  glutenfree: 4,
  highprotein: 3,
  lowcarb: 2,
  nopreferences: 1,
  quick: 5,

  // Meal types
  breakfast: 4,
  lunch: 1,
  dinner: 2,
  snack: 5,

  // Workout categories (covers both labels like "Cardio" and snake-case like "cardio_hiit")
  cardio: 7,
  cardiohiit: 7,
  strength: 1,
  hiit: 4,
  yoga: 2,
  mobility: 0,
  gym: 1,
  bodyweight: 6,
  run: 7,
  running: 7,
  walk: 0,
  swim: 1,
  cycling: 1,
  pilates: 3,
  core: 3,
  outdoor: 0,
  home: 6,

  // Intensity-like labels that occasionally appear as chips
  low: 0,
  moderate: 5,
  high: 3,
};

function normalizeKey(tag: string): string {
  return tag.trim().toLowerCase().replace(/[\s_\-]+/g, '');
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function pastelTagStyle(tag: string): PastelStyle {
  const key = normalizeKey(tag);
  if (!key) return PASTEL_PALETTE[0];
  const named = NAMED_TAG_INDEX[key];
  const index =
    typeof named === 'number' ? named : hashString(key) % PASTEL_PALETTE.length;
  return PASTEL_PALETTE[index];
}
