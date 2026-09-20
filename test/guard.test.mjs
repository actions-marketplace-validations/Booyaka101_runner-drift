import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { loaderFor, runGuard, EXIT_OK, EXIT_DRIFT, EXIT_USAGE } from '../src/cli.mjs';
import { readLock, writeLock, SCHEMA_VERSION } from '../src/lock.mjs';
import { captureIO, fixtureLoader, FIXTURES, jsonOf, stubApi } from './helpers.mjs';

async function tmp() {
  return mkdtemp(path.join(os.tmpdir(), 'runner-drift-test-'));
}

/**
 * Every guard test below is offline: `--tools node` is probeable, and the lock
 * carries the same ImageVersion as the fake env, so no attribution fetch runs.
 */
const IMAGE = '20260720.234.2';
const ENV = { ImageVersion: IMAGE, ImageOS: 'ubuntu22' };

async function guard(opts, env = ENV, deps = {}) {
  const cap = captureIO();
  const code = await runGuard({ summary: true, 'update-lock': true, ...opts }, cap.io, env, deps);
  return { code, stdout: cap.stdout, stderr: cap.stderr };
}

test('self-hosted / local: no ImageVersion means a clean skip, exit 0', async () => {
  const r = await guard({ tools: 'node' }, {});
  assert.equal(r.code, EXIT_OK);
  assert.match(r.stdout, /No ImageVersion environment variable/);
  assert.match(r.stdout, /::notice title=runner-drift::/);
  assert.match(r.stdout, /skipping/);
});

test('an unknown ImageOS is a warning and a skip, not a crash', async () => {
  const dir = await tmp();
  try {
    const r = await guard(
      { tools: 'node', 'lock-file': path.join(dir, 'runner-lock.json'), workflows: path.join(dir, 'none') },
      { ImageVersion: IMAGE, ImageOS: 'plan9' },
    );
    assert.equal(r.code, EXIT_OK);
    assert.match(r.stdout, /Unknown runner label/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--json off an unknown image still prints what the lanes found', async () => {
  const dir = await tmp();
  try {
    const r = await guard(
      {
        tools: 'node',
        json: true,
        'lock-file': path.join(dir, 'runner-lock.json'),
        'fail-on-migration': '0',
        workflows: path.join(FIXTURES, 'workflows-quoted-job'),
      },
      { ImageVersion: IMAGE, ImageOS: 'plan9' },
      { now: new Date('2026-09-20T00:00:00Z'), loadManifest: fixtureLoader({ 'ubuntu-24.04': 'ubuntu-24.04@2026-09' }) },
    );
    assert.match(r.stdout, /Unknown runner label/);
    const j = jsonOf(r.stdout);
    assert.equal(j.migration.surveys[0].label, 'ubuntu-latest');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('first run with no lock creates one and exits 0 with "baseline recorded"', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  try {
    const r = await guard({ tools: 'node', 'lock-file': lockFile });
    assert.equal(r.code, EXIT_OK);
    assert.match(r.stdout, /baseline recorded/);

    const lock = await readLock(lockFile);
    assert.equal(lock.schemaVersion, SCHEMA_VERSION);
    assert.equal(lock.label, 'ubuntu-22.04');
    assert.equal(lock.imageVersion, IMAGE);
    assert.equal(lock.tools['Node.js'].source, 'probe');
    assert.equal(lock.tools['Node.js'].versions[0], process.versions.node);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no drift on a second run against the same image', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  try {
    await guard({ tools: 'node', 'lock-file': lockFile });
    const r = await guard({ tools: 'node', 'lock-file': lockFile });
    assert.equal(r.code, EXIT_OK);
    assert.match(r.stdout, /No drift/);
    assert.ok(!r.stdout.includes('::warning'), 'no annotations when nothing changed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('drift is reported with a ::warning and exits 0 by default', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  try {
    await writeLock(
      {
        label: 'ubuntu-22.04',
        imageOS: 'ubuntu22',
        imageVersion: IMAGE,
        tools: { 'Node.js': { versions: ['18.0.0'], source: 'probe' } },
      },
      lockFile,
    );
    const r = await guard({ tools: 'node', 'lock-file': lockFile });
    assert.equal(r.code, EXIT_OK, 'exit 0 by default');
    assert.match(r.stdout, /::warning title=runner-drift: Node\.js major::/);
    assert.match(r.stdout, /Node\.js 18\.0\.0 -> /);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a lock file naming a tool after a property of Object is handled like any other', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  try {
    // Written as text: a `__proto__` key survives JSON.parse as an own property,
    // but an object literal would set the prototype instead.
    await writeFile(
      lockFile,
      `{"schemaVersion":${SCHEMA_VERSION},"label":"ubuntu-22.04","imageOS":"ubuntu22",`
        + `"imageVersion":"${IMAGE}","tools":{`
        + `"constructor":{"versions":["1.0.0"],"source":"manifest"},`
        + `"__proto__":{"versions":["2.0.0"],"source":"manifest"}}}`,
      'utf8',
    );
    const r = await guard({ 'lock-file': lockFile, json: true }, ENV, {
      loadManifest: fixtureLoader(),
    });
    assert.equal(r.code, EXIT_OK);
    assert.match(r.stdout, /constructor: no probe recipe here/);
    assert.match(r.stdout, /__proto__: no probe recipe here/);
    assert.deepEqual(jsonOf(r.stdout).notCompared.sort(), ['__proto__', 'constructor']);
    // Carried into the rewritten lock as their own keys, not onto a prototype.
    const after = JSON.parse(await readFile(lockFile, 'utf8'));
    assert.ok(Object.hasOwn(after.tools, '__proto__'));
    assert.deepEqual(after.tools.constructor.versions, ['1.0.0']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a lock from the other side of a migration is not attributed to this image history', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  const api = stubApi(() => ({ status: 200, body: [] }));
  try {
    await writeLock(
      {
        label: 'ubuntu-24.04',
        imageOS: 'ubuntu24',
        imageVersion: '20260720.247.2',
        tools: { 'Node.js': { versions: ['18.0.0'], source: 'probe' } },
      },
      lockFile,
    );
    const r = await guard({ tools: 'node', 'lock-file': lockFile, 'update-lock': false }, {
      ImageVersion: '20260907.131.1',
      ImageOS: 'ubuntu26',
    });
    assert.equal(r.code, EXIT_OK);
    assert.match(
      r.stdout,
      /ubuntu-24\.04 image 20260720\.247\.2 -> ubuntu-26\.04 image 20260907\.131\.1/,
      'both labels named, because the two images are different operating systems',
    );
    assert.deepEqual(api.calls, [], 'no commit in the 26.04 history shipped a 24.04 difference');
    assert.doesNotMatch(r.stdout, /Attribution unavailable/);
    assert.doesNotMatch(r.stdout, /shipped by/);
  } finally {
    api.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a rate-limited attribution lookup does not cost the manifest read', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  // Every API call refused, so pinning the manifest to the commit that shipped
  // this image cannot happen. The label's own readme is still readable.
  const api = stubApi(() => ({ status: 403, body: '', headers: { 'x-ratelimit-remaining': '0' } }));
  try {
    await writeLock(
      {
        label: 'ubuntu-22.04',
        imageOS: 'ubuntu22',
        imageVersion: '20260623.199.1',
        tools: { Bazel: { versions: ['9.1.0'], source: 'manifest' } },
      },
      lockFile,
    );
    const r = await guard({ tools: 'Bazel', 'lock-file': lockFile, 'update-lock': false }, ENV, {
      loadManifest: fixtureLoader(),
    });
    assert.equal(r.code, EXIT_OK);
    assert.match(r.stdout, /Bazel 9\.1\.0 -> 9\.2\.0/, 'read off the readme, not reported as removed');
    assert.doesNotMatch(r.stdout, /REMOVED/);
  } finally {
    api.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a manifest that cannot be read at all is not every locked tool removed', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  // Both reads refused: the pinned commit lookup by the API, the label's own
  // readme by a dropped connection.
  const api = stubApi(() => ({ status: 403, body: '', headers: { 'x-ratelimit-remaining': '0' } }));
  try {
    await writeLock(
      {
        label: 'ubuntu-22.04',
        imageOS: 'ubuntu22',
        imageVersion: IMAGE,
        tools: { Bazel: { versions: ['9.1.0'], source: 'manifest' } },
      },
      lockFile,
    );
    const r = await guard({ tools: 'Bazel', 'lock-file': lockFile, 'fail-on': 'major', summary: false }, ENV, {
      loadManifest: async () => {
        throw new Error('fetch failed (ECONNRESET)');
      },
    });
    assert.equal(r.code, EXIT_OK, 'an unreadable manifest is not drift');
    assert.match(r.stdout, /Bazel: .*could not be fetched/);
    assert.doesNotMatch(r.stdout, /REMOVED/);
    const after = await readLock(lockFile);
    assert.deepEqual(after.tools.Bazel.versions, ['9.1.0'], 'kept, or the next run calls it ADDED');
  } finally {
    api.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a tool the readme does not list is not removed unless the machine agrees', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  const api = stubApi(() => ({ status: 403, body: '', headers: { 'x-ratelimit-remaining': '0' } }));
  try {
    // Fortran has no probe recipe, so the readme was its only observer and a
    // heading it does not appear under says nothing about the image.
    await writeLock(
      {
        label: 'ubuntu-22.04',
        imageOS: 'ubuntu22',
        imageVersion: IMAGE,
        tools: { Fortran: { versions: ['13.2.0'], source: 'manifest' } },
      },
      lockFile,
    );
    const r = await guard(
      { tools: 'Fortran', 'lock-file': lockFile, 'fail-on': 'major', json: true, summary: false },
      ENV,
      { loadManifest: fixtureLoader() },
    );
    assert.equal(r.code, EXIT_OK);
    assert.match(r.stdout, /Fortran: no probe recipe here and not listed/);
    assert.doesNotMatch(r.stdout, /REMOVED/);
    assert.deepEqual(jsonOf(r.stdout).notCompared, ['Fortran'], 'named in the document, not only on stdout');
    const after = await readLock(lockFile);
    assert.deepEqual(after.tools.Fortran.versions, ['13.2.0']);
  } finally {
    api.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test('exit code 1 only under --fail-on major (and above)', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  const seed = () =>
    writeLock(
      {
        label: 'ubuntu-22.04',
        imageOS: 'ubuntu22',
        imageVersion: IMAGE,
        tools: { 'Node.js': { versions: ['18.0.0'], source: 'probe' } },
      },
      lockFile,
    );
  try {
    await seed();
    assert.equal((await guard({ tools: 'node', 'lock-file': lockFile })).code, EXIT_OK);

    await seed();
    const major = await guard({ tools: 'node', 'lock-file': lockFile, 'fail-on': 'major' });
    assert.equal(major.code, EXIT_DRIFT);
    assert.match(major.stderr, /MAJOR drift detected/);

    await seed();
    assert.equal((await guard({ tools: 'node', 'lock-file': lockFile, 'fail-on': 'any' })).code, EXIT_DRIFT);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a PATCH-only drift does not trip --fail-on major', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  try {
    const [maj, min, pat] = process.versions.node.split('.');
    const older = `${maj}.${min}.${Number(pat) + 1}`; // differs only in the patch field
    await writeLock(
      {
        label: 'ubuntu-22.04',
        imageOS: 'ubuntu22',
        imageVersion: IMAGE,
        tools: { 'Node.js': { versions: [older], source: 'probe' } },
      },
      lockFile,
    );
    const r = await guard({ tools: 'node', 'lock-file': lockFile, 'fail-on': 'major' });
    assert.equal(r.code, EXIT_OK);
    assert.match(r.stdout, /PATCH/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an invalid --fail-on value is a usage error', async () => {
  const r = await guard({ tools: 'node', 'fail-on': 'catastrophic' });
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /--fail-on must be one of/);
});

test('zero tools and no lock tells the user to pass --tools', async () => {
  const dir = await tmp();
  try {
    const r = await guard({
      'lock-file': path.join(dir, 'runner-lock.json'),
      workflows: path.join(dir, 'no-workflows'),
    });
    assert.equal(r.code, EXIT_USAGE);
    assert.match(r.stderr, /--tools python,cmake,clang/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--json off a hosted runner still prints the retirement document', async () => {
  const r = await guard(
    {
      tools: 'node',
      json: true,
      'fail-on-retirement': '365',
      workflows: path.join(FIXTURES, 'workflows-retirement'),
    },
    {},
  );
  const j = jsonOf(r.stdout);
  assert.ok(j.retirement.findings.length, 'the lane ran, so its findings are in the document');
});

test('guard writes a markdown table to $GITHUB_STEP_SUMMARY', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  const summaryFile = path.join(dir, 'summary.md');
  await writeFile(summaryFile, '', 'utf8');
  const prev = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summaryFile;
  try {
    await writeLock(
      {
        label: 'ubuntu-22.04',
        imageOS: 'ubuntu22',
        imageVersion: IMAGE,
        tools: { 'Node.js': { versions: ['18.0.0'], source: 'probe' } },
      },
      lockFile,
    );
    await guard({ tools: 'node', 'lock-file': lockFile });
    const md = await readFile(summaryFile, 'utf8');
    assert.match(md, /## runner-drift/);
    assert.match(md, /\| Tool \| Locked \| Now \| Change \| Shipped by \|/);
    assert.match(md, /\| `Node\.js` \| 18\.0\.0 \|/);
  } finally {
    if (prev === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test('without --fail-on-retirement, retiring labels change nothing', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  const workflows = path.join(FIXTURES, 'workflows-retirement');
  try {
    // The fixture pins macos-14, which retires 2026-11-02.
    const r = await guard({ tools: 'node', 'lock-file': lockFile, workflows });
    assert.equal(r.code, EXIT_OK);
    assert.match(r.stdout, /baseline recorded/);
    assert.ok(!r.stdout.includes('::error'), 'no retirement annotations');
    assert.ok(!r.stdout.includes('retirement'), 'no retirement text');
    assert.equal(r.stderr, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--no-update-lock writes no lock on the first run either', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  try {
    const r = await guard({ tools: 'node', 'lock-file': lockFile, 'update-lock': false });
    assert.equal(r.code, EXIT_OK);
    assert.match(r.stdout, /baseline observed/);
    assert.ok(!r.stdout.includes('baseline recorded'), 'nothing was recorded anywhere');
    assert.match(r.stdout, /Nothing written: --no-update-lock is set/);
    await assert.rejects(() => readFile(lockFile, 'utf8'), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the first-run summary does not claim a lock file that was not written', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  const summaryFile = path.join(dir, 'summary.md');
  await writeFile(summaryFile, '', 'utf8');
  const prev = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summaryFile;
  try {
    await guard({ tools: 'node', 'lock-file': lockFile, 'update-lock': false });
    const md = await readFile(summaryFile, 'utf8');
    assert.match(md, /Nothing written/);
    assert.ok(!md.includes('locked in'), 'there is no file to lock anything in');
    assert.ok(!md.includes('diff against this baseline'), 'nothing was kept to diff against');
  } finally {
    if (prev === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test('runGuard writes the lock by default, with no update-lock key at all', async () => {
  // --no-update-lock is resolved into `update-lock` by main(). A caller of the
  // exported runGuard builds its own options and has neither key.
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  const cap = captureIO();
  try {
    const code = await runGuard({ tools: 'node', 'lock-file': lockFile, summary: false }, cap.io, ENV);
    assert.equal(code, EXIT_OK);
    assert.equal((await readLock(lockFile)).label, 'ubuntu-22.04');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a manifest read that failed is retried, not replayed from the memo', async () => {
  // Both lanes want the same manifest mid-window, and the second one asking
  // must not be handed the first one's network error with no request of its own.
  let calls = 0;
  const load = loaderFor(async (label) => {
    calls += 1;
    if (calls === 1) throw new Error('502 from raw.githubusercontent.com');
    return { label, call: calls };
  });
  await assert.rejects(load('ubuntu-24.04'), /502/);
  assert.deepEqual(await load('ubuntu-24.04'), { label: 'ubuntu-24.04', call: 2 });
  assert.deepEqual(await load('ubuntu-24.04'), { label: 'ubuntu-24.04', call: 2 }, 'one read once it works');
  assert.equal(calls, 2);
});

test('the drift summary does not claim a lock update that --no-update-lock stopped', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  const summaryFile = path.join(dir, 'summary.md');
  await writeFile(summaryFile, '', 'utf8');
  const prev = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summaryFile;
  try {
    await writeLock(
      {
        label: 'ubuntu-22.04',
        imageOS: 'ubuntu22',
        imageVersion: '20260623.199.1',
        tools: { 'Node.js': { versions: ['18.0.0'], source: 'probe' } },
      },
      lockFile,
    );
    await guard({ tools: 'node', 'lock-file': lockFile, 'update-lock': false });
    const md = await readFile(summaryFile, 'utf8');
    assert.match(md, /left at image `20260623\.199\.1`/);
    assert.ok(!md.includes('updated to image'), 'nothing was updated');
  } finally {
    if (prev === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test('--json says whether the lock was written', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  try {
    await writeLock(
      {
        label: 'ubuntu-22.04',
        imageOS: 'ubuntu22',
        imageVersion: IMAGE,
        tools: { 'Node.js': { versions: ['18.0.0'], source: 'probe' } },
      },
      lockFile,
    );
    const off = await guard({ tools: 'node', 'lock-file': lockFile, 'update-lock': false, json: true });
    assert.equal(jsonOf(off.stdout).written, false);
    const on = await guard({ tools: 'node', 'lock-file': lockFile, json: true });
    assert.equal(jsonOf(on.stdout).written, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a lock this version cannot read does not swallow the self-hosted skip', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  try {
    await writeFile(lockFile, JSON.stringify({ schemaVersion: 99, label: 'ubuntu-24.04' }), 'utf8');
    const r = await guard(
      {
        tools: 'node',
        'lock-file': lockFile,
        'fail-on-migration': '0',
        workflows: path.join(FIXTURES, 'workflows-migration'),
      },
      {},
      { now: new Date('2026-09-20T00:00:00Z'), loadManifest: fixtureLoader({ 'ubuntu-24.04': 'ubuntu-24.04@2026-09' }) },
    );
    assert.equal(r.code, EXIT_OK, 'no ImageVersion is a skip, not a lock error');
    assert.match(r.stdout, /not a GitHub-hosted runner/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--no-update-lock leaves the lock alone', async () => {
  const dir = await tmp();
  const lockFile = path.join(dir, 'runner-lock.json');
  try {
    await writeLock(
      {
        label: 'ubuntu-22.04',
        imageOS: 'ubuntu22',
        imageVersion: '20260101.1.1',
        tools: { 'Node.js': { versions: ['18.0.0'], source: 'probe' } },
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      lockFile,
    );
    await guard({ tools: 'node', 'lock-file': lockFile, 'update-lock': false }, { ...ENV, ImageVersion: '20260101.1.1' });
    const lock = await readLock(lockFile);
    assert.equal(lock.updatedAt, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(lock.tools['Node.js'].versions, ['18.0.0']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
