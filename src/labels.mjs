/**
 * Runner label -> runner-images manifest path, plus deprecation deadlines.
 *
 * Every path here was verified to resolve against
 * https://raw.githubusercontent.com/actions/runner-images/main/<path>
 * Paths that 404 at runtime are reported as a clear skip, never a crash.
 */

import { daysUntil as daysUntilDate } from './dates.mjs';

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
 * changing the label. `plan` refuses them; `guard` resolves them from the
 * ImageOS env var that the real runner exports.
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
  return LABEL_PATHS[label] ?? null;
}

export function deadlineFor(label) {
  return DEADLINES[label] ?? null;
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
  const dl = DEADLINES[label];
  if (!dl) return null;
  for (const b of dl.brownouts ?? []) {
    const d = daysUntilDate(b, now);
    if (d !== null && d >= 0) return b;
  }
  return null;
}

/** Retirement countdown for a label, or null when it has no announced deadline. */
export function retirementStatus(label, now = new Date()) {
  const dl = DEADLINES[label];
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
