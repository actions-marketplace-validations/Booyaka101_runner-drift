import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { readLock, writeLock, emptyLock, toVersionMap, SCHEMA_VERSION } from '../src/lock.mjs';
import { DriftError } from '../src/http.mjs';

async function tmp() {
  return mkdtemp(path.join(os.tmpdir(), 'runner-drift-lock-'));
}

test('lock round-trips exactly', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'runner-lock.json');
  try {
    const input = {
      label: 'ubuntu-22.04',
      imageOS: 'ubuntu22',
      imageVersion: '20260720.234.2',
      tools: {
        Python: { versions: ['3.10.12'], source: 'probe', command: 'python3 --version' },
        Clang: { versions: ['13.0.1', '14.0.0', '15.0.7'], source: 'manifest' },
      },
      updatedAt: '2026-08-05T09:00:00.000Z',
    };
    const written = await writeLock(input, file);
    const read = await readLock(file);
    assert.deepEqual(read, written);
    assert.deepEqual(read, { schemaVersion: SCHEMA_VERSION, ...input });

    // and it is pretty-printed JSON with a trailing newline
    const raw = await readFile(file, 'utf8');
    assert.ok(raw.endsWith('}\n'));
    assert.ok(raw.includes('\n  "label": "ubuntu-22.04",'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing lock file reads as null, not an error', async () => {
  const dir = await tmp();
  try {
    assert.equal(await readLock(path.join(dir, 'nope.json')), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt lock file gives an actionable message', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'runner-lock.json');
  try {
    await writeFile(file, '{ not json', 'utf8');
    await assert.rejects(() => readLock(file), (err) => {
      assert.ok(err instanceof DriftError);
      assert.equal(err.code, 'LOCK_PARSE');
      assert.match(err.hint, /Delete .* and re-run/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a future schemaVersion is refused rather than misread', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'runner-lock.json');
  try {
    await writeFile(file, JSON.stringify({ schemaVersion: 99, tools: {} }), 'utf8');
    await assert.rejects(() => readLock(file), (err) => err.code === 'LOCK_VERSION');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writing to an unwritable path gives an actionable message', async () => {
  await assert.rejects(
    () => writeLock(emptyLock(), path.join(os.tmpdir(), 'runner-drift-no-such-dir', 'x', 'lock.json')),
    (err) => {
      assert.equal(err.code, 'LOCK_WRITE');
      return true;
    },
  );
});

test('toVersionMap accepts both entry shapes, and answers only for its own keys', () => {
  const map = toVersionMap({ A: { versions: ['1.0.0'], source: 'probe' }, B: ['2.0.0'] });
  assert.deepEqual({ ...map }, { A: ['1.0.0'], B: ['2.0.0'] });
  assert.equal(Object.getPrototypeOf(map), null, 'a tool named `constructor` is data, not a function');
  assert.equal('constructor' in map, false);
  assert.deepEqual({ ...toVersionMap(undefined) }, {});
});
