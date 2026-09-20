/**
 * runner-lock.json — the baseline a later `guard` run diffs against.
 *
 * Shape:
 * {
 *   "schemaVersion": 1,
 *   "label": "ubuntu-22.04",
 *   "imageOS": "ubuntu22",
 *   "imageVersion": "20260720.234.2",
 *   "tools": { "Python": { "versions": ["3.10.12"], "source": "probe" } },
 *   "updatedAt": "2026-08-05T09:41:12.000Z"
 * }
 */

import { readFile, writeFile } from 'node:fs/promises';
import { DriftError } from './http.mjs';

export const SCHEMA_VERSION = 1;
export const DEFAULT_LOCK_FILE = 'runner-lock.json';

export function emptyLock({ label = null, imageOS = null, imageVersion = null } = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    label,
    imageOS,
    imageVersion,
    tools: {},
    updatedAt: null,
  };
}

/** @returns {Promise<object|null>} null when the file does not exist. */
export async function readLock(file = DEFAULT_LOCK_FILE) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new DriftError(`Cannot read lock file ${file}: ${err.message}`, { code: 'LOCK_READ' });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new DriftError(`Lock file ${file} is not valid JSON: ${err.message}`, {
      code: 'LOCK_PARSE',
      hint: `Delete ${file} and re-run to record a fresh baseline.`,
    });
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new DriftError(`Lock file ${file} is not a JSON object.`, { code: 'LOCK_SHAPE' });
  }
  if (json.schemaVersion !== SCHEMA_VERSION) {
    throw new DriftError(
      `Lock file ${file} has schemaVersion ${json.schemaVersion ?? '(missing)'}, expected ${SCHEMA_VERSION}.`,
      { code: 'LOCK_VERSION', hint: `Delete ${file} and re-run to record a fresh baseline.` },
    );
  }
  json.tools ??= {};
  return json;
}

/** The lock file's on-disk shape, built without writing it. */
export function lockPayload(lock) {
  return {
    schemaVersion: SCHEMA_VERSION,
    label: lock.label ?? null,
    imageOS: lock.imageOS ?? null,
    imageVersion: lock.imageVersion ?? null,
    tools: lock.tools ?? {},
    updatedAt: lock.updatedAt ?? new Date().toISOString(),
  };
}

export async function writeLock(lock, file = DEFAULT_LOCK_FILE) {
  const out = lockPayload(lock);
  try {
    await writeFile(file, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  } catch (err) {
    throw new DriftError(`Cannot write lock file ${file}: ${err.message}`, {
      code: 'LOCK_WRITE',
      hint: 'Check the path exists and the process can write to it.',
    });
  }
  return out;
}

/** Build a `tools` map from resolved observations. */
export function toolsEntry(versions, source, extra = {}) {
  return { versions: [...versions], source, ...extra };
}

/** `{Tool: {versions, source}}` -> `{Tool: versions[]}`, keyed without a prototype. */
export function toVersionMap(tools) {
  const out = Object.create(null);
  for (const [k, v] of Object.entries(tools ?? {})) {
    out[k] = Array.isArray(v) ? v : (v?.versions ?? []);
  }
  return out;
}
