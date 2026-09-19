import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { ACTIONS_REPO, FIXTURES, PINNED_SHA, actionRoutes, captureIO, stubApi } from './helpers.mjs';
import { extractUses, readScalar } from '../src/detect.mjs';
import {
  MAX_COMPOSITE_DEPTH,
  NODE20_REMOVAL_DATE,
  REF_STATUS,
  classifyRuntime,
  collectSources,
  parseRef,
  readRunsBlock,
  surveyActions,
  walkNodes,
} from '../src/runtimes.mjs';
import { actionsAnnotations, actionsReport, actionsSummaryMarkdown } from '../src/report.mjs';
import { EXIT_DRIFT, EXIT_OK, OPTIONS, main } from '../src/cli.mjs';

/** Ten days before the removal, so every countdown in here is stable. */
const NOW = new Date('2026-09-13T00:00:00Z');

const EXAMPLE_REPO = path.join(FIXTURES, 'actions-example');

/** The fixture repository surveyed offline, through the real http.mjs. */
async function survey(root = ACTIONS_REPO, { routes = {}, ...opts } = {}) {
  const api = stubApi(actionRoutes(routes));
  try {
    const result = await surveyActions({ root, now: NOW, ...opts });
    return { result, calls: api.calls };
  } finally {
    api.restore();
  }
}

const refFor = (result, ref) => result.references.find((r) => r.ref === ref);
const chain = (node) => [...walkNodes(node)].map((n) => n.ref);

/* ------------------------------------------------------------------ parsing */

test('parseRef classifies every shape a uses: line can hold', () => {
  assert.deepEqual({ ...parseRef('actions/checkout@v4') }, {
    kind: 'remote',
    ref: 'actions/checkout@v4',
    owner: 'actions',
    repo: 'checkout',
    subdir: '',
    gitRef: 'v4',
  });
  assert.equal(parseRef('acme/tools/setup@v2').subdir, 'setup');
  assert.equal(parseRef('acme/flows/.github/workflows/x.yml@v3').kind, 'remote-workflow');
  assert.equal(parseRef('./.github/actions/thing').kind, 'local');
  assert.equal(parseRef('./.github/workflows/x.yml').kind, 'local-workflow');
  assert.equal(parseRef('./').kind, 'local');
  assert.equal(parseRef('docker://alpine:3.20').kind, 'docker');
  assert.equal(parseRef('').kind, 'invalid');
  assert.equal(parseRef('actions/checkout').kind, 'invalid');
  assert.match(parseRef('${{ matrix.action }}@v1').reason, /expression/);
});

test('readScalar drops a trailing comment without cutting a ref that contains #', () => {
  assert.equal(readScalar(`acme/pinned@${PINNED_SHA} # v1.2.3`), `acme/pinned@${PINNED_SHA}`);
  assert.equal(readScalar("'actions/checkout@v4'"), 'actions/checkout@v4');
  assert.equal(readScalar('acme/repo@ref#frag'), 'acme/repo@ref#frag');
  assert.equal(readScalar('  # only a comment'), '');
});

test('extractUses records every reference with the line it is written on', () => {
  const text = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - uses: acme/one@v1',
    '      - run: x',
    '  b:',
    '    uses: acme/two@v2',
  ].join('\n');
  assert.deepEqual(
    extractUses(text).map((s) => [s.ref, s.line]),
    [
      ['acme/one@v1', 4],
      ['acme/two@v2', 7],
    ],
  );
});

test('a uses: line inside a run: heredoc is shell text, not a reference', () => {
  const text = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: |',
    '          cat > generated.yml <<EOF',
    '          - uses: acme/generated@v1',
    '          EOF',
    '      - uses: acme/real@v1',
  ].join('\n');
  assert.deepEqual(
    extractUses(text).map((s) => s.ref),
    ['acme/real@v1'],
  );
});

test('a flow-style step is a reference, and shell text on the same line is not', () => {
  const text = [
    'jobs:',
    '  a:',
    '    steps: [{uses: acme/one@v1}, {uses: acme/two@v2}]',
    '  b:',
    "    steps: [{run: echo '{\"uses\": \"acme/three@v3\"}'}]",
    '  c:',
    '    steps:',
    '      - run: echo {uses: acme/four@v4}',
  ].join('\n');
  assert.deepEqual(
    extractUses(text).map((s) => [s.ref, s.line]),
    [
      ['acme/one@v1', 3],
      ['acme/two@v2', 3],
    ],
  );
});

test('readRunsBlock reads using and the composite steps under it', () => {
  const block = readRunsBlock(
    [
      'name: x',
      'runs:',
      '  using: composite',
      '  steps:',
      '    - uses: acme/one@v1',
      '      with:',
      '        using: not-this',
      '    - shell: bash',
      '      run: echo',
    ].join('\n'),
  );
  assert.equal(block.using, 'composite');
  assert.deepEqual(block.steps.map((s) => s.ref), ['acme/one@v1']);
});

test('readRunsBlock ignores an inline runs: value and a file with no runs: at all', () => {
  assert.equal(readRunsBlock('runs: something-else\nname: x\n'), null);
  assert.equal(readRunsBlock('name: just a workflow\non: [push]\n'), null);
});

test('an input called runs does not shadow the real runs: block', () => {
  const block = readRunsBlock(
    [
      'inputs:',
      '  runs:',
      '    description: how many times to run it',
      'runs:',
      '  using: node20',
      '  main: dist/index.js',
    ].join('\n'),
  );
  assert.equal(block.using, 'node20');
});

test('classifyRuntime fails everything below node24 and passes everything at or above', () => {
  for (const dead of ['node12', 'node16', 'node20']) {
    assert.equal(classifyRuntime(dead), REF_STATUS.FAIL, dead);
  }
  for (const alive of ['node24', 'node26', 'docker']) {
    assert.equal(classifyRuntime(alive), REF_STATUS.OK, alive);
  }
  assert.equal(classifyRuntime('composite'), null);
  assert.equal(classifyRuntime(null), null);
});

/* ---------------------------------------------------------- file collection */

test('collectSources reads the workflows and every action.yml under .github/actions', async () => {
  const found = await collectSources({ root: ACTIONS_REPO });
  assert.deepEqual(
    found.files.map((f) => [f.kind, path.basename(path.dirname(f.file))]).sort(),
    [
      ['action', 'local-thing'],
      ['action', 'pure-shell'],
      ['workflow', 'workflows'],
    ],
  );
  assert.equal(found.missing, false);
});

test('collectSources reports a repository with no .github as missing, not as an error', async () => {
  const found = await collectSources({ root: path.join(FIXTURES, 'runners') });
  assert.equal(found.missing, true);
  assert.deepEqual(found.files, []);
});

/* ------------------------------------------------------------------ survey */

test('every reference in the fixture repository lands in the right bucket', async () => {
  const { result } = await survey();
  assert.equal(result.totalReferences, 10);
  assert.equal(result.uniqueReferences, 10);
  assert.deepEqual(result.counts, { fail: 4, unknown: 2, ok: 4 });
  assert.equal(result.failing, true);
  assert.equal(result.removalDate, NODE20_REMOVAL_DATE);
  assert.equal(result.daysLeft, 10);
  assert.deepEqual(result.readErrors, []);
  const byStatus = (status) =>
    result.references
      .filter((r) => r.status === status)
      .map((r) => r.ref)
      .sort();
  assert.deepEqual(byStatus(REF_STATUS.FAIL), [
    './.github/actions/local-thing',
    'acme/outer@v1',
    'actions/checkout@v4',
    'actions/upload-artifact@v4',
  ]);
  assert.deepEqual(byStatus(REF_STATUS.UNKNOWN), ['acme/loop@v1', 'acme/private@v1']);
  assert.deepEqual(byStatus(REF_STATUS.OK), [
    'acme/flows/.github/workflows/release.yml@v3',
    `acme/pinned@${PINNED_SHA}`,
    'acme/tools/setup@v2',
    'docker://alpine:3.20',
  ]);
});

test('a node20 step two composites down is named, not just the action that pulls it in', async () => {
  const { result } = await survey();
  const outer = refFor(result, 'acme/outer@v1');
  assert.equal(outer.status, REF_STATUS.FAIL);
  assert.deepEqual(chain(outer), ['acme/outer@v1', 'acme/inner@v2', 'acme/leaf@v3']);
  assert.equal([...walkNodes(outer)].at(-1).using, 'node20');

  // And the whole chain has to survive into what the user actually reads.
  const text = actionsReport(result);
  assert.match(
    text,
    / {2}acme\/outer@v1 +composite\n {4}acme\/inner@v2 +composite\n {6}acme\/leaf@v3 +node20/,
  );
  const [line] = actionsAnnotations(result).filter((l) => l.includes('acme/leaf@v3'));
  assert.match(line, /via acme\/outer@v1 -> acme\/inner@v2 -> acme\/leaf@v3/);
  assert.match(line, /ci\.yml,line=10/);
});

test('a local composite is followed into the checkout and its failing step named', async () => {
  const { result } = await survey();
  const local = refFor(result, './.github/actions/local-thing');
  assert.equal(local.status, REF_STATUS.FAIL);
  assert.deepEqual(chain(local), ['./.github/actions/local-thing', 'actions/upload-artifact@v4']);
});

test('a cycle stops instead of recursing, and the chain is not called safe', async () => {
  const { result } = await survey();
  const loop = refFor(result, 'acme/loop@v1');
  assert.equal(loop.status, REF_STATUS.UNKNOWN);
  assert.deepEqual(chain(loop), ['acme/loop@v1', 'acme/loop2@v1', 'acme/loop@v1']);
  const stopped = [...walkNodes(loop)].at(-1);
  assert.equal(stopped.status, REF_STATUS.CYCLE);
  assert.match(stopped.reason, /already being resolved further up this chain/);
});

test('a composite chain deeper than the cap stops at the cap', async () => {
  const files = {};
  for (let i = 0; i <= MAX_COMPOSITE_DEPTH + 2; i++) {
    files[`https://raw.githubusercontent.com/acme/deep${i}/v1/action.yml`] =
      `runs:\n  using: composite\n  steps:\n    - uses: acme/deep${i + 1}@v1\n`;
  }
  files['https://raw.githubusercontent.com/acme/outer/v1/action.yml'] =
    'runs:\n  using: composite\n  steps:\n    - uses: acme/deep0@v1\n';
  const { result } = await survey(ACTIONS_REPO, { routes: { files } });
  const refs = chain(refFor(result, 'acme/outer@v1'));
  assert.equal(refs.length, MAX_COMPOSITE_DEPTH + 2);
  const last = [...walkNodes(refFor(result, 'acme/outer@v1'))].at(-1);
  assert.equal(last.status, REF_STATUS.UNKNOWN);
  assert.match(last.reason, new RegExp(`deeper than ${MAX_COMPOSITE_DEPTH} levels`));
});

test('a subtree cut off by the cap is not cached as the answer for that action', async () => {
  // `acme/outer@v1` reaches deep4 at the cap, so deep4's own chain is truncated
  // there. `acme/pinned@<sha>` reaches the same deep4 one level in, where there
  // is depth left to find the node20 at the end of it.
  const files = {
    'https://raw.githubusercontent.com/acme/outer/v1/action.yml':
      'runs:\n  using: composite\n  steps:\n    - uses: acme/deep0@v1\n',
    [`https://raw.githubusercontent.com/acme/pinned/${PINNED_SHA}/action.yml`]:
      'runs:\n  using: composite\n  steps:\n    - uses: acme/deep4@v1\n',
  };
  for (let i = 0; i <= 6; i++) {
    const next = i === 6 ? 'actions/checkout@v4' : `acme/deep${i + 1}@v1`;
    files[`https://raw.githubusercontent.com/acme/deep${i}/v1/action.yml`] =
      `runs:\n  using: composite\n  steps:\n    - uses: ${next}\n`;
  }
  const { result } = await survey(ACTIONS_REPO, { routes: { files } });
  const pinned = refFor(result, `acme/pinned@${PINNED_SHA}`);
  assert.equal(pinned.status, REF_STATUS.FAIL);
  assert.deepEqual(chain(pinned), [
    `acme/pinned@${PINNED_SHA}`,
    'acme/deep4@v1',
    'acme/deep5@v1',
    'acme/deep6@v1',
    'actions/checkout@v4',
  ]);
});

test('a private repository is unknown with the reason, never a crash', async () => {
  const { result } = await survey();
  const priv = refFor(result, 'acme/private@v1');
  assert.equal(priv.status, REF_STATUS.UNKNOWN);
  assert.match(priv.reason, /private repository/);
  assert.match(priv.reason, /GITHUB_TOKEN/);
});

test('docker:// is reported as docker and never fetched', async () => {
  const { result, calls } = await survey();
  const docker = refFor(result, 'docker://alpine:3.20');
  assert.equal(docker.status, REF_STATUS.OK);
  assert.equal(docker.using, 'docker');
  assert.ok(!calls.some((u) => u.includes('alpine')));
});

test('a subdir action falls back from action.yml to action.yaml', async () => {
  const { result, calls } = await survey();
  assert.equal(refFor(result, 'acme/tools/setup@v2').status, REF_STATUS.OK);
  assert.ok(calls.includes('https://raw.githubusercontent.com/acme/tools/v2/setup/action.yml'));
  assert.ok(calls.includes('https://raw.githubusercontent.com/acme/tools/v2/setup/action.yaml'));
});

test('a reusable workflow is followed into its own uses: lines', async () => {
  const { result } = await survey();
  const flow = refFor(result, 'acme/flows/.github/workflows/release.yml@v3');
  assert.equal(flow.using, 'reusable-workflow');
  assert.deepEqual(flow.children.map((c) => c.ref), ['actions/setup-node@v5']);
  assert.equal(flow.status, REF_STATUS.OK);
});

test('a SHA pin with a trailing version comment resolves at the SHA', async () => {
  const { result, calls } = await survey();
  const pinned = refFor(result, `acme/pinned@${PINNED_SHA}`);
  assert.equal(pinned.status, REF_STATUS.OK);
  assert.equal(pinned.using, 'node24');
  assert.ok(
    calls.includes(`https://raw.githubusercontent.com/acme/pinned/${PINNED_SHA}/action.yml`),
  );
});

test('a failing action is given the major tag of its latest release, verified', async () => {
  const { result, calls } = await survey();
  const { upgrade } = refFor(result, 'actions/checkout@v4');
  assert.equal(upgrade.available, true);
  assert.equal(upgrade.ref, 'actions/checkout@v7');
  assert.equal(upgrade.using, 'node24');
  assert.equal(upgrade.latestRelease, 'v7.0.1');
  assert.ok(calls.includes('https://api.github.com/repos/actions/checkout/releases/latest'));
  // The major tag is what the report suggests, so the exact tag is never read.
  assert.ok(!calls.includes('https://raw.githubusercontent.com/actions/checkout/v7.0.1/action.yml'));
});

test('an action with no node24 release says so rather than inventing a target', async () => {
  const { result } = await survey();
  const leaf = [...walkNodes(refFor(result, 'acme/outer@v1'))].at(-1);
  assert.equal(leaf.upgrade.available, false);
  assert.equal(leaf.upgrade.checked, true);
  assert.equal(leaf.upgrade.reason, 'no published release declares node24');
});

test('a release that went composite is named as one, not as nothing to move to', async () => {
  const { result } = await survey(ACTIONS_REPO, {
    routes: {
      releases: { 'acme/leaf': { tag_name: 'v4.0.0' } },
      files: {
        'https://raw.githubusercontent.com/acme/leaf/v4/action.yml':
          'runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo\n',
      },
    },
  });
  const leaf = [...walkNodes(refFor(result, 'acme/outer@v1'))].at(-1);
  assert.equal(leaf.upgrade.available, false);
  assert.equal(leaf.upgrade.checked, true);
  assert.match(leaf.upgrade.reason, /^acme\/leaf@v4 is composite/);
});

test('a composite is not given an upgrade target that cannot be verified', async () => {
  const { result, calls } = await survey();
  assert.equal(refFor(result, 'acme/outer@v1').upgrade, undefined);
  assert.ok(!calls.includes('https://api.github.com/repos/acme/outer/releases/latest'));
});

test('a rate limit is unknown with the reason, and the run still finishes', async () => {
  const api = stubApi(() => ({
    status: 403,
    body: { message: 'API rate limit exceeded' },
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1789000000' },
  }));
  let result;
  try {
    result = await surveyActions({ root: EXAMPLE_REPO, now: NOW });
  } finally {
    api.restore();
  }
  assert.deepEqual(result.counts, { fail: 0, unknown: 3, ok: 0 });
  for (const ref of result.references) {
    assert.equal(ref.status, REF_STATUS.UNKNOWN);
    assert.match(ref.reason, /rate limit/i);
    assert.match(ref.reason, /GITHUB_TOKEN/);
  }
  assert.match(actionsReport(result), /unchecked, not as safe/);
});

test('an offline box is unknown with the reason, and exits 0 rather than pretending', async () => {
  const api = stubApi(() => null); // what undici throws when the network is gone
  const cap = captureIO();
  let code;
  try {
    code = await main(['actions', EXAMPLE_REPO, '--no-summary'], cap.io);
  } finally {
    api.restore();
  }
  assert.equal(code, EXIT_OK);
  assert.match(cap.stdout, /fetch failed/);
  assert.match(cap.stdout, /unchecked, not as safe/);
  assert.doesNotMatch(cap.stdout, /WILL FAIL/);
});

test('--fail-on-unknown turns an unresolved reference into a failure, and --warn-only still wins', async () => {
  const api = stubApi(() => null);
  const cap = captureIO();
  let code;
  try {
    code = await main(['actions', EXAMPLE_REPO, '--no-summary', '--fail-on-unknown'], cap.io);
  } finally {
    api.restore();
  }
  assert.equal(code, EXIT_DRIFT);
  assert.match(cap.stderr, /could not be resolved/);
  assert.match(cap.stderr, /--fail-on-unknown/);

  const api2 = stubApi(() => null);
  const cap2 = captureIO();
  let code2;
  try {
    code2 = await main(
      ['actions', EXAMPLE_REPO, '--no-summary', '--fail-on-unknown', '--warn-only'],
      cap2.io,
    );
  } finally {
    api2.restore();
  }
  assert.equal(code2, EXIT_OK);
  assert.match(cap2.stderr, /could not be resolved/);
});

test('--fail-on-unknown says nothing when every reference resolved', async () => {
  const api = stubApi(actionRoutes());
  const cap = captureIO();
  let code;
  try {
    code = await main(['actions', EXAMPLE_REPO, '--no-summary', '--fail-on-unknown'], cap.io);
  } finally {
    api.restore();
  }
  assert.equal(code, EXIT_DRIFT); // the example repo has two node20 references
  assert.match(cap.stderr, /stop working/);
  assert.doesNotMatch(cap.stderr, /could not be resolved/);
});

test('each URL is fetched once however many places name it', async () => {
  const { calls } = await survey();
  assert.equal(calls.length, new Set(calls).size);
  assert.equal(calls.filter((u) => u.includes('/actions/checkout/v4/')).length, 1);
});

test('a repository with no workflows says so and reports nothing failing', async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), 'runner-drift-'));
  try {
    const { result } = await survey(empty);
    assert.equal(result.missing, true);
    assert.equal(result.uniqueReferences, 0);
    assert.equal(result.failing, false);
    assert.match(actionsReport(result), /nothing to check/);
    assert.match(actionsSummaryMarkdown(result), /nothing here depends on a Node runtime/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('a --workflows path that does not exist still reads the actions tree', async () => {
  const { result } = await survey(ACTIONS_REPO, {
    workflows: path.join(ACTIONS_REPO, '.github', 'workflows', 'nope.yml'),
  });
  assert.equal(result.workflowsMissing, true);
  assert.equal(result.missing, false);
  assert.deepEqual(
    result.references.map((r) => r.ref),
    ['actions/upload-artifact@v4'],
  );
});

/* ------------------------------------------------------------------ output */

test('the report matches the example the README publishes, byte for byte', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const block = readme.match(/```\n\$ npx runner-drift actions\n([\s\S]*?)\n```/);
  assert.ok(block, 'the README still shows a worked `actions` example');
  const { result } = await survey(EXAMPLE_REPO);
  assert.equal(actionsReport(result), block[1]);
});

/**
 * The README publishes the `--json` shape as a contract, the same way the
 * runners lane does. Keys compared against a real survey, so adding a field
 * without documenting it fails here.
 */
test('the --json shape the README documents is the shape it emits', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const block = readme.match(/### `actions --json`[\s\S]*?```json\n([\s\S]*?)\n```/);
  assert.ok(block, 'the README still documents the JSON shape');
  const documented = JSON.parse(block[1]);
  const { result } = await survey(EXAMPLE_REPO);

  const keys = (o) => Object.keys(o).sort();
  assert.deepEqual(keys(documented), keys(result), 'top level');
  assert.deepEqual(keys(documented.counts), keys(result.counts), 'counts');
  assert.deepEqual(keys(documented.files[0]), keys(result.files[0]), 'files');
  const failing = documented.references.find((r) => r.status === 'fail');
  const realFailing = result.references.find((r) => r.status === 'fail');
  assert.deepEqual(keys(failing), keys(realFailing), 'reference');
  assert.deepEqual(keys(failing.upgrade), keys(realFailing.upgrade), 'upgrade');
  assert.deepEqual(keys(failing.where[0]), keys(realFailing.where[0]), 'where');
  // The values that are load-bearing claims rather than illustration.
  assert.equal(documented.removalDate, result.removalDate);
  assert.equal(documented.source, result.source);
  assert.equal(failing.using, realFailing.using);
  assert.equal(failing.upgrade.ref, realFailing.upgrade.ref);
});

test('the step summary names the removal date, the counts and every reference', async () => {
  const { result } = await survey();
  const md = actionsSummaryMarkdown(result);
  assert.match(md, /## runner-drift — action runtimes/);
  assert.match(md, /\*\*2026-09-23\*\* \(10 days\)/);
  assert.match(md, /\*\*4 of 10\*\* action references stop working in 10 days\./);
  for (const ref of result.references) assert.ok(md.includes(`\`${ref.ref}\``), ref.ref);
  assert.match(md, /↳ ↳ `acme\/leaf@v3`/);
});

test('annotations are errors on failures and warnings on unresolved references', async () => {
  const { result } = await survey();
  const lines = actionsAnnotations(result);
  assert.equal(lines.filter((l) => l.startsWith('::error')).length, 4);
  assert.equal(lines.filter((l) => l.startsWith('::warning')).length, 2);
  for (const line of lines) assert.match(line, /file=test\/fixtures\/actions-repo\/\.github\//);
});

/* --------------------------------------------------------------------- cli */

async function cli(argv, { routes = {}, env = {} } = {}) {
  const api = stubApi(actionRoutes(routes));
  const cap = captureIO();
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const code = await main(argv, cap.io);
    return { code, stdout: cap.stdout, stderr: cap.stderr, calls: api.calls };
  } finally {
    api.restore();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Through main() rather than runActions(), because a flag that never meets the
// real argv parser is a flag nobody has actually checked.
test('actions exits 1 when a reference will fail, and names them on stderr', async () => {
  const r = await cli(['actions', EXAMPLE_REPO, '--no-summary']);
  assert.equal(r.code, EXIT_DRIFT);
  assert.match(r.stdout, /WILL FAIL/);
  assert.match(r.stderr, /actions\/checkout@v4/);
  assert.match(r.stderr, /2 action reference\(s\) stop working/);
});

test('--warn-only reports the same thing and exits 0', async () => {
  const r = await cli(['actions', EXAMPLE_REPO, '--warn-only', '--no-summary']);
  assert.equal(r.code, EXIT_OK);
  assert.match(r.stdout, /WILL FAIL/);
});

test('--json prints the structured result and nothing else', async () => {
  const r = await cli(['actions', EXAMPLE_REPO, '--json', '--no-summary']);
  assert.equal(r.code, EXIT_DRIFT);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.removalDate, NODE20_REMOVAL_DATE);
  assert.equal(parsed.counts.fail, 2);
  assert.equal(parsed.references.length, 3);
  assert.ok(!r.stdout.includes('::error'));
});

test('a repository whose actions all survive exits 0', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-drift-'));
  const workflows = path.join(dir, '.github', 'workflows');
  try {
    await mkdir(workflows, { recursive: true });
    await writeFile(
      path.join(workflows, 'ci.yml'),
      'jobs:\n  a:\n    steps:\n      - uses: actions/setup-node@v5\n      - uses: acme/tools/setup@v2\n',
    );
    const r = await cli(['actions', dir, '--no-summary']);
    assert.equal(r.code, EXIT_OK);
    assert.match(r.stdout, /All 2 action references survive the 2026-09-23 removal\./);
    assert.doesNotMatch(r.stdout, /WILL FAIL/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the action the repository itself publishes is scanned, workflows or not', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-drift-'));
  try {
    await writeFile(
      path.join(dir, 'action.yml'),
      [
        'name: acme',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - uses: actions/checkout@v4',
        '    - shell: bash',
        '      run: echo hi',
      ].join('\n'),
    );
    const r = await cli(['actions', dir, '--no-summary']);
    assert.equal(r.code, EXIT_DRIFT);
    assert.match(r.stdout, /scanned 1 action file, 1 action reference\(s\), 1 unique/);
    assert.match(r.stdout, /actions\/checkout@v4 +node20/);
    assert.match(r.stdout, /file=action\.yml,line=5/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('actions writes the job summary and the will-fail-count output', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-drift-'));
  const summary = path.join(dir, 'summary.md');
  const output = path.join(dir, 'output.txt');
  try {
    const r = await cli(['actions', EXAMPLE_REPO], {
      env: { GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
    });
    assert.equal(r.code, EXIT_DRIFT);
    assert.match(await readFile(summary, 'utf8'), /## runner-drift — action runtimes/);
    const written = await readFile(output, 'utf8');
    const [head, value] = written.split('\n');
    assert.match(head, /^will-fail-count<<rd_[0-9a-f-]+$/);
    assert.equal(value, '2');
    assert.equal(written.trimEnd().split('\n').at(-1), head.split('<<')[1]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--no-summary leaves $GITHUB_STEP_SUMMARY alone', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-drift-'));
  const summary = path.join(dir, 'summary.md');
  try {
    await cli(['actions', EXAMPLE_REPO, '--no-summary'], {
      env: { GITHUB_STEP_SUMMARY: summary },
    });
    await assert.rejects(readFile(summary, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--help documents every flag the parser accepts', async () => {
  const cap = captureIO();
  await main(['actions', '--help'], cap.io);
  for (const flag of Object.keys(OPTIONS)) {
    if (flag === 'help' || flag === 'version') continue;
    // A flag whose documented spelling is the negative one counts as documented.
    const documented =
      cap.stdout.includes(`--${flag}`) || cap.stdout.includes(`--no-${flag}`);
    assert.ok(documented, `--${flag} is not in the usage text`);
  }
});

test('action.yml wires mode: actions through to the CLI and the output', async () => {
  const yml = await readFile(new URL('../action.yml', import.meta.url), 'utf8');
  assert.match(yml, /^ {2}mode:\n(?: {4}.*\n)* {4}default: 'guard'$/m);
  assert.match(yml, /^ {2}warn-only:$/m);
  assert.match(yml, /will-fail-count:\n {4}description: .*\n {4}value: \$\{\{ steps\.drift\.outputs\.will-fail-count \}\}/);
  assert.match(yml, /args=\(actions "\$GITHUB_WORKSPACE" --workflows "\$WF_ABS"\)/);
  assert.match(yml, /args\+=\(--warn-only\)/);
});
