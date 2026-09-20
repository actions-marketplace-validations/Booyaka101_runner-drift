/**
 * Day arithmetic, in one place.
 *
 * Three callers need it and they were three copies before 1.2.0: the image
 * deadline table in labels.mjs (`YYYY-MM-DD`), the report renderers, and the
 * runner-version dates from the API (full ISO date-times). Rounding to whole
 * days is what every countdown in the output is built on, so it has to be the
 * same rounding everywhere.
 */

export const MS_PER_DAY = 86_400_000;

/**
 * Whole days from `now` to a date. Accepts `YYYY-MM-DD` (read as UTC midnight,
 * which is how the announcement issues state their deadlines) and a full ISO
 * date-time (which is what the deprecations API returns).
 *
 * @returns {number|null} null when the input does not parse
 */
export function daysUntil(date, now = new Date()) {
  return daysFromMs(Date.parse(normalise(date)), now);
}

/**
 * The same count, for a timestamp already in milliseconds.
 *
 * Counted from the start of `now`'s UTC day, so a deadline dated 2026-11-19 is
 * "0 days" for the whole of the 19th rather than flipping to "1 day ago" at
 * midday. GitHub announces calendar dates; a countdown that changes at noon
 * both reads as a bug and moves a window boundary half a day early.
 */
export function daysFromMs(target, now = new Date()) {
  if (!Number.isFinite(target)) return null;
  const today = Math.floor(now.getTime() / MS_PER_DAY) * MS_PER_DAY;
  return Math.floor((target - today) / MS_PER_DAY);
}

/** True when the date is strictly in the past. Never rounded: a boundary matters. */
export function isPast(date, now = new Date()) {
  const at = Date.parse(normalise(date));
  return Number.isFinite(at) && at < now.getTime();
}

function normalise(date) {
  const raw = String(date ?? '');
  return raw.includes('T') ? raw : `${raw}T00:00:00Z`;
}
