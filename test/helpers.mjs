import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest } from '../src/manifest.mjs';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Real manifest snapshots downloaded from actions/runner-images. */
export const SNAPSHOTS = {
  'ubuntu-22.04': 'Ubuntu2204-Readme-20260720.234.2.md',
  'ubuntu-22.04@old': 'Ubuntu2204-Readme-20260623.199.1.md',
  'ubuntu-24.04': 'Ubuntu2404-Readme-20260720.247.2.md',
  'ubuntu-24.04@2026-09': 'Ubuntu2404-Readme-20260907.300.1.md',
  'ubuntu-26.04': 'Ubuntu2604-Readme-20260907.131.1.md',
  'macos-15': 'macos-15-Readme-20260720.0353.1.md',
};

export async function readFixture(key) {
  const name = SNAPSHOTS[key] ?? key;
  return readFile(path.join(FIXTURES, name), 'utf8');
}

export async function loadFixtureManifest(label, key = label) {
  if (!SNAPSHOTS[key]) {
    return { skipped: true, label, reason: `no fixture for ${label}` };
  }
  const text = await readFixture(key);
  return { ...parseManifest(text, label), skipped: false, url: `fixture:${key}`, ref: 'fixture' };
}

/**
 * A `loadManifest` stand-in that pins a label to one dated snapshot, so a test
 * can diff two images that really did exist at the same moment.
 */
export const fixtureLoader =
  (aliases = {}) =>
  (label) =>
    loadFixtureManifest(label, aliases[label] ?? label);

const RUNNER_FIXTURES = path.join(FIXTURES, 'runners');

/** Recorded live responses from the runner-deprecations endpoint. */
export async function readRunnerFixtures() {
  const [recorded, fleets, releases] = await Promise.all(
    ['deprecations-recorded.json', 'fleets.json', 'runner-releases-recorded.json'].map(async (f) =>
      JSON.parse(await readFile(path.join(RUNNER_FIXTURES, f), 'utf8')),
    ),
  );
  return { recorded, fleets, releases };
}

/**
 * Stub `globalThis.fetch` from a url -> {status, body} table, so runners.mjs is
 * exercised through the real http.mjs (rate-limit, 403 and 404 handling
 * included) rather than around it.
 *
 * @param {(url:string) => {status:number, body:unknown, headers?:object}|null} route
 * @returns {{restore:() => void, calls:string[]}}
 */
export function stubApi(route) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const hit = route(u);
    if (!hit) throw new TypeError(`fetch failed (no stub route for ${u})`);
    const headers = { 'x-ratelimit-remaining': '4999', ...(hit.headers ?? {}) };
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      text: async () => (typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body)),
    };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = real;
    },
  };
}

/**
 * The routing table the runner tests share: a fleet listing for `scopePath`,
 * the recorded deprecations responses, and actions/runner's release list.
 */
export function runnerRoutes({ scopePath, fleet, recorded, releases, listing = null }) {
  return (url) => {
    if (url.startsWith(`https://api.github.com${scopePath}/actions/runners/deprecations/`)) {
      const version = decodeURIComponent(url.split('/deprecations/')[1]);
      const hit = recorded.responses[version];
      return hit ?? { status: 404, body: { message: 'Not Found', status: '404' } };
    }
    if (url.startsWith(`https://api.github.com${scopePath}/actions/runners?`)) {
      return listing ?? { status: 200, body: fleet };
    }
    if (url.startsWith('https://api.github.com/repos/actions/runner/releases')) {
      return { status: 200, body: releases.releases };
    }
    return null;
  };
}

/**
 * The `--json` document a run printed, past the annotation lines above it.
 * Found by the line the document opens on: an annotation can contain a brace of
 * its own, and the rate-limit hint spells out `${{ github.token }}`.
 */
export function jsonOf(stdout) {
  const at = stdout.search(/^\{$/m);
  if (at < 0) throw new Error(`no JSON document in:
${stdout}`);
  return JSON.parse(stdout.slice(at));
}

/** Capture stdout/stderr from a command function. */
export function captureIO() {
  const outChunks = [];
  const errChunks = [];
  return {
    io: {
      stdout: { write: (s) => outChunks.push(s) },
      stderr: { write: (s) => errChunks.push(s) },
    },
    get stdout() {
      return outChunks.join('');
    },
    get stderr() {
      return errChunks.join('');
    },
  };
}

/* ------------------------------------------------- action-runtime fixtures */

export const ACTIONS_REPO = path.join(FIXTURES, 'actions-repo');

const RAW = 'https://raw.githubusercontent.com';
const API = 'https://api.github.com';

/** The SHA `ci.yml` pins, written there with a `# v1.2.3` comment after it. */
export const PINNED_SHA = '8f4b7f8452b1a2ee3bd35a08f1a1a62c76c8a2fa';

const nodeAction = (using) =>
  `name: fixture\ndescription: a fixture action\nruns:\n  using: ${using}\n  main: dist/index.js\n`;

const compositeAction = (...refs) =>
  `name: fixture\ndescription: a fixture composite\nruns:\n  using: composite\n  steps:\n` +
  refs.map((r) => `    - uses: ${r}\n`).join('') +
  `    - shell: bash\n      run: echo done\n`;

const reusableWorkflow = (...refs) =>
  `name: release\non:\n  workflow_call:\njobs:\n  publish:\n    runs-on: ubuntu-24.04\n    steps:\n` +
  refs.map((r) => `      - uses: ${r}\n`).join('');

/**
 * Every remote file the fixture repository reaches for. Anything absent 404s,
 * which is how `acme/private@v1` and the `action.yml`-before-`action.yaml`
 * fallback are exercised.
 */
export const ACTION_FILES = {
  [`${RAW}/actions/checkout/v4/action.yml`]: nodeAction('node20'),
  [`${RAW}/actions/checkout/v7/action.yml`]: nodeAction('node24'),
  [`${RAW}/actions/upload-artifact/v4/action.yml`]: nodeAction('node20'),
  [`${RAW}/actions/upload-artifact/v7/action.yml`]: nodeAction('node24'),
  [`${RAW}/actions/setup-node/v5/action.yml`]: nodeAction('node24'),
  // Subdir action, and the `.yaml` spelling: the `.yml` URL is not in the table.
  [`${RAW}/acme/tools/v2/setup/action.yaml`]: nodeAction('node24'),
  [`${RAW}/acme/outer/v1/action.yml`]: compositeAction('acme/inner@v2'),
  [`${RAW}/acme/inner/v2/action.yml`]: compositeAction('acme/leaf@v3'),
  [`${RAW}/acme/leaf/v3/action.yml`]: nodeAction('node20'),
  [`${RAW}/acme/leaf/v3.1.0/action.yml`]: nodeAction('node20'),
  [`${RAW}/acme/loop/v1/action.yml`]: compositeAction('acme/loop2@v1'),
  [`${RAW}/acme/loop2/v1/action.yml`]: compositeAction('acme/loop@v1'),
  [`${RAW}/acme/pinned/${PINNED_SHA}/action.yml`]: nodeAction('node24'),
  [`${RAW}/acme/flows/v3/.github/workflows/release.yml`]: reusableWorkflow('actions/setup-node@v5'),
};

/** `releases/latest` for the actions the fixture repository has to upgrade. */
export const ACTION_RELEASES = {
  'actions/checkout': { tag_name: 'v7.0.1' },
  'actions/upload-artifact': { tag_name: 'v7.0.0' },
  // Has releases, but none of them declares node24.
  'acme/leaf': { tag_name: 'v3.1.0' },
};

/**
 * Routing table for the action-runtime lane, so the walk runs through the real
 * http.mjs offline. `overrides` replaces or removes single entries: pass
 * `{ [url]: { status: 403, ... } }` for a rate limit, or `null` to make one
 * file disappear.
 */
export function actionRoutes({ files = {}, releases = {}, fallback = null } = {}) {
  const table = { ...ACTION_FILES, ...files };
  const tags = { ...ACTION_RELEASES, ...releases };
  return (url) => {
    if (Object.hasOwn(table, url)) {
      const hit = table[url];
      if (hit === null) return { status: 404, body: 'Not Found' };
      return typeof hit === 'string' ? { status: 200, body: hit } : hit;
    }
    // Compared as an origin, not as a prefix: api.github.com.example.test
    // starts with the same characters and is a different host.
    const { origin, pathname } = new URL(url);
    const api = origin === API;
    if (api && pathname.startsWith('/repos/') && pathname.endsWith('/releases/latest')) {
      const slug = pathname.slice('/repos/'.length, -'/releases/latest'.length);
      const hit = Object.hasOwn(tags, slug) ? tags[slug] : null;
      if (hit === null) return { status: 404, body: { message: 'Not Found' } };
      return hit.status ? hit : { status: 200, body: hit };
    }
    if (api || origin === RAW) {
      return fallback ?? { status: 404, body: 'Not Found' };
    }
    return null;
  };
}
