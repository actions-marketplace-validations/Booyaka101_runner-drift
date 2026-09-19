/**
 * ImageVersion -> commit SHA index, built from the runner-images commit log.
 *
 * The readme for each image is committed once per image rollout with a message
 * like "Updating readme file for ubuntu22 version 20260720.234.2 (#14428)", so
 * the commit list for that one path *is* the image-version history — and the
 * blob at that SHA is the exact manifest that shipped with the image.
 */

import { fetchJson, fetchText, DriftError } from './http.mjs';
import { compareDottedNumbers as compareImageVersions } from './diff.mjs';
import { API_BASE, RAW_BASE, RUNNER_IMAGES_REPO, pathForLabel } from './labels.mjs';
import { parseManifest } from './manifest.mjs';

const VERSION_RE = /version\s+(\d{8}\.[\d.]+)/i;

export function imageVersionFromMessage(message) {
  const m = String(message ?? '').match(VERSION_RE);
  return m ? m[1] : null;
}

/** Numeric tuple compare for `20260720.234.2` style image versions. */
export { compareImageVersions };

/**
 * @returns {Promise<Array<{sha,date,message,url,imageVersion}>>} newest first
 */
export async function listManifestCommits(label, { perPage = 100 } = {}) {
  const path = pathForLabel(label);
  if (!path) {
    throw new DriftError(`Unknown runner label "${label}" — cannot look up its commit history.`, {
      code: 'UNKNOWN_LABEL',
    });
  }
  const url = `${API_BASE}/repos/${RUNNER_IMAGES_REPO}/commits?path=${encodeURIComponent(path)}&per_page=${perPage}`;
  const { json } = await fetchJson(url);
  if (!Array.isArray(json)) {
    throw new DriftError(`Unexpected commit-list payload from ${url}`, { code: 'BAD_PAYLOAD' });
  }
  return json.map((c) => ({
    sha: c.sha,
    date: c.commit?.author?.date ?? c.commit?.committer?.date ?? null,
    message: (c.commit?.message ?? '').split('\n')[0],
    url: c.html_url ?? `https://github.com/${RUNNER_IMAGES_REPO}/commit/${c.sha}`,
    imageVersion: imageVersionFromMessage(c.commit?.message),
  }));
}

/**
 * Locate the commit that shipped a given image version.
 * Falls back to the nearest EARLIER commit when the readme lags the rollout,
 * flagging the result `approximate`.
 *
 * @returns {{commit, approximate:boolean, reason:string}|null}
 */
export function findCommitForImageVersion(commits, imageVersion) {
  if (!imageVersion) return null;
  const versioned = commits.filter((c) => c.imageVersion);
  const exact = versioned.find((c) => c.imageVersion === imageVersion);
  if (exact) return { commit: exact, approximate: false, reason: 'exact image-version match' };

  const sorted = [...versioned].sort((a, b) => compareImageVersions(b.imageVersion, a.imageVersion));
  const earlier = sorted.find((c) => compareImageVersions(c.imageVersion, imageVersion) < 0);
  if (earlier) {
    return {
      commit: earlier,
      approximate: true,
      reason: `no commit for ${imageVersion} yet (readme lags rollout); using nearest earlier ${earlier.imageVersion}`,
    };
  }
  return null;
}

/** Fetch + parse the manifest blob at a specific SHA. */
export async function manifestAtSha(label, sha) {
  const path = pathForLabel(label);
  if (!path) {
    throw new DriftError(`Unknown runner label "${label}".`, { code: 'UNKNOWN_LABEL' });
  }
  const url = `${RAW_BASE}/${sha}/${path}`;
  const res = await fetchText(url, { allow404: true });
  if (!res.ok) return null;
  return { ...parseManifest(res.text, label), url, ref: sha };
}

/**
 * Attribute an image version to its runner-images commit.
 * @returns {Promise<{commit,approximate,reason}|null>}
 */
export async function attribute(label, imageVersion, { perPage = 100, commits = null } = {}) {
  const list = commits ?? (await listManifestCommits(label, { perPage }));
  return findCommitForImageVersion(list, imageVersion);
}

/** The rollout commits strictly after `fromVersion` and up to `toVersion`, oldest first. */
export function commitWindow(commits, fromVersion, toVersion) {
  const versioned = commits.filter((c) => c.imageVersion);
  const inRange = versioned.filter(
    (c) =>
      compareImageVersions(c.imageVersion, fromVersion) > 0 &&
      compareImageVersions(c.imageVersion, toVersion) <= 0,
  );
  return inRange.sort((a, b) => compareImageVersions(a.imageVersion, b.imageVersion));
}

/**
 * Pin each changed tool to the earliest rollout commit in the window whose
 * manifest already carries the new version. With a single-commit window (the
 * common case) no extra network calls are made.
 *
 * @param {string} label
 * @param {Array} diffs           output of diffTool()
 * @param {Array} window          commitWindow() result, oldest first
 * @param {object} opts
 * @returns {Promise<Record<string, {sha,url,imageVersion,date,exact:boolean}>>}
 */
export async function attributeChanges(label, diffs, window, { maxFetch = 8, candidates = null } = {}) {
  const changed = diffs.filter((d) => d.changed);
  const out = {};
  if (!window.length || !changed.length) return out;

  const newest = window.at(-1);
  const stamp = (c, exact) => ({
    sha: c.sha,
    url: c.url,
    imageVersion: c.imageVersion,
    date: c.date,
    exact,
  });

  if (window.length === 1) {
    for (const d of changed) out[d.tool] = stamp(newest, true);
    return out;
  }

  const pending = new Set(changed.map((d) => d.tool));
  const byTool = new Map(changed.map((d) => [d.tool, d]));
  for (const commit of window.slice(0, maxFetch)) {
    if (!pending.size) break;
    let snap = null;
    try {
      snap = await manifestAtSha(label, commit.sha);
    } catch {
      snap = null;
    }
    if (!snap) continue;
    for (const tool of [...pending]) {
      const d = byTool.get(tool);
      const versions = resolveVersions(snap, tool, candidates);
      if (versions && sameSet(versions, d.to)) {
        out[tool] = stamp(commit, true);
        pending.delete(tool);
      }
    }
  }
  for (const tool of pending) out[tool] = stamp(newest, false);
  return out;
}

function sameSet(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const s = new Set(b);
  return a.every((x) => s.has(x));
}

function resolveVersions(manifest, tool, candidates) {
  const names = candidates?.[tool] ?? [tool];
  const index = new Map(Object.keys(manifest.tools ?? {}).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const hit = index.get(String(n).toLowerCase());
    if (hit) return manifest.tools[hit];
  }
  return null;
}
