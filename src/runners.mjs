/**
 * Self-hosted runner agent versions, and GitHub's end-of-support dates for them.
 *
 * Two endpoints, both on api.github.com:
 *   GET /{scope}/actions/runners                    -> the fleet, each runner's `version`
 *   GET /{scope}/actions/runners/deprecations/{ver}  -> when that version stops working
 *
 * Unlike the image deadlines in labels.mjs these dates cannot be a table. The
 * rule is rolling: every actions/runner release has to be installed within 30
 * days of publication, so the cut-off for any given version moves each time a
 * new one ships. Hence one lookup per distinct version, cached per run — twenty
 * runners on one version cost one call.
 *
 * Both endpoints need administration / self-hosted-runner read, which the
 * default GITHUB_TOKEN does not carry. A refusal is a reported status, never a
 * crash and never a failing exit code on its own.
 */

import { fetchJson } from './http.mjs';
import { compareDottedNumbers } from './diff.mjs';
import { daysUntil, isPast } from './dates.mjs';
import { API_BASE } from './labels.mjs';

/** GitHub's own rule: install each release within 30 days of publication. */
export const DEFAULT_DEPRECATION_WINDOW_DAYS = 30;

/** Minimum version required to register at all (changelog 2026-06-12). */
export const MINIMUM_REGISTRATION_VERSION = '2.329.0';

/** Runner versions are always three numeric fields. */
const RUNNER_VERSION_SHAPE = /^\d+\.\d+\.\d+$/;

export function isRunnerVersion(version) {
  return typeof version === 'string' && RUNNER_VERSION_SHAPE.test(version);
}

/**
 * True for a version GitHub will not let register at all, whatever the
 * deprecations endpoint says. Worth reporting on its own because a version old
 * enough to predate the API's records answers 404, i.e. UNKNOWN-VERSION.
 *
 * Anything not shaped like X.Y.Z answers false rather than being compared:
 * `Number('v2')` is NaN, which sorts low, so `v2.337.0` would otherwise be
 * reported as unregisterable.
 */
export function belowRegistrationMinimum(version) {
  if (!isRunnerVersion(version)) return false;
  return compareRunnerVersions(version, MINIMUM_REGISTRATION_VERSION) < 0;
}

export const RUNNER_STATUS = {
  OK: 'OK',
  UNKNOWN_VERSION: 'UNKNOWN-VERSION',
  REGISTRATION_DUE: 'REGISTRATION-DUE',
  RUNTIME_DUE: 'RUNTIME-DUE',
  EXPIRED: 'EXPIRED',
};

/** Worst last, so a sort on the index puts the urgent groups first. */
const STATUS_SEVERITY = [
  RUNNER_STATUS.OK,
  RUNNER_STATUS.UNKNOWN_VERSION,
  RUNNER_STATUS.REGISTRATION_DUE,
  RUNNER_STATUS.RUNTIME_DUE,
  RUNNER_STATUS.EXPIRED,
];

/** Survey-level statuses: the fleet could not be read at all. */
export const SURVEY_STATUS = {
  OK: 'OK',
  PERMISSION: 'PERMISSION',
  UNAVAILABLE: 'UNAVAILABLE',
};

export const GHES_NOTE =
  'enforcement covers github.com and GitHub Enterprise Cloud, not GitHub Enterprise Server';

export const AUTO_UPDATE_NOTE =
  'self-hosted runners auto-update by default — at risk are the ones registered with ' +
  '--disableupdate, baked into a VM or container image, or pinned by actions-runner-controller';

const SOURCE_CHANGELOG = 'https://github.blog/changelog/2026-06-12-github-actions-minimum-version-enforcement-timeline-for-self-hosted-runners/';

/** What a caller has to fix when the listing is refused, one line each. */
const PERMISSION_HINT = {
  repo: [
    'A fine-grained token needs the "Administration" repository permission (read);',
    'a classic token needs the `repo` scope. The default GITHUB_TOKEN has neither.',
  ],
  org: [
    'A fine-grained token needs the "Self-hosted runners" organization permission (read);',
    'a classic token needs the `admin:org` scope. The default GITHUB_TOKEN has neither.',
  ],
};

const NO_TOKEN_HINT = ['These endpoints are never readable anonymously — set GITHUB_TOKEN.'];

/* ------------------------------------------------------------------- scopes */

// A scope name is interpolated straight into the request path, so it has to be
// checked here rather than escaped later: `acme?per_page=1` would otherwise
// build a URL with a query string in the middle of it.
const OWNER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_NAME = /^(?!\.+$)[A-Za-z0-9_.-]+$/;

export function repoScope(owner, repo) {
  return { kind: 'repo', owner, repo, name: `${owner}/${repo}`, path: `/repos/${owner}/${repo}` };
}

export function orgScope(org) {
  return { kind: 'org', org, name: org, path: `/orgs/${org}` };
}

/**
 * Resolve `--repo` / `--org` (falling back to $GITHUB_REPOSITORY) to one scope.
 * @returns {{scope:object}|{error:string, detail?:string}}
 */
export function resolveScope({ repo = null, org = null, env = {} } = {}) {
  if (repo && org) {
    return { error: '--repo and --org are mutually exclusive — pick one.' };
  }
  if (org) {
    const name = String(org).trim();
    if (!OWNER_NAME.test(name)) {
      return { error: `--org takes an organization name, not "${org}".` };
    }
    return { scope: orgScope(name) };
  }
  const slug = String(repo ?? env.GITHUB_REPOSITORY ?? '').trim();
  if (!slug) {
    return {
      error: 'No repository to look at.',
      detail: 'Pass --repo <owner/repo> or --org <name> (inside a workflow $GITHUB_REPOSITORY is used).',
    };
  }
  const [owner, name, ...rest] = slug.split('/');
  if (rest.length || !OWNER_NAME.test(owner ?? '') || !REPO_NAME.test(name ?? '')) {
    return { error: `--repo takes owner/repo, not "${slug}".` };
  }
  return { scope: repoScope(owner, name) };
}

export function runnersUrl(scope) {
  return `${API_BASE}${scope.path}/actions/runners`;
}

export function deprecationsUrl(scope, version) {
  return `${API_BASE}${scope.path}/actions/runners/deprecations/${encodeURIComponent(version)}`;
}

/**
 * `GET /orgs/acme/actions/runners` — the endpoint as a user would curl it.
 *
 * The query is dropped by splitting rather than by `/\?.*$/`, which is quadratic
 * on a string of many `?` (CodeQL js/polynomial-redos).
 */
export function endpointLabel(url) {
  return `GET ${String(url).replace(API_BASE, '').split('?')[0]}`;
}

/* ------------------------------------------------------------------ failures */

/**
 * Turn a fetch failure into a reportable survey status. A 403 that is not a
 * rate limit, and a 404, both mean "this token cannot see it" — the same fix.
 */
const REFUSAL = {
  UNAUTHORIZED: 'not authenticated (HTTP 401)',
  FORBIDDEN: 'refused (HTTP 403)',
  NOT_FOUND: 'not visible to this token (HTTP 404)',
};

function describeFailure(err, scope, url) {
  const endpoint = endpointLabel(url);
  const refusal = REFUSAL[err?.code];
  if (refusal) {
    return {
      status: SURVEY_STATUS.PERMISSION,
      message: `${endpoint} was ${refusal}`,
      hint: [
        ...(err.code === 'UNAUTHORIZED' ? NO_TOKEN_HINT : []),
        ...PERMISSION_HINT[scope.kind],
      ],
    };
  }
  return {
    status: SURVEY_STATUS.UNAVAILABLE,
    message: `${endpoint} could not be read — ${err?.message ?? err}`,
    hint: err?.hint ? [err.hint] : [],
  };
}

/* ------------------------------------------------------------------- listing */

/**
 * Every self-hosted runner in the scope, following pagination.
 * @returns {Promise<{ok:true, runners:object[], totalCount:number, url:string}
 *                  |{ok:false, status:string, message:string, hint:string|null, url:string}>}
 */
export async function listRunners(scope, { perPage = 100, maxPages = 10, fetch: fj = fetchJson } = {}) {
  const base = runnersUrl(scope);
  const runners = [];
  let totalCount = null;
  for (let page = 1; page <= maxPages; page++) {
    const url = `${base}?per_page=${perPage}&page=${page}`;
    let json;
    try {
      ({ json } = await fj(url));
    } catch (err) {
      return { ok: false, url: base, ...describeFailure(err, scope, base) };
    }
    if (!json || !Array.isArray(json.runners)) {
      return {
        ok: false,
        url: base,
        status: SURVEY_STATUS.UNAVAILABLE,
        message: `${endpointLabel(base)} returned no \`runners\` array`,
        hint: [],
      };
    }
    if (totalCount === null && Number.isFinite(json.total_count)) totalCount = json.total_count;
    runners.push(...json.runners);
    if (json.runners.length < perPage) {
      return { ok: true, runners, totalCount: totalCount ?? runners.length, url: base, truncated: false };
    }
  }
  // maxPages full pages and still more to come. Report it rather than quietly
  // surveying a prefix of the fleet.
  return {
    ok: true,
    runners,
    totalCount: totalCount ?? runners.length,
    url: base,
    truncated: true,
  };
}

/* -------------------------------------------------------------- deprecations */

/**
 * The schema says date-time, so an ISO prefix is required rather than merely
 * "something Date.parse accepts": `date` is rendered as `at.slice(0, 10)`, which
 * would be nonsense for anything else. Whatever this rejects is reported as an
 * unparsed field, never silently dropped.
 */
function isoOrNull(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/** A date field the API sent but we could not parse. Reported, never ignored. */
function unparsedDates(json) {
  return ['registration_deprecates_at', 'runtime_deprecates_at'].filter(
    (k) => typeof json?.[k] === 'string' && json[k] && !isoOrNull(json[k]),
  );
}

/**
 * End-of-support dates for one runner version.
 *
 * `registration_deprecates_at` is documented as "string or null" but the live
 * API omits the key entirely on every version checked (2.325.0 through
 * 2.337.0), so an absent key and an explicit null are treated the same.
 *
 * @param {Map|null} cache keyed by version string — one lookup per version, not per runner
 */
export async function lookupDeprecation(scope, version, { cache = null, fetch: fj = fetchJson } = {}) {
  if (cache?.has(version)) return cache.get(version);
  const url = deprecationsUrl(scope, version);
  let result;
  try {
    const { json } = await fj(url);
    result = {
      ok: true,
      url,
      version,
      runnerVersion: typeof json?.runner_version === 'string' ? json.runner_version : version,
      registrationDeprecatesAt: isoOrNull(json?.registration_deprecates_at),
      runtimeDeprecatesAt: isoOrNull(json?.runtime_deprecates_at),
      unparsedDates: unparsedDates(json),
    };
  } catch (err) {
    result =
      err?.code === 'NOT_FOUND'
        ? { ok: false, url, version, unknownVersion: true }
        : { ok: false, url, version, ...describeFailure(err, scope, url) };
  }
  cache?.set(version, result);
  return result;
}

/* ------------------------------------------------------------------ grouping */

/**
 * One entry per distinct `version`, null for runners that never connected.
 *
 * `members` is each runner's own labels, kept because a job only lands on a
 * runner carrying every label of its `runs-on:` set, and the union across the
 * group would over-match. It is dropped before the group reaches `--json`.
 */
export function groupByVersion(runners) {
  const byVersion = new Map();
  for (const r of runners ?? []) {
    const raw = typeof r?.version === 'string' ? r.version.trim() : '';
    const key = raw || null;
    if (!byVersion.has(key)) byVersion.set(key, []);
    byVersion.get(key).push(r);
  }
  return [...byVersion.entries()].map(([version, group]) => {
    const members = group.map((m) => ({
      name: m?.name ?? '(unnamed)',
      labels: (m?.labels ?? []).map((l) => l?.name).filter(Boolean),
    }));
    return {
      version,
      count: members.length,
      names: members.map((m) => m.name),
      online: group.filter((m) => m?.status === 'online').length,
      busy: group.filter((m) => m?.busy === true).length,
      ephemeral: group.some((m) => m?.ephemeral === true),
      labels: [...new Set(members.flatMap((m) => m.labels))],
      members,
    };
  });
}

/**
 * The `runs-on:` sites this group would actually serve.
 *
 * GitHub schedules a job onto a runner only when the runner carries every label
 * in the set, so this is a per-runner subset test, case-insensitive the way
 * GitHub matches. A target whose value is a `${{ … }}` expression is skipped:
 * which runner serves it is not decidable from the file.
 *
 * @returns {Array<{labels:string[], file:string, line:number, col:number, runners:string[]}>}
 */
export function matchRunsOnTargets(group, targets) {
  const lower = (list) => new Set(list.map((l) => String(l).toLowerCase()));
  const byRunner = (group.members ?? []).map((m) => ({ name: m.name, labels: lower(m.labels) }));
  const matched = [];
  for (const target of targets ?? []) {
    if (target.expression || !target.labels?.length) continue;
    const wanted = [...lower(target.labels)];
    const serving = byRunner.filter((r) => wanted.every((l) => r.labels.has(l))).map((r) => r.name);
    if (serving.length) matched.push({ ...target, runners: serving });
  }
  return matched;
}

/* ------------------------------------------------------------ classification */

function dateFacts(iso, now) {
  if (!iso) return null;
  const days = daysUntil(iso, now);
  if (days === null) return null;
  return { at: iso, date: iso.slice(0, 10), days, past: isPast(iso, now) };
}

/**
 * Classify one version group. `EXPIRED` is unconditional (same rule the image
 * lane uses for a label past its date); `RUNTIME-DUE` outranks
 * `REGISTRATION-DUE` because jobs stopping beats not being able to re-register,
 * but both dates are always reported.
 */
export function classifyVersion({
  version,
  registrationDeprecatesAt = null,
  runtimeDeprecatesAt = null,
  unknownVersion = false,
  days = DEFAULT_DEPRECATION_WINDOW_DAYS,
  now = new Date(),
} = {}) {
  const runtime = dateFacts(runtimeDeprecatesAt, now);
  const registration = dateFacts(registrationDeprecatesAt, now);
  const facts = { runtime, registration };

  if (!version || unknownVersion) {
    return { status: RUNNER_STATUS.UNKNOWN_VERSION, ...facts };
  }
  if (runtime?.past || registration?.past) {
    return { status: RUNNER_STATUS.EXPIRED, ...facts };
  }
  if (runtime && runtime.days <= days) {
    return { status: RUNNER_STATUS.RUNTIME_DUE, ...facts };
  }
  if (registration && registration.days <= days) {
    return { status: RUNNER_STATUS.REGISTRATION_DUE, ...facts };
  }
  return { status: RUNNER_STATUS.OK, ...facts };
}

/**
 * Does this status fail the run? EXPIRED always; the two DUE statuses only when
 * --fail-on-deprecation asked for a window. UNKNOWN-VERSION never.
 */
export function statusFails(status, { failOn = false } = {}) {
  if (status === RUNNER_STATUS.EXPIRED) return true;
  if (!failOn) return false;
  return status === RUNNER_STATUS.RUNTIME_DUE || status === RUNNER_STATUS.REGISTRATION_DUE;
}

export function statusRank(status) {
  const i = STATUS_SEVERITY.indexOf(status);
  return i === -1 ? 0 : i;
}

/**
 * Identical versions across several hosts, or an ephemeral runner, is the
 * signature of an image or an actions-runner-controller template rather than a
 * host somebody can just re-run config.sh on. Stated as a guess in the output.
 */
export function looksImagePinned(group) {
  return group.count > 1 || group.ephemeral;
}

/* ------------------------------------------------------- release publication */

const RUNNER_RELEASES_URL = `${API_BASE}/repos/actions/runner/releases?per_page=100`;

/**
 * actions/runner's own releases: publication dates, and which stable version is
 * newest so the report can name what to update TO rather than only what breaks.
 *
 * Drafts and prereleases are excluded from `latest` — actions/runner really does
 * ship prereleases (v2.320.1, v2.318.0 and eight others as of 2026-09-09), and
 * telling someone to install one would be worse than saying nothing.
 *
 * Best effort throughout: it annotates the report and nothing more, so any
 * failure yields an empty result rather than taking the survey down with it.
 *
 * @returns {Promise<{dates:Map<string,string>, latest:string|null}>}
 */
export async function releasePublishDates({ fetch: fj = fetchJson } = {}) {
  const dates = new Map();
  let latest = null;
  try {
    const { json } = await fj(RUNNER_RELEASES_URL);
    if (!Array.isArray(json)) return { dates, latest };
    for (const rel of json) {
      const tag = String(rel?.tag_name ?? '').replace(/^v/, '');
      if (!isRunnerVersion(tag)) continue;
      const at = isoOrNull(rel?.published_at);
      if (at) dates.set(tag, at);
      if (rel?.draft || rel?.prerelease) continue;
      if (!latest || compareDottedNumbers(tag, latest) > 0) latest = tag;
    }
  } catch {
    return { dates: new Map(), latest: null };
  }
  return { dates, latest };
}

/* -------------------------------------------------------------------- survey */

/**
 * The whole picture for one scope: fleet, versions, dates, statuses.
 *
 * @param {object} scope repoScope()/orgScope()
 * @param {object} opts
 * @param {number} opts.days classification window (EXPIRED ignores it)
 * @param {boolean} opts.failOn whether --fail-on-deprecation was given
 * @param {string|null} opts.onlyRunnerName narrow to one runner, for `guard`
 * @param {boolean} opts.publishDates annotate OK rows with the release date
 * @param {Array} opts.runsOnTargets detect().runsOnTargets, to name the jobs served
 */
export async function surveyRunners(
  scope,
  {
    days = DEFAULT_DEPRECATION_WINDOW_DAYS,
    failOn = false,
    now = new Date(),
    onlyRunnerName = null,
    publishDates = true,
    runsOnTargets = [],
    fetch: fj = fetchJson,
  } = {},
) {
  const base = {
    scope: { kind: scope.kind, name: scope.name, path: scope.path },
    runnersUrl: runnersUrl(scope),
    windowDays: days,
    failOn,
    checkedAt: now.toISOString(),
    // Present and null on the happy path so --json needs no optional-key checks.
    message: null,
    hint: [],
    ghesNote: GHES_NOTE,
    autoUpdateNote: AUTO_UPDATE_NOTE,
    source: SOURCE_CHANGELOG,
  };

  // Every return below carries the same keys, so a --json consumer never has to
  // branch on which failure it is looking at.
  const unreadable = (failure, totalCount) => ({
    ...base,
    status: failure.status,
    message: failure.message,
    hint: failure.hint,
    truncated: false,
    surveyedCount: 0,
    totalCount,
    groups: [],
    failing: false,
  });

  const listed = await listRunners(scope, { fetch: fj });
  if (!listed.ok) return unreadable(listed, null);

  const all = listed.runners;
  const selected = onlyRunnerName ? all.filter((r) => r?.name === onlyRunnerName) : all;
  const groups = groupByVersion(selected);

  const cache = new Map();
  const resolved = [];
  // One shape for every group, whether or not it had a version to look up.
  // `members` exists only for the workflow join and does not survive into it.
  const resolve = ({ members, ...group }, dep) => ({
    ...group,
    workflowSites: matchRunsOnTargets({ members }, runsOnTargets),
    ...classifyVersion({
      version: group.version,
      registrationDeprecatesAt: dep?.registrationDeprecatesAt ?? null,
      runtimeDeprecatesAt: dep?.runtimeDeprecatesAt ?? null,
      unknownVersion: Boolean(dep?.unknownVersion),
      days,
      now,
    }),
    unknownVersion: Boolean(dep?.unknownVersion),
    unparsedDates: dep?.unparsedDates ?? [],
    source: dep ? endpointLabel(dep.url) : null,
    publishedAt: null,
    updateTo: null,
    imagePinned: looksImagePinned(group),
  });

  for (const group of groups) {
    if (group.version === null) {
      resolved.push(resolve(group, null));
      continue;
    }
    const dep = await lookupDeprecation(scope, group.version, { cache, fetch: fj });
    // The listing worked, so a refusal here is systemic: stop rather than
    // repeat a doomed call for every remaining version.
    if (!dep.ok && !dep.unknownVersion) return unreadable(dep, listed.totalCount);
    resolved.push(resolve(group, dep));
  }

  // Fetched after classification, and only when a row can use it: an OK row
  // shows when its version shipped, and any behind row gets an update target.
  if (publishDates && resolved.some((g) => isRunnerVersion(g.version))) {
    const { dates, latest } = await releasePublishDates({ fetch: fj });
    for (const g of resolved) {
      if (!isRunnerVersion(g.version)) continue;
      g.publishedAt = dates.get(g.version) ?? null;
      if (latest && compareRunnerVersions(g.version, latest) < 0) {
        g.updateTo = { version: latest, publishedAt: dates.get(latest) ?? null };
      }
    }
  }

  resolved.sort(
    (a, b) =>
      statusRank(b.status) - statusRank(a.status) ||
      compareRunnerVersions(a.version, b.version) ||
      a.count - b.count,
  );

  // Two different numbers, deliberately. `surveyedCount` is what was actually
  // classified and is what the report counts; `totalCount` is the fleet size the
  // API claims. They differ when the listing was truncated, or when the API's
  // total_count disagrees with the objects it returned — either way the report
  // says so rather than printing a number it cannot stand behind.
  const surveyedCount = resolved.reduce((n, g) => n + g.count, 0);
  return {
    ...base,
    status: SURVEY_STATUS.OK,
    truncated: Boolean(listed.truncated),
    surveyedCount,
    totalCount: onlyRunnerName ? surveyedCount : listed.totalCount,
    groups: resolved,
    failing: resolved.some((g) => statusFails(g.status, { failOn })),
  };
}

/** Ascending numeric compare for `2.335.1`; a null version sorts last. */
export function compareRunnerVersions(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareDottedNumbers(a, b);
}
