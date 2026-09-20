import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  MIGRATIONS,
  MIGRATION_PHASE,
  MIGRATION_STATE,
  deadlineFor,
  labelForImageOS,
  migrationBetween,
  migrationFails,
  migrationFor,
  migrationStatus,
  pathForLabel,
} from '../src/labels.mjs';
import { attributeImageOS, imageDiffs, surveyMigration } from '../src/migration.mjs';
import { migrationAnnotations, migrationLines, migrationSummaryMarkdown } from '../src/report.mjs';
import { detect, extractFloatingSites, extractLabelSites, jobMatcher } from '../src/detect.mjs';
import { writeLock } from '../src/lock.mjs';
import { runGuard, runPlan, EXIT_OK, EXIT_DRIFT, EXIT_USAGE } from '../src/cli.mjs';
import { captureIO, fixtureLoader, FIXTURES, jsonOf } from './helpers.mjs';

const WORKFLOWS = path.join(FIXTURES, 'workflows-migration');

// The clock is injected everywhere below, never read from the host: these
// assertions have to mean the same thing after the window has passed.
const BEFORE = new Date('2026-10-01T00:00:00Z');
const DURING = new Date('2026-10-25T00:00:00Z');
const AFTER = new Date('2026-11-25T00:00:00Z');

// ubuntu-24.04 has several snapshots; the migration wants the one that was
// current alongside the Ubuntu 26.04 image, or the kernel delta is fiction.
const LOAD = fixtureLoader({ 'ubuntu-24.04': 'ubuntu-24.04@2026-09' });

const TOOLS = ['CMake', 'Node.js', 'Python', 'Rust'];

async function survey(now, imageOS = null, opts = {}) {
  return surveyMigration({
    label: 'ubuntu-latest',
    now,
    imageOS,
    tools: TOOLS,
    load: LOAD,
    ...opts,
  });
}

/* -------------------------------------------------------------- the table */

test('MIGRATIONS transcribes the changelog window and cites its source', () => {
  const m = MIGRATIONS['ubuntu-latest'];
  assert.deepEqual(
    { from: m.from, to: m.to, starts: m.starts, ends: m.ends, announced: m.announced },
    {
      from: 'ubuntu-24.04',
      to: 'ubuntu-26.04',
      starts: '2026-10-19',
      ends: '2026-11-19',
      announced: '2026-09-17',
    },
  );
  assert.equal(m.sourceRef, 'actions/runner-images#14748');
  assert.equal(m.source, 'https://github.com/actions/runner-images/issues/14748');
});

test('MIGRATIONS does not reuse the DEADLINES vocabulary', () => {
  for (const m of Object.values(MIGRATIONS)) {
    assert.equal(m.migrateTo, undefined, 'migrateTo means something else in DEADLINES');
    assert.equal(m.fullyUnsupported, undefined);
  }
});

/* -------------------------------------------------------- migrationStatus */

test('pending: the window has not opened, countdown is whole days', () => {
  const s = migrationStatus('ubuntu-latest', { now: BEFORE });
  assert.equal(s.phase, MIGRATION_PHASE.PENDING);
  assert.equal(s.state, MIGRATION_STATE.PENDING);
  assert.equal(s.daysToStart, 18);
  assert.equal(s.daysToEnd, 49);
  assert.equal(s.anomaly, false);
  assert.equal(s.done, false);
});

test('in-window on the from-image: not yet migrated, not an anomaly', () => {
  const s = migrationStatus('ubuntu-latest', { now: DURING, imageOS: 'ubuntu24' });
  assert.equal(s.phase, MIGRATION_PHASE.IN_WINDOW);
  assert.equal(s.state, MIGRATION_STATE.NOT_YET_MIGRATED);
  assert.equal(s.observed, 'ubuntu-24.04');
  assert.equal(s.anomaly, false);
  assert.equal(s.daysToEnd, 25);
});

test('in-window on the to-image: the migration reached this runner', () => {
  const s = migrationStatus('ubuntu-latest', { now: DURING, imageOS: 'ubuntu26' });
  assert.equal(s.state, MIGRATION_STATE.MIGRATED);
  assert.equal(s.observed, 'ubuntu-26.04');
  assert.equal(s.done, true);
  assert.equal(s.anomaly, false);
});

test('settled and correct: the label now means the new image', () => {
  assert.equal(
    migrationStatus('ubuntu-latest', { now: AFTER, imageOS: 'ubuntu26' }).state,
    MIGRATION_STATE.MIGRATED,
  );
  const blind = migrationStatus('ubuntu-latest', { now: AFTER });
  assert.equal(blind.phase, MIGRATION_PHASE.SETTLED);
  assert.equal(blind.state, MIGRATION_STATE.SETTLED);
  assert.equal(blind.done, true);
  assert.equal(blind.daysToEnd, -6);
});

test('settled on the old image is an anomaly, not drift', () => {
  const s = migrationStatus('ubuntu-latest', { now: AFTER, imageOS: 'ubuntu24' });
  assert.equal(s.state, MIGRATION_STATE.STALE);
  assert.equal(s.anomaly, true);
  assert.equal(s.done, false);
});

test('missing ImageOS: the calendar alone still decides pending and settled', () => {
  assert.equal(migrationStatus('ubuntu-latest', { now: BEFORE }).state, MIGRATION_STATE.PENDING);
  assert.equal(migrationStatus('ubuntu-latest', { now: AFTER }).state, MIGRATION_STATE.SETTLED);
  const mid = migrationStatus('ubuntu-latest', { now: DURING });
  assert.equal(mid.state, MIGRATION_STATE.AMBIGUOUS);
  assert.equal(mid.observed, null);
  assert.equal(mid.anomaly, false, 'not knowing is not a fault');
});

test('an image that arrived before the window opened reads as early, not wrong', () => {
  const s = migrationStatus('ubuntu-latest', { now: BEFORE, imageOS: 'ubuntu26' });
  assert.equal(s.state, MIGRATION_STATE.MOVED_EARLY);
  assert.equal(s.done, true);
});

test('a known image that is neither end of the window is an anomaly', () => {
  const s = migrationStatus('ubuntu-latest', { now: DURING, imageOS: 'ubuntu22' });
  assert.equal(s.state, MIGRATION_STATE.UNEXPECTED);
  assert.equal(s.observed, 'ubuntu-22.04');
  assert.equal(s.anomaly, true);
});

test('an ImageOS this build has never heard of reads as no observation', () => {
  // guard already warns about an unknown ImageOS on its own. Guessing here
  // would turn every future image name into a fake anomaly.
  const s = migrationStatus('ubuntu-latest', { now: DURING, imageOS: 'ubuntu28' });
  assert.equal(s.state, MIGRATION_STATE.AMBIGUOUS);
  assert.equal(s.observed, null);
  assert.equal(s.anomaly, false);
});

test('no migration configured behaves exactly as before: null', () => {
  assert.equal(migrationFor('windows-latest'), null);
  assert.equal(migrationStatus('windows-latest', { now: DURING }), null);
  assert.equal(migrationStatus('macos-latest', { now: DURING }), null);
});

test('a pinned concrete label is never treated as migrating', () => {
  for (const label of ['ubuntu-24.04', 'ubuntu-26.04', 'ubuntu-22.04', 'macos-15']) {
    assert.equal(migrationStatus(label, { now: DURING, imageOS: 'ubuntu24' }), null, label);
  }
});

test('a date outside every window still classifies, never throws', () => {
  for (const when of ['2020-01-01', '2099-01-01']) {
    const s = migrationStatus('ubuntu-latest', { now: new Date(`${when}T00:00:00Z`) });
    assert.ok(Object.values(MIGRATION_STATE).includes(s.state));
  }
});

test('the window boundaries belong to the window', () => {
  const on = (d) => migrationStatus('ubuntu-latest', { now: new Date(`${d}T00:00:00Z`) }).phase;
  assert.equal(on('2026-10-18'), MIGRATION_PHASE.PENDING);
  assert.equal(on('2026-10-19'), MIGRATION_PHASE.IN_WINDOW);
  assert.equal(on('2026-11-19'), MIGRATION_PHASE.IN_WINDOW);
  assert.equal(on('2026-11-20'), MIGRATION_PHASE.SETTLED);
});

test('the phase holds all day, at every hour of a boundary date', () => {
  for (const hour of ['00:00', '11:59', '12:00', '13:00', '23:59']) {
    const at = (d) => migrationStatus('ubuntu-latest', { now: new Date(`${d}T${hour}:00Z`) });
    assert.equal(at('2026-10-18').phase, MIGRATION_PHASE.PENDING, `2026-10-18 ${hour}`);
    assert.equal(at('2026-10-19').phase, MIGRATION_PHASE.IN_WINDOW, `2026-10-19 ${hour}`);
    assert.equal(at('2026-11-19').phase, MIGRATION_PHASE.IN_WINDOW, `2026-11-19 ${hour}`);
    assert.equal(at('2026-11-19').daysToEnd, 0, `countdown on the last day, ${hour}`);
    assert.equal(at('2026-11-20').phase, MIGRATION_PHASE.SETTLED, `2026-11-20 ${hour}`);
  }
});

/* --------------------------------------------------------- migrationFails */

test('the gate fires inside the threshold, in the window, and on an anomaly', () => {
  const pending = migrationStatus('ubuntu-latest', { now: BEFORE });
  assert.equal(migrationFails(pending, 10), false, '18 days out, threshold 10');
  assert.equal(migrationFails(pending, 18), true, 'threshold meets the countdown');

  assert.equal(migrationFails(migrationStatus('ubuntu-latest', { now: DURING }), 0), true);
  assert.equal(
    migrationFails(migrationStatus('ubuntu-latest', { now: AFTER, imageOS: 'ubuntu22' }), 0),
    true,
    'an image from outside the window fires whatever the threshold',
  );
  assert.equal(
    migrationFails(migrationStatus('ubuntu-latest', { now: AFTER, imageOS: 'ubuntu24' }), 10000),
    false,
    'a rollout running late is reported, not failed',
  );
  assert.equal(
    migrationFails(migrationStatus('ubuntu-latest', { now: AFTER, imageOS: 'ubuntu26' }), 10000),
    false,
    'a completed migration is not a failure',
  );
  assert.equal(migrationFails(null, 0), false);
});

/* -------------------------------------------------------- surveyMigration */

test('pending: the manifest diff is the kernel and systemd move, from real snapshots', async () => {
  const s = await survey(BEFORE);
  assert.equal(s.state, MIGRATION_STATE.PENDING);
  assert.deepEqual(s.images, { from: '20260907.300.1', to: '20260907.131.1' });
  assert.deepEqual(
    s.image.map((d) => [d.tool, d.from[0], d.to[0]]),
    [
      ['OS', '24.04.5 LTS', '26.04.1 LTS'],
      ['Kernel', '6.17.0-1022-azure', '7.0.0-1012-azure'],
      ['Systemd', '255.4-1ubuntu8.17', '259.5-0ubuntu3.4'],
    ],
  );
});

test('only tools that actually move are listed', async () => {
  const s = await survey(BEFORE);
  assert.deepEqual(
    s.toolDiffs.map((d) => `${d.tool} ${d.from[0]} -> ${d.to[0]}`),
    ['CMake 3.31.6 -> 4.4.3', 'Node.js 22.23.2 -> 24.20.0', 'Python 3.12.3 -> 3.14.4'],
  );
  assert.ok(!s.toolDiffs.some((d) => d.tool === 'Rust'), 'Rust 1.98.1 is the same on both images');
});

test('a settled migration skips the manifest fetch entirely', async () => {
  const calls = [];
  const s = await survey(AFTER, 'ubuntu26', {
    load: (label) => {
      calls.push(label);
      return LOAD(label);
    },
  });
  assert.equal(s.state, MIGRATION_STATE.MIGRATED);
  assert.deepEqual(calls, [], 'the lock diff is the before/after once the label has moved');
  assert.deepEqual(s.image, []);
});

test('a 404 degrades to the notice instead of losing it', async () => {
  const s = await survey(BEFORE, null, {
    load: async (label) => ({ skipped: true, label, reason: `No manifest at ${label} (404).` }),
  });
  assert.equal(s.state, MIGRATION_STATE.PENDING);
  assert.equal(s.images, null);
  assert.deepEqual(s.image, []);
  assert.equal(s.notes.length, 2);
  assert.match(s.notes[0], /No manifest at ubuntu-24\.04 \(404\)/);
  assert.match(migrationLines(s).join('\n'), /Manifest diff unavailable: No manifest/);
});

test('a network failure degrades the same way', async () => {
  const s = await survey(BEFORE, null, {
    load: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.equal(s.state, MIGRATION_STATE.PENDING);
  assert.match(s.notes[0], /fetch failed/);
  assert.match(migrationLines(s).join('\n'), /rollout starts 2026-10-19 \(18 days\)/);
});

test('a tool on neither image is skipped, not diffed to nothing', async () => {
  const s = await survey(BEFORE, null, { tools: [...TOOLS, 'Xcode'] });
  assert.deepEqual(s.notOnManifest, ['Xcode'], 'Xcode is a macOS tool, absent from both');
  assert.ok(!s.toolDiffs.some((d) => d.tool === 'Xcode'));
});

test('surveying a label with no migration is null, not an empty survey', async () => {
  assert.equal(await survey(BEFORE, null, { label: 'windows-latest' }), null);
  assert.equal(await survey(BEFORE, null, { label: 'ubuntu-24.04' }), null);
});

test('imageDiffs tolerates a manifest with no kernel or systemd line', () => {
  const rows = imageDiffs({ osVersion: '15.6' }, { osVersion: '26.0' });
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.filter((d) => d.changed).map((d) => d.tool),
    ['OS'],
  );
});

test('a header field one side does not publish is not a removal', () => {
  // `plan --from ubuntu-24.04 --to windows-2025` is a legal comparison, and
  // Windows manifests carry no kernel or systemd line.
  const rows = imageDiffs(
    { osVersion: '24.04.5 LTS', kernelVersion: '6.17.0-1022-azure', systemdVersion: '255.4' },
    { osVersion: 'Windows Server 2025' },
  );
  assert.deepEqual(
    rows.filter((d) => d.changed).map((d) => d.tool),
    ['OS'],
  );
});

/* ----------------------------------------------------------------- report */

test('each state gets its own sentence, and the anomaly says so', async () => {
  const sentence = (now, imageOS) =>
    migrationLines({
      ...migrationStatus('ubuntu-latest', { now, imageOS }),
      sites: [],
      image: [],
      toolDiffs: [],
      notOnManifest: [],
      notes: [],
    })[0];
  assert.match(
    sentence(BEFORE, null),
    /moves from ubuntu-24\.04 to ubuntu-26\.04.*starts 2026-10-19 \(18 days\)/,
  );
  assert.match(sentence(DURING, 'ubuntu24'), /this runner served ubuntu-24\.04/);
  assert.match(sentence(DURING, 'ubuntu26'), /has reached this runner/);
  assert.match(sentence(DURING, null), /the label means either image/);
  assert.match(sentence(AFTER, null), /finished migrating/);
  assert.match(sentence(AFTER, 'ubuntu24'), /anomaly, not drift/);
  assert.match(sentence(AFTER, 'ubuntu22'), /neither ubuntu-24\.04 nor ubuntu-26\.04/);
});

test('annotations land on the runs-on line and pick the right severity', async () => {
  const sites = (await detect(WORKFLOWS)).floatingSites;
  const at = async (now, imageOS) => migrationAnnotations([await survey(now, imageOS, { sites })])[0];

  assert.match(await at(BEFORE, null), /^::notice file=[^,]*latest\.yml,line=6,col=14,/);
  assert.match(
    await at(BEFORE, null),
    /title=runner-drift: ubuntu-latest becomes ubuntu-26\.04 in 18 days::/,
  );
  assert.match(await at(DURING, 'ubuntu24'), /^::warning file=/);
  assert.match(await at(DURING, 'ubuntu26'), /^::notice file=/);
  assert.match(await at(AFTER, 'ubuntu24'), /^::error file=/);
  assert.match(
    await at(AFTER, 'ubuntu24'),
    /See https:\/\/github\.com\/actions\/runner-images\/issues\/14748/,
  );
});

test('a survey with no site on disk still gets one step-level annotation', async () => {
  const [line] = migrationAnnotations([await survey(BEFORE)]);
  assert.ok(!line.includes('file='));
  assert.match(line, /^::notice title=runner-drift: /);
});

test('the step summary names the window, the status and the image diff', async () => {
  const md = migrationSummaryMarkdown([await survey(BEFORE)]);
  assert.match(md, /^## runner-drift — floating label migration/);
  assert.match(md, /\| Label \| Status \| Move \| Window \| This runner \| Source \|/);
  assert.match(
    md,
    /\| `ubuntu-latest` \| 🗓 pending \| `ubuntu-24\.04` → `ubuntu-26\.04` \| 2026-10-19 \(18 days\) → 2026-11-19 \(49 days\) \| — \| \[actions\/runner-images#14748\]/,
  );
  assert.match(md, /\| Kernel \| 6\.17\.0-1022-azure \| 7\.0\.0-1012-azure \| 🔴 MAJOR \|/);
});

test('a runner left on the old image is badged stale, not settled', async () => {
  // The row sits beside this survey's own ::error, so the calendar-only badge
  // read as a clean bill of health.
  const s = await survey(AFTER, 'ubuntu24');
  assert.equal(s.state, MIGRATION_STATE.STALE);
  const md = migrationSummaryMarkdown([s]);
  assert.match(md, /\| `ubuntu-latest` \| 🔴 stale \|/);
  assert.doesNotMatch(md, /settled/);
});

test('a floating label inside a matrix is a site like any other', () => {
  const y = [
    'jobs:',
    '  a:',
    '    strategy:',
    '      matrix:',
    '        os: [ubuntu-22.04, ubuntu-latest]',
    '    runs-on: ${{ matrix.os }}',
  ].join('\n');
  assert.deepEqual(extractFloatingSites(y, 'ci.yml'), [
    { label: 'ubuntu-latest', file: 'ci.yml', line: 5, col: 28, job: 'a', viaMatrix: true },
  ]);
});

/* ------------------------------------------------------------------- plan */

async function plan(opts, now = BEFORE) {
  const cap = captureIO();
  const code = await runPlan({ workflows: WORKFLOWS, ...opts }, cap.io, { loadManifest: LOAD, now });
  return { code, stdout: cap.stdout, stderr: cap.stderr };
}

test('plan --from ubuntu-latest resolves the window and diffs the two images', async () => {
  const r = await plan({ from: 'ubuntu-latest' });
  assert.equal(r.code, EXIT_OK);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(
    lines[0],
    'ubuntu-latest moves from ubuntu-24.04 to ubuntu-26.04. The rollout starts 2026-10-19 (18 days) and finishes 2026-11-19 (49 days).',
  );
  assert.equal(
    lines[1],
    'announced 2026-09-17; source actions/runner-images#14748 https://github.com/actions/runner-images/issues/14748',
  );
  assert.equal(lines[2], 'ubuntu-24.04 -> ubuntu-26.04 (images 20260907.300.1 -> 20260907.131.1)');
  assert.ok(r.stdout.includes('Kernel 6.17.0-1022-azure -> 7.0.0-1012-azure  MAJOR'));
  assert.ok(r.stdout.includes('Systemd 255.4-1ubuntu8.17 -> 259.5-0ubuntu3.4  MAJOR'));
});

test('an explicit --to still refuses a floating label, and says to drop it', async () => {
  const r = await plan({ from: 'ubuntu-latest', to: 'ubuntu-26.04' });
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /floating label/);
  assert.match(r.stderr, /Or drop --to: runner-drift plan --from ubuntu-latest/);
});

test('a floating --to with no migration of its own gets no such hint', async () => {
  const r = await plan({ from: 'ubuntu-24.04', to: 'windows-latest' });
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /--to windows-latest is a floating label/);
  assert.doesNotMatch(r.stderr, /Or drop --to/);
});

test('a floating label with no migration is still a usage error that says so', async () => {
  const r = await plan({ from: 'windows-latest' });
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /plan needs both --from <label> and --to <label>/);
  assert.match(r.stderr, /need only --from: ubuntu-latest/);
});

test('plan --json carries the migration and the image diff', async () => {
  const r = await plan({ from: 'ubuntu-latest', json: true });
  const j = JSON.parse(r.stdout);
  assert.equal(j.from, 'ubuntu-24.04');
  assert.equal(j.to, 'ubuntu-26.04');
  assert.equal(j.migration.state, 'pending');
  assert.equal(j.migration.daysToStart, 18);
  assert.deepEqual(
    j.image.map((d) => d.tool),
    ['OS', 'Kernel', 'Systemd'],
  );
});

/* ------------------------------------------------------------------ guard */

async function guard(opts, env = {}, now = BEFORE) {
  const cap = captureIO();
  const code = await runGuard(
    { summary: false, 'update-lock': true, workflows: WORKFLOWS, ...opts },
    cap.io,
    env,
    { now, loadManifest: LOAD },
  );
  return { code, stdout: cap.stdout, stderr: cap.stderr };
}

test('guard is unchanged without the flag: no migration output at all', async () => {
  const r = await guard({ tools: 'node' });
  assert.equal(r.code, EXIT_OK);
  assert.ok(!r.stdout.includes('ubuntu-latest'));
  assert.equal(r.stderr, '');
});

test('guard --fail-on-migration reports the pending window and the diff', async () => {
  const r = await guard({ tools: 'node', 'fail-on-migration': '30' });
  assert.equal(r.code, EXIT_DRIFT);
  assert.match(r.stdout, /^::notice file=.*latest\.yml,line=6,col=14,/m);
  assert.match(r.stdout, /rollout starts 2026-10-19 \(18 days\)/);
  assert.match(r.stdout, /Kernel 6\.17\.0-1022-azure -> 7\.0\.0-1012-azure/);
  assert.match(r.stderr, /--fail-on-migration 30 is set\./);
});

test('below the threshold it reports and exits 0', async () => {
  const r = await guard({ tools: 'node', 'fail-on-migration': '10' });
  assert.equal(r.code, EXIT_OK);
  assert.match(r.stdout, /rollout starts 2026-10-19/);
  assert.equal(r.stderr, '');
});

test('in the window the exit turns on whether this runner has moved', async () => {
  const at = (ImageOS) =>
    guard({ tools: 'node', 'fail-on-migration': '0' }, { ImageOS, GITHUB_JOB: 'build' }, DURING);
  assert.equal((await at('ubuntu24')).code, EXIT_DRIFT, 'the change is still ahead of this runner');
  assert.equal((await at('ubuntu26')).code, EXIT_OK, 'this runner already has it');
  const blind = await guard({ tools: 'node', 'fail-on-migration': '0' }, {}, DURING);
  assert.equal(blind.code, EXIT_DRIFT, 'which of the two this job got cannot be told');
});

test('a rollout still running late is an error annotation, not a red build', async () => {
  // GitHub has slipped both previous `latest` moves. Nothing here is broken by
  // that, and a threshold that cannot turn the failure off is one people fix by
  // deleting the check.
  const env = { ImageOS: 'ubuntu24', GITHUB_JOB: 'build' };
  const r = await guard({ tools: 'node', 'fail-on-migration': '0' }, env, AFTER);
  assert.equal(r.code, EXIT_OK);
  assert.match(r.stdout, /^::error file=/m);
  assert.match(r.stdout, /still serving ubuntu-24\.04/);
  assert.equal(r.stderr, '');
});

test('an image from outside the window fails whatever the threshold', async () => {
  const env = { ImageOS: 'ubuntu22', GITHUB_JOB: 'build' };
  const r = await guard({ tools: 'node', 'fail-on-migration': '0' }, env, AFTER);
  assert.equal(r.code, EXIT_DRIFT);
  assert.match(r.stdout, /^::error file=/m);
  assert.match(r.stderr, /which is neither ubuntu-24\.04 nor ubuntu-26\.04/);
  assert.ok(!r.stderr.includes('--fail-on-migration 0 is set'), 'an anomaly is not a countdown');
});

test('without GITHUB_JOB the pinned sibling job holds the anomaly back', async () => {
  // The same fixture has a job on ubuntu-24.04. With nothing saying which job
  // this is, that job explains the image as well as a stalled migration does.
  const r = await guard({ tools: 'node', 'fail-on-migration': '0' }, { ImageOS: 'ubuntu24' }, AFTER);
  assert.equal(r.code, EXIT_OK);
  assert.doesNotMatch(r.stdout, /^::error file=/m);
  assert.match(r.stdout, /ask for ubuntu-24\.04 by name/);
});

test('a workflow with no floating label produces nothing and exits 0', async () => {
  const r = await guard({
    tools: 'node',
    'fail-on-migration': '365',
    workflows: path.join(FIXTURES, 'workflows'),
  });
  assert.equal(r.code, EXIT_OK);
  assert.ok(!r.stdout.includes('ubuntu-latest'));
  assert.equal(r.stderr, '');
});

test('a missing workflow directory is a notice, not an error', async () => {
  const r = await guard({
    tools: 'node',
    'fail-on-migration': '30',
    workflows: path.join(FIXTURES, 'definitely-not-here'),
  });
  assert.equal(r.code, EXIT_OK);
  assert.match(r.stdout, /::notice title=runner-drift::No workflow directory/);
  assert.match(r.stdout, /no floating labels to check for migration/);
});

test('both lint lanes with no workflow directory say so once', async () => {
  const r = await guard({
    tools: 'node',
    'fail-on-migration': '30',
    'fail-on-retirement': '60',
    workflows: path.join(FIXTURES, 'definitely-not-here'),
  });
  assert.equal(r.code, EXIT_OK);
  assert.equal(r.stdout.match(/No workflow directory/g).length, 2, 'the annotation and its log line');
});

test('a bad --fail-on-migration value is a usage error', async () => {
  for (const bad of ['soon', '-5', '2.5', '']) {
    const r = await guard({ tools: 'node', 'fail-on-migration': bad });
    assert.equal(r.code, EXIT_USAGE, `"${bad}" rejected`);
    assert.match(r.stderr, /--fail-on-migration needs a whole number of days >= 0/);
  }
});

test('the migration ride-along appears in guard --json', async () => {
  const r = await guard({ tools: 'node', 'fail-on-migration': '30', json: true });
  const j = jsonOf(r.stdout);
  assert.equal(j.migration.days, 30);
  assert.equal(j.migration.surveys.length, 1);
  assert.equal(j.migration.surveys[0].state, 'pending');
  assert.equal(j.migration.surveys[0].sites[0].line, 6);
});

/* ------------------------------------------------ whose image is this? */

// The fixture has three jobs: build on ubuntu-latest, pinned on ubuntu-24.04,
// lint on ubuntu-22.04. A runner exports these two for the job it is serving.
const inJob = (job) => ({
  GITHUB_JOB: job,
  GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/latest.yml@refs/heads/main',
});

test('a job id shared by two workflow files is told apart by the file', async () => {
  // ci.yml and release.yml both have a job called build. This run is the
  // Windows one, so its ImageOS says nothing about ubuntu-latest.
  const r = await guard(
    {
      tools: 'node',
      'fail-on-migration': '0',
      json: true,
      workflows: path.join(FIXTURES, 'workflows-two-builds'),
    },
    {
      ImageOS: 'win25',
      GITHUB_JOB: 'build',
      GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/release.yml@refs/heads/main',
    },
    DURING,
  );
  const j = jsonOf(r.stdout);
  const s = j.migration.surveys[0];
  assert.equal(s.observed, null, 'the windows job is not evidence about ubuntu-latest');
  assert.notEqual(s.state, MIGRATION_STATE.UNEXPECTED);
  assert.match(s.notes.join(' '), /did not run on ubuntu-latest/);
});

test('a run from a file the scan never saw cannot claim a shared job id', async () => {
  // ci.yml and release.yml both have a job called build, and the run reports a
  // caller the scan does not hold, so only the id is left to match on. One of
  // the two is pinned to the image this runner is on.
  const r = await guard(
    {
      tools: 'node',
      'fail-on-migration': '0',
      json: true,
      workflows: path.join(FIXTURES, 'workflows-shared-build-id'),
    },
    {
      ImageOS: 'ubuntu26',
      GITHUB_JOB: 'build',
      GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/caller.yml@refs/heads/main',
    },
    DURING,
  );
  const j = jsonOf(r.stdout);
  const s = j.migration.surveys.find((x) => x.label === 'ubuntu-latest');
  assert.equal(s.observed, null, 'the runner may be the job pinned to ubuntu-26.04');
  assert.notEqual(s.state, MIGRATION_STATE.MIGRATED);
  assert.match(s.notes.join(' '), /More than one workflow has a job called "build"/);
});

test('a runs-on taken from an input default still belongs to its job', async () => {
  // The label resolves above the jobs map, so the site's own line carries no job
  // id. The job whose runs-on is that expression is the one it serves.
  const r = await guard(
    {
      tools: 'node',
      'fail-on-migration': '30',
      json: true,
      workflows: path.join(FIXTURES, 'workflows-input-default'),
    },
    {
      ImageOS: 'ubuntu26',
      GITHUB_JOB: 'build',
      GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/build.yml@refs/heads/main',
    },
    DURING,
  );
  const s = jsonOf(r.stdout).migration.surveys[0];
  assert.equal(s.observed, 'ubuntu-26.04');
  assert.equal(s.state, MIGRATION_STATE.MIGRATED);
  assert.deepEqual(s.notes, [], 'the job did run on ubuntu-latest');
  assert.equal(r.code, EXIT_OK, 'a migrated runner does not red the build');
});

test('the same shared job id withholds the drift explanation', async () => {
  const r = await guardAcrossTheMove(
    {
      workflows: path.join(FIXTURES, 'workflows-shared-build-id'),
      env: {
        GITHUB_JOB: 'build',
        GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/caller.yml@refs/heads/main',
      },
    },
    DURING,
  );
  assert.equal(r.code, EXIT_OK);
  assert.doesNotMatch(r.stdout, /Explained by the scheduled/);
});

test('a guard step on an unrelated image says nothing about the floating label', async () => {
  const r = await guard(
    { tools: 'node', 'fail-on-migration': '0', json: true },
    { ImageOS: 'ubuntu22', ...inJob('lint') },
    BEFORE,
  );
  const j = jsonOf(r.stdout);
  const s = j.migration.surveys[0];
  assert.equal(s.state, MIGRATION_STATE.PENDING, 'the lint runner is not evidence');
  assert.equal(s.observed, null);
  assert.match(s.notes[0], /did not run on ubuntu-latest/);
  assert.equal(r.code, EXIT_OK, 'another job image is not an anomaly');
  assert.ok(!r.stdout.includes('::error'), 'nothing to raise');
});

test('the job that does ask for the label owns the image it ran on', async () => {
  const r = await guard(
    { tools: 'node', 'fail-on-migration': '0', json: true },
    { ImageOS: 'ubuntu22', ...inJob('build') },
    BEFORE,
  );
  const j = jsonOf(r.stdout);
  assert.equal(j.migration.surveys[0].state, MIGRATION_STATE.UNEXPECTED);
  assert.deepEqual(j.migration.surveys[0].notes, []);
  assert.equal(r.code, EXIT_DRIFT, 'ubuntu-latest serving 22.04 is a real anomaly');
});

test('a job pinned to the old image is not the floating label running late', async () => {
  // ubuntu-24.04 is a window endpoint, so this is the case where "the image is
  // one of the two" must not override "this job never asked for the label".
  const r = await guard(
    { tools: 'node', 'fail-on-migration': '0', json: true },
    { ImageOS: 'ubuntu24', ...inJob('pinned') },
    AFTER,
  );
  const j = jsonOf(r.stdout);
  assert.equal(j.migration.surveys[0].state, MIGRATION_STATE.SETTLED);
  assert.equal(r.code, EXIT_OK, 'a pinned job is not a stale floating runner');
  assert.ok(!r.stdout.includes('::error'), 'nothing to raise');
});

test('the step summary says why This runner is a dash', async () => {
  const s = await survey(DURING, 'ubuntu22', {
    sites: [{ label: 'ubuntu-latest', file: 'ci.yml', line: 6, col: 14, job: 'build' }],
    here: { job: 'lint', file: 'ci.yml' },
  });
  const md = migrationSummaryMarkdown([s]);
  assert.match(md, /\| — \|/, 'no image attributed');
  assert.match(md, /Job that ran this check|did not run on ubuntu-latest/);
});

test('mid-window, the job on the floating label still reads as migrated', async () => {
  const r = await guard(
    { tools: 'node', 'fail-on-migration': '30', json: true },
    { ImageOS: 'ubuntu26', ...inJob('build') },
    DURING,
  );
  const j = jsonOf(r.stdout);
  assert.equal(j.migration.surveys[0].state, MIGRATION_STATE.MIGRATED);
  assert.equal(j.migration.surveys[0].observed, 'ubuntu-26.04');
});

test('a matrix that also asks for the old image by name settles nothing', () => {
  // [ubuntu-latest, ubuntu-24.04] after the window: a runner on 24.04 is far
  // more likely to be the pinned leg than the floating label running late.
  const y = [
    'jobs:',
    '  a:',
    '    strategy:',
    '      matrix:',
    '        os: [ubuntu-latest, ubuntu-24.04]',
    '    runs-on: ${{ matrix.os }}',
  ].join('\n');
  const sites = extractFloatingSites(y, 'ci.yml');
  const others = extractLabelSites(y, 'ci.yml');
  const here = { job: 'a', file: 'ci.yml' };
  const a = attributeImageOS({ label: 'ubuntu-latest', imageOS: 'ubuntu24', sites, others, here });
  assert.equal(a.imageOS, null);
  assert.match(a.note, /also asks for ubuntu-24\.04 by name/);
  assert.equal(
    migrationStatus('ubuntu-latest', { now: AFTER, imageOS: a.imageOS }).state,
    MIGRATION_STATE.SETTLED,
    'not STALE, which would fail whatever the threshold',
  );
});

test('the job id alone decides when the run came from a file the scan never saw', () => {
  // A reusable workflow reports the caller in GITHUB_WORKFLOW_REF.
  const sites = [{ label: 'ubuntu-latest', file: 'reusable.yml', line: 6, col: 14, job: 'build' }];
  const belongs = jobMatcher({ job: 'build', file: 'caller.yml' }, sites);
  assert.equal(belongs(sites[0]), true);
  const strict = jobMatcher({ job: 'build', file: 'reusable.yml' }, sites);
  assert.equal(strict({ ...sites[0], file: 'other.yml' }), false, 'a scanned file still has to match');
});

test('a matrix in a sibling job does not overrule this one plain runs-on', async () => {
  // ci.yml has a matrix job and a guard job pinned to ubuntu-latest whose env
  // names ubuntu-26.04. The token scan used to read that env value as a runner
  // the guard job asks for, and treat this runner as that leg.
  const r = await guard(
    {
      tools: 'node',
      'fail-on-migration': '30',
      json: true,
      workflows: path.join(FIXTURES, 'workflows-matrix-sibling'),
    },
    {
      ImageOS: 'ubuntu26',
      GITHUB_JOB: 'guard',
      GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/ci.yml@refs/heads/main',
    },
    DURING,
  );
  const s = jsonOf(r.stdout).migration.surveys[0];
  assert.equal(s.observed, 'ubuntu-26.04');
  assert.equal(s.state, MIGRATION_STATE.MIGRATED);
  assert.deepEqual(s.notes, []);
  assert.equal(r.code, EXIT_OK, 'a runner that has already moved is green');
});

test('an unplaceable run does not hand another file\'s Windows image to the label', async () => {
  // ci.yml's build is on ubuntu-latest and release.yml's is on windows-latest.
  // The run reports a caller the scan does not hold, so the id alone is left to
  // match on, and a plain runs-on: in the wrong file used to settle it.
  const r = await guard(
    {
      tools: 'node',
      'fail-on-migration': '30',
      json: true,
      workflows: path.join(FIXTURES, 'workflows-build-elsewhere'),
    },
    {
      ImageOS: 'win25',
      GITHUB_JOB: 'build',
      GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/caller.yml@refs/heads/main',
    },
    DURING,
  );
  const s = jsonOf(r.stdout).migration.surveys[0];
  assert.equal(s.observed, null, 'a Windows runner says nothing about ubuntu-latest');
  assert.notEqual(s.state, MIGRATION_STATE.UNEXPECTED, 'not an error raised at the wrong repo');
  assert.match(s.notes.join(' '), /they do not all run on ubuntu-latest/);
});

test('with no job at all, a matrix leg is not described as a pin', async () => {
  const y = await readFile(path.join(FIXTURES, 'workflows-matrix', 'ci.yml'), 'utf8');
  const a = attributeImageOS({
    label: 'ubuntu-latest',
    imageOS: 'ubuntu22',
    sites: extractFloatingSites(y, 'ci.yml'),
    others: extractLabelSites(y, 'ci.yml'),
    here: null,
  });
  assert.equal(a.imageOS, null);
  const b = attributeImageOS({
    label: 'ubuntu-latest',
    imageOS: 'ubuntu26',
    sites: extractFloatingSites(y, 'ci.yml'),
    others: extractLabelSites(y, 'ci.yml'),
    here: null,
  });
  assert.doesNotMatch(b.note, /ask for ubuntu-26.04 by name/, 'the only site is a matrix leg');
  assert.match(b.note, /A matrix in these workflows can be scheduled onto ubuntu-26.04/);
});

test('a repo with no tools still gets the migration gate, and its exit code', async () => {
  // The gate reads the workflow files, not the tool list, so the annotation was
  // printed while the run exited 2 with no reason line.
  const r = await guard(
    {
      'fail-on-migration': '30',
      workflows: path.join(FIXTURES, 'workflows-no-tools'),
      'lock-file': path.join(FIXTURES, 'workflows-no-tools', 'no-such-lock.json'),
      'update-lock': false,
    },
    { ImageOS: 'ubuntu24', ImageVersion: '20260907.300.1' },
    BEFORE,
  );
  assert.equal(r.code, EXIT_DRIFT, 'the gate decides the exit code, not the empty tool list');
  assert.match(r.stdout, /ubuntu-latest becomes ubuntu-26.04 in 18 days/);
  assert.match(r.stderr, /--fail-on-migration 30 is set\./);
  assert.match(r.stderr, /No tools detected/, 'the usage advice is still printed');
});

test('a namesake job that matrixes onto the image is named as one, not as a leg', () => {
  // This run's own job asks for the floating label outright, so the rival can
  // only be the other file's job of the same id.
  const mine = ['jobs:', '  build:', '    runs-on: ubuntu-latest'].join(String.fromCharCode(10));
  const theirs = [
    'jobs:',
    '  build:',
    '    strategy:',
    '      matrix:',
    '        os: [ubuntu-26.04]',
    '    runs-on: ${{ matrix.os }}',
  ].join(String.fromCharCode(10));
  const sites = [...extractFloatingSites(mine, 'ci.yml'), ...extractFloatingSites(theirs, 'release.yml')];
  const others = [...extractLabelSites(mine, 'ci.yml'), ...extractLabelSites(theirs, 'release.yml')];
  const here = { job: 'build', file: 'caller.yml' };
  const a = attributeImageOS({ label: 'ubuntu-latest', imageOS: 'ubuntu26', sites, others, here });
  assert.equal(a.imageOS, null);
  assert.doesNotMatch(a.note, /through a matrix/, 'this job has no matrix');
  assert.match(a.note, /More than one workflow has a job called "build", and one of them can be scheduled onto ubuntu-26.04/);
});

test('one matrix job is not reported as two workflows sharing a job id', () => {
  // The same withholding, but the repository has one file and one job in it:
  // the rival is the other leg of this job's own matrix, not a namesake.
  const y = [
    'jobs:',
    '  build:',
    '    strategy:',
    '      matrix:',
    '        os: [ubuntu-latest, ubuntu-24.04]',
    '    runs-on: ${{ matrix.os }}',
  ].join(String.fromCharCode(10));
  const sites = extractFloatingSites(y, 'reusable.yml');
  const others = extractLabelSites(y, 'reusable.yml');
  const here = { job: 'build', file: 'caller.yml' };
  const a = attributeImageOS({ label: 'ubuntu-latest', imageOS: 'ubuntu24', sites, others, here });
  assert.equal(a.imageOS, null, 'the runner may be the 24.04 leg');
  assert.doesNotMatch(a.note, /More than one workflow/);
  assert.match(a.note, /reaches ubuntu-latest through a matrix/);
});

test('a job id the run cannot be placed by does not speak for another file', () => {
  // The run came from a reusable workflow, so GITHUB_WORKFLOW_REF names a file
  // the scan does not hold and only the job id is left to match on. Two files
  // use that id, and one of them is pinned to the image this runner is on.
  const sites = [{ label: 'ubuntu-latest', file: 'ci.yml', line: 6, col: 14, job: 'build' }];
  const others = [{ label: 'ubuntu-26.04', file: 'release.yml', line: 6, col: 14, job: 'build' }];
  const here = { job: 'build', file: 'caller.yml' };
  const a = attributeImageOS({ label: 'ubuntu-latest', imageOS: 'ubuntu26', sites, others, here });
  assert.equal(a.imageOS, null, 'release.yml pins a build job to the image this runner is on');
  assert.match(a.note, /More than one workflow has a job called "build"/);
  assert.notEqual(
    migrationStatus('ubuntu-latest', { now: DURING, imageOS: a.imageOS }).state,
    MIGRATION_STATE.MIGRATED,
  );
  const alone = attributeImageOS({ label: 'ubuntu-latest', imageOS: 'ubuntu26', sites, others: [], here });
  assert.equal(alone.imageOS, 'ubuntu26', 'one file uses the id, so the callee is found');
});

test('a matrix leg is trusted for the two images in the window and no others', () => {
  const site = { label: 'ubuntu-latest', file: 'ci.yml', line: 5, col: 28, job: 'a', viaMatrix: true };
  const here = { job: 'a', file: 'ci.yml' };
  assert.equal(attributeImageOS({ label: 'ubuntu-latest', imageOS: 'ubuntu26', sites: [site], here }).imageOS, 'ubuntu26');
  const off = attributeImageOS({ label: 'ubuntu-latest', imageOS: 'ubuntu22', sites: [site], here });
  assert.equal(off.imageOS, null, 'this runner is serving another leg');
  assert.match(off.note, /through a matrix/);
});

test('a label that names a property of Object is in none of the tables', async () => {
  // Labels come out of workflow files, so every table keyed by one is data.
  for (const key of ['__proto__', 'constructor', 'toString']) {
    assert.equal(migrationFor(key), null, key);
    assert.equal(deadlineFor(key), null, key);
    assert.equal(pathForLabel(key), null, key);
    assert.equal(migrationStatus(key, { now: DURING }), null, key);
    assert.equal(await surveyMigration({ label: key, now: DURING }), null, key);
  }
});

test('the day before the window opens, everything says one day', () => {
  const s = migrationStatus('ubuntu-latest', { now: new Date('2026-10-18T00:00:00Z') });
  const [a] = migrationAnnotations([{ ...s, sites: [{ file: 'ci.yml', line: 6, col: 14 }] }]);
  assert.match(a, /title=runner-drift: ubuntu-latest becomes ubuntu-26\.04 in 1 day:/);
  assert.match(a, /The rollout starts 2026-10-19 \(1 day\)/);
});

test('an ImageOS that names a property of Object is not an image', () => {
  // ImageOS is an environment variable, so the table has to be read as data.
  assert.equal(labelForImageOS('__proto__'), null);
  assert.equal(labelForImageOS('constructor'), null);
  const s = migrationStatus('ubuntu-latest', { now: DURING, imageOS: '__proto__' });
  assert.equal(s.observed, null);
  assert.equal(s.state, MIGRATION_STATE.AMBIGUOUS);
  assert.equal(s.anomaly, false);
});

test('with no GITHUB_JOB the window images are still attributed', () => {
  const sites = [{ label: 'ubuntu-latest', file: 'ci.yml', line: 6, col: 14, job: 'build' }];
  const a = attributeImageOS({ label: 'ubuntu-latest', imageOS: 'ubuntu24', sites, here: null });
  assert.equal(a.imageOS, 'ubuntu24');
  assert.equal(a.note, null);
  const b = attributeImageOS({ label: 'ubuntu-latest', imageOS: 'ubuntu22', sites, here: null });
  assert.equal(b.imageOS, null);
  assert.match(b.note, /No GITHUB_JOB says which job this check ran in/);
});

test('with no GITHUB_JOB a job pinned to the new image is the likelier runner', () => {
  // Nothing says which job this check is in, so a plain `runs-on: ubuntu-26.04`
  // elsewhere explains the image as well as the migration having landed does.
  const y = [
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '  compat:',
    '    runs-on: ubuntu-26.04',
  ].join('\n');
  const sites = extractFloatingSites(y, 'ci.yml');
  const others = extractLabelSites(y, 'ci.yml');
  const a = attributeImageOS({ label: 'ubuntu-latest', imageOS: 'ubuntu26', sites, others, here: null });
  assert.equal(a.imageOS, null);
  assert.match(a.note, /ask for ubuntu-26\.04 by name/);
  assert.notEqual(
    migrationStatus('ubuntu-latest', { now: DURING, imageOS: a.imageOS }).state,
    MIGRATION_STATE.MIGRATED,
  );
  const scoped = attributeImageOS({
    label: 'ubuntu-latest', imageOS: 'ubuntu26', sites, others, here: { job: 'build', file: 'ci.yml' },
  });
  assert.equal(scoped.imageOS, 'ubuntu26', 'the job id settles it');
});

test('a job id the calling workflow does not use is looked up in the callee', () => {
  // A reusable workflow reports the caller in GITHUB_WORKFLOW_REF, and the
  // caller is a scanned file: the job id still has to decide which site is ours.
  const callee = [{ label: 'ubuntu-latest', file: 'build.yml', line: 6, col: 14, job: 'build' }];
  const caller = [{ label: 'ubuntu-22.04', file: 'release.yml', line: 4, col: 14, job: 'publish' }];
  const here = { job: 'build', file: 'release.yml' };
  assert.equal(jobMatcher(here, [...callee, ...caller])(callee[0]), true);
  const a = attributeImageOS({ label: 'ubuntu-latest', imageOS: 'ubuntu24', sites: callee, others: caller, here });
  assert.equal(a.imageOS, 'ubuntu24');
  assert.equal(a.note, null);
  const shadowed = [{ ...caller[0], job: 'build' }];
  assert.equal(
    jobMatcher(here, [...callee, ...shadowed])(callee[0]),
    false,
    'the caller has a job of that id, so the file decides again',
  );
});

// The probe reads the interpreter running this test, so a literal version in the
// lock below is drift only until a runner ships that exact Node. Derive one the
// probe cannot report: `engines` floors this package at 22.
const LOCKED_NODE = `${Number(process.versions.node.split('.')[0]) - 1}.0.0`;
const LOCKED_NODE_DRIFT = new RegExp(`Node\\.js ${LOCKED_NODE.replaceAll('.', String.raw`\.`)} -> `);

/**
 * Guard against a lock recorded on the pre-migration image, with the runner
 * serving the post-migration one: the drift a real user sees mid-rollout.
 */
async function guardAcrossTheMove(opts, now, locked = { label: 'ubuntu-24.04', imageOS: 'ubuntu24' }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-drift-migration-'));
  const lockFile = path.join(dir, 'runner-lock.json');
  const IMAGE = '20260907.131.1';
  try {
    await writeLock(
      {
        ...locked,
        imageVersion: IMAGE,
        tools: { 'Node.js': { versions: [LOCKED_NODE], source: 'probe' } },
      },
      lockFile,
    );
    const { env = {}, ...rest } = opts;
    return await guard(
      { tools: 'node', 'lock-file': lockFile, 'update-lock': false, ...rest },
      { ImageVersion: IMAGE, ImageOS: 'ubuntu26', ...env },
      now,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('drift caused by the migration is named as such, not left unexplained', async () => {
  const r = await guardAcrossTheMove({ 'fail-on-migration': '30' }, DURING);
  assert.equal(r.code, EXIT_OK, 'a completed migration is not a failure');
  assert.match(
    r.stdout,
    /Explained by the scheduled ubuntu-latest migration ubuntu-24\.04 -> ubuntu-26\.04/,
  );
  assert.match(r.stdout, /\(2026-10-19 to 2026-11-19\)/);
  assert.match(r.stdout, LOCKED_NODE_DRIFT);
  assert.equal(r.stderr, '');
});

test('the explanation needs no flag: the two labels alone identify the move', async () => {
  const r = await guardAcrossTheMove({}, DURING);
  assert.equal(r.code, EXIT_OK);
  assert.match(
    r.stdout,
    /Explained by the scheduled ubuntu-latest migration ubuntu-24\.04 -> ubuntu-26\.04/,
  );
  // Without --fail-on-migration the lane itself stays quiet: no window, no diff.
  assert.ok(!r.stdout.includes('rollout'), 'no migration report without the flag');
  assert.equal(r.stderr, '');
});

test('the step summary names the explanation the way stdout does', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-drift-summary-'));
  const summaryFile = path.join(dir, 'summary.md');
  await writeFile(summaryFile, '', 'utf8');
  const prev = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summaryFile;
  try {
    await guardAcrossTheMove({ summary: true }, DURING);
    const md = await readFile(summaryFile, 'utf8');
    assert.match(md, /Explained by the scheduled `ubuntu-latest` migration/);
    assert.match(md, /\(2026-10-19 to 2026-11-19\)/);
  } finally {
    if (prev === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test('--json names the explanation without --fail-on-migration too', async () => {
  const r = await guardAcrossTheMove({ json: true }, DURING);
  const j = jsonOf(r.stdout);
  assert.equal(j.explains, 'ubuntu-latest');
  assert.equal(j.migration, undefined, 'the lane itself still needs the flag');
});

test('a quoted job id is the same job GITHUB_JOB names', async () => {
  const r = await guard(
    {
      tools: 'node',
      'fail-on-migration': '0',
      json: true,
      workflows: path.join(FIXTURES, 'workflows-quoted-job'),
    },
    { ImageOS: 'ubuntu26', ...inJob('build') },
    DURING,
  );
  const j = jsonOf(r.stdout);
  const s = j.migration.surveys[0];
  assert.equal(s.observed, 'ubuntu-26.04', 'the runner is attributed to "build"');
  assert.equal(s.state, MIGRATION_STATE.MIGRATED);
  assert.deepEqual(s.notes, []);
});

test('an empty --tools list falls back like no list at all', async () => {
  const r = await guard({ tools: ',', 'fail-on-migration': '30', json: true }, {}, BEFORE);
  const j = jsonOf(r.stdout);
  assert.ok(
    j.migration.surveys[0].toolDiffs.length > 0,
    'the workflows are still scanned for tools',
  );
});

test('a matrix leg pinned to the new image is not the migration arriving', async () => {
  // matrix: [ubuntu-latest, ubuntu-26.04]. This runner is on 26.04, which the
  // job asks for by name, so the jump from the lock is not GitHub's doing.
  const r = await guardAcrossTheMove(
    { workflows: path.join(FIXTURES, 'workflows-matrix') },
    DURING,
  );
  assert.ok(!r.stdout.includes('Explained by'), 'the pinned leg asks for 26.04 itself');
  assert.match(r.stdout, LOCKED_NODE_DRIFT, 'the drift is still reported');
});

test('the migration lane diffs the tools the lock watches', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-drift-migration-'));
  const lockFile = path.join(dir, 'runner-lock.json');
  try {
    await writeLock(
      {
        label: 'ubuntu-24.04',
        imageOS: 'ubuntu24',
        imageVersion: '20260907.300.1',
        tools: { Python: { versions: ['3.12.3'], source: 'probe' } },
      },
      lockFile,
    );
    const r = await guard({ 'fail-on-migration': '30', 'lock-file': lockFile, json: true });
    const j = jsonOf(r.stdout);
    const tools = j.migration.surveys[0].toolDiffs.map((d) => d.tool);
    assert.ok(tools.includes('Python'), 'the locked tool is in the diff');
    assert.ok(!tools.includes('Node.js'), 'and the ones only the workflows mention are not');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a repo that pins its runners is not told GitHub moved it', async () => {
  // The same 24.04 -> 26.04 jump, in a repo whose workflows never say
  // ubuntu-latest: someone bumped the pin by hand and owns the upgrade.
  const r = await guardAcrossTheMove({ workflows: path.join(FIXTURES, 'workflows') }, DURING);
  assert.ok(!r.stdout.includes('Explained by'), 'no floating label, no migration to blame');
  assert.match(r.stdout, LOCKED_NODE_DRIFT, 'the drift is still reported');
});

test('with no job id, a sibling pinned to the new image withholds the explanation', async () => {
  // build: ubuntu-latest, compat: ubuntu-26.04. This runner is on 26.04 and
  // nothing says which of the two jobs it is, so the move is not attributable.
  const where = { workflows: path.join(FIXTURES, 'workflows-pinned-sibling') };
  const blind = await guardAcrossTheMove(where, DURING);
  assert.ok(!blind.stdout.includes('Explained by'), 'either job explains this image');
  assert.match(blind.stdout, LOCKED_NODE_DRIFT, 'the drift is still reported');

  const mine = await guardAcrossTheMove({ ...where, env: inJob('build') }, DURING);
  assert.match(mine.stdout, /Explained by the scheduled ubuntu-latest migration/);
  const theirs = await guardAcrossTheMove({ ...where, env: inJob('compat') }, DURING);
  assert.ok(!theirs.stdout.includes('Explained by'), 'compat asks for 26.04 by name');
});

test('the explanation follows the job, not the repo, when Actions says which job', async () => {
  const mine = await guardAcrossTheMove({ env: inJob('build') }, DURING);
  assert.match(mine.stdout, /Explained by the scheduled ubuntu-latest migration/);
  const theirs = await guardAcrossTheMove({ env: inJob('pinned') }, DURING);
  assert.ok(!theirs.stdout.includes('Explained by'), 'the pinned job was not moved by the window');
});

test('a jump the migration table does not describe is left unexplained', async () => {
  const r = await guardAcrossTheMove({}, DURING, {
    label: 'ubuntu-22.04',
    imageOS: 'ubuntu22',
  });
  assert.ok(!r.stdout.includes('Explained by'), 'no announced move goes 22.04 -> 26.04');
});

test('migrationBetween matches only the announced pair', async () => {
  assert.equal(migrationBetween('ubuntu-24.04', 'ubuntu-26.04').label, 'ubuntu-latest');
  assert.equal(migrationBetween('ubuntu-26.04', 'ubuntu-24.04'), null, 'not backwards');
  assert.equal(migrationBetween('ubuntu-22.04', 'ubuntu-26.04'), null);
});
