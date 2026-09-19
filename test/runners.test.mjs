import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';

import {
  DEFAULT_DEPRECATION_WINDOW_DAYS,
  MINIMUM_REGISTRATION_VERSION,
  RUNNER_STATUS,
  SURVEY_STATUS,
  belowRegistrationMinimum,
  classifyVersion,
  compareRunnerVersions,
  deprecationsUrl,
  endpointLabel,
  groupByVersion,
  listRunners,
  lookupDeprecation,
  looksImagePinned,
  matchRunsOnTargets,
  orgScope,
  repoScope,
  resolveScope,
  surveyRunners,
} from '../src/runners.mjs';
import {
  annotation,
  annotationPath,
  markdownTable,
  runnersReport,
  runnersAnnotations,
  runnersSummaryMarkdown,
} from '../src/report.mjs';
import { detect } from '../src/detect.mjs';
import { runRunners, runGuard, EXIT_OK, EXIT_DRIFT, EXIT_USAGE } from '../src/cli.mjs';
import { captureIO, readRunnerFixtures, runnerRoutes, stubApi, FIXTURES } from './helpers.mjs';

/**
 * Every date below comes from the recorded live responses in
 * test/fixtures/runners/deprecations-recorded.json. At this instant:
 *   2.335.1 runtime ends 2026-09-24 -> 16 days  (RUNTIME-DUE inside 30)
 *   2.336.0 runtime ends 2026-11-05 -> 57 days  (OK)
 *   2.337.0 runtime null                        (OK, current)
 *   2.325.0 runtime ended 2025-09-11            (EXPIRED)
 *   9.9.9   404                                 (UNKNOWN-VERSION)
 */
const NOW = new Date('2026-09-09T00:00:00Z');
const ORG = orgScope('acme');
const REPO = repoScope('acme', 'widgets');

const { recorded, fleets, releases } = await readRunnerFixtures();

function routes(fleet, extra = {}) {
  return runnerRoutes({ scopePath: '/orgs/acme', fleet, recorded, releases, ...extra });
}

async function survey(fleet, opts = {}, extra = {}) {
  const api = stubApi(routes(fleet, extra));
  try {
    return await surveyRunners(ORG, { now: NOW, ...opts });
  } finally {
    api.restore();
  }
}

async function runners(opts, env = {}, fleet = fleets.arc, extra = {}) {
  const api = stubApi(routes(fleet, extra));
  const cap = captureIO();
  try {
    const code = await runRunners({ summary: false, json: false, ...opts }, cap.io, env, { now: NOW });
    return { code, stdout: cap.stdout, stderr: cap.stderr, calls: api.calls };
  } finally {
    api.restore();
  }
}

/* ------------------------------------------------------------------- scopes */

test('resolveScope takes --repo, --org or $GITHUB_REPOSITORY', () => {
  assert.deepEqual(resolveScope({ org: 'acme' }).scope, {
    kind: 'org',
    org: 'acme',
    name: 'acme',
    path: '/orgs/acme',
  });
  assert.equal(resolveScope({ repo: 'acme/widgets' }).scope.path, '/repos/acme/widgets');
  assert.equal(
    resolveScope({ env: { GITHUB_REPOSITORY: 'Booyaka101/runner-drift' } }).scope.name,
    'Booyaka101/runner-drift',
  );
  // An explicit --repo beats the environment.
  assert.equal(
    resolveScope({ repo: 'acme/widgets', env: { GITHUB_REPOSITORY: 'other/thing' } }).scope.name,
    'acme/widgets',
  );
});

test('resolveScope rejects both flags, a bad slug and nothing at all', () => {
  assert.match(resolveScope({ repo: 'a/b', org: 'acme' }).error, /mutually exclusive/);
  assert.match(resolveScope({ repo: 'not-a-slug' }).error, /owner\/repo/);
  assert.match(resolveScope({ repo: 'a/b/c' }).error, /owner\/repo/);
  assert.match(resolveScope({ org: 'acme/widgets' }).error, /organization name/);
  const none = resolveScope({ env: {} });
  assert.match(none.error, /No repository to look at/);
  assert.match(none.detail, /--repo <owner\/repo> or --org <name>/);
});

test('the endpoints are the documented paths', () => {
  assert.equal(deprecationsUrl(ORG, '2.335.1'), 'https://api.github.com/orgs/acme/actions/runners/deprecations/2.335.1');
  assert.equal(
    deprecationsUrl(REPO, '2.335.1'),
    'https://api.github.com/repos/acme/widgets/actions/runners/deprecations/2.335.1',
  );
  assert.equal(endpointLabel(deprecationsUrl(ORG, '2.335.1')), 'GET /orgs/acme/actions/runners/deprecations/2.335.1');
  assert.equal(
    endpointLabel('https://api.github.com/orgs/acme/actions/runners?per_page=100&page=1'),
    'GET /orgs/acme/actions/runners',
  );
});

/* ---------------------------------------------------------------- lookups */

test('lookupDeprecation reads the recorded live shape, absent field included', async () => {
  const api = stubApi(routes(fleets.arc));
  try {
    const due = await lookupDeprecation(ORG, '2.335.1');
    assert.equal(due.ok, true);
    assert.equal(due.runnerVersion, '2.335.1');
    assert.equal(due.runtimeDeprecatesAt, '2026-09-24T15:30:55Z');
    // The live API omits registration_deprecates_at entirely; absent reads as null.
    assert.equal(due.registrationDeprecatesAt, null);

    const current = await lookupDeprecation(ORG, '2.337.0');
    assert.equal(current.runtimeDeprecatesAt, null);
    assert.equal(current.registrationDeprecatesAt, null);
  } finally {
    api.restore();
  }
});

test('a 404 on an unrecognised version is reported, not thrown', async () => {
  const api = stubApi(routes(fleets.arc));
  try {
    const miss = await lookupDeprecation(ORG, '9.9.9');
    assert.equal(miss.ok, false);
    assert.equal(miss.unknownVersion, true);
    assert.equal(miss.version, '9.9.9');
  } finally {
    api.restore();
  }
});

test('the version cache means twenty runners cost one lookup', async () => {
  const fleet = {
    total_count: 20,
    runners: Array.from({ length: 20 }, (_, i) => ({
      id: i,
      name: `arc-${i}`,
      os: 'linux',
      status: 'online',
      busy: false,
      labels: [],
      ephemeral: true,
      version: '2.335.1',
    })),
  };
  const api = stubApi(routes(fleet));
  try {
    const s = await surveyRunners(ORG, { now: NOW });
    assert.equal(s.groups.length, 1);
    assert.equal(s.groups[0].count, 20);
    const lookups = api.calls.filter((u) => u.includes('/deprecations/'));
    assert.equal(lookups.length, 1, 'one deprecations call for twenty runners');
  } finally {
    api.restore();
  }
});

/* ---------------------------------------------------------------- grouping */

test('groupByVersion keeps names, counts, ephemeral and a null version', () => {
  const groups = groupByVersion(fleets.arc.runners);
  assert.deepEqual(
    groups.map((g) => [g.version, g.count]),
    [
      ['2.335.1', 2],
      ['2.337.0', 1],
    ],
  );
  assert.deepEqual(groups[0].names, ['arc-linux-1', 'arc-linux-2']);
  assert.equal(groups[0].ephemeral, true);
  assert.equal(groups[0].busy, 1);
  assert.equal(groups[1].ephemeral, false);
  assert.equal(groupByVersion(fleets.unknown.runners)[0].version, null);
  assert.deepEqual(groupByVersion([]), []);
});

test('looksImagePinned is a guess from count or ephemerality, and says so', () => {
  assert.equal(looksImagePinned({ count: 2, ephemeral: false }), true);
  assert.equal(looksImagePinned({ count: 1, ephemeral: true }), true);
  assert.equal(looksImagePinned({ count: 1, ephemeral: false }), false);
});

test('compareRunnerVersions is numeric, and nulls sort last', () => {
  assert.ok(compareRunnerVersions('2.335.1', '2.337.0') < 0);
  assert.ok(compareRunnerVersions('2.9.0', '2.10.0') < 0, 'not a string compare');
  assert.equal(compareRunnerVersions('2.335.1', '2.335.1'), 0);
  assert.ok(compareRunnerVersions(null, '2.337.0') > 0);
});

/* ---------------------------------------------------------- classification */

test('both dates absent is OK, not "no data"', () => {
  const c = classifyVersion({ version: '2.337.0', days: 30, now: NOW });
  assert.equal(c.status, RUNNER_STATUS.OK);
  assert.equal(c.runtime, null);
  assert.equal(c.registration, null);
});

test('runtime inside the window is RUNTIME-DUE', () => {
  const c = classifyVersion({
    version: '2.335.1',
    runtimeDeprecatesAt: '2026-09-24T15:30:55Z',
    days: 30,
    now: NOW,
  });
  assert.equal(c.status, RUNNER_STATUS.RUNTIME_DUE);
  assert.equal(c.runtime.days, 16);
  assert.equal(c.runtime.date, '2026-09-24');
  assert.equal(c.runtime.past, false);
});

test('runtime beyond the window is OK, and the window is what moves it', () => {
  const args = { version: '2.336.0', runtimeDeprecatesAt: '2026-11-05T08:04:55Z', now: NOW };
  assert.equal(classifyVersion({ ...args, days: 30 }).status, RUNNER_STATUS.OK);
  assert.equal(classifyVersion({ ...args, days: 30 }).runtime.days, 57);
  assert.equal(classifyVersion({ ...args, days: 60 }).status, RUNNER_STATUS.RUNTIME_DUE);
});

test('registration is its own status, never folded into RUNTIME-DUE', () => {
  const regOnly = classifyVersion({
    version: '2.330.0',
    registrationDeprecatesAt: '2026-09-20T00:00:00Z',
    days: 30,
    now: NOW,
  });
  assert.equal(regOnly.status, RUNNER_STATUS.REGISTRATION_DUE);
  assert.equal(regOnly.runtime, null);
  assert.equal(regOnly.registration.days, 11);

  // Both due: runtime outranks, but the registration date is still reported.
  const both = classifyVersion({
    version: '2.330.0',
    registrationDeprecatesAt: '2026-09-20T00:00:00Z',
    runtimeDeprecatesAt: '2026-09-25T00:00:00Z',
    days: 30,
    now: NOW,
  });
  assert.equal(both.status, RUNNER_STATUS.RUNTIME_DUE);
  assert.equal(both.registration.days, 11);
});

test('a date already past is EXPIRED whatever the window', () => {
  for (const days of [0, 1, 365]) {
    const c = classifyVersion({
      version: '2.325.0',
      runtimeDeprecatesAt: '2025-09-11T13:58:34Z',
      days,
      now: NOW,
    });
    assert.equal(c.status, RUNNER_STATUS.EXPIRED, `days=${days}`);
    assert.equal(c.runtime.past, true);
  }
  // A past registration date alone is enough.
  assert.equal(
    classifyVersion({ version: '2.320.0', registrationDeprecatesAt: '2026-01-01T00:00:00Z', days: 0, now: NOW })
      .status,
    RUNNER_STATUS.EXPIRED,
  );
});

test('a null version and an unrecognised version are both UNKNOWN-VERSION', () => {
  assert.equal(classifyVersion({ version: null, now: NOW }).status, RUNNER_STATUS.UNKNOWN_VERSION);
  assert.equal(
    classifyVersion({ version: '9.9.9', unknownVersion: true, now: NOW }).status,
    RUNNER_STATUS.UNKNOWN_VERSION,
  );
});

test('belowRegistrationMinimum knows the 2.329.0 floor', () => {
  assert.equal(MINIMUM_REGISTRATION_VERSION, '2.329.0');
  assert.equal(belowRegistrationMinimum('2.328.0'), true);
  assert.equal(belowRegistrationMinimum('2.329.0'), false);
  assert.equal(belowRegistrationMinimum('2.337.0'), false);
  assert.equal(belowRegistrationMinimum(null), false);
});

test('the default window is GitHub\'s own 30 days', () => {
  assert.equal(DEFAULT_DEPRECATION_WINDOW_DAYS, 30);
});

/* ------------------------------------------------------------------ survey */

test('the worked example: two image-pinned runners due, one current', async () => {
  const s = await survey(fleets.arc, { days: 30, failOn: true });
  assert.equal(s.status, SURVEY_STATUS.OK);
  assert.equal(s.totalCount, 3);
  assert.equal(s.groups.length, 2);

  const [due, ok] = s.groups;
  assert.equal(due.status, RUNNER_STATUS.RUNTIME_DUE);
  assert.equal(due.version, '2.335.1');
  assert.equal(due.count, 2);
  assert.equal(due.imagePinned, true);
  assert.equal(due.runtime.date, '2026-09-24');
  assert.equal(due.runtime.days, 16);
  assert.equal(due.source, 'GET /orgs/acme/actions/runners/deprecations/2.335.1');

  assert.equal(ok.status, RUNNER_STATUS.OK);
  assert.equal(ok.version, '2.337.0');
  assert.equal(ok.publishedAt, '2026-08-26T14:33:29Z');
  assert.equal(s.failing, true);
});

test('urgent groups sort first', async () => {
  const s = await survey(fleets.expired, { days: 30, failOn: true });
  assert.deepEqual(
    s.groups.map((g) => [g.status, g.version]),
    [
      [RUNNER_STATUS.EXPIRED, '2.325.0'],
      [RUNNER_STATUS.OK, '2.336.0'],
    ],
  );
  assert.equal(s.failing, true, 'EXPIRED fails');
});

test('an EXPIRED runner fails with no --fail-on-deprecation at all', async () => {
  const s = await survey(fleets.expired, { days: 30, failOn: false });
  assert.equal(s.groups[0].status, RUNNER_STATUS.EXPIRED);
  assert.equal(s.failing, true);
});

test('an entirely current fleet is OK and never fails', async () => {
  const s = await survey(fleets.current, { days: 30, failOn: true });
  assert.equal(s.groups.length, 1);
  assert.equal(s.groups[0].status, RUNNER_STATUS.OK);
  assert.equal(s.groups[0].count, 2);
  assert.equal(s.failing, false);
  // auto-2 is offline in the fixture, and the row says so: an offline runner on
  // a dead version is a different job from an online one.
  assert.equal(s.groups[0].online, 1);
  assert.match(runnersReport(s), /OK {12}2\.337\.0 {2}x2 \(1 offline\) {2}auto-1, auto-2/);
});

test('UNKNOWN-VERSION never fails, even with the flag set', async () => {
  const s = await survey(fleets.unknown, { days: 3650, failOn: true });
  assert.deepEqual(new Set(s.groups.map((g) => g.status)), new Set([RUNNER_STATUS.UNKNOWN_VERSION]));
  assert.equal(s.failing, false);
  assert.equal(s.groups.find((g) => g.version === null).count, 1);
  assert.equal(s.groups.find((g) => g.version === '9.9.9').unknownVersion, true);
});

test('zero self-hosted runners is the normal case, not a failure', async () => {
  const s = await survey(fleets.arc, { failOn: true }, { listing: recorded.listing });
  assert.equal(s.status, SURVEY_STATUS.OK);
  assert.equal(s.totalCount, 0);
  assert.equal(s.surveyedCount, 0);
  assert.deepEqual(s.groups, []);
  assert.equal(s.failing, false);
});

test('the header counts what was surveyed, and a shortfall is stated', async () => {
  // total_count says nine, the listing returns two. Printing nine would be a lie.
  const short = {
    total_count: 9,
    runners: [
      { id: 1, name: 'a', os: 'linux', status: 'online', busy: false, labels: [], version: '2.337.0' },
      { id: 2, name: 'b', os: 'linux', status: 'online', busy: false, labels: [], version: '2.337.0' },
    ],
  };
  const s = await survey(short, { days: 30 });
  assert.equal(s.totalCount, 9);
  assert.equal(s.surveyedCount, 2);
  const text = runnersReport(s);
  assert.match(text, /^self-hosted runners — acme \(2 runners, 1 version\)$/m);
  assert.match(text, /^note: the API reported 9 runners but returned 2 — only what it returned was checked$/m);
  assert.match(runnersSummaryMarkdown(s), /`acme` — 2 runners on 1 version/);
  assert.match(runnersSummaryMarkdown(s), /> ⚠️ the API reported 9 runners but returned 2/);
});

test('an empty fleet the API claims is non-empty still says so', async () => {
  const s = await survey(fleets.arc, {}, { listing: { status: 200, body: { total_count: 3, runners: [] } } });
  const text = runnersReport(s);
  assert.match(text, /^self-hosted runners — acme \(0 runners\)$/m);
  assert.match(text, /no self-hosted runners registered/);
  assert.match(text, /the API reported 3 runners but returned 0/);
  assert.match(runnersSummaryMarkdown(s), /the API reported 3 runners but returned 0/);
});

test('a listing 403 is a PERMISSION status naming the permission and endpoint', async () => {
  const s = await survey(fleets.arc, {}, { listing: { status: 403, body: fleets.forbidden } });
  assert.equal(s.status, SURVEY_STATUS.PERMISSION);
  assert.match(s.message, /^GET \/orgs\/acme\/actions\/runners was refused \(HTTP 403\)$/);
  assert.match(s.hint.join(' '), /"Self-hosted runners" organization permission \(read\)/);
  assert.match(s.hint.join(' '), /admin:org/);
  assert.deepEqual(s.groups, []);
});

test('a listing 404 (an org the token cannot see) is the same PERMISSION status', async () => {
  const s = await survey(fleets.arc, {}, { listing: { status: 404, body: fleets.missing } });
  assert.equal(s.status, SURVEY_STATUS.PERMISSION);
  assert.match(s.message, /not visible to this token \(HTTP 404\)/);
});

test('a repo-scope refusal names the Administration permission instead', async () => {
  const api = stubApi(
    runnerRoutes({
      scopePath: '/repos/acme/widgets',
      fleet: fleets.arc,
      recorded,
      releases,
      listing: { status: 403, body: fleets.forbidden },
    }),
  );
  try {
    const s = await surveyRunners(REPO, { now: NOW });
    assert.equal(s.status, SURVEY_STATUS.PERMISSION);
    assert.match(s.hint.join(' '), /"Administration" repository permission \(read\)/);
    assert.match(s.message, /GET \/repos\/acme\/widgets\/actions\/runners/);
  } finally {
    api.restore();
  }
});

test('no token at all (HTTP 401) is PERMISSION, not an opaque HTTP error', async () => {
  const s = await survey(
    fleets.arc,
    {},
    { listing: { status: 401, body: { message: 'Requires authentication', status: '401' } } },
  );
  assert.equal(s.status, SURVEY_STATUS.PERMISSION);
  assert.match(s.message, /was not authenticated \(HTTP 401\)/);
  assert.match(s.hint.join(' '), /never readable anonymously — set GITHUB_TOKEN/);
  assert.match(s.hint.join(' '), /"Self-hosted runners" organization permission/);
});

test('a rate limit is UNAVAILABLE with the token hint, not a crash', async () => {
  const s = await survey(
    fleets.arc,
    {},
    {
      listing: {
        status: 403,
        body: { message: 'rate limited' },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1789000000' },
      },
    },
  );
  assert.equal(s.status, SURVEY_STATUS.UNAVAILABLE);
  assert.match(s.message, /rate limit exceeded/);
  assert.match(s.hint.join(' '), /Set GITHUB_TOKEN/);
});

test('a network failure is UNAVAILABLE, not a stack trace', async () => {
  const api = stubApi(() => null); // the stub throws TypeError('fetch failed')
  try {
    const s = await surveyRunners(ORG, { now: NOW });
    assert.equal(s.status, SURVEY_STATUS.UNAVAILABLE);
    assert.match(s.message, /could not be read/);
  } finally {
    api.restore();
  }
});

test('a non-JSON-shaped listing is UNAVAILABLE, not a crash', async () => {
  const s = await survey(fleets.arc, {}, { listing: { status: 200, body: { total_count: 3 } } });
  assert.equal(s.status, SURVEY_STATUS.UNAVAILABLE);
  assert.match(s.message, /returned no `runners` array/);
});

test('the listing paginates', async () => {
  const page = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: i,
      name: `r${i}`,
      os: 'linux',
      status: 'online',
      busy: false,
      labels: [],
      version: '2.337.0',
    }));
  const api = stubApi((url) => {
    if (url.includes('/deprecations/')) return recorded.responses['2.337.0'];
    if (url.includes('/actions/runners?')) {
      const p = Number(new URL(url).searchParams.get('page'));
      return { status: 200, body: { total_count: 150, runners: p === 1 ? page(100) : page(50) } };
    }
    return { status: 200, body: releases.releases };
  });
  try {
    const listed = await listRunners(ORG);
    assert.equal(listed.ok, true);
    assert.equal(listed.runners.length, 150);
    assert.equal(listed.totalCount, 150);
  } finally {
    api.restore();
  }
});

test('a fleet past the page cap is reported as truncated, not silently cut', async () => {
  const full = () =>
    Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `r${i}`,
      os: 'linux',
      status: 'online',
      busy: false,
      labels: [],
      version: '2.337.0',
    }));
  const api = stubApi((url) => {
    if (url.includes('/deprecations/')) return recorded.responses['2.337.0'];
    if (url.includes('/actions/runners?')) return { status: 200, body: { total_count: 5000, runners: full() } };
    return { status: 200, body: releases.releases };
  });
  try {
    const listed = await listRunners(ORG);
    assert.equal(listed.truncated, true);
    assert.equal(listed.runners.length, 1000, 'ten pages of a hundred');
    const s = await surveyRunners(ORG, { now: NOW });
    assert.equal(s.truncated, true);
    assert.equal(s.surveyedCount, 1000);
    assert.equal(s.totalCount, 5000);
    // The header counts what was classified, never the number the API claimed.
    const text = runnersReport(s);
    assert.match(text, /^self-hosted runners — acme \(1000 runners, 1 version\)$/m);
    assert.match(text, /the runner listing was cut off after 1000 of 5000 — this is a prefix of the fleet/);
    assert.match(runnersSummaryMarkdown(s), /> ⚠️ the runner listing was cut off after 1000 of 5000/);
  } finally {
    api.restore();
  }
});

test('the release lookup happens once, and only when a row can use it', async () => {
  // A fleet whose only runners never reported a version has nothing to date and
  // nothing to update, so the extra call is not made.
  const api = stubApi(routes({ total_count: 1, runners: [{ id: 1, name: 'never', version: null }] }));
  try {
    const s = await surveyRunners(ORG, { now: NOW });
    assert.equal(s.groups[0].status, RUNNER_STATUS.UNKNOWN_VERSION);
    assert.equal(api.calls.filter((u) => u.includes('/repos/actions/runner/releases')).length, 0);
  } finally {
    api.restore();
  }

  // With real versions it is fetched exactly once, however many groups there are.
  const api2 = stubApi(routes(fleets.arc));
  try {
    const s = await surveyRunners(ORG, { now: NOW, days: 30 });
    assert.equal(s.groups.find((g) => g.version === '2.337.0').publishedAt, '2026-08-26T14:33:29Z');
    assert.equal(api2.calls.filter((u) => u.includes('/repos/actions/runner/releases')).length, 1);
  } finally {
    api2.restore();
  }
});

test('a behind version is told what to update to, and it is never a prerelease', async () => {
  const s = await survey(fleets.arc, { days: 30, failOn: true });
  const due = s.groups.find((g) => g.version === '2.335.1');
  assert.deepEqual(due.updateTo, { version: '2.337.0', publishedAt: '2026-08-26T14:33:29Z' });
  assert.match(
    runnersReport(s),
    /update to 2\.337\.0, published 2026-08-26 — the newest stable actions\/runner release/,
  );

  // The newest version has nothing to update to.
  assert.equal(s.groups.find((g) => g.version === '2.337.0').updateTo, null);

  // An OK row that happens to be behind keeps the value in --json but is not
  // nagged about in the text: it already prints why it is fine.
  const ok = await survey(fleets.expired, { days: 30 });
  const behindButOk = ok.groups.find((g) => g.version === '2.336.0');
  assert.equal(behindButOk.status, RUNNER_STATUS.OK);
  assert.equal(behindButOk.updateTo.version, '2.337.0');
  const okLines = runnersReport(ok)
    .split('\n')
    .filter((l) => l.includes('2.336.0') || l.includes('beyond the'));
  assert.ok(
    !okLines.some((l) => l.includes('update to')),
    'no update nag on a row that is not actionable',
  );
  assert.match(runnersReport(ok), /EXPIRED[\s\S]*update to 2\.337\.0/, 'but the EXPIRED row gets one');

  // actions/runner really does ship prereleases (v2.320.1 and nine others in the
  // recorded list); recommending one would be worse than saying nothing.
  assert.ok(
    releases.releases.some((r) => r.prerelease),
    'the recorded fixture still contains prereleases, so this assertion means something',
  );
  const preOnly = {
    ...releases,
    releases: [{ tag_name: 'v9.9.9', published_at: '2026-09-01T00:00:00Z', prerelease: true, draft: false }],
  };
  const api2 = stubApi((url) => {
    if (url.includes('/repos/actions/runner/releases')) return { status: 200, body: preOnly.releases };
    if (url.includes('/deprecations/')) {
      return recorded.responses[decodeURIComponent(url.split('/deprecations/')[1])];
    }
    return { status: 200, body: fleets.arc };
  });
  try {
    const only = await surveyRunners(ORG, { now: NOW, days: 30 });
    assert.ok(
      only.groups.every((g) => g.updateTo === null),
      'a prerelease is never offered as the update target',
    );
  } finally {
    api2.restore();
  }
});

test('an unparseable date from the API is reported, not silently read as safe', async () => {
  const api = stubApi((url) => {
    if (url.includes('/deprecations/')) {
      return { status: 200, body: { runner_version: '2.335.1', runtime_deprecates_at: 'not-a-date' } };
    }
    if (url.includes('/repos/actions/runner/releases')) return { status: 200, body: releases.releases };
    return { status: 200, body: fleets.arc };
  });
  try {
    const s = await surveyRunners(ORG, { now: NOW, days: 30 });
    const g = s.groups.find((x) => x.version === '2.335.1');
    assert.deepEqual(g.unparsedDates, ['runtime_deprecates_at']);
    assert.equal(g.runtime, null);
    assert.match(
      runnersReport(s),
      /the API sent a `runtime_deprecates_at` this build could not parse — treated as no date, so do not read this row as safe/,
    );
  } finally {
    api.restore();
  }
});

test('a runner name containing a pipe cannot break the summary table', async () => {
  assert.deepEqual(markdownTable(['A'], [['a|b']]), ['| A |', '| --- |', '| a\\|b |']);

  const piped = {
    total_count: 1,
    runners: [{ id: 1, name: 'evil|name', os: 'linux', status: 'online', busy: false, labels: [], version: '2.335.1' }],
  };
  const md = runnersSummaryMarkdown(await survey(piped, { days: 30, failOn: true }));
  const row = md.split('\n').find((l) => l.startsWith('| `2.335.1`'));
  assert.equal(row.split(' | ').length, 6, 'still six cells, not seven');
  assert.match(row, /evil\\\|name/);
});

test('a best-effort release-date fetch that fails still leaves a usable survey', async () => {
  const api = stubApi((url) => {
    if (url.includes('/repos/actions/runner/releases')) return null; // throws
    if (url.includes('/deprecations/')) return recorded.responses['2.335.1'];
    return { status: 200, body: fleets.arc };
  });
  try {
    const s = await surveyRunners(ORG, { now: NOW });
    assert.equal(s.status, SURVEY_STATUS.OK);
    assert.equal(s.groups[0].publishedAt, null);
  } finally {
    api.restore();
  }
});

/* ------------------------------------------------------------------ report */

test('the report reproduces the worked example', async () => {
  const s = await survey(fleets.arc, { days: 30, failOn: true });
  const text = runnersReport(s);
  const lines = text.split('\n');
  assert.equal(lines[0], 'self-hosted runners — acme (3 runners, 2 versions)');
  assert.match(lines[1], /^ {2}RUNTIME-DUE {3}2\.335\.1 {2}x2 {2}arc-linux-1, arc-linux-2$/);
  assert.match(text, /runtime support ends 2026-09-24 \(16 days\) — jobs stop being queued/);
  assert.match(text, /ephemeral runners — change the actions-runner-controller image tag, not the host/);
  assert.match(text, /^ {2}OK {12}2\.337\.0 {2}x1 {2}build-mac-1 {2}\(published 2026-08-26\)$/m);
  assert.match(text, /^note: self-hosted runners auto-update by default/m);
  assert.match(
    text,
    /^note: enforcement covers github\.com and GitHub Enterprise Cloud, not GitHub Enterprise Server$/m,
  );
  assert.match(text, /^source: GET \/orgs\/acme\/actions\/runners\/deprecations\/2\.335\.1$/m);
  // Not a universal deadline: the current version carries no date at all.
  assert.match(text, /no end date returned — this version is current/);
});

test('two non-ephemeral hosts on one version read as a VM image, not as ARC', async () => {
  // GitHub's required-actions list names both populations. Identical versions on
  // separate long-lived hosts is the "recreate runners built from older cached
  // images or templates" case, and the wording has to differ from the ARC one.
  const s = await survey(fleets.vmimage, { days: 30, failOn: true });
  assert.equal(s.groups[0].imagePinned, true);
  assert.equal(s.groups[0].ephemeral, false);
  const text = runnersReport(s);
  assert.match(text, /these look image-pinned; update the image or template, not the host/);
  assert.ok(!text.includes('actions-runner-controller image tag'), 'not the ARC wording');
});

test('the report names the registration consequence separately', () => {
  const s = {
    status: 'OK',
    scope: { name: 'acme' },
    totalCount: 1,
    windowDays: 30,
    autoUpdateNote: 'note-a',
    ghesNote: 'note-g',
    groups: [
      {
        status: RUNNER_STATUS.REGISTRATION_DUE,
        version: '2.330.0',
        count: 1,
        names: ['host-1'],
        ephemeral: false,
        imagePinned: false,
        runtime: null,
        registration: { at: '2026-09-20T00:00:00Z', date: '2026-09-20', days: 11, past: false },
        source: 'GET /orgs/acme/actions/runners/deprecations/2.330.0',
      },
    ],
  };
  const text = runnersReport(s);
  assert.match(text, /REGISTRATION-DUE 2\.330\.0/);
  assert.match(text, /registration ends 2026-09-20 \(11 days\) — cannot register or reregister/);
  assert.ok(!text.includes('jobs stop being queued'), 'no runtime line when there is no runtime date');
});

test('an expired runner reads in the past tense', async () => {
  const s = await survey(fleets.expired, { days: 30, failOn: false });
  const text = runnersReport(s);
  assert.match(text, /EXPIRED/);
  assert.match(text, /runtime support ended 2025-09-11 \(362 days ago\) — jobs are no longer queued to it/);
});

test('the unknown-version report echoes the version and the 2.329.0 floor', () => {
  const s = {
    status: 'OK',
    scope: { name: 'acme' },
    totalCount: 2,
    windowDays: 30,
    autoUpdateNote: 'a',
    ghesNote: 'g',
    groups: [
      {
        status: RUNNER_STATUS.UNKNOWN_VERSION,
        version: '2.320.0',
        count: 1,
        names: ['old-1'],
        runtime: null,
        registration: null,
        source: 'GET /orgs/acme/actions/runners/deprecations/2.320.0',
      },
      {
        status: RUNNER_STATUS.UNKNOWN_VERSION,
        version: null,
        count: 1,
        names: ['never-connected'],
        runtime: null,
        registration: null,
        source: null,
      },
    ],
  };
  const text = runnersReport(s);
  assert.match(text, /does not recognise version 2\.320\.0 — reporting only, never failing/);
  assert.match(text, /2\.320\.0 is below the 2\.329\.0 registration minimum/);
  assert.match(text, /no version reported — the runner has never connected/);
});

test('the empty report says so plainly and names the endpoint', async () => {
  const s = await survey(fleets.arc, {}, { listing: recorded.listing });
  const text = runnersReport(s);
  assert.match(text, /^self-hosted runners — acme \(0 runners\)$/m);
  assert.match(text, /no self-hosted runners registered — nothing to check/);
  assert.match(text, /GitHub-hosted runners are not affected/);
  assert.match(text, /^source: GET \/orgs\/acme\/actions\/runners$/m);
});

test('the permission report leads with the status and the fix', async () => {
  const s = await survey(fleets.arc, {}, { listing: { status: 403, body: fleets.forbidden } });
  const text = runnersReport(s);
  assert.match(text, /^PERMISSION {2}GET \/orgs\/acme\/actions\/runners was refused \(HTTP 403\)$/m);
  assert.match(text, /"Self-hosted runners" organization permission \(read\)/);
});

test('annotations escalate only where they should', async () => {
  const due = runnersAnnotations(await survey(fleets.arc, { days: 30, failOn: true }));
  assert.equal(due.length, 1, 'no annotation for the OK group');
  assert.match(due[0], /^::error title=runner-drift: runner 2\.335\.1 RUNTIME-DUE::/);
  assert.match(due[0], /not GitHub Enterprise Server/);

  const report = runnersAnnotations(await survey(fleets.arc, { days: 30, failOn: false }));
  assert.match(report[0], /^::warning title=/, 'a report-only run warns rather than errors');

  const unknown = runnersAnnotations(await survey(fleets.unknown, { days: 30, failOn: true }));
  assert.ok(
    unknown.every((l) => l.startsWith('::notice ')),
    'UNKNOWN-VERSION is a notice',
  );

  const refused = runnersAnnotations(
    await survey(fleets.arc, {}, { listing: { status: 403, body: fleets.forbidden } }),
  );
  assert.equal(refused.length, 1);
  assert.match(refused[0], /^::warning title=runner-drift: PERMISSION::/);
  assert.match(refused[0], /organization permission \(read\)/);
});

test('the step summary tables the fleet, with the notes and citation underneath', async () => {
  const md = runnersSummaryMarkdown(await survey(fleets.arc, { days: 30, failOn: true }));
  assert.match(md, /^## runner-drift — self-hosted runners/);
  assert.match(
    md,
    /\| Version \| Runners \| Status \| Runtime ends \| Registration ends \| Update to \|/,
  );
  assert.equal(
    md.split('\n').find((l) => l.startsWith('| `2.335.1`')),
    '| `2.335.1` | x2 arc-linux-1, arc-linux-2 | 🟠 RUNTIME-DUE | 2026-09-24 (16 days) | — | `2.337.0` |',
  );
  assert.equal(
    md.split('\n').find((l) => l.startsWith('| `2.337.0`')),
    '| `2.337.0` | x1 build-mac-1 | ⚪ OK | — | — | — |',
  );
  assert.match(md, /^Source: `GET \/orgs\/acme\/actions\/runners\/deprecations\/2\.335\.1`, /m);
  assert.match(md, /^> self-hosted runners auto-update by default/m);
  assert.match(md, /not GitHub Enterprise Server — see \[the enforcement timeline\]/);
});

test('the step summary covers the empty and refused cases too', async () => {
  const empty = runnersSummaryMarkdown(await survey(fleets.arc, {}, { listing: recorded.listing }));
  assert.match(empty, /has no self-hosted runners registered/);
  const refused = runnersSummaryMarkdown(
    await survey(fleets.arc, {}, { listing: { status: 403, body: fleets.forbidden } }),
  );
  assert.match(refused, /\*\*PERMISSION\*\*/);
});

/* ------------------------------------------------------- the CLI: `runners` */

test('runners exits 1 on the due fleet with --fail-on-deprecation 30', async () => {
  const r = await runners({ org: 'acme', 'fail-on-deprecation': '30' });
  assert.equal(r.code, EXIT_DRIFT);
  assert.match(r.stdout, /RUNTIME-DUE {3}2\.335\.1/);
  assert.match(
    r.stderr,
    /^runner-drift: 2 self-hosted runner\(s\) on 2\.335\.1 lose runtime support on 2026-09-24 \(16 days\) and --fail-on-deprecation 30 is set\.$/m,
  );
});

test('runners exits 0 on the current fleet, and on the due fleet without the flag', async () => {
  const current = await runners({ org: 'acme', 'fail-on-deprecation': '30' }, {}, fleets.current);
  assert.equal(current.code, EXIT_OK);
  assert.equal(current.stderr, '');

  const reportOnly = await runners({ org: 'acme' });
  assert.equal(reportOnly.code, EXIT_OK, 'the plain report never fails');
  assert.match(reportOnly.stdout, /RUNTIME-DUE/, 'but it still says what is coming');
  assert.equal(reportOnly.stderr, '');
});

test('runners exits 1 on an expired runner even without the flag', async () => {
  const r = await runners({ org: 'acme' }, {}, fleets.expired);
  assert.equal(r.code, EXIT_DRIFT);
  assert.match(r.stderr, /lost runtime support on 2025-09-11 \(362 days ago\) — jobs are no longer queued/);
});

test('runners exits 2 when --repo and --org are both given', async () => {
  const cap = captureIO();
  const code = await runRunners({ summary: false, org: 'acme', repo: 'acme/widgets' }, cap.io, {}, { now: NOW });
  assert.equal(code, EXIT_USAGE);
  assert.match(cap.stderr, /--repo and --org are mutually exclusive/);
});

test('runners exits 2 with no scope at all, and on a bad --fail-on-deprecation', async () => {
  const cap = captureIO();
  assert.equal(await runRunners({ summary: false }, cap.io, {}, { now: NOW }), EXIT_USAGE);
  assert.match(cap.stderr, /No repository to look at/);

  for (const bad of ['soon', '-5', '2.5', '']) {
    const r = await runners({ org: 'acme', 'fail-on-deprecation': bad });
    assert.equal(r.code, EXIT_USAGE, `"${bad}" rejected`);
    assert.match(r.stderr, /--fail-on-deprecation needs a whole number of days >= 0/);
  }
});

test('runners on a permission failure reports and still exits 0', async () => {
  const r = await runners({ org: 'acme', 'fail-on-deprecation': '30' }, {}, fleets.arc, {
    listing: { status: 403, body: fleets.forbidden },
  });
  assert.equal(r.code, EXIT_OK, 'a refusal is never a failing exit code by itself');
  assert.match(r.stdout, /::warning title=runner-drift: PERMISSION::/, 'but never a silent pass');
  assert.match(r.stdout, /PERMISSION {2}GET \/orgs\/acme\/actions\/runners was refused \(HTTP 403\)/);
  assert.equal(r.stderr, '');
});

test('runners on an empty fleet reports and exits 0', async () => {
  const r = await runners({ org: 'acme', 'fail-on-deprecation': '0' }, {}, fleets.arc, {
    listing: recorded.listing,
  });
  assert.equal(r.code, EXIT_OK);
  assert.match(r.stdout, /no self-hosted runners registered/);
  assert.ok(!r.stdout.includes('::'), 'nothing to annotate');
});

test('runners --repo defaults to $GITHUB_REPOSITORY', async () => {
  const api = stubApi(
    runnerRoutes({ scopePath: '/repos/acme/widgets', fleet: fleets.current, recorded, releases }),
  );
  const cap = captureIO();
  try {
    const code = await runRunners(
      { summary: false },
      cap.io,
      { GITHUB_REPOSITORY: 'acme/widgets' },
      { now: NOW },
    );
    assert.equal(code, EXIT_OK);
    assert.match(cap.stdout, /^self-hosted runners — acme\/widgets \(2 runners, 1 version\)$/m);
  } finally {
    api.restore();
  }
});

test('runners --json shapes the whole survey', async () => {
  const r = await runners({ org: 'acme', 'fail-on-deprecation': '30', json: true });
  assert.equal(r.code, EXIT_DRIFT);
  const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.equal(parsed.status, 'OK');
  assert.equal(parsed.scope.name, 'acme');
  assert.equal(parsed.windowDays, 30);
  assert.equal(parsed.failOn, true);
  assert.equal(parsed.groups[0].status, 'RUNTIME-DUE');
  // --json keeps the full timestamp; the text report trims it to a date.
  assert.equal(parsed.groups[0].runtime.at, '2026-09-24T15:30:55Z');
  assert.equal(parsed.groups[0].runtime.days, 16);
  // Fleet health rides along for automation even though the text report only
  // surfaces the offline count.
  assert.equal(parsed.groups[0].online, 2);
  assert.equal(parsed.groups[0].busy, 1);
  assert.equal(parsed.groups[0].ephemeral, true);
  assert.deepEqual(parsed.groups[0].labels, ['self-hosted', 'Linux', 'X64', 'gpu']);
  assert.equal(parsed.ghesNote, 'enforcement covers github.com and GitHub Enterprise Cloud, not GitHub Enterprise Server');
  assert.match(parsed.source, /^https:\/\/github\.blog\/changelog\/2026-06-12-/);
});

test('runners writes the table to $GITHUB_STEP_SUMMARY', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-drift-runners-'));
  const summaryFile = path.join(dir, 'summary.md');
  await writeFile(summaryFile, '', 'utf8');
  const prev = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summaryFile;
  try {
    await runners({ org: 'acme', summary: true, 'fail-on-deprecation': '30' });
    const md = await readFile(summaryFile, 'utf8');
    assert.match(md, /## runner-drift — self-hosted runners/);
    assert.match(md, /🟠 RUNTIME-DUE/);
  } finally {
    if (prev === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------- the CLI: `guard` lane */

const SELFHOSTED_WF = path.join(FIXTURES, 'workflows', 'selfhosted.yml');

async function guardSelfHosted(env, opts = {}, extra = {}) {
  const api = stubApi(runnerRoutes({ scopePath: '/orgs/acme', fleet: fleets.arc, recorded, releases, ...extra }));
  const cap = captureIO();
  try {
    const code = await runGuard(
      { summary: false, 'update-lock': true, tools: 'node', workflows: SELFHOSTED_WF, ...opts },
      cap.io,
      env,
      { now: NOW },
    );
    return { code, stdout: cap.stdout, stderr: cap.stderr, calls: api.calls };
  } finally {
    api.restore();
  }
}

const SKIP_NOTICE =
  '::notice title=runner-drift::No ImageVersion environment variable — this is not a GitHub-hosted runner ' +
  '(self-hosted runner or local shell). runner-drift guard has nothing to compare; skipping.\n' +
  'No ImageVersion environment variable — this is not a GitHub-hosted runner ' +
  '(self-hosted runner or local shell). runner-drift guard has nothing to compare; skipping.\n';

test('guard on a self-hosted runner with no token is the 1.1.0 skip, byte for byte', async () => {
  const r = await guardSelfHosted({ RUNNER_NAME: 'arc-linux-1', GITHUB_REPOSITORY: 'acme/widgets' });
  assert.equal(r.code, EXIT_OK);
  assert.equal(r.stdout, SKIP_NOTICE);
  assert.equal(r.stderr, '');
  assert.deepEqual(r.calls, [], 'no token means no API call is even attempted');
});

test('guard with no RUNNER_NAME is the same skip', async () => {
  const r = await guardSelfHosted({ GITHUB_TOKEN: 'x', GITHUB_REPOSITORY: 'acme/widgets' });
  assert.equal(r.code, EXIT_OK);
  assert.equal(r.stdout, SKIP_NOTICE);
  assert.deepEqual(r.calls, []);
});

test('guard with a token reports this runner\'s own dates after the skip', async () => {
  const r = await guardSelfHosted({ RUNNER_NAME: 'arc-linux-1', GITHUB_TOKEN: 'x', org: 'acme' }, { org: 'acme' });
  assert.equal(r.code, EXIT_OK, 'no --fail-on-deprecation, so report only');
  assert.ok(r.stdout.startsWith(SKIP_NOTICE), 'the 1.1.0 skip still leads');
  assert.match(r.stdout, /::warning title=runner-drift: runner 2\.335\.1 RUNTIME-DUE::/);
  assert.match(r.stdout, /^self-hosted runners — acme \(1 runner, 1 version\)$/m);
  assert.match(r.stdout, /RUNTIME-DUE {3}2\.335\.1 {2}x1 {2}arc-linux-1/);
  assert.match(r.stdout, /runtime support ends 2026-09-24 \(16 days\)/);
  // Only this runner was looked up, not the whole fleet's other version.
  const lookups = r.calls.filter((u) => u.includes('/deprecations/'));
  assert.deepEqual(lookups.map((u) => u.split('/deprecations/')[1]), ['2.335.1']);
});

test('guard --fail-on-deprecation fails on its own runner', async () => {
  const r = await guardSelfHosted(
    { RUNNER_NAME: 'arc-linux-1', GITHUB_TOKEN: 'x' },
    { org: 'acme', 'fail-on-deprecation': '30' },
  );
  assert.equal(r.code, EXIT_DRIFT);
  assert.match(r.stdout, /::error title=runner-drift: runner 2\.335\.1 RUNTIME-DUE::/);
  assert.match(r.stderr, /1 self-hosted runner\(s\) on 2\.335\.1 lose runtime support on 2026-09-24 \(16 days\)/);
});

test('guard on a current self-hosted runner passes', async () => {
  const r = await guardSelfHosted(
    { RUNNER_NAME: 'build-mac-1', GITHUB_TOKEN: 'x' },
    { org: 'acme', 'fail-on-deprecation': '30' },
  );
  assert.equal(r.code, EXIT_OK);
  assert.match(r.stdout, /OK {12}2\.337\.0 {2}x1 {2}build-mac-1/);
  assert.equal(r.stderr, '');
});

test('guard falls back to the plain skip when the token lacks the permission', async () => {
  const r = await guardSelfHosted(
    { RUNNER_NAME: 'arc-linux-1', GITHUB_TOKEN: 'x' },
    { org: 'acme', 'fail-on-deprecation': '30' },
    { listing: { status: 403, body: fleets.forbidden } },
  );
  assert.equal(r.code, EXIT_OK, 'a refusal never fails the job');
  assert.ok(r.stdout.startsWith(SKIP_NOTICE));
  assert.match(r.stdout, /::warning title=runner-drift: PERMISSION::/);
  assert.match(r.stdout, /"Self-hosted runners" organization permission \(read\)/);
  assert.equal(r.stderr, '');
});

test('guard says nothing extra when this runner is not in the listing', async () => {
  const r = await guardSelfHosted(
    { RUNNER_NAME: 'some-enterprise-runner', GITHUB_TOKEN: 'x' },
    { org: 'acme', 'fail-on-deprecation': '30' },
  );
  assert.equal(r.code, EXIT_OK);
  assert.equal(r.stdout, SKIP_NOTICE);
});

test('guard --json carries the runners block on the self-hosted path', async () => {
  const r = await guardSelfHosted(
    { RUNNER_NAME: 'arc-linux-1', GITHUB_TOKEN: 'x' },
    { org: 'acme', 'fail-on-deprecation': '30', json: true },
  );
  assert.equal(r.code, EXIT_DRIFT);
  const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.equal(parsed.runners.groups[0].version, '2.335.1');
  assert.equal(parsed.runners.groups[0].status, 'RUNTIME-DUE');
  assert.equal(parsed.runners.totalCount, 1);
});

test('guard combines a retiring image label with a due runner version', async () => {
  const r = await guardSelfHosted(
    { RUNNER_NAME: 'arc-linux-1', GITHUB_TOKEN: 'x' },
    {
      org: 'acme',
      'fail-on-deprecation': '30',
      'fail-on-retirement': '60',
      workflows: path.join(FIXTURES, 'workflows-retirement'),
    },
  );
  assert.equal(r.code, EXIT_DRIFT);
  assert.match(r.stderr, /macos-14 is fully unsupported on 2026-11-02/, 'the image lane still reports');
  assert.match(r.stderr, /on 2\.335\.1 lose runtime support/, 'and so does the runner lane');
});

test('a bad --fail-on-deprecation is exit 2 on guard, hosted runner or not', async () => {
  // The self-hosted path: the check would run, so the flag must be validated.
  const selfHosted = await guardSelfHosted(
    { RUNNER_NAME: 'arc-linux-1', GITHUB_TOKEN: 'x' },
    { org: 'acme', 'fail-on-deprecation': 'soon' },
  );
  assert.equal(selfHosted.code, EXIT_USAGE);
  assert.match(selfHosted.stderr, /--fail-on-deprecation needs a whole number of days >= 0/);
  assert.deepEqual(selfHosted.calls, [], 'rejected before any API call');

  // The hosted path: the check never runs, and a bad value must still not pass.
  const cap = captureIO();
  const hosted = await runGuard(
    { summary: false, tools: 'node', workflows: SELFHOSTED_WF, 'fail-on-deprecation': '-1' },
    cap.io,
    { ImageVersion: '20260720.234.2', ImageOS: 'ubuntu22' },
    { now: NOW },
  );
  assert.equal(hosted, EXIT_USAGE);
  assert.match(cap.stderr, /--fail-on-deprecation needs a whole number of days >= 0/);
});

/* ---------------------------------------------- the workflow join */

const WORKFLOWS = path.join(FIXTURES, 'workflows');

test('matchRunsOnTargets is a per-runner subset test, not a union one', async () => {
  const targets = (await detect(WORKFLOWS)).runsOnTargets;
  assert.deepEqual(
    targets.map((t) => t.labels),
    [['ubuntu-22.04'], ['self-hosted', 'linux', 'gpu']],
    'the label set of each runs-on stays together',
  );

  // Only gpu-1 carries all three. A union across the group would match both and
  // claim a job can land on a runner that cannot take it.
  const [group] = groupByVersion([
    { name: 'gpu-1', version: '2.335.1', labels: [{ name: 'self-hosted' }, { name: 'Linux' }, { name: 'GPU' }] },
    { name: 'plain-1', version: '2.335.1', labels: [{ name: 'self-hosted' }, { name: 'Linux' }] },
  ]);
  const matched = matchRunsOnTargets(group, targets);
  assert.equal(matched.length, 1, 'the ubuntu-22.04 job is not served by a self-hosted runner');
  assert.deepEqual(matched[0].runners, ['gpu-1'], 'case-insensitive, and per runner');
  assert.equal(matched[0].line, 9);
  assert.match(matched[0].file, /selfhosted\.yml$/);
});

test('a runs-on expression is skipped rather than guessed at', () => {
  const targets = [
    { labels: [], expression: true, file: 'm.yml', line: 4, col: 14 },
    { labels: ['self-hosted'], expression: false, file: 'm.yml', line: 9, col: 14 },
  ];
  const [group] = groupByVersion([{ name: 'r', version: '2.335.1', labels: [{ name: 'self-hosted' }] }]);
  assert.deepEqual(
    matchRunsOnTargets(group, targets).map((m) => m.line),
    [9],
  );
  assert.deepEqual(matchRunsOnTargets(group, []), []);
  assert.deepEqual(matchRunsOnTargets({ members: [] }, targets), []);
});

test('a due group names the jobs it serves, and annotates the runs-on line', async () => {
  const targets = (await detect(WORKFLOWS)).runsOnTargets;
  const s = await survey(fleets.arc, { days: 30, failOn: true, runsOnTargets: targets });
  const due = s.groups.find((g) => g.version === '2.335.1');
  assert.equal(due.workflowSites.length, 1);
  assert.deepEqual(due.workflowSites[0].runners, ['arc-linux-1', 'arc-linux-2']);

  assert.match(
    runnersReport(s),
    /serves .*selfhosted\.yml:9 \(runs-on: self-hosted, linux, gpu\) — arc-linux-1, arc-linux-2/,
  );

  const lines = runnersAnnotations(s);
  const onFile = lines.filter((l) => l.includes('file='));
  assert.equal(onFile.length, 1, 'one file annotation for the one job served');
  assert.match(onFile[0], /^::error file=[^,]*selfhosted\.yml,line=9,col=13,/);
  assert.match(onFile[0], /serve this job \(arc-linux-1, arc-linux-2\)/);
  // The annotation is already on that line, so it does not repeat it.
  assert.ok(!onFile[0].includes('serves '), 'no redundant location in the message');
  assert.match(onFile[0], /runtime support ends 2026-09-24 \(16 days\)/);
});

/**
 * GitHub matches `file=` against the repository tree, so a path that is absolute
 * or backslash-separated silently attaches the annotation to the step instead of
 * the line. Both happen on a real runner: `action.yml` passes `--workflows` as an
 * absolute path, and `path.join` yields backslashes on `windows-latest`. Neither
 * is an error, which is why it went unnoticed from 1.1.0.
 */
/**
 * The README publishes the `--json` shape as a contract. Comparing keys against a
 * real survey is what stops it drifting the moment a field is added.
 */
test('the --json shape the README documents is the shape it emits', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const block = readme.match(/### `runners --json`[\s\S]*?```json\n([\s\S]*?)\n```/);
  assert.ok(block, 'the README still documents the JSON shape');
  const documented = JSON.parse(block[1]);

  const targets = (await detect(WORKFLOWS)).runsOnTargets;
  const real = await survey(fleets.arc, { days: 30, failOn: true, runsOnTargets: targets });

  const keys = (o) => Object.keys(o).sort();
  assert.deepEqual(keys(documented), keys(real), 'top level');
  assert.deepEqual(keys(documented.scope), keys(real.scope), 'scope');
  assert.deepEqual(keys(documented.groups[0]), keys(real.groups[0]), 'group');
  assert.deepEqual(keys(documented.groups[0].runtime), keys(real.groups[0].runtime), 'runtime');
  assert.deepEqual(keys(documented.groups[0].updateTo), keys(real.groups[0].updateTo), 'updateTo');
  assert.deepEqual(
    keys(documented.groups[0].workflowSites[0]),
    keys(real.groups[0].workflowSites[0]),
    'workflowSites',
  );
  // The values that are load-bearing claims, not just illustrative.
  assert.equal(documented.groups[0].status, real.groups[0].status);
  assert.deepEqual(documented.groups[0].runtime, real.groups[0].runtime);
  assert.deepEqual(documented.groups[0].updateTo, real.groups[0].updateTo);
  assert.equal(documented.ghesNote, real.ghesNote);
  assert.equal(documented.source, real.source);
});

test('the step summary lists the affected jobs below the table', async () => {
  const targets = (await detect(WORKFLOWS)).runsOnTargets;
  const md = runnersSummaryMarkdown(await survey(fleets.arc, { days: 30, failOn: true, runsOnTargets: targets }));
  assert.match(md, /\*\*Jobs these runners serve:\*\*/);
  assert.match(
    md,
    /- `test\/fixtures\/workflows\/selfhosted\.yml:9` \(`runs-on: self-hosted, linux, gpu`\) — arc-linux-1, arc-linux-2 on `2\.335\.1`/,
  );
  // Nothing to list when nothing is due.
  const clean = runnersSummaryMarkdown(await survey(fleets.current, { days: 30, runsOnTargets: targets }));
  assert.ok(!clean.includes('Jobs these runners serve'));
});

test('a file= path is made repo-relative and POSIX-separated', () => {
  const p = (file, env) => annotationPath(file, env);
  assert.equal(p('a\\b\\c.yml', {}), 'a/b/c.yml', 'separators');
  assert.equal(p('.github/workflows/ci.yml', {}), '.github/workflows/ci.yml', 'already relative');

  const root = path.resolve('/work/repo');
  assert.equal(
    p(path.join(root, '.github', 'workflows', 'ci.yml'), { GITHUB_WORKSPACE: root }),
    '.github/workflows/ci.yml',
    'the absolute path the action passes',
  );
  // Outside the workspace there is nothing better to offer than what we were given.
  const outside = path.resolve('/somewhere/else/ci.yml');
  assert.equal(p(outside, { GITHUB_WORKSPACE: root }), outside.replaceAll('\\', '/'));

  assert.match(
    annotation('error', 'T', 'm', { file: 'a\\b\\c.yml', line: 1, col: 2 }),
    /^::error file=a\/b\/c\.yml,line=1,col=2,/,
  );
});

test('the retirement lane gets the same path treatment', async () => {
  // The image lane annotates from an absolute --workflows too, via the action.
  const { retirementFindings, retirementAnnotations } = await import('../src/report.mjs');
  const root = path.resolve('/work/repo');
  const saved = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = root;
  try {
    const findings = retirementFindings(
      [{ label: 'macos-14', file: path.join(root, '.github', 'workflows', 'ci.yml'), line: 12, col: 14 }],
      { now: NOW, days: 3650 },
    );
    assert.match(retirementAnnotations(findings)[0], /^::error file=\.github\/workflows\/ci\.yml,line=12,col=14,/);
  } finally {
    if (saved === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = saved;
  }
});

test('an OK or unknown group annotates no files', async () => {
  const targets = (await detect(WORKFLOWS)).runsOnTargets;
  for (const fleet of [fleets.current, fleets.unknown]) {
    const s = await survey(fleet, { days: 30, failOn: true, runsOnTargets: targets });
    assert.ok(
      !runnersAnnotations(s).some((l) => l.includes('file=')),
      'only a moving date earns a file annotation',
    );
  }
});

test('no workflow directory is silent, not an error', async () => {
  const r = await runners({ org: 'acme', workflows: path.join(FIXTURES, 'definitely-not-here') });
  assert.equal(r.code, EXIT_OK);
  assert.ok(!r.stdout.includes('serves '), 'nothing to join against');
  assert.ok(!r.stdout.includes('file='));
  assert.equal(r.stderr, '');
});

/* --------------------------------------------------- the exit-code contract */

/**
 * The whole documented contract in one table: 0 for success including a refused
 * permission and an empty fleet, 1 for a version inside the window or already
 * past it, 2 for usage. Nothing else is a legal exit code.
 */
test('every documented exit code, end to end through main()', async () => {
  const { main } = await import('../src/cli.mjs');
  const empty = { total_count: 0, runners: [] };
  const cases = [
    ['due fleet, --fail-on-deprecation 30', fleets.arc, ['--org', 'acme', '--fail-on-deprecation', '30'], EXIT_DRIFT],
    ['due fleet, no flag', fleets.arc, ['--org', 'acme'], EXIT_OK],
    ['current fleet, window 30', fleets.current, ['--org', 'acme', '--fail-on-deprecation', '30'], EXIT_OK],
    ['current fleet, window 0', fleets.current, ['--org', 'acme', '--fail-on-deprecation', '0'], EXIT_OK],
    ['expired fleet, no flag', fleets.expired, ['--org', 'acme'], EXIT_DRIFT],
    ['expired fleet, huge window', fleets.expired, ['--org', 'acme', '--fail-on-deprecation', '9999'], EXIT_DRIFT],
    ['unknown versions, window 0', fleets.unknown, ['--org', 'acme', '--fail-on-deprecation', '0'], EXIT_OK],
    ['unknown versions, huge window', fleets.unknown, ['--org', 'acme', '--fail-on-deprecation', '9999'], EXIT_OK],
    ['vm-image fleet, window 30', fleets.vmimage, ['--org', 'acme', '--fail-on-deprecation', '30'], EXIT_DRIFT],
    ['empty fleet, window 0', empty, ['--org', 'acme', '--fail-on-deprecation', '0'], EXIT_OK],
    ['--repo and --org together', fleets.arc, ['--repo', 'a/b', '--org', 'acme'], EXIT_USAGE],
    ['bad window value', fleets.arc, ['--org', 'acme', '--fail-on-deprecation', 'soon'], EXIT_USAGE],
    ['negative window', fleets.arc, ['--org', 'acme', '--fail-on-deprecation', '-1'], EXIT_USAGE],
    ['a query string smuggled into --org', fleets.arc, ['--org', 'acme?per_page=1'], EXIT_USAGE],
    ['a query string smuggled into --repo', fleets.arc, ['--repo', 'a/b?x=1'], EXIT_USAGE],
    ['a dot for a repo name', fleets.arc, ['--repo', 'a/..'], EXIT_USAGE],
  ];
  const sink = { stdout: { write() {} }, stderr: { write() {} } };
  const savedToken = process.env.GITHUB_TOKEN;
  const savedRepo = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_TOKEN = 'stub';
  delete process.env.GITHUB_REPOSITORY;
  try {
    for (const [label, fleet, argv, want] of cases) {
      const api = stubApi(routes(fleet));
      try {
        assert.equal(await main(['runners', '--no-summary', ...argv], sink), want, label);
      } finally {
        api.restore();
      }
    }
    // The refusal statuses, which must never fail a build on their own.
    for (const [label, listing] of [
      ['403', { status: 403, body: fleets.forbidden }],
      ['404', { status: 404, body: fleets.missing }],
      ['401', { status: 401, body: { message: 'Requires authentication' } }],
      [
        'rate limit',
        { status: 403, body: { message: 'rate limited' }, headers: { 'x-ratelimit-remaining': '0' } },
      ],
    ]) {
      const api = stubApi(routes(fleets.arc, { listing }));
      try {
        assert.equal(
          await main(['runners', '--no-summary', '--org', 'acme', '--fail-on-deprecation', '30'], sink),
          EXIT_OK,
          `${label} never fails the build by itself`,
        );
      } finally {
        api.restore();
      }
    }
    // No scope at all, with nothing in the environment to fall back to.
    assert.equal(await main(['runners', '--no-summary'], sink), EXIT_USAGE, 'no scope');
  } finally {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
    if (savedRepo !== undefined) process.env.GITHUB_REPOSITORY = savedRepo;
  }
});

test('guard on a hosted runner ignores --fail-on-deprecation entirely', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-drift-hosted-'));
  const api = stubApi(runnerRoutes({ scopePath: '/orgs/acme', fleet: fleets.arc, recorded, releases }));
  const cap = captureIO();
  try {
    const code = await runGuard(
      {
        summary: false,
        'update-lock': true,
        tools: 'node',
        'lock-file': path.join(dir, 'runner-lock.json'),
        workflows: SELFHOSTED_WF,
        org: 'acme',
        'fail-on-deprecation': '30',
      },
      cap.io,
      { ImageVersion: '20260720.234.2', ImageOS: 'ubuntu22', RUNNER_NAME: 'arc-linux-1', GITHUB_TOKEN: 'x' },
      { now: NOW },
    );
    assert.equal(code, EXIT_OK);
    assert.match(cap.stdout, /baseline recorded/);
    assert.deepEqual(api.calls, [], 'a hosted runner has no agent version to check');
    // But it says the flag does not apply, rather than silently doing nothing.
    assert.match(
      cap.stdout,
      /::notice title=runner-drift::--fail-on-deprecation 30 does not apply on a GitHub-hosted runner/,
    );
    assert.match(cap.stdout, /Use `runner-drift runners` for a self-hosted fleet/);
  } finally {
    api.restore();
    await rm(dir, { recursive: true, force: true });
  }
});
