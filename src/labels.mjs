/**
 * Runner label -> runner-images manifest path, plus deprecation deadlines.
 *
 * Every path here was verified to resolve against
 * https://raw.githubusercontent.com/actions/runner-images/main/<path>
 * Paths that 404 at runtime are reported as a clear skip, never a crash.
 */

import { daysUntil as daysUntilDate } from './dates.mjs';
import { lookup } from './tables.mjs';

export const RUNNER_IMAGES_REPO = 'actions/runner-images';
export const RAW_HOST = 'https://raw.githubusercontent.com';
export const RAW_BASE = `${RAW_HOST}/${RUNNER_IMAGES_REPO}`;
export const API_BASE = 'https://api.github.com';

/** label -> manifest path under the runner-images repo */
export const LABEL_PATHS = {
  'ubuntu-22.04': 'images/ubuntu/Ubuntu2204-Readme.md',
  'ubuntu-22.04-arm': 'images/ubuntu/Ubuntu2204-Arm64-Readme.md',
  'ubuntu-24.04': 'images/ubuntu/Ubuntu2404-Readme.md',
  'ubuntu-24.04-arm': 'images/ubuntu/Ubuntu2404-Arm64-Readme.md',
  'ubuntu-26.04': 'images/ubuntu/Ubuntu2604-Readme.md',
  'ubuntu-26.04-arm': 'images/ubuntu/Ubuntu2604-Arm64-Readme.md',
  'windows-2022': 'images/windows/Windows2022-Readme.md',
  'windows-2025': 'images/windows/Windows2025-Readme.md',
  'macos-14': 'images/macos/macos-14-Readme.md',
  'macos-14-arm64': 'images/macos/macos-14-arm64-Readme.md',
  'macos-15': 'images/macos/macos-15-Readme.md',
  'macos-15-arm64': 'images/macos/macos-15-arm64-Readme.md',
  'macos-26': 'images/macos/macos-26-Readme.md',
  'macos-26-arm64': 'images/macos/macos-26-arm64-Readme.md',
};

/**
 * Floating labels cannot be resolved offline — GitHub moves them without
 * changing the label. `guard` resolves them from the ImageOS env var that the
 * real runner exports; `plan` refuses one as a diff endpoint, except where
 * MIGRATIONS below names the two concrete labels a move goes between.
 */
export const FLOATING_LABELS = new Set(['ubuntu-latest', 'windows-latest', 'macos-latest']);

/** ImageOS env value -> concrete label (as exported by real GitHub-hosted runners) */
export const IMAGE_OS_TO_LABEL = {
  ubuntu22: 'ubuntu-22.04',
  ubuntu24: 'ubuntu-24.04',
  ubuntu26: 'ubuntu-26.04',
  win22: 'windows-2022',
  win25: 'windows-2025',
  macos14: 'macos-14',
  macos15: 'macos-15',
  macos26: 'macos-26',
};

/**
 * The concrete label an `ImageOS` names, or null for anything else. An
 * unrecognised value reads as no observation at all, which is what the
 * migration lane wants: a new image name is not an anomaly.
 */
export function labelForImageOS(imageOS) {
  return imageOS ? lookup(IMAGE_OS_TO_LABEL, String(imageOS).toLowerCase()) : null;
}

const MACOS_14_BROWNOUTS = [
  '2026-10-05',
  '2026-10-12',
  '2026-10-16',
  '2026-10-19',
  '2026-10-23',
  '2026-10-26',
  '2026-10-29',
  '2026-10-30',
];

/**
 * Deprecation deadlines, transcribed from the announcement issues.
 * Verified 2026-08-05 against the linked issues; macOS 14 brownout dates and
 * the large/xlarge rows re-verified 2026-08-12 against #13518.
 */
export const DEADLINES = {
  'ubuntu-22.04': {
    deprecationStart: '2026-09-17',
    fullyUnsupported: '2027-04-17',
    brownouts: ['2027-03-23', '2027-03-30', '2027-04-06', '2027-04-13'],
    brownoutWindow: '14:00-00:00 UTC',
    migrateTo: ['ubuntu-24.04', 'ubuntu-26.04', 'ubuntu-latest'],
    source: 'https://github.com/actions/runner-images/issues/14254',
    sourceRef: 'actions/runner-images#14254',
  },
  'ubuntu-22.04-arm': {
    deprecationStart: '2026-09-17',
    fullyUnsupported: '2027-04-17',
    brownouts: ['2027-03-23', '2027-03-30', '2027-04-06', '2027-04-13'],
    brownoutWindow: '14:00-00:00 UTC',
    migrateTo: ['ubuntu-24.04-arm', 'ubuntu-26.04-arm'],
    source: 'https://github.com/actions/runner-images/issues/14254',
    sourceRef: 'actions/runner-images#14254',
  },
  'macos-14': {
    deprecationStart: '2026-07-06',
    fullyUnsupported: '2026-11-02',
    brownouts: MACOS_14_BROWNOUTS,
    brownoutWindow: '14:00-00:00 UTC',
    migrateTo: ['macos-15', 'macos-26', 'macos-latest'],
    source: 'https://github.com/actions/runner-images/issues/13518',
    sourceRef: 'actions/runner-images#13518',
  },
  'macos-14-arm64': {
    deprecationStart: '2026-07-06',
    fullyUnsupported: '2026-11-02',
    brownouts: MACOS_14_BROWNOUTS,
    brownoutWindow: '14:00-00:00 UTC',
    migrateTo: ['macos-15-arm64', 'macos-26-arm64'],
    source: 'https://github.com/actions/runner-images/issues/13518',
    sourceRef: 'actions/runner-images#13518',
  },
  // No readme in runner-images, hence no LABEL_PATHS entry: countdown only.
  'macos-14-large': {
    deprecationStart: '2026-07-06',
    fullyUnsupported: '2026-11-02',
    brownouts: MACOS_14_BROWNOUTS,
    brownoutWindow: '14:00-00:00 UTC',
    migrateTo: ['macos-latest-large', 'macos-15-large'],
    source: 'https://github.com/actions/runner-images/issues/13518',
    sourceRef: 'actions/runner-images#13518',
  },
  'macos-14-xlarge': {
    deprecationStart: '2026-07-06',
    fullyUnsupported: '2026-11-02',
    brownouts: MACOS_14_BROWNOUTS,
    brownoutWindow: '14:00-00:00 UTC',
    migrateTo: ['macos-latest-xlarge', 'macos-15-xlarge', 'macos-26-xlarge'],
    source: 'https://github.com/actions/runner-images/issues/13518',
    sourceRef: 'actions/runner-images#13518',
  },
};

export function knownLabels() {
  return Object.keys(LABEL_PATHS);
}

export function pathForLabel(label) {
  return lookup(LABEL_PATHS, label);
}

export function deadlineFor(label) {
  return lookup(DEADLINES, label);
}

export function isFloating(label) {
  return FLOATING_LABELS.has(label);
}

/** Normalise a `runs-on` string: strip quotes/whitespace, lowercase. */
export function normaliseLabel(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^['"]|['"]$/g, '').trim();
  return s ? s.toLowerCase() : null;
}

/** First brownout date on or after `now`, else null. */
export function nextBrownout(label, now = new Date()) {
  const dl = deadlineFor(label);
  if (!dl) return null;
  for (const b of dl.brownouts ?? []) {
    const d = daysUntilDate(b, now);
    if (d !== null && d >= 0) return b;
  }
  return null;
}

/** Retirement countdown for a label, or null when it has no announced deadline. */
export function retirementStatus(label, now = new Date()) {
  const dl = deadlineFor(label);
  if (!dl) return null;
  const daysToUnsupported = daysUntilDate(dl.fullyUnsupported, now);
  const brownout = nextBrownout(label, now);
  return {
    label,
    deprecationStart: dl.deprecationStart,
    deprecationStarted: daysUntilDate(dl.deprecationStart, now) <= 0,
    nextBrownout: brownout,
    daysToBrownout: brownout ? daysUntilDate(brownout, now) : null,
    fullyUnsupported: dl.fullyUnsupported,
    daysToUnsupported,
    retired: daysToUnsupported < 0,
    migrateTo: dl.migrateTo,
    source: dl.source,
    sourceRef: dl.sourceRef,
  };
}

/* ------------------------------------------------- floating-label migrations */

/**
 * Scheduled migrations of a floating label, transcribed from the changelog.
 *
 * Deliberately not part of DEADLINES. A deadline retires a concrete label and
 * offers destinations you choose between (`migrateTo`); a migration is GitHub
 * re-pointing a floating label from one image to another on dates you do not
 * get to pick, and the label itself never changes. Nothing in DEADLINES can say
 * that, which is why `starts`/`ends` are new fields rather than an overload.
 *
 * Verified 2026-09-20 against the changelog and actions/runner-images#14748.
 * Adding windows-latest or macos-latest later is a pure data addition.
 */
export const MIGRATIONS = {
  'ubuntu-latest': {
    from: 'ubuntu-24.04',
    to: 'ubuntu-26.04',
    starts: '2026-10-19',
    ends: '2026-11-19',
    announced: '2026-09-17',
    source: 'https://github.com/actions/runner-images/issues/14748',
    sourceRef: 'actions/runner-images#14748',
    changelog:
      'https://github.blog/changelog/2026-09-17-ubuntu-26-generally-available-and-latest-migration/',
  },
};

/** Where today sits relative to the rollout window. */
export const MIGRATION_PHASE = {
  PENDING: 'pending',
  IN_WINDOW: 'in-window',
  SETTLED: 'settled',
};

/** The window crossed with the image this runner actually served. */
export const MIGRATION_STATE = {
  PENDING: 'pending',
  MOVED_EARLY: 'moved-early',
  NOT_YET_MIGRATED: 'not-yet-migrated',
  AMBIGUOUS: 'ambiguous',
  MIGRATED: 'migrated',
  SETTLED: 'settled',
  STALE: 'stale',
  UNEXPECTED: 'unexpected',
};

/**
 * phase x observed image -> state. A table rather than a chain of conditionals:
 * every cell is a different sentence in the report, and a missing one would be
 * a silent fallthrough.
 */
const STATE_BY_PHASE = {
  [MIGRATION_PHASE.PENDING]: {
    none: MIGRATION_STATE.PENDING,
    from: MIGRATION_STATE.PENDING,
    to: MIGRATION_STATE.MOVED_EARLY,
  },
  [MIGRATION_PHASE.IN_WINDOW]: {
    none: MIGRATION_STATE.AMBIGUOUS,
    from: MIGRATION_STATE.NOT_YET_MIGRATED,
    to: MIGRATION_STATE.MIGRATED,
  },
  [MIGRATION_PHASE.SETTLED]: {
    none: MIGRATION_STATE.SETTLED,
    from: MIGRATION_STATE.STALE,
    to: MIGRATION_STATE.MIGRATED,
  },
};

/** The announced migration of a floating label, or null when there is none. */
export function migrationFor(label) {
  return lookup(MIGRATIONS, label);
}

/**
 * The announced migration that moves between these two concrete labels, or null.
 *
 * Pure table lookup, no dates and no network, so `guard` can name the cause of a
 * lock-to-runner jump even when the migration lane itself was not asked for.
 */
export function migrationBetween(from, to) {
  for (const [label, m] of Object.entries(MIGRATIONS)) {
    if (m.from === from && m.to === to) return { label, ...m };
  }
  return null;
}

/** Floating labels runner-drift has a migration window for. */
export function migratingLabels() {
  return Object.keys(MIGRATIONS);
}

/**
 * Classify a floating label against its migration window.
 *
 * `imageOS` is the env var a real runner exports, so on a hosted runner the
 * calendar answer is checked against the image that actually turned up. Without
 * it the calendar alone still decides pending and settled; only inside the
 * window is the answer genuinely unknowable, since that is the month where the
 * same label is two operating systems.
 *
 * @returns {object|null} null when the label has no announced migration
 */
export function migrationStatus(label, { now = new Date(), imageOS = null } = {}) {
  const m = migrationFor(label);
  if (!m) return null;

  // The changelog states calendar dates, so both ends are inside the window.
  // Phase therefore turns on the same whole-day countdown the report prints:
  // when the output says "starts 2026-10-19 (0 days)", it is in the window.
  const daysToStart = daysUntilDate(m.starts, now);
  const daysToEnd = daysUntilDate(m.ends, now);
  const phase =
    daysToStart > 0
      ? MIGRATION_PHASE.PENDING
      : daysToEnd >= 0
        ? MIGRATION_PHASE.IN_WINDOW
        : MIGRATION_PHASE.SETTLED;

  // An ImageOS this build does not recognise reads as no observation at all:
  // guard already reports an unknown ImageOS on its own, and guessing here
  // would turn a new image name into a fake anomaly.
  const observed = labelForImageOS(imageOS);
  const seen = observed === null ? 'none' : observed === m.to ? 'to' : observed === m.from ? 'from' : 'other';
  const state = seen === 'other' ? MIGRATION_STATE.UNEXPECTED : STATE_BY_PHASE[phase][seen];

  return {
    label,
    from: m.from,
    to: m.to,
    starts: m.starts,
    ends: m.ends,
    announced: m.announced,
    phase,
    state,
    daysToStart,
    daysToEnd,
    imageOS: imageOS ?? null,
    observed,
    anomaly: state === MIGRATION_STATE.STALE || state === MIGRATION_STATE.UNEXPECTED,
    done:
      state === MIGRATION_STATE.MIGRATED ||
      state === MIGRATION_STATE.MOVED_EARLY ||
      state === MIGRATION_STATE.SETTLED,
    source: m.source,
    sourceRef: m.sourceRef,
    changelog: m.changelog,
  };
}

/**
 * Should `--fail-on-migration <days>` fail on this status?
 *
 * A label serving an image that is neither end of its window fires whatever the
 * threshold: that is not a countdown, it is a fault, and no date makes it fine.
 *
 * A rollout that has not finished by the announced end does not. Both previous
 * `latest` moves ran late, the runners keep working when they do, and a build
 * that goes red over GitHub's schedule with no threshold that turns it off is a
 * build people fix by deleting the check. It is still reported as an anomaly,
 * with an `::error` annotation, because the announced date has passed.
 */
export function migrationFails(status, days) {
  if (!status) return false;
  if (status.state === MIGRATION_STATE.UNEXPECTED) return true;
  if (status.state === MIGRATION_STATE.STALE) return false;
  if (status.done) return false;
  if (status.phase === MIGRATION_PHASE.IN_WINDOW) return true;
  return Number.isFinite(days) && status.daysToStart !== null && status.daysToStart <= days;
}
