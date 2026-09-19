import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { main, EXIT_OK, EXIT_USAGE } from '../src/cli.mjs';
import { captureIO } from './helpers.mjs';

async function run(argv) {
  const cap = captureIO();
  const code = await main(argv, cap.io);
  return { code, stdout: cap.stdout, stderr: cap.stderr };
}

test('--help prints usage and exits 0', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, EXIT_OK);
  assert.match(r.stdout, /runner-drift init/);
  assert.match(r.stdout, /runner-drift guard/);
  assert.match(r.stdout, /runner-drift plan/);
  assert.match(r.stdout, /Known labels: ubuntu-22\.04/);
});

test('--version prints the version from package.json', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const r = await run(['--version']);
  assert.equal(r.code, EXIT_OK);
  assert.equal(r.stdout.trim(), pkg.version);
});

test('no command prints usage to stderr and exits 2', async () => {
  const r = await run([]);
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /Usage:/);
});

test('an unknown command is named', async () => {
  const r = await run(['frobnicate']);
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /Unknown command "frobnicate"/);
});

test('an unknown flag is a usage error, not a crash', async () => {
  const r = await run(['plan', '--nope']);
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /Unknown option '--nope'/);
});

/**
 * These go through main(), not through runGuard() directly. `--no-summary` and
 * `--no-update-lock` were documented from 1.0.0 but never parsed: parseArgs has
 * no `--no-` negation, so both exited 2 with "Unknown option". Every existing
 * test set `{ 'update-lock': false }` on runGuard by hand and so never touched
 * the parse layer where the bug lived.
 */
test('every flag --help advertises actually parses', async () => {
  const usage = (await run(['--help'])).stdout;
  const flags = [...new Set([...usage.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)].map((m) => m[1]))];
  assert.ok(flags.length >= 12, `expected the whole table, got ${flags.length}`);
  for (const flag of flags) {
    if (flag === 'help' || flag === 'version') continue;
    // A bad value is fine; "Unknown option" means the flag does not exist.
    for (const argv of [['guard', `--${flag}`], ['guard', `--${flag}`, 'x']]) {
      const r = await run(argv);
      assert.ok(
        !r.stderr.includes(`Unknown option '--${flag}'`),
        `--${flag} is advertised but parseArgs rejects it`,
      );
    }
  }
});

test('--no-summary and --no-update-lock parse and take effect', async () => {
  const { mkdtemp, rm, writeFile, readFile: rf } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-drift-neg-'));
  const lockFile = path.join(dir, 'runner-lock.json');
  const summaryFile = path.join(dir, 'summary.md');
  const lock = {
    schemaVersion: 1,
    label: 'ubuntu-22.04',
    imageOS: 'ubuntu22',
    imageVersion: '20260720.234.2',
    tools: { 'Node.js': { versions: ['18.0.0'], source: 'probe' } },
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const saved = { ...process.env };
  process.env.ImageVersion = '20260720.234.2';
  process.env.ImageOS = 'ubuntu22';
  process.env.GITHUB_STEP_SUMMARY = summaryFile;
  try {
    await writeFile(summaryFile, '', 'utf8');
    await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
    const r = await run(['guard', '--tools', 'node', '--lock-file', lockFile, '--no-summary', '--no-update-lock']);
    assert.equal(r.code, EXIT_OK);
    assert.ok(!r.stderr.includes('Unknown option'), 'both flags parse');
    assert.equal(await rf(summaryFile, 'utf8'), '', '--no-summary wrote nothing');
    assert.equal(
      JSON.parse(await rf(lockFile, 'utf8')).updatedAt,
      '2026-01-01T00:00:00.000Z',
      '--no-update-lock left the lock alone',
    );

    // And without them, both do happen.
    await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
    await run(['guard', '--tools', 'node', '--lock-file', lockFile]);
    assert.notEqual(await rf(summaryFile, 'utf8'), '', 'the summary is written by default');
    assert.notEqual(
      JSON.parse(await rf(lockFile, 'utf8')).updatedAt,
      '2026-01-01T00:00:00.000Z',
      'the lock is updated by default',
    );
  } finally {
    for (const k of ['ImageVersion', 'ImageOS', 'GITHUB_STEP_SUMMARY']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('guard on a machine with no ImageVersion skips cleanly through main()', async () => {
  const saved = process.env.ImageVersion;
  delete process.env.ImageVersion;
  try {
    const r = await run(['guard', '--tools', 'node']);
    assert.equal(r.code, EXIT_OK);
    assert.match(r.stdout, /not a GitHub-hosted runner/);
  } finally {
    if (saved !== undefined) process.env.ImageVersion = saved;
  }
});
