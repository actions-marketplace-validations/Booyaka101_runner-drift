/**
 * `init` resolves the runner label offline here; the manifest fetch it would do
 * next is exercised live in the acceptance run and by the plan golden test, so
 * these cases stop at the label/tool decision, which is where the edge cases are.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { runInit, main, EXIT_OK, EXIT_USAGE } from '../src/cli.mjs';
import { captureIO, FIXTURES, readFixture, stubApi } from './helpers.mjs';

async function repo(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-drift-init-'));
  const wf = path.join(dir, '.github', 'workflows');
  await mkdir(wf, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(wf, name), body, 'utf8');
  }
  return { dir, workflows: wf };
}

async function init(opts) {
  const cap = captureIO();
  const code = await runInit(opts, cap.io);
  return { code, stdout: cap.stdout, stderr: cap.stderr };
}

test('a self-hosted-only repo is a clean skip, exit 0', async () => {
  const r = await init({
    workflows: path.join(FIXTURES, 'workflows', 'selfhosted.yml'),
    'lock-file': path.join(os.tmpdir(), 'runner-drift-should-not-exist.json'),
  });
  assert.equal(r.code, EXIT_OK);
  assert.match(r.stdout, /Only self-hosted runners found/);
  assert.match(r.stdout, /Skipping/);
});

test('extra self-hosted tags (gpu, linux) are not mistaken for image labels', async () => {
  const { dir, workflows } = await repo({
    'a.yml': 'jobs:\n  a:\n    runs-on: [self-hosted, linux, gpu, x64]\n    steps:\n      - run: python x.py\n',
  });
  try {
    const r = await init({ workflows, 'lock-file': path.join(dir, 'runner-lock.json') });
    assert.equal(r.code, EXIT_OK);
    assert.match(r.stdout, /Only self-hosted runners found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unknown but image-shaped label is named, not silently dropped', async () => {
  const { dir, workflows } = await repo({
    'a.yml': 'jobs:\n  a:\n    runs-on: ubuntu-18.04\n    steps:\n      - run: python x.py\n',
  });
  try {
    const r = await init({ workflows, 'lock-file': path.join(dir, 'runner-lock.json') });
    assert.equal(r.code, EXIT_USAGE);
    assert.match(r.stderr, /Unknown runner label "ubuntu-18\.04"/);
    assert.match(r.stderr, /Known labels:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a floating label is refused with the two ways forward', async () => {
  const { dir, workflows } = await repo({
    'a.yml': 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: python x.py\n',
  });
  try {
    const r = await init({ workflows, 'lock-file': path.join(dir, 'runner-lock.json') });
    assert.equal(r.code, EXIT_USAGE);
    assert.match(r.stderr, /floating label\(s\) ubuntu-latest/);
    assert.match(r.stderr, /--label ubuntu-24\.04/);
    assert.match(r.stderr, /guard.* reads the real/s);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two different image labels need an explicit --label', async () => {
  const { dir, workflows } = await repo({
    'a.yml': 'jobs:\n  a:\n    runs-on: ubuntu-22.04\n    steps:\n      - run: python x.py\n',
    'b.yml': 'jobs:\n  b:\n    runs-on: macos-15\n    steps:\n      - run: python y.py\n',
  });
  try {
    const r = await init({ workflows, 'lock-file': path.join(dir, 'runner-lock.json') });
    assert.equal(r.code, EXIT_USAGE);
    assert.match(r.stderr, /Multiple runner labels found: macos-15, ubuntu-22\.04/);
    assert.match(r.stderr, /--label <label>/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('zero detected tools tells the user to pass --tools', async () => {
  const { dir, workflows } = await repo({
    'a.yml': 'jobs:\n  a:\n    runs-on: ubuntu-22.04\n    steps:\n      - run: echo hi\n',
  });
  try {
    const r = await init({ workflows, 'lock-file': path.join(dir, 'runner-lock.json') });
    assert.equal(r.code, EXIT_USAGE);
    assert.match(r.stderr, /No known tools detected/);
    assert.match(r.stderr, /--tools python,cmake,clang/);
    assert.match(r.stderr, /Recognised tools:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing workflow directory is a clear message', async () => {
  const r = await init({ workflows: path.join(os.tmpdir(), 'runner-drift-nope-'.concat('x')) });
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /No workflow directory/);
  assert.match(r.stderr, /--workflows <path> or --tools/);
});

for (const label of ['xcode-27', 'xcode-27-xlarge']) {
  test(`init locks ${label} inventory and runtime identity`, async () => {
    const { dir, workflows } = await repo({
      'build.yml': `jobs:\n  build:\n    runs-on: '${label.toUpperCase()}'\n    steps:\n      - run: xcodebuild -version\n`,
    });
    const body = await readFixture(label);
    const api = stubApi(() => ({ status: 200, body }));
    try {
      const r = await init({ workflows, 'lock-file': path.join(dir, 'lock.json'), json: true });
      assert.equal(r.code, EXIT_OK);
      const j = JSON.parse(r.stdout);
      assert.deepEqual(j.detected.tools, ['Xcode']);
      const { lock } = j;
      assert.deepEqual({ label: lock.label, imageOS: lock.imageOS, imageVersion: lock.imageVersion,
        versions: lock.tools.Xcode.versions.sort() }, {
        label, imageOS: 'macos27', imageVersion: '20261022.0305.3', versions: ['27.0', '27.1', '27.2'],
      });
      assert.equal(lock.tools.Xcode.source, 'manifest');
      assert.match(api.calls[0], /\/images\/macos\/xcode-27-arm64-Readme\.md$/);
    } finally {
      api.restore();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('both Xcode aliases still require explicit selection, and --tools Xcode overrides prose', async () => {
  const { dir, workflows } = await repo({
    'a.yml': 'jobs:\n  a:\n    runs-on: xcode-27\n    steps:\n      - run: echo xcodebuild\n',
    'b.yml': 'jobs:\n  b:\n    runs-on: xcode-27-xlarge\n',
  });
  const body = await readFixture('xcode-27');
  const api = stubApi(() => ({ status: 200, body }));
  try {
    const r = await init({ workflows, tools: 'Xcode' });
    assert.equal(r.code, EXIT_USAGE);
    assert.match(r.stderr, /Multiple runner labels found: xcode-27, xcode-27-xlarge/);
    assert.equal(api.calls.length, 0);
    const chosen = await init({ workflows, tools: 'Xcode', label: 'xcode-27-xlarge',
      'lock-file': path.join(dir, 'lock.json'), json: true });
    assert.equal(chosen.code, EXIT_OK);
    assert.equal(JSON.parse(chosen.stdout).lock.label, 'xcode-27-xlarge');
  } finally {
    api.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test('init ignores another literal job\'s env value when selecting a matrix runner', async () => {
  const { dir, workflows } = await repo({
    'build.yml': [
      'jobs:',
      '  apple:',
      '    strategy:',
      '      matrix:',
      '        os: [xcode-27]',
      '    runs-on: ${{ matrix.os }}',
      '    steps:',
      '      - run: xcodebuild -version',
      '  linux:',
      '    runs-on: ubuntu-latest',
      '    env:',
      '      TARGET_IMAGE: xcode-27-xlarge',
    ].join('\n'),
  });
  const body = await readFixture('xcode-27');
  const api = stubApi(() => ({ status: 200, body }));
  try {
    const r = await init({ workflows, 'lock-file': path.join(dir, 'lock.json'), json: true });
    assert.equal(r.code, EXIT_OK, r.stderr);
    assert.equal(JSON.parse(r.stdout).lock.label, 'xcode-27');
  } finally {
    api.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const label of ['xcode-99', 'xcode-27-typo']) {
  test(`init does not silently discard unknown image-shaped ${label}`, async () => {
    const { dir, workflows } = await repo({
      'build.yml': `jobs:\n  build:\n    runs-on: ${label}\n    steps:\n      - run: xcodebuild -version\n`,
    });
    const api = stubApi(() => { throw new Error('Unknown labels should not need the network'); });
    try {
      const r = await init({ workflows, 'lock-file': path.join(dir, 'lock.json') });
      assert.equal(r.code, EXIT_USAGE);
      assert.match(r.stderr, new RegExp(`Unknown runner label "${label}"`));
      assert.equal(api.calls.length, 0);
    } finally {
      api.restore();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const status of [404, 429, 503, 'network', 'empty', 'missing']) {
  test(`Xcode init handles ${status} without a stack trace`, async () => {
    const { dir, workflows } = await repo({
      'build.yml': 'jobs:\n  build:\n    runs-on: xcode-27\n    steps:\n      - run: xcrun --version\n',
    });
    const cap = captureIO();
    const api = stubApi(() => {
      if (status === 'network') throw new TypeError('connection reset');
      return { status: typeof status === 'number' ? status : 200,
        body: status === 'missing' ? '# macOS 27\n- Image Version: 20261022.0305.3\n' : '' };
    });
    try {
      const code = await main(['init', '--workflows', workflows, '--lock-file', path.join(dir, 'lock.json'), '--json'], cap.io);
      assert.equal(code, status === 'missing' ? EXIT_OK : EXIT_USAGE);
      if (status === 'missing') {
        const j = JSON.parse(cap.stdout);
        assert.deepEqual(j.missing, ['Xcode']);
        assert.deepEqual(j.lock.tools, {});
      } else {
        assert.match(cap.stderr, /404|rate limit|HTTP 503|Network error|no "Image Version:"/i);
        assert.doesNotMatch(cap.stderr, /\n\s+at /);
      }
    } finally {
      api.restore();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
