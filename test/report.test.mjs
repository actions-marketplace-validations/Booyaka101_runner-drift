import test from 'node:test';
import assert from 'node:assert/strict';
import { deadlineLines, daysUntil, annotations, stepSummaryMarkdown, planRow } from '../src/report.mjs';
import { diffTool } from '../src/diff.mjs';

const NOW = new Date('2026-08-05T00:00:00Z');

test('deadline lines cite the source issue', () => {
  const lines = deadlineLines('ubuntu-22.04', NOW);
  assert.equal(
    lines[0],
    'ubuntu-22.04 is fully unsupported on 2027-04-17; brownouts begin 2027-03-23 (source: actions/runner-images#14254)',
  );
  // Anchored rather than `.includes(url)`: a substring test against a URL reads
  // as incomplete sanitization to CodeQL, and matching the end of the line is a
  // tighter assertion anyway.
  assert.ok(
    lines.some((l) => /\bhttps:\/\/github\.com\/actions\/runner-images\/issues\/14254$/.test(l)),
  );
  assert.ok(lines.some((l) => l.includes('brownout windows (14:00-00:00 UTC)')));
});

test('macos-14 has its own deadline and brownout schedule', () => {
  const lines = deadlineLines('macos-14', NOW);
  assert.equal(
    lines[0],
    'macos-14 is fully unsupported on 2026-11-02; brownouts begin 2026-10-05 (source: actions/runner-images#13518)',
  );
  assert.ok(lines.some((l) => l.includes('issues/13518')));
  assert.ok(lines.some((l) => l.includes('brownout windows (14:00-00:00 UTC): 2026-10-05')));
});

test('a label with no announced deadline returns null', () => {
  assert.equal(deadlineLines('ubuntu-24.04', NOW), null);
});

test('daysUntil counts down and then up', () => {
  assert.equal(daysUntil('2026-08-15', NOW), 10);
  assert.equal(daysUntil('2026-07-26', NOW), -10);
  assert.equal(daysUntil('not-a-date', NOW), null);
});

test('a past deadline reads as retired', () => {
  const lines = deadlineLines('macos-14', new Date('2027-01-01T00:00:00Z'));
  assert.ok(lines.some((l) => l.startsWith('retired 60 days ago')));
});

test('planRow renders the golden format', () => {
  assert.equal(planRow(diffTool('Python', ['3.10.12'], ['3.12.3'])), 'Python 3.10.12 -> 3.12.3  MINOR');
  assert.equal(
    planRow(diffTool('Clang', ['13.0.1', '14.0.0', '15.0.7'], ['16.0.6', '17.0.6', '18.1.3'])),
    'Clang 13.0.1,14.0.0,15.0.7 -> 16.0.6,17.0.6,18.1.3  REMOVED: 13.0.1, 14.0.0, 15.0.7 / ADDED: 16.0.6, 17.0.6, 18.1.3',
  );
});

test('annotations name the tool, the change and the shipping commit', () => {
  const diffs = [diffTool('Python', ['3.10.12'], ['3.12.3'])];
  const attribution = {
    Python: {
      sha: '3b7fa9c1aa1efb5fc0ba4b443dcfa69f47f53434',
      url: 'https://github.com/actions/runner-images/commit/3b7fa9c1',
      imageVersion: '20260720.234.2',
      exact: true,
    },
  };
  const [line] = annotations(diffs, attribution, 'ubuntu-22.04');
  assert.match(line, /^::warning title=runner-drift: Python minor::/);
  assert.match(line, /Python drifted on ubuntu-22\.04: 3\.10\.12 -> 3\.12\.3 \(MINOR\)/);
  assert.match(line, /shipped by 20260720\.234\.2/);
});

test('unchanged tools produce no annotations', () => {
  assert.deepEqual(annotations([diffTool('CMake', ['3.31.6'], ['3.31.6'])]), []);
});

test('step summary flags approximate attribution', () => {
  const md = stepSummaryMarkdown({
    label: 'ubuntu-22.04',
    fromImage: '20260714.228.1',
    toImage: '20260721.999.1',
    diffs: [diffTool('Python', ['3.10.12'], ['3.12.3'])],
    attribution: {},
    approximate: true,
    lockFile: 'runner-lock.json',
  });
  assert.match(md, /⚠️ \*\*approximate\*\*/);
  assert.match(md, /the readme lags the rollout/);
  assert.match(md, /\| `Python` \| 3\.10\.12 \| 3\.12\.3 \| 🟠 MINOR \| — \|/);
});

test('step summary spells out a multi-version set diff next to the badge', () => {
  const md = stepSummaryMarkdown({
    label: 'ubuntu-22.04',
    fromImage: '20260623.199.1',
    toImage: '20260720.234.2',
    diffs: [diffTool('Clang', ['13.0.1', '14.0.0', '15.0.7'], ['16.0.6', '17.0.6', '18.1.3'])],
    lockFile: 'runner-lock.json',
  });
  assert.match(md, /🔴 MAJOR — REMOVED: 13\.0\.1, 14\.0\.0, 15\.0\.7 \/ ADDED: 16\.0\.6, 17\.0\.6, 18\.1\.3/);
});

test('baseline summary says baseline, not drift', () => {
  const md = stepSummaryMarkdown({
    label: 'ubuntu-22.04',
    toImage: '20260720.234.2',
    diffs: ['Python', 'CMake'],
    baseline: true,
    lockFile: 'runner-lock.json',
  });
  assert.match(md, /Baseline recorded/);
  assert.ok(!md.includes('| Tool |'));
});
