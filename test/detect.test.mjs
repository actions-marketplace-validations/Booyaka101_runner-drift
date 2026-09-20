import test from 'node:test';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  analyseWorkflow,
  extractLabels,
  extractLabelSites,
  extractFloatingSites,
  extractRunsOnTargets,
  extractRunScripts,
  commandsInScript,
  detect,
  SELF_HOSTED,
} from '../src/detect.mjs';
import { canonicalTool, manifestCandidates } from '../src/tools.mjs';
import { isProbeable, probeTool } from '../src/probe.mjs';
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

test('a tool named after a property of Object is just an unknown tool', () => {
  // `--tools constructor` used to hand a function to the manifest resolver,
  // which asked it for a list of candidate names and crashed.
  for (const name of ['constructor', 'toString', '__proto__']) {
    assert.equal(typeof canonicalTool(name), 'string', name);
    assert.deepEqual(manifestCandidates(name), [name], name);
    assert.equal(isProbeable(name), false, name);
    assert.equal(probeTool(name).reason, 'no probe recipe', name);
  }
});

test('a step that runs a command named after Object is not a detected tool', () => {
  // conda ships a real `constructor` CLI, so this reaches the scanner from a
  // plain workflow. Inherited, it used to become a tool with no probe recipe.
  for (const name of ['constructor', 'toString', 'valueOf']) {
    assert.deepEqual(commandsInScript(`${name} --build .`), [], name);
    const r = analyseWorkflow(
      `jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - uses: ${name}@v1
`,
    );
    assert.deepEqual(r.tools, [], name);
  }
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
  assert.deepEqual(sites, [{ label: 'ubuntu-22.04', file: null, line: 3, col: 14, job: 'a' }]);
});

test('labelSites: a quoted scalar points inside the quotes', () => {
  const sites = extractLabelSites("jobs:\n  a:\n    runs-on: 'macos-14'\n");
  assert.deepEqual(sites, [{ label: 'macos-14', file: null, line: 3, col: 15, job: 'a' }]);
});

test('labelSites: flow-sequence items get their own columns, self-hosted none', () => {
  const sites = extractLabelSites('    runs-on: [self-hosted, linux, x64]\n');
  assert.deepEqual(sites, [
    { label: 'linux', file: null, line: 1, col: 28, job: null },
    { label: 'x64', file: null, line: 1, col: 35, job: null },
  ]);
});

test('labelSites: block-sequence items carry their own line and column', () => {
  const y = 'jobs:\n  a:\n    runs-on:\n      - self-hosted\n      - macos-14\n    steps: []\n';
  assert.deepEqual(extractLabelSites(y), [{ label: 'macos-14', file: null, line: 5, col: 9, job: 'a' }]);
});

test('labelSites: a runs-on mapping reads its labels and not its group', () => {
  const y = 'jobs:\n  a:\n    runs-on:\n      group: default\n      labels: [ubuntu-22.04]\n';
  assert.deepEqual(extractLabelSites(y), [
    { label: 'ubuntu-22.04', file: null, line: 5, col: 16, job: 'a' },
  ]);
});

test('labelSites: a mapping whose labels are a block list', () => {
  const y = [
    'jobs:',
    '  a:',
    '    runs-on:',
    '      group: big',
    '      labels:',
    '        - self-hosted',
    '        - macos-14',
    '    steps: []',
  ].join('\n');
  assert.deepEqual(extractLabelSites(y), [
    { label: 'macos-14', file: null, line: 7, col: 11, job: 'a' },
  ]);
});

test('labelSites: a mapping whose labels are a single scalar', () => {
  const y = 'jobs:\n  a:\n    runs-on:\n      labels: ubuntu-22.04\n';
  assert.deepEqual(extractLabelSites(y), [
    { label: 'ubuntu-22.04', file: null, line: 4, col: 15, job: 'a' },
  ]);
});

test('a group on its own is a pool, not a label', () => {
  const y = 'jobs:\n  a:\n    runs-on:\n      group: default\n    steps: []\n';
  assert.deepEqual(extractLabels(y), []);
  assert.deepEqual(extractLabelSites(y), []);
  assert.deepEqual(extractRunsOnTargets(y)[0].labels, []);
});

test('a mapping is one target, so its labels are a set the runner must carry', () => {
  const y = [
    'jobs:',
    '  a:',
    '    runs-on:',
    '      group: big',
    '      labels: [self-hosted, macos-14]',
    '  b:',
    '    runs-on: ubuntu-22.04',
  ].join('\n');
  const targets = extractRunsOnTargets(y);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets[0].labels, [SELF_HOSTED, 'macos-14']);
  assert.deepEqual(targets[1].labels, ['ubuntu-22.04']);
});

test('a floating label under a mapping is still floating', () => {
  const y = 'jobs:\n  a:\n    runs-on:\n      group: default\n      labels: [ubuntu-latest]\n';
  assert.deepEqual(extractFloatingSites(y), [
    { label: 'ubuntu-latest', file: null, line: 5, col: 16, job: 'a' },
  ]);
});

test('an expression inside a mapping marks the target, same as a bare one', () => {
  const y = [
    'jobs:',
    '  a:',
    '    runs-on:',
    '      group: default',
    '      labels: [${{ matrix.os }}]',
    '    strategy:',
    '      matrix:',
    '        os: [ubuntu-22.04]',
  ].join('\n');
  assert.ok(extractRunsOnTargets(y)[0].expression, 'the mapping resolves through the matrix');
  assert.deepEqual(
    extractLabelSites(y).map((s) => s.label),
    ['ubuntu-22.04'],
  );
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
    { label: 'ubuntu-22.04', file: null, line: 5, col: 14, job: 'a', viaMatrix: true },
    { label: 'macos-14', file: null, line: 5, col: 28, job: 'a', viaMatrix: true },
  ]);
});

test('a flow-mapping matrix is read like a block one', () => {
  const y = [
    'jobs:',
    '  a:',
    '    strategy:',
    '      matrix: {os: [ubuntu-latest, ubuntu-22.04]}',
    '    runs-on: ${{ matrix.os }}',
  ].join('\n');
  assert.deepEqual(extractLabels(y).sort(), ['ubuntu-22.04', 'ubuntu-latest']);
  assert.deepEqual(
    extractFloatingSites(y).map((s) => [s.label, s.line, s.job]),
    [['ubuntu-latest', 4, 'a']],
  );
});

test('an expression runs-on resolves a workflow_call input default', () => {
  const y = [
    'on:',
    '  workflow_call:',
    '    inputs:',
    '      runner:',
    '        default: ubuntu-22.04',
    'jobs:',
    '  a:',
    '    runs-on: ${{ inputs.runner }}',
  ].join('\n');
  assert.deepEqual(extractLabels(y), ['ubuntu-22.04']);
  assert.deepEqual(
    extractLabelSites(y).map((s) => [s.label, s.line, s.job, s.jobs]),
    [['ubuntu-22.04', 5, null, ['a']]],
    'the default sits above the jobs map, but it is job a that runs on it',
  );
});

test('a label an expression reaches from top-level env still belongs to the jobs', () => {
  const y = [
    'env:',
    '  RUNNER: ubuntu-latest',
    'jobs:',
    '  a:',
    '    runs-on: ${{ env.RUNNER }}',
    '  b:',
    '    runs-on: ubuntu-22.04',
    '  c:',
    '    runs-on: ${{ env.RUNNER }}',
  ].join('\n');
  assert.deepEqual(
    extractFloatingSites(y).map((s) => [s.label, s.line, s.jobs]),
    [['ubuntu-latest', 2, ['a', 'c']]],
    'one annotation, naming both jobs it can serve; the pinned job is not one',
  );
});

test('an input named jobs does not become the jobs map', () => {
  const y = [
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      jobs:',
    '        default: all',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-22.04',
  ].join('\n');
  assert.deepEqual(
    extractLabelSites(y).map((s) => [s.label, s.job]),
    [['ubuntu-22.04', 'build']],
  );
});

test('a step name and a run: script are not places a runner is asked for', () => {
  const y = [
    'jobs:',
    '  build:',
    '    strategy:',
    '      matrix: {os: [ubuntu-24.04]}',
    '    runs-on: ${{ matrix.os }}',
    '    steps:',
    '      - name: build on ubuntu-latest',
    '        if: contains(matrix.os, "ubuntu-latest")',
    '        run: |',
    '          echo ubuntu-latest > /tmp/ubuntu-22.04',
    '      - run: echo ubuntu-latest',
  ].join('\n');
  assert.deepEqual(extractFloatingSites(y), []);
  assert.deepEqual(
    extractLabelSites(y).map((s) => [s.label, s.line]),
    [['ubuntu-24.04', 4]],
  );
});

test('labelSites: a matrix does not make every mention of a label a site', () => {
  const y = [
    '# this repo moved off ubuntu-latest years ago',
    'jobs:',
    '  a:',
    '    strategy:',
    '      matrix:',
    '        os: [ubuntu-24.04]   # not ubuntu-latest',
    '    runs-on: ${{ matrix.os }}',
    '    steps:',
    '      - run: echo ubuntu-latest',
  ].join('\n');
  assert.deepEqual(extractFloatingSites(y), [], 'a comment is not a runs-on');
  assert.deepEqual(
    extractLabelSites(y).map((s) => [s.label, s.line]),
    [['ubuntu-24.04', 6]],
  );
});

test('a dashed run: block does not swallow the step keys under it', () => {
  const y = [
    'jobs:',
    '  a:',
    '    runs-on: ${{ matrix.os }}',
    '    strategy:',
    '      matrix:',
    '        os: [ubuntu-22.04]',
    '    steps:',
    '      - run: |',
    '          echo ubuntu-20.04',
    '        env:',
    '          FALLBACK: ubuntu-18.04',
  ].join('\n');
  assert.deepEqual(
    extractLabelSites(y).map((s) => s.label),
    ['ubuntu-22.04', 'ubuntu-18.04'],
  );
});

test('a quoted job id is recorded without its quotes', () => {
  const y = [
    'jobs:',
    '  "build":',
    '    runs-on: ubuntu-latest',
  ].join('\n');
  assert.equal(extractFloatingSites(y)[0].job, 'build');
});

test('a trailing comment is not part of the label', () => {
  const y = [
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-latest  # floating on purpose',
    '  b:',
    '    runs-on: [self-hosted, linux]  # the fleet',
    '  c:',
    '    runs-on:',
    '      - macos-14   # the mac leg',
  ].join('\n');
  assert.deepEqual(
    extractFloatingSites(y).map((s) => [s.label, s.line, s.col]),
    [['ubuntu-latest', 3, 14]],
  );
  assert.deepEqual(
    extractLabelSites(y).map((s) => s.label),
    ['linux', 'macos-14'],
  );
  assert.deepEqual(extractRunsOnTargets(y)[1].labels, [SELF_HOSTED, 'linux']);
});

test('a label written in a step name or a condition is not a runner', () => {
  // The prose keys hold a plain scalar as often as a block one, and a plain
  // scalar folds over the lines below it just the same.
  const y = [
    'jobs:',
    '  a:',
    '    strategy:',
    '      matrix:',
    '        os: [ubuntu-24.04]',
    '    runs-on: ${{ matrix.os }}',
    '    steps:',
    '      - name:',
    '          build on ubuntu-latest',
    '        run: make',
    '      - if: >',
    '          github.repository != "acme/ubuntu-22.04"',
    '        run: echo skipped',
  ].join('\n');
  assert.deepEqual(extractFloatingSites(y), []);
  assert.deepEqual(
    extractLabelSites(y).map((s) => s.label),
    ['ubuntu-24.04'],
  );
  assert.deepEqual(extractLabels(y), ['ubuntu-24.04']);
});

test('a job called matrix is not a matrix block', () => {
  const y = [
    'jobs:',
    '  matrix:',
    '    runs-on: ${{ inputs.runner }}',
    '    steps:',
    '      - name: drop macos-14 from the support table',
    '        run: make',
  ].join(String.fromCharCode(10));
  assert.deepEqual(extractLabels(y), [], 'the step title is prose in any job');
});

test('a run-name is a title, not a runner the workflow asks for', () => {
  const y = [
    'run-name: nightly build on ubuntu-22.04 by ${{ github.actor }}',
    'jobs:',
    '  a:',
    '    strategy:',
    '      matrix:',
    '        os: [ubuntu-24.04]',
    '    runs-on: ${{ matrix.os }}',
    '    steps:',
    "      - run: make",
  ].join(String.fromCharCode(10));
  assert.deepEqual(extractLabels(y), ['ubuntu-24.04']);
  assert.deepEqual(extractFloatingSites(y), []);
});

test('an input description is prose too', () => {
  const y = [
    'on:',
    '  workflow_call:',
    '    inputs:',
    '      runner:',
    '        description: which runner to use, e.g. ubuntu-22.04',
    '        default: ubuntu-24.04',
    'jobs:',
    '  a:',
    '    runs-on: ${{ inputs.runner }}',
  ].join(String.fromCharCode(10));
  assert.deepEqual(extractLabels(y), ['ubuntu-24.04']);
});

test('a matrix dimension named after a prose key is still values', () => {
  // `name` is a step title under `steps:` and a matrix axis under `matrix:`.
  const y = [
    'jobs:',
    '  a:',
    '    strategy:',
    '      matrix:',
    '        name: [ubuntu-22.04, macos-14]',
    '    runs-on: ${{ matrix.name }}',
    '    steps:',
    '      - name: build on ubuntu-latest',
    '        run: make',
  ].join(String.fromCharCode(10));
  assert.deepEqual(extractLabels(y).sort(), ['macos-14', 'ubuntu-22.04']);
  assert.deepEqual(
    extractLabelSites(y).map((s) => [s.label, s.line, s.job]),
    [
      ['ubuntu-22.04', 5, 'a'],
      ['macos-14', 5, 'a'],
    ],
  );
  assert.deepEqual(extractFloatingSites(y), [], 'the step title is still prose');
});

test('a job with a plain runs-on gets no labels from the matrix fallback', () => {
  // The fallback is a token scan over the whole file, so one matrix job used to
  // turn every label-shaped value in every other job into a runner it asks for.
  const y = [
    'jobs:',
    '  test:',
    '    strategy:',
    '      matrix:',
    '        os: [ubuntu-22.04]',
    '    runs-on: ${{ matrix.os }}',
    '  guard:',
    '    runs-on: ubuntu-latest',
    '    env:',
    '      TARGET_IMAGE: ubuntu-26.04',
  ].join(String.fromCharCode(10));
  assert.deepEqual(
    extractLabelSites(y).map((s) => [s.label, s.job]),
    [['ubuntu-22.04', 'test']],
    'the env value is not a runner the guard job asks for',
  );
  assert.deepEqual(
    extractFloatingSites(y).map((s) => [s.label, s.job, s.viaMatrix]),
    [['ubuntu-latest', 'guard', undefined]],
  );
});

test('a job with no runs-on still hands a label to the workflow it calls', () => {
  // A `uses:` job has no runs-on of its own, so the label it passes in `with:`
  // is the only record of the runner this file asks for.
  const y = [
    'jobs:',
    '  test:',
    '    strategy:',
    '      matrix:',
    '        os: [ubuntu-24.04]',
    '    runs-on: ${{ matrix.os }}',
    '  call:',
    '    uses: ./.github/workflows/build.yml',
    '    with:',
    '      runner: ubuntu-22.04',
  ].join(String.fromCharCode(10));
  assert.deepEqual(
    extractLabelSites(y).map((s) => [s.label, s.job]),
    [
      ['ubuntu-24.04', 'test'],
      ['ubuntu-22.04', 'call'],
    ],
  );
});

test('one label line is one site, however many jobs the expression serves', () => {
  // Three jobs sharing an input default used to mean three identical
  // annotations on the same line.
  const y = [
    'on:',
    '  workflow_call:',
    '    inputs:',
    '      runner:',
    '        default: ubuntu-latest',
    'jobs:',
    '  a:',
    '    runs-on: ${{ inputs.runner }}',
    '  b:',
    '    runs-on: ${{ inputs.runner }}',
    '  c:',
    '    runs-on: ${{ inputs.runner }}',
  ].join(String.fromCharCode(10));
  const sites = extractFloatingSites(y);
  assert.equal(sites.length, 1);
  assert.deepEqual(sites[0].jobs, ['a', 'b', 'c']);
});

test('an empty prose key that holds a map is read, not skipped', () => {
  // `name:` is a prose key, but `inputs.name` is an input whose default a
  // `runs-on:` expression resolves to.
  const y = [
    'on:',
    '  workflow_call:',
    '    inputs:',
    '      name:',
    '        default: ubuntu-22.04',
    'jobs:',
    '  a:',
    '    runs-on: ${{ inputs.name }}',
  ].join('\n');
  assert.deepEqual(extractLabels(y), ['ubuntu-22.04']);
  assert.deepEqual(
    extractLabelSites(y).map((s) => [s.label, s.line, s.jobs]),
    [['ubuntu-22.04', 5, ['a']]],
  );
});

test('a key under the block that follows the jobs map is not a job id', () => {
  // `x-` template blocks are a real shape, and the id can collide with a job's.
  const y = [
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '',
    'x-templates:',
    '  build:',
    '    runs-on: ubuntu-22.04',
  ].join('\n');
  assert.equal(extractFloatingSites(y)[0].job, 'build');
  assert.equal(extractLabelSites(y)[0].job, null);
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
    ['a labels: key with a CR', () => extractRunsOnTargets(`runs-on:\n  labels:${pad}${CR}`)],
    ['extractLabels', () => extractLabels(`runs-on:${pad}${CR}x`)],
    ['extractLabelSites', () => extractLabelSites(`runs-on:${pad}${CR}x`)],
    ['commandsInScript after sudo', () => commandsInScript(`sudo${pad}x`)],
    ['a matrix scan over an indent with no colon', () => extractLabelSites(`runs-on: \${{ matrix.os }}\n${pad}x`)],
    ['a matrix scan over a dashed indent', () => extractLabelSites(`runs-on: \${{ matrix.os }}\n${pad}-${pad}x`)],
    [
      'comment starts before a stray CR',
      () => extractLabelSites(`runs-on: \${{ matrix.os }}\n${' #'.repeat(100_000)}${CR}`),
    ],
  ];

  for (const [label, fn] of cases) {
    const started = performance.now();
    fn();
    const elapsed = performance.now() - started;
    assert.ok(elapsed < BUDGET_MS, `${label} took ${elapsed.toFixed(0)}ms, budget ${BUDGET_MS}ms`);
  }
});
