/**
 * Version diffing and change classification.
 *
 * Single-version tools classify as major/minor/patch. Multi-version tools
 * (Clang: 13.0.1, 14.0.0, 15.0.7) are set-diffed, because "Clang went from
 * three versions to three different versions" is the change a maintainer needs
 * to see — a naive first-element compare hides two thirds of it.
 */

export const SEVERITY_ORDER = ['none', 'patch', 'minor', 'major'];

export function parseVersion(v) {
  const m = String(v ?? '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/**
 * Compare two dot-separated numeric tuples: `20260720.234.2` runner-image
 * versions and `2.335.1` runner agent versions alike. A missing field sorts
 * low, so `2.9` comes before `2.9.1`.
 */
export function compareDottedNumbers(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : -1;
    const y = Number.isFinite(pb[i]) ? pb[i] : -1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return String(a).localeCompare(String(b));
}

/** major | minor | patch | none, for two single versions. */
export function severityBetween(from, to) {
  if (from === to) return 'none';
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return 'major';
  if (a[0] !== b[0]) return 'major';
  if (a[1] !== b[1]) return 'minor';
  if (a[2] !== b[2]) return 'patch';
  return 'patch'; // differs only in a suffix such as `3.0.2p107`
}

function maxVersion(list) {
  return [...list].sort(compareVersions).at(-1) ?? null;
}

function setDiff(from, to) {
  const fromSet = new Set(from);
  const toSet = new Set(to);
  return {
    removed: from.filter((v) => !toSet.has(v)),
    added: to.filter((v) => !fromSet.has(v)),
  };
}

export function severityAtLeast(sev, floor) {
  return SEVERITY_ORDER.indexOf(sev) >= SEVERITY_ORDER.indexOf(floor);
}

/**
 * Diff one tool between two version lists.
 * @param {string} tool
 * @param {string[]|null} from  null/[] when the tool is absent on the source image
 * @param {string[]|null} to    null/[] when the tool is absent on the target image
 * @returns {{tool, from, to, kind, severity, added, removed, detail, changed}}
 */
export function diffTool(tool, from, to) {
  const a = (from ?? []).filter(Boolean);
  const b = (to ?? []).filter(Boolean);

  if (!a.length && !b.length) {
    return mk(tool, a, b, 'missing', 'none', [], [], 'not present on either image', false);
  }
  if (!a.length) {
    return mk(tool, a, b, 'added', 'major', b, [], `ADDED: ${b.join(', ')}`, true);
  }
  if (!b.length) {
    return mk(tool, a, b, 'removed', 'major', [], a, `REMOVED: ${a.join(', ')}`, true);
  }

  const multi = a.length > 1 || b.length > 1;
  const { added, removed } = setDiff(a, b);

  if (!added.length && !removed.length) {
    return mk(tool, a, b, 'unchanged', 'none', [], [], 'unchanged', false);
  }

  const severity = severityBetween(maxVersion(a), maxVersion(b));
  if (multi) {
    const parts = [];
    if (removed.length) parts.push(`REMOVED: ${removed.join(', ')}`);
    if (added.length) parts.push(`ADDED: ${added.join(', ')}`);
    return mk(tool, a, b, 'changed', severity === 'none' ? 'patch' : severity, added, removed, parts.join(' / '), true);
  }

  return mk(tool, a, b, 'changed', severity, added, removed, severity.toUpperCase(), true);
}

function mk(tool, from, to, kind, severity, added, removed, detail, changed) {
  return { tool, from, to, kind, severity, added, removed, detail, changed };
}

/**
 * Diff a set of tools between two `{name: versions[]}` maps.
 * `tools` is the list of canonical tool names to consider; resolution of a
 * canonical name to the manifest's own key is done by the caller.
 */
export function diffToolMaps(tools, fromMap, toMap) {
  return tools.map((t) => diffTool(t, fromMap[t] ?? null, toMap[t] ?? null));
}

/** Highest severity across a list of diffs. */
export function maxSeverity(diffs) {
  let best = 'none';
  for (const d of diffs) {
    if (!d.changed) continue;
    if (SEVERITY_ORDER.indexOf(d.severity) > SEVERITY_ORDER.indexOf(best)) best = d.severity;
  }
  return best;
}

/**
 * Should we exit non-zero?
 * @param {string} failOn  'none' | 'major' | 'minor' | 'any'
 */
export function shouldFail(diffs, failOn) {
  const changed = diffs.filter((d) => d.changed);
  if (!changed.length) return false;
  switch (failOn) {
    case 'any':
      return true;
    case 'minor':
      return changed.some((d) => severityAtLeast(d.severity, 'minor'));
    case 'major':
      return changed.some((d) => severityAtLeast(d.severity, 'major'));
    default:
      return false;
  }
}
