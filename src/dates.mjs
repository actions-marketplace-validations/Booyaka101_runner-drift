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

/** The same rounding, for a timestamp already in milliseconds. */
export function daysFromMs(target, now = new Date()) {
  if (!Number.isFinite(target)) return null;
  return Math.round((target - now.getTime()) / MS_PER_DAY);
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
