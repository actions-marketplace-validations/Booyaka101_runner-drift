import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { nextBrownout, retirementStatus, deadlineFor, pathForLabel } from '../src/labels.mjs';
import {
  retirementFindings,
  retirementAnnotations,
  retirementSummaryMarkdown,
} from '../src/report.mjs';
import { detect } from '../src/detect.mjs';
import { runGuard, EXIT_OK, EXIT_DRIFT, EXIT_USAGE } from '../src/cli.mjs';
import { captureIO, FIXTURES, jsonOf } from './helpers.mjs';

// At this date macos-14 browns out in 54 days and retires in 82;
// ubuntu-22.04 is 223 and 248 days out.
const NOW = new Date('2026-08-12T00:00:00Z');
const WORKFLOWS = path.join(FIXTURES, 'workflows-retirement');

const SITES = [
  { label: 'macos-14', file: 'ci.yml', line: 12, col: 14 },
  { label: 'ubuntu-22.04', file: 'ci.yml', line: 30, col: 14 },
];

/* ------------------------------------------------------------ nextBrownout */

test('nextBrownout returns the first window on or after now', () => {
  assert.equal(nextBrownout('macos-14', NOW), '2026-10-05');
  assert.equal(nextBrownout('macos-14', new Date('2026-10-05T00:00:00Z')), '2026-10-05');
  assert.equal(nextBrownout('macos-14', new Date('2026-10-06T00:00:00Z')), '2026-10-12');
  assert.equal(nextBrownout('macos-14', new Date('2026-10-31T00:00:00Z')), null);
  assert.equal(nextBrownout('ubuntu-22.04', NOW), '2027-03-23');
});

test('nextBrownout is null for unknown labels', () => {
  assert.equal(nextBrownout('ubuntu-24.04', NOW), null);
  assert.equal(nextBrownout('not-a-label', NOW), null);
});

test('a runs-on named after a property of Object has no deadline', () => {
  // The bogus status that Object.prototype handed back had no migrateTo, and
  // the annotation that follows a finding joins that list into a sentence.
  for (const name of ['constructor', 'toString', 'valueOf']) {
    assert.equal(nextBrownout(name, NOW), null, name);
    assert.equal(retirementStatus(name, NOW), null, name);
    assert.deepEqual(retirementFindings([{ label: name, file: 'ci.yml', line: 5, col: 14 }], { now: NOW, days: 90 }), [], name);
  }
});

/* -------------------------------------------------------- retirementStatus */

test('retirementStatus before deprecation starts', () => {
  const s = retirementStatus('ubuntu-22.04', NOW);
  assert.equal(s.deprecationStarted, false);
  assert.equal(s.retired, false);
  assert.equal(s.nextBrownout, '2027-03-23');
  assert.equal(s.daysToBrownout, 223);
  assert.equal(s.daysToUnsupported, 248);
  assert.equal(s.sourceRef, 'actions/runner-images#14254');
});

test('retirementStatus mid-deprecation', () => {
  const s = retirementStatus('macos-14', NOW);
  assert.equal(s.deprecationStarted, true);
  assert.equal(s.retired, false);
  assert.equal(s.nextBrownout, '2026-10-05');
  assert.equal(s.daysToBrownout, 54);
  assert.equal(s.fullyUnsupported, '2026-11-02');
  assert.equal(s.daysToUnsupported, 82);
});

test('retirementStatus past retirement', () => {
  const s = retirementStatus('macos-14', new Date('2027-01-01T00:00:00Z'));
  assert.equal(s.retired, true);
  assert.equal(s.daysToUnsupported, -60);
  assert.equal(s.nextBrownout, null);
  assert.equal(s.daysToBrownout, null);
});

test('retirementStatus is null for labels with no announced deadline', () => {
  assert.equal(retirementStatus('ubuntu-24.04', NOW), null);
  assert.equal(retirementStatus('windows-2022', NOW), null);
  assert.equal(retirementStatus('ubuntu-latest', NOW), null);
});

test('macos-14-large/xlarge have deadlines but no manifest path', () => {
  for (const label of ['macos-14-large', 'macos-14-xlarge']) {
    assert.equal(pathForLabel(label), null);
    assert.ok(deadlineFor(label));
    const s = retirementStatus(label, NOW);
    assert.equal(s.daysToBrownout, 54);
    assert.equal(s.daysToUnsupported, 82);
  }
  assert.deepEqual(deadlineFor('macos-14-large').migrateTo, ['macos-latest-large', 'macos-15-large']);
  assert.deepEqual(deadlineFor('macos-14-xlarge').migrateTo, [
    'macos-latest-xlarge',
    'macos-15-xlarge',
    'macos-26-xlarge',
  ]);
});

test('macos-14 brownout table matches issue 13518', () => {
  assert.deepEqual(deadlineFor('macos-14').brownouts, [
    '2026-10-05',
    '2026-10-12',
    '2026-10-16',
    '2026-10-19',
    '2026-10-23',
    '2026-10-26',
    '2026-10-29',
    '2026-10-30',
  ]);
  assert.equal(deadlineFor('macos-14').brownoutWindow, '14:00-00:00 UTC');
  assert.deepEqual(deadlineFor('macos-14-arm64').brownouts, deadlineFor('macos-14').brownouts);
});

/* ------------------------------------------------------ retirementFindings */

test('threshold 10: nothing fires', () => {
  assert.deepEqual(retirementFindings(SITES, { now: NOW, days: 10 }), []);
});

test('threshold 60: only the macos-14 brownout fires', () => {
  const f = retirementFindings(SITES, { now: NOW, days: 60 });
  assert.equal(f.length, 1);
  assert.equal(f[0].label, 'macos-14');
  assert.equal(f[0].trigger, 'brownout');
  assert.equal(f[0].line, 12);
});

test('threshold 250: both labels fire on retirement', () => {
  const f = retirementFindings(SITES, { now: NOW, days: 250 });
  assert.deepEqual(f.map((x) => [x.label, x.trigger]), [
    ['macos-14', 'retirement'],
    ['ubuntu-22.04', 'retirement'],
  ]);
});

test('threshold 0 fires only on retired labels', () => {
  assert.deepEqual(retirementFindings(SITES, { now: NOW, days: 0 }), []);
  const f = retirementFindings(SITES, { now: new Date('2027-01-01T00:00:00Z'), days: 0 });
  assert.equal(f.length, 1);
  assert.equal(f[0].label, 'macos-14');
  assert.equal(f[0].status.retired, true);
});

test('a retired label fires whatever the threshold', () => {
  const f = retirementFindings(
    [{ label: 'macos-14', file: 'x.yml', line: 1, col: 1 }],
    { now: new Date('2027-06-01T00:00:00Z'), days: 5 },
  );
  assert.equal(f.length, 1);
  assert.equal(f[0].trigger, 'retirement');
});

test('sites for unknown-deadline labels never fire', () => {
  const f = retirementFindings(
    [{ label: 'ubuntu-24.04', file: 'x.yml', line: 1, col: 1 }],
    { now: NOW, days: 10000 },
  );
  assert.deepEqual(f, []);
});

test('the same label at three sites yields three findings', () => {
  const sites = [1, 2, 3].map((n) => ({ label: 'macos-14', file: `f${n}.yml`, line: n, col: 5 }));
  const f = retirementFindings(sites, { now: NOW, days: 100 });
  assert.equal(f.length, 3);
});

/* --------------------------------------------------- retirementAnnotations */

test('a retirement inside the threshold is a ::error naming dates, targets and source', () => {
  const f = retirementFindings(SITES, { now: NOW, days: 100 });
  const [line] = retirementAnnotations(f);
  assert.match(line, /^::error file=ci\.yml,line=12,col=14,title=runner-drift: macos-14 retires in 82 days::/);
  assert.match(line, /fully unsupported on 2026-11-02 \(82 days\)/);
  assert.match(line, /next brownout 2026-10-05 \(54 days\)/);
  assert.match(line, /Migrate to macos-15, macos-26, macos-latest\./);
  assert.match(line, /https:\/\/github\.com\/actions\/runner-images\/issues\/13518/);
});

test('a brownout with retirement beyond the threshold is a ::warning', () => {
  const f = retirementFindings(SITES, { now: NOW, days: 60 });
  const [line] = retirementAnnotations(f);
  assert.match(line, /^::warning file=ci\.yml,line=12,col=14,title=runner-drift: macos-14 deprecation::/);
  assert.match(line, /next brownout 2026-10-05 \(54 days\)/);
});

test('a retired label reads "retired N days ago"', () => {
  const f = retirementFindings(SITES, { now: new Date('2027-01-01T00:00:00Z'), days: 0 });
  const [line] = retirementAnnotations(f);
  assert.match(line, /^::error file=ci\.yml,line=12,col=14,title=runner-drift: macos-14 retired 60 days ago::/);
  assert.match(line, /retired 60 days ago — fully unsupported since 2026-11-02/);
});

test('the last day before retirement reads "1 day", not "1 days"', () => {
  const eve = retirementFindings(SITES, { now: new Date('2026-11-01T00:00:00Z'), days: 5 });
  const [soon] = retirementAnnotations(eve);
  assert.match(soon, /title=runner-drift: macos-14 retires in 1 day::/);
  assert.match(retirementSummaryMarkdown(eve), /2026-11-02 \(1 day\)/);

  const morning = retirementFindings(SITES, { now: new Date('2026-11-03T00:00:00Z'), days: 0 });
  const [gone] = retirementAnnotations(morning);
  assert.match(gone, /title=runner-drift: macos-14 retired 1 day ago::/);
  assert.match(gone, /retired 1 day ago . fully unsupported since 2026-11-02/);
  assert.match(retirementSummaryMarkdown(morning), /2026-11-02 \(retired 1 day ago\)/);
});

/* ------------------------------------------------ retirementSummaryMarkdown */

test('summary markdown has the six columns, one row per site', () => {
  const f = retirementFindings(SITES, { now: NOW, days: 250 });
  const md = retirementSummaryMarkdown(f);
  assert.match(md, /^## runner-drift — retirement/);
  assert.match(md, /\| Label \| Where \| Next brownout \| Fully unsupported \| Migrate to \| Source \|/);
  assert.match(md, /\| `macos-14` \| `ci\.yml:12` \| 2026-10-05 \(54 days\) \| 2026-11-02 \(82 days\) \| `macos-15`, `macos-26`, `macos-latest` \| \[actions\/runner-images#13518\]/);
  assert.match(md, /\| `ubuntu-22\.04` \| `ci\.yml:30` \| 2027-03-23 \(223 days\) \| 2027-04-17 \(248 days\) \|/);
});

/* ---------------------------------------------------------------- runGuard */

async function guard(opts, env = {}, now = NOW) {
  const cap = captureIO();
  const code = await runGuard(
    { summary: true, 'update-lock': true, ...opts },
    cap.io,
    env,
    { now },
  );
  return { code, stdout: cap.stdout, stderr: cap.stderr };
}

test('guard --fail-on-retirement=60 fails a plain lint job on the macos-14 site', async () => {
  const r = await guard({ workflows: WORKFLOWS, 'fail-on-retirement': '60' });
  assert.equal(r.code, EXIT_DRIFT);
  const lines = r.stdout.split('\n').filter((l) => l.startsWith('::warning file=') || l.startsWith('::error file='));
  assert.equal(lines.length, 1, 'exactly one annotation');
  assert.match(lines[0], /file=.*pinned\.yml,line=12,col=14/);
  assert.match(lines[0], /macos-14/);
  assert.ok(!r.stdout.includes('ubuntu-22.04 is fully unsupported'), 'ubuntu-22.04 not flagged at 60');
  assert.match(r.stderr, /runner-drift: macos-14 is fully unsupported on 2026-11-02 \(82 days\) and --fail-on-retirement 60 is set\./);
});

test('the failure line counts a single day in the singular too', async () => {
  const r = await guard(
    { workflows: WORKFLOWS, 'fail-on-retirement': '5' },
    {},
    new Date('2026-11-01T00:00:00Z'),
  );
  assert.equal(r.code, EXIT_DRIFT);
  assert.match(r.stderr, /macos-14 is fully unsupported on 2026-11-02 \(1 day\) and --fail-on-retirement 5 is set\./);
});

test('guard --fail-on-retirement=10 exits 0 with no annotations', async () => {
  const r = await guard({ workflows: WORKFLOWS, 'fail-on-retirement': '10' });
  assert.equal(r.code, EXIT_OK);
  assert.ok(!r.stdout.includes('::error'));
  assert.ok(!r.stdout.includes('::warning file='));
  assert.equal(r.stderr, '');
});

test('guard --fail-on-retirement=250 flags both labels', async () => {
  const r = await guard({ workflows: WORKFLOWS, 'fail-on-retirement': '250' });
  assert.equal(r.code, EXIT_DRIFT);
  const lines = r.stdout.split('\n').filter((l) => l.startsWith('::error file='));
  assert.equal(lines.length, 2);
  assert.match(r.stderr, /macos-14 is fully unsupported on 2026-11-02/);
  assert.match(r.stderr, /ubuntu-22\.04 is fully unsupported on 2027-04-17 \(248 days\)/);
});

test('a retired label fails even at --fail-on-retirement=0', async () => {
  const cap = captureIO();
  const code = await runGuard(
    { summary: true, 'update-lock': true, workflows: WORKFLOWS, 'fail-on-retirement': '0' },
    cap.io,
    {},
    { now: new Date('2027-01-01T00:00:00Z') },
  );
  assert.equal(code, EXIT_DRIFT);
  assert.match(cap.stdout, /::error file=.*pinned\.yml,line=12,col=14/);
  assert.match(cap.stderr, /macos-14 has been fully unsupported since 2026-11-02 \(retired 60 days ago\) and --fail-on-retirement 0 is set\./);
});

test('a non-integer or negative value is a usage error', async () => {
  for (const bad of ['soon', '-5', '2.5', '']) {
    const r = await guard({ workflows: WORKFLOWS, 'fail-on-retirement': bad });
    assert.equal(r.code, EXIT_USAGE, `"${bad}" rejected`);
    assert.match(r.stderr, /--fail-on-retirement needs a whole number of days >= 0/);
  }
});

test('a missing workflow directory is a notice, not an error', async () => {
  const r = await guard({
    workflows: path.join(FIXTURES, 'definitely-not-here'),
    'fail-on-retirement': '60',
  });
  assert.equal(r.code, EXIT_OK);
  assert.match(r.stdout, /::notice title=runner-drift::No workflow directory/);
  assert.equal(r.stderr, '');
});

test('retirement rides along with the normal guard flow and its JSON', async () => {
  // Hosted-runner env, probeable tool, no lock: baseline still gets written,
  // and the retirement check still fails the run.
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-drift-retire-'));
  const lockFile = path.join(dir, 'runner-lock.json');
  try {
    const r = await guard(
      { workflows: WORKFLOWS, 'fail-on-retirement': '60', tools: 'node', 'lock-file': lockFile, json: true },
      { ImageVersion: '20260720.234.2', ImageOS: 'ubuntu22' },
    );
    assert.equal(r.code, EXIT_DRIFT);
    const parsed = jsonOf(r.stdout);
    assert.equal(parsed.baseline, true);
    assert.equal(parsed.retirement.days, 60);
    assert.equal(parsed.retirement.findings.length, 1);
    assert.equal(parsed.retirement.findings[0].label, 'macos-14');
    assert.equal(parsed.retirement.findings[0].line, 12);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detect() feeds sites straight into findings end to end', async () => {
  const d = await detect(WORKFLOWS);
  const f = retirementFindings(d.labelSites, { now: NOW, days: 250 });
  assert.deepEqual(f.map((x) => x.label).sort(), ['macos-14', 'ubuntu-22.04']);
});
