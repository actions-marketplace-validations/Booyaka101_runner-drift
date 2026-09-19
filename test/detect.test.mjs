import test from 'node:test';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  analyseWorkflow,
  extractLabels,
  extractLabelSites,
  extractRunsOnTargets,
  extractRunScripts,
  commandsInScript,
  detect,
  SELF_HOSTED,
} from '../src/detect.mjs';
import { canonicalTool } from '../src/tools.mjs';
import { FIXTURES } from './helpers.mjs';

test('extracts an inline runs-on label', () => {
  assert.deepEqual(extractLabels('jobs:\n  a:\n    runs-on: ubuntu-22.04\n'), ['ubuntu-22.04']);
});

test('extracts a flow-sequence runs-on', () => {
  assert.deepEqual(
    extractLabels('    runs-on: [self-hosted, linux, x64]\n').sort(),
    ['linux', 'self-hosted', 'x64'],
  );
});

test('extracts a block-sequence runs-on', () => {
  const y = 'jobs:\n  a:\n    runs-on:\n      - self-hosted\n      - linux\n    steps: []\n';
  assert.deepEqual(extractLabels(y).sort(), ['linux', 'self-hosted']);
});

test('resolves runs-on: ${{ matrix.os }} from the matrix values in the same file', () => {
  const y = [
    'jobs:',
    '  a:',
    '    strategy:',
    '      matrix:',
    '        os: [ubuntu-22.04, ubuntu-24.04, macos-15]',
    '    runs-on: ${{ matrix.os }}',
  ].join('\n');
  assert.deepEqual(extractLabels(y).sort(), ['macos-15', 'ubuntu-22.04', 'ubuntu-24.04']);
});

test('extracts single-line and block run scripts', () => {
  const y = [
    'steps:',
    '  - run: python -m pip install -r requirements.txt',
    '  - name: build',
    '    run: |',
    '      cmake -S . -B build',
    '      cmake --build build',
    '  - uses: actions/checkout@v4',
  ].join('\n');
  const scripts = extractRunScripts(y);
  assert.equal(scripts.length, 2);
  assert.equal(scripts[0], 'python -m pip install -r requirements.txt');
  assert.match(scripts[1], /cmake --build build/);
});

test('finds commands past sudo, env assignments and pipes', () => {
  const cmds = commandsInScript(
    'sudo docker build . && CC=clang cmake -S . -B out\ngit rev-parse HEAD | head -1',
  );
  assert.deepEqual(cmds.sort(), ['cmake', 'docker', 'git']);
});

test('maps commands to the canonical manifest tool', () => {
  assert.equal(canonicalTool('python3'), 'Python');
  assert.equal(canonicalTool('npx'), 'Node.js');
  assert.equal(canonicalTool('clang++'), 'Clang');
  assert.equal(canonicalTool('g++'), 'GNU C++');
  assert.equal(canonicalTool('javac'), 'Temurin');
  assert.equal(canonicalTool('dotnet'), '.NET Core SDK');
});

test('actions/setup-* counts as using the tool', () => {
  const r = analyseWorkflow(
    'jobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/setup-go@v5\n',
  );
  assert.deepEqual(r.tools, ['Go']);
});

test('a flow-style step still counts as using the tool', () => {
  const r = analyseWorkflow(
    'jobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps: [{uses: actions/setup-go@v5}, {run: go build}]\n',
  );
  assert.deepEqual(r.tools, ['Go']);
  assert.deepEqual(
    r.uses.map((s) => [s.ref, s.col]),
    [['actions/setup-go@v5', 20]],
  );
});

test('scans a real workflow directory', async () => {
  const d = await detect(path.join(FIXTURES, 'workflows'));
  assert.equal(d.missing, false);
  assert.equal(d.files.length, 2);
  assert.deepEqual(d.tools, ['CMake', 'Clang', 'Python']);
  assert.ok(d.labels.includes('ubuntu-22.04'));
  assert.ok(d.labels.includes(SELF_HOSTED));
});

test('a single workflow file works as well as a directory', async () => {
  const d = await detect(path.join(FIXTURES, 'workflows', 'build.yml'));
  assert.deepEqual(d.files.length, 1);
  assert.deepEqual(d.tools, ['CMake', 'Clang', 'Python']);
});

test('a missing directory is reported, not thrown', async () => {
  const d = await detect(path.join(FIXTURES, 'definitely-not-here'));
  assert.equal(d.missing, true);
  assert.deepEqual(d.tools, []);
});

test('an empty or non-workflow document yields nothing', () => {
  const r = analyseWorkflow('');
  assert.deepEqual(r.labels, []);
  assert.deepEqual(r.tools, []);
});

test('labelSites: an inline scalar points at the label text, 1-indexed', () => {
  const sites = extractLabelSites('jobs:\n  a:\n    runs-on: ubuntu-22.04\n');
  assert.deepEqual(sites, [{ label: 'ubuntu-22.04', file: null, line: 3, col: 14 }]);
});

test('labelSites: a quoted scalar points inside the quotes', () => {
  const sites = extractLabelSites("jobs:\n  a:\n    runs-on: 'macos-14'\n");
  assert.deepEqual(sites, [{ label: 'macos-14', file: null, line: 3, col: 15 }]);
});

test('labelSites: flow-sequence items get their own columns, self-hosted none', () => {
  const sites = extractLabelSites('    runs-on: [self-hosted, linux, x64]\n');
  assert.deepEqual(sites, [
    { label: 'linux', file: null, line: 1, col: 28 },
    { label: 'x64', file: null, line: 1, col: 35 },
  ]);
});

test('labelSites: block-sequence items carry their own line and column', () => {
  const y = 'jobs:\n  a:\n    runs-on:\n      - self-hosted\n      - macos-14\n    steps: []\n';
  assert.deepEqual(extractLabelSites(y), [{ label: 'macos-14', file: null, line: 5, col: 9 }]);
});

test('labelSites: ${{ matrix.os }} resolves to the matrix value positions', () => {
  const y = [
    'jobs:',
    '  a:',
    '    strategy:',
    '      matrix:',
    '        os: [ubuntu-22.04, macos-14]',
    '    runs-on: ${{ matrix.os }}',
  ].join('\n');
  assert.deepEqual(extractLabelSites(y), [
    { label: 'ubuntu-22.04', file: null, line: 5, col: 14 },
    { label: 'macos-14', file: null, line: 5, col: 28 },
  ]);
});

test('labelSites: floating labels are never a site', () => {
  assert.deepEqual(extractLabelSites('    runs-on: ubuntu-latest\n'), []);
});

test('detect() aggregates labelSites with the file recorded', async () => {
  const d = await detect(path.join(FIXTURES, 'workflows'));
  const site = d.labelSites.find((s) => s.label === 'ubuntu-22.04');
  assert.ok(site, 'ubuntu-22.04 site found');
  assert.equal(path.basename(site.file), 'build.yml');
  assert.equal(site.line, 10);
  assert.equal(site.col, 14);
  assert.ok(!d.labelSites.some((s) => s.label === SELF_HOSTED));
});

test('detect() on the retirement fixture pins macos-14 and ubuntu-22.04 at known lines', async () => {
  const d = await detect(path.join(FIXTURES, 'workflows-retirement'));
  const at = (label) => d.labelSites.find((s) => s.label === label);
  assert.deepEqual(
    { line: at('macos-14').line, col: at('macos-14').col },
    { line: 12, col: 14 },
  );
  assert.deepEqual(
    { line: at('ubuntu-22.04').line, col: at('ubuntu-22.04').col },
    { line: 30, col: 14 },
  );
  assert.ok(!d.labelSites.some((s) => s.label === 'ubuntu-latest'), 'floating label has no site');
});

/**
 * The line scanners are linear, and this is what says so.
 *
 * CodeQL raised js/polynomial-redos on three of them during the 1.2.0 review.
 * The shape was `\s*(.*)$`: both quantifiers can match a space, and `$` can fail
 * because `.` excludes line terminators, so one stray carriage return on a long
 * line made the engine try every way to split the whitespace between them. The
 * `run:` scanner had a second variant, `[ \t]*-?[ \t]*`, where nothing mandatory
 * sat between the two runs.
 *
 * At this size the quadratic versions took tens of seconds; the linear ones take
 * under a millisecond. The budget is deliberately loose so a slow CI box cannot
 * fail it, while any reintroduction still blows straight through it.
 */
test('the line scanners stay linear on pathological input', () => {
  const CR = String.fromCharCode(13);
  const pad = ' '.repeat(200_000);
  const BUDGET_MS = 2000;

  const cases = [
    ['indent that never reaches run:', () => extractRunScripts(`${pad}x`)],
    ['dash then indent, no run:', () => extractRunScripts(`${pad}-${pad}x`)],
    ['run: with a trailing CR', () => extractRunScripts(`  run:${pad}${CR}x`)],
    ['runs-on: with a trailing CR', () => extractRunsOnTargets(`runs-on:${pad}${CR}x`)],
    ['a block-list dash with a CR', () => extractRunsOnTargets(`runs-on:\n${pad}-${pad}${CR}`)],
    ['extractLabels', () => extractLabels(`runs-on:${pad}${CR}x`)],
    ['extractLabelSites', () => extractLabelSites(`runs-on:${pad}${CR}x`)],
    ['commandsInScript after sudo', () => commandsInScript(`sudo${pad}x`)],
  ];

  for (const [label, fn] of cases) {
    const started = performance.now();
    fn();
    const elapsed = performance.now() - started;
    assert.ok(elapsed < BUDGET_MS, `${label} took ${elapsed.toFixed(0)}ms, budget ${BUDGET_MS}ms`);
  }
});
