import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runPlan, EXIT_OK, EXIT_USAGE } from '../src/cli.mjs';
import { detect } from '../src/detect.mjs';
import { captureIO, loadFixtureManifest, FIXTURES } from './helpers.mjs';

const WORKFLOWS = path.join(FIXTURES, 'workflows');
// Pinned so the countdown line is deterministic.
const NOW = new Date('2026-08-05T00:00:00Z');

test('plan compares Xcode inventory to either alias with automatic or explicit tools', async () => {
  for (const label of ['xcode-27', 'xcode-27-xlarge']) {
    for (const tools of [undefined, 'Xcode']) {
      const r = await plan({ from: 'macos-15', to: `"${label.toUpperCase()}"`, tools,
        workflows: path.join(FIXTURES, 'workflows-xcode'), json: true });
      assert.equal(r.code, EXIT_OK);
      const j = JSON.parse(r.stdout);
      assert.deepEqual(j.tools, ['Xcode']);
      assert.equal(j.to, label);
      assert.deepEqual(j.diffs[0].to.sort(), ['27.0', '27.1', '27.2']);
    }
  }
});

test('plan between Xcode aliases has unchanged inventory and no artificial tool diff', async () => {
  const r = await plan({ from: 'xcode-27', to: 'xcode-27-xlarge', tools: 'Xcode', json: true });
  assert.equal(r.code, EXIT_OK);
  assert.deepEqual(JSON.parse(r.stdout).diffs, []);
  assert.deepEqual(JSON.parse(r.stdout).unchanged, ['Xcode']);
});

for (const [from, to] of [['xcode-27', 'xcode-27-xlarge'], ['xcode-27-xlarge', 'xcode-27'],
  ['xcode-27', 'xcode-27']]) {
  test(`plan ${from} to ${to} uses one consistent manifest snapshot`, async () => {
    const cap = captureIO();
    const calls = [];
    const code = await runPlan({ from, to, tools: 'Xcode', json: true }, cap.io, {
      now: NOW,
      loadManifest: async (label) => {
        calls.push(label);
        const manifest = await loadFixtureManifest(label);
        return calls.length === 1 ? manifest : { ...manifest, imageVersion: '20261023.0307.1', tools: { Xcode: ['28.0'] } };
      },
    });
    assert.equal(code, EXIT_OK);
    const j = JSON.parse(cap.stdout);
    assert.equal(j.from, from);
    assert.equal(j.to, to);
    assert.equal(j.fromImage, j.toImage);
    assert.deepEqual(j.diffs, []);
    assert.deepEqual(calls, [from]);
  });
}

async function plan(opts) {
  const cap = captureIO();
  const code = await runPlan(
    { workflows: WORKFLOWS, ...opts },
    cap.io,
    { loadManifest: loadFixtureManifest, now: NOW },
  );
  return { code, stdout: cap.stdout, stderr: cap.stderr };
}

test('golden: ubuntu-22.04 -> ubuntu-24.04 for a python/cmake/clang workflow', async () => {
  const r = await plan({ from: 'ubuntu-22.04', to: 'ubuntu-24.04' });
  assert.equal(r.code, EXIT_OK);

  const lines = r.stdout.trimEnd().split('\n');

  assert.equal(lines[0], 'ubuntu-22.04 -> ubuntu-24.04 (images 20260720.234.2 -> 20260720.247.2)');
  assert.equal(
    lines[1],
    'ubuntu-22.04 is fully unsupported on 2027-04-17; brownouts begin 2027-03-23 (source: actions/runner-images#14254)',
  );
  assert.equal(
    lines[2],
    '255 days left (230 days until the first brownout) — deprecation began 2026-09-17; see https://github.com/actions/runner-images/issues/14254',
  );

  const rows = lines.filter((l) => /^(Python|Clang|CMake|Node\.js|Git|Go) /.test(l));
  assert.deepEqual(rows, [
    'Clang 13.0.1,14.0.0,15.0.7 -> 16.0.6,17.0.6,18.1.3  REMOVED: 13.0.1, 14.0.0, 15.0.7 / ADDED: 16.0.6, 17.0.6, 18.1.3',
    'Python 3.10.12 -> 3.12.3  MINOR',
  ]);
  assert.equal(rows.length, 2, 'exactly two affected rows');
});

test('golden: CMake is 3.31.6 on both images and must not appear', async () => {
  const r = await plan({ from: 'ubuntu-22.04', to: 'ubuntu-24.04' });
  assert.ok(!r.stdout.includes('CMake'), 'unchanged CMake must be suppressed entirely');
  assert.match(r.stdout, /2 of 3 detected tool\(s\) change; 1 unchanged \(not shown\)/);
});

test('the workflow scan really is what picks the three tools', async () => {
  const d = await detect(WORKFLOWS);
  assert.deepEqual(d.tools, ['CMake', 'Clang', 'Python']);
  assert.ok(d.labels.includes('ubuntu-22.04'));
});

test('--tools overrides detection', async () => {
  const r = await plan({ from: 'ubuntu-22.04', to: 'ubuntu-24.04', tools: 'git,node' });
  assert.equal(r.code, EXIT_OK);
  assert.match(r.stdout, /No change to any of the 2 tool\(s\)/);
});

test('plan refuses a floating label and says what to pass instead', async () => {
  const r = await plan({ from: 'ubuntu-latest', to: 'ubuntu-24.04' });
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /floating label/);
  assert.match(r.stderr, /concrete label/);
});

test('plan needs both --from and --to', async () => {
  const r = await plan({ from: 'ubuntu-22.04' });
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /--from <label> and --to <label>/);
});

test('an unknown label is a clear message, not a crash', async () => {
  const r = await plan({ from: 'ubuntu-22.04', to: 'ubuntu-99.04' });
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /no fixture for ubuntu-99\.04/);
  assert.match(r.stderr, /Known labels:/);
});

test('a missing workflow directory is a clear message, not a crash', async () => {
  const r = await plan({ from: 'ubuntu-22.04', to: 'ubuntu-24.04', workflows: 'no/such/dir' });
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /No workflow directory/);
  assert.match(r.stderr, /--tools/);
});

test('zero detected tools tells the user to pass --tools', async () => {
  const r = await plan({ from: 'ubuntu-22.04', to: 'ubuntu-24.04', workflows: FIXTURES });
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /No known tools detected/);
  assert.match(r.stderr, /--tools python,cmake,clang/);
});

test('--json emits only the affected rows', async () => {
  const r = await plan({ from: 'ubuntu-22.04', to: 'ubuntu-24.04', json: true });
  const j = JSON.parse(r.stdout);
  assert.equal(j.fromImage, '20260720.234.2');
  assert.equal(j.toImage, '20260720.247.2');
  assert.deepEqual(j.diffs.map((d) => d.tool).sort(), ['Clang', 'Python']);
  assert.deepEqual(j.unchanged, ['CMake']);
  assert.equal(j.deadline.fullyUnsupported, '2027-04-17');
});
