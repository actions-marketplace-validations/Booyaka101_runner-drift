/**
 * Action runtimes: which of this repository's `uses:` references stop working
 * when GitHub removes Node 20 from the hosted runners on 2026-09-23.
 *
 * The lane exists because the runtime is not in your workflow. `uses:
 * actions/checkout@v4` says nothing about Node; `runs.using` inside that
 * action's own `action.yml` says `node20`, and that file lives in a repository
 * you do not control. So the reference has to be resolved before it can be
 * classified, and a composite action has to be followed into its own steps —
 * a `node20` step three levels down takes the job with it just as surely as a
 * `node20` action named in the workflow.
 *
 * actionlint answers the same question from a table of "more than 100 popular
 * actions" embedded at build time, which is fast and needs no network but
 * cannot see your own composites, an internal action, or anything outside the
 * table. This resolves the real file at the real ref instead.
 *
 * Two hosts, both already allowed by http.mjs: raw.githubusercontent.com for
 * `action.yml` at a ref, and api.github.com for the latest release of a failing
 * action so the report can name what to move to.
 *
 * Deliberately no YAML dependency — the package has none and keeps none. The
 * two constructs needed here (`runs:` with its `using:`, and `uses:` lines) are
 * unambiguous at line level, the same bet detect.mjs already makes.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fetchJson, fetchText } from './http.mjs';
import { daysUntil } from './dates.mjs';
import { API_BASE, RAW_HOST } from './labels.mjs';
import { extractUses, indentOf, readScalar } from './detect.mjs';

/** GitHub removes Node 20 from the hosted runner images on this date. */
export const NODE20_REMOVAL_DATE = '2026-09-23';

export const NODE20_SOURCE =
  'https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/';

/** Runners already default to Node 24; the removal is what breaks the old ones. */
export const NODE24_DEFAULT_DATE = '2026-06-16';

/** `runs.using` values that stop working on NODE20_REMOVAL_DATE. */
export const FAILING_RUNTIMES = ['node20', 'node16', 'node12'];

/** How far a composite chain is followed before the walk gives up and says so. */
export const MAX_COMPOSITE_DEPTH = 5;

/** The lowest `nodeNN` the runners will still carry after the removal. */
const FIRST_SURVIVING_NODE = 24;

export const REF_STATUS = {
  OK: 'ok',
  FAIL: 'fail',
  UNKNOWN: 'unknown',
  CYCLE: 'cycle',
};

/* ------------------------------------------------------------------ parsing */

// Anchored, and every segment excludes the delimiter that follows it, so there
// is exactly one way to split any input and nothing to backtrack over.
const REMOTE_REF = /^([^/@\s]+)\/([^/@\s]+)((?:\/[^@\s]+)?)@([^\s]+)$/;
const YAML_FILE = /\.ya?ml$/i;
const ACTION_FILE = /^action\.ya?ml$/i;

/** Both spellings are live in the wild, and `.yml` is the common one. */
const ACTION_FILENAMES = ['action.yml', 'action.yaml'];

/**
 * Classify one `uses:` value.
 *
 * @returns {{kind:string, ref:string, owner?:string, repo?:string,
 *            subdir?:string, gitRef?:string, path?:string, reason?:string}}
 *   kind is `remote`, `remote-workflow` (a reusable workflow), `local`,
 *   `local-workflow`, `docker`, or `invalid`.
 */
export function parseRef(ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return { kind: 'invalid', ref: raw, reason: 'empty `uses:` value' };
  if (raw.startsWith('docker://')) {
    return { kind: 'docker', ref: raw, image: raw.slice('docker://'.length) };
  }
  if (raw.includes('${{')) {
    return {
      kind: 'invalid',
      ref: raw,
      reason: 'the reference is a ${{ }} expression, so it is not decidable from the file',
    };
  }
  if (raw === '.' || raw === './' || raw.startsWith('./') || raw.startsWith('../')) {
    const rel = raw === '.' || raw === './' ? '' : raw.replace(/^\.\//, '');
    return { kind: YAML_FILE.test(raw) ? 'local-workflow' : 'local', ref: raw, path: rel };
  }
  const m = raw.match(REMOTE_REF);
  if (!m) {
    return {
      kind: 'invalid',
      ref: raw,
      reason: 'not `owner/repo[/subdir]@ref`, `./path` or `docker://image`',
    };
  }
  const [, owner, repo, subdir, gitRef] = m;
  const sub = subdir.replace(/^\//, '');
  return {
    kind: YAML_FILE.test(sub) ? 'remote-workflow' : 'remote',
    ref: raw,
    owner,
    repo,
    subdir: sub,
    gitRef,
  };
}

/** `actions/checkout@v4` — what the visited set and the fetch cache key on. */
function refKey(parsed) {
  return parsed.kind === 'remote' || parsed.kind === 'remote-workflow'
    ? `${parsed.owner}/${parsed.repo}${parsed.subdir ? `/${parsed.subdir}` : ''}@${parsed.gitRef}`
    : `${parsed.kind}:${parsed.ref}`;
}

/** `actions/checkout` — the slug the report and the release lookup both use. */
function slugOf(parsed) {
  return `${parsed.owner}/${parsed.repo}${parsed.subdir ? `/${parsed.subdir}` : ''}`;
}

function rawUrl(parsed, file = null) {
  const parts = [parsed.owner, parsed.repo, parsed.gitRef];
  if (parsed.subdir) parts.push(parsed.subdir);
  if (file) parts.push(file);
  return `${RAW_HOST}/${parts.join('/')}`;
}

/* ------------------------------------------------------- the `runs:` reader */

/**
 * `runs.using`, and the `uses:` references of a composite's own steps.
 *
 * Targeted rather than parsed: find the `runs:` key, take the lines indented
 * under it, and read `using:` at the block's own key indent so a `using:` in
 * some step's `with:` cannot be mistaken for it.
 *
 * @returns {{using:string|null, steps:object[]}|null} null when there is no `runs:` block
 */
export function readRunsBlock(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let first = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)runs:[ \t]*([^\r\n]*)/);
    if (!m) continue;
    // `runs: something` on one line is not the block this reads.
    if (readScalar(m[2])) continue;
    const baseIndent = m[1].length;
    const block = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') {
        block.push('');
        continue;
      }
      if (indentOf(line) <= baseIndent) break;
      block.push(line);
    }
    const found = { using: usingIn(block), steps: extractUses(block.join('\n')) };
    // An input or output called `runs` has the same line shape as the real key,
    // and it sorts above it in most files, so a candidate with no `using:` does
    // not end the search.
    if (found.using) return found;
    first ??= found;
  }
  return first;
}

function usingIn(block) {
  const first = block.find((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  if (first === undefined) return null;
  const keyIndent = indentOf(first);
  for (const line of block) {
    if (indentOf(line) !== keyIndent) continue;
    const m = line.match(/^[ \t]*using:[ \t]*([^\r\n]*)/);
    if (m) return readScalar(m[1]).toLowerCase() || null;
  }
  return null;
}

/**
 * `node20` -> fail, `node24` -> ok, and the same answer for a runtime neither
 * this release nor GitHub's changelog has heard of yet: anything below Node 24
 * goes when Node 20 does, anything at or above it is what the runners will
 * carry.
 */
export function classifyRuntime(using) {
  if (!using) return null;
  if (using === 'docker') return REF_STATUS.OK;
  const m = using.match(/^node(\d+)$/);
  if (!m) return null;
  return Number(m[1]) >= FIRST_SURVIVING_NODE ? REF_STATUS.OK : REF_STATUS.FAIL;
}

/* ------------------------------------------------------------------ reading */

/** Turn a DriftError (or anything else thrown) into one reportable line. */
function failureReason(err, url) {
  if (err?.code === 'RATE_LIMIT' || err?.code === 'FORBIDDEN') {
    return `${err.message} Set GITHUB_TOKEN to raise the limit.`;
  }
  if (err?.code === 'UNAUTHORIZED') return err.message;
  if (err?.code === 'TIMEOUT' || err?.code === 'NETWORK') return err.message;
  return `could not read ${url} — ${err?.message ?? err}`;
}

/**
 * One network layer for the whole walk: memoised by URL, and never throwing.
 * Every failure comes back as a reason string the report can print verbatim.
 */
function makeReader({ fetchText: ft = fetchText, fetchJson: fj = fetchJson } = {}) {
  const cache = new Map();
  const get = async (url, parse) => {
    if (cache.has(url)) return cache.get(url);
    const pending = (async () => {
      try {
        const r = await parse(url, { allow404: true });
        if (r.ok) return { ok: true, status: r.status, text: r.text, json: r.json };
        return { ok: false, status: r.status, reason: `not found (HTTP 404): ${url}` };
      } catch (err) {
        return { ok: false, status: err?.code ?? 'ERROR', reason: failureReason(err, url) };
      }
    })();
    cache.set(url, pending);
    return pending;
  };
  return {
    text: (url) => get(url, ft),
    json: (url) => get(url, fj),
    get calls() {
      return [...cache.keys()];
    },
  };
}

async function readRemoteAction(parsed, reader) {
  let last = null;
  for (const name of ACTION_FILENAMES) {
    const url = rawUrl(parsed, name);
    const r = await reader.text(url);
    if (r.ok) return { ok: true, text: r.text, source: url };
    last = { ok: false, reason: r.reason, source: url };
    // A rate limit or a network failure is not "try the other spelling".
    if (r.status !== 404) return last;
  }
  return {
    ok: false,
    source: last.source,
    reason: `no action.yml or action.yaml at ${slugOf(parsed)}@${parsed.gitRef} — wrong ref, or a private repository (set GITHUB_TOKEN)`,
  };
}

/**
 * Paths in the report are workspace-relative and POSIX-separated, so the same
 * repo reads the same on a Windows box and on a runner, and so `file=` in an
 * annotation is a path GitHub can resolve. Same base as `annotationPath`, since
 * a `--workflows` handed over as an absolute path must not surface as one.
 */
function displayPath(file, root, env = process.env) {
  const abs = path.resolve(file);
  for (const base of [env.GITHUB_WORKSPACE || process.cwd(), root]) {
    const rel = path.relative(path.resolve(base), abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replaceAll('\\', '/');
  }
  return String(file).replaceAll('\\', '/');
}

async function readLocalAction(relPath, root) {
  const dir = path.resolve(root, relPath);
  for (const name of ACTION_FILENAMES) {
    const file = path.join(dir, name);
    try {
      return { ok: true, text: await readFile(file, 'utf8'), source: displayPath(file, root) };
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
        const shown = displayPath(file, root);
        return { ok: false, source: shown, reason: `${shown} could not be read — ${err.message}` };
      }
    }
  }
  return {
    ok: false,
    source: displayPath(path.join(dir, 'action.yml'), root),
    reason: `no action.yml or action.yaml in ${path.relative(root, dir) || '.'}`,
  };
}

async function readLocalFile(relPath, root) {
  const file = path.resolve(root, relPath);
  try {
    return { ok: true, text: await readFile(file, 'utf8'), source: displayPath(file, root) };
  } catch (err) {
    return {
      ok: false,
      source: displayPath(file, root),
      reason:
        err.code === 'ENOENT'
          ? `${relPath} does not exist in this checkout`
          : `${relPath} could not be read — ${err.message}`,
    };
  }
}

/* ------------------------------------------------------------- the resolver */

/**
 * Resolve one reference to a runtime, following composites and reusable
 * workflows into their own `uses:` lines.
 *
 * `trail` is the chain currently being resolved, which is what makes a cycle
 * terminate; `ctx.done` memoises finished subtrees so a reference used by ten
 * workflows costs one fetch.
 */
async function resolveRef(ref, ctx, depth = 0, trail = new Set()) {
  const parsed = parseRef(ref);
  const key = refKey(parsed);
  const base = { ref, kind: parsed.kind, using: null, source: null, children: [] };

  if (parsed.kind === 'invalid') {
    return { ...base, status: REF_STATUS.UNKNOWN, reason: parsed.reason };
  }
  if (parsed.kind === 'docker') {
    return { ...base, status: REF_STATUS.OK, using: 'docker', source: parsed.ref };
  }
  if (trail.has(key)) {
    return {
      ...base,
      status: REF_STATUS.CYCLE,
      stopped: true,
      reason: `${key} is already being resolved further up this chain — stopped`,
    };
  }
  if (depth > MAX_COMPOSITE_DEPTH) {
    return {
      ...base,
      status: REF_STATUS.UNKNOWN,
      stopped: true,
      reason: `composite nesting goes deeper than ${MAX_COMPOSITE_DEPTH} levels — stopped here`,
    };
  }
  if (ctx.done.has(key)) return { ...ctx.done.get(key), ref };

  const node = await readAndClassify(parsed, key, ctx, depth, new Set([...trail, key]));
  if (!wasStopped(node)) ctx.done.set(key, node);
  return node;
}

/**
 * Both limits depend on where the walk entered: the same action reached from a
 * shallower step has depth left to spend, and is not inside the same cycle. So
 * a subtree that hit either one is answered, reported and then thrown away
 * rather than cached as that action's runtime.
 */
function wasStopped(node) {
  return node.stopped === true || (node.children ?? []).some(wasStopped);
}

async function readAndClassify(parsed, key, ctx, depth, trail) {
  const base = { ref: parsed.ref, kind: parsed.kind, using: null, source: null, children: [] };
  const isWorkflow = parsed.kind === 'remote-workflow' || parsed.kind === 'local-workflow';

  let doc;
  if (parsed.kind === 'remote') doc = await readRemoteAction(parsed, ctx.reader);
  else if (parsed.kind === 'remote-workflow') {
    const url = rawUrl(parsed);
    const r = await ctx.reader.text(url);
    doc = r.ok
      ? { ok: true, text: r.text, source: url }
      : { ok: false, source: url, reason: r.reason };
  } else if (parsed.kind === 'local') doc = await readLocalAction(parsed.path, ctx.root);
  else doc = await readLocalFile(parsed.path, ctx.root);

  if (!doc.ok) {
    return { ...base, status: REF_STATUS.UNKNOWN, source: doc.source, reason: doc.reason };
  }

  // A reusable workflow has no `runs:` of its own; what breaks it is the steps
  // inside it, so it is classified purely by what it calls.
  const runs = isWorkflow ? null : readRunsBlock(doc.text);
  const uses = isWorkflow ? extractUses(doc.text) : (runs?.steps ?? []);
  const using = isWorkflow ? 'reusable-workflow' : (runs?.using ?? null);

  if (!isWorkflow && using === null) {
    return {
      ...base,
      status: REF_STATUS.UNKNOWN,
      source: doc.source,
      reason: runs
        ? `${doc.source} has a \`runs:\` block with no \`using:\``
        : `${doc.source} has no \`runs:\` block — it does not look like an action definition`,
    };
  }

  const direct = isWorkflow ? null : classifyRuntime(using);
  if (direct) {
    return { ...base, status: direct, using, source: doc.source };
  }
  if (!isWorkflow && using !== 'composite') {
    return {
      ...base,
      status: REF_STATUS.UNKNOWN,
      using,
      source: doc.source,
      reason: `\`runs.using: ${using}\` is not a runtime this release knows how to classify`,
    };
  }

  const children = [];
  for (const site of dedupeRefs(uses)) {
    children.push(await resolveRef(site, ctx, depth + 1, trail));
  }
  return {
    ...base,
    status: aggregate(children),
    using,
    source: doc.source,
    children,
  };
}

function dedupeRefs(sites) {
  return [...new Set(sites.map((s) => s.ref))];
}

/**
 * A parent is only as safe as its worst child. A cycle counts against it: the
 * chain was stopped, not resolved, so calling it ok would be a guess.
 */
function aggregate(children) {
  if (children.some((c) => c.status === REF_STATUS.FAIL)) return REF_STATUS.FAIL;
  const stopped = (c) => c.status === REF_STATUS.UNKNOWN || c.status === REF_STATUS.CYCLE;
  if (children.some(stopped)) return REF_STATUS.UNKNOWN;
  return REF_STATUS.OK;
}

/** Depth-first over a resolved node and everything under it. */
export function* walkNodes(node) {
  yield node;
  for (const child of node.children ?? []) yield* walkNodes(child);
}

/* --------------------------------------------------------- upgrade targets */

/** `v7.0.1` -> `v7`. What people actually pin, and what the report suggests. */
function majorTag(tag) {
  const m = String(tag).match(/^(v?)(\d+)\./);
  return m ? `${m[1]}${m[2]}` : String(tag);
}

/**
 * Where a failing action's users should move to: its latest release, resolved
 * so the answer is the runtime that tag really declares rather than a guess
 * that a newer major must be newer inside.
 *
 * The major tag is tried first because that is the ref people pin
 * (`actions/checkout@v7`, not `@v7.0.1`) and because it keeps receiving
 * patches; the exact release tag is the fallback for repositories that publish
 * no moving major.
 */
async function findUpgrade(parsed, reader) {
  const url = `${API_BASE}/repos/${parsed.owner}/${parsed.repo}/releases/latest`;
  const r = await reader.json(url);
  if (!r.ok) {
    // 404 here is an answer, not a failure to look: the repository publishes no
    // releases at all, so there is no tag to move to.
    if (r.status === 404) {
      return {
        available: false,
        checked: true,
        reason: `${parsed.owner}/${parsed.repo} publishes no releases, so there is no tag to move to`,
        url,
      };
    }
    return { available: false, checked: false, reason: r.reason, url };
  }
  const tag = typeof r.json?.tag_name === 'string' ? r.json.tag_name : null;
  if (!tag) {
    return {
      available: false,
      checked: true,
      reason: `${parsed.owner}/${parsed.repo} has no published release`,
      url,
    };
  }
  const candidates = [...new Set([majorTag(tag), tag])];
  let composite = null;
  for (const candidate of candidates) {
    const at = await readRemoteAction({ ...parsed, gitRef: candidate }, reader);
    if (!at.ok) continue;
    const using = readRunsBlock(at.text)?.using ?? null;
    if (classifyRuntime(using) === REF_STATUS.OK) {
      return {
        available: true,
        checked: true,
        ref: `${slugOf(parsed)}@${candidate}`,
        tag: candidate,
        latestRelease: tag,
        using,
        url: at.source,
      };
    }
    // A release that went composite has no runtime of its own, so it is neither
    // a verified target nor evidence that there is nothing to move to.
    if (using === 'composite') composite ??= candidate;
  }
  return {
    available: false,
    checked: true,
    latestRelease: tag,
    reason: composite
      ? `${slugOf(parsed)}@${composite} is composite — its own steps decide, so check that release rather than this row`
      : `no published release declares node${FIRST_SURVIVING_NODE}`,
    url,
  };
}

/* ------------------------------------------------------------ file collection */

const WORKFLOW_EXT = /\.ya?ml$/i;
const MAX_WALK_DEPTH = 10;

async function walkFiles(dir, keep, depth = 0) {
  if (depth > MAX_WALK_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
  const found = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...((await walkFiles(full, keep, depth + 1)) ?? []));
    else if (entry.isFile() && keep(entry.name)) found.push(full);
  }
  return found;
}

/**
 * The files whose `uses:` lines count as this repository's own.
 *
 * Workflows under `.github/workflows`, and the `action.yml` of every composite
 * under `.github/actions` — the second because a local composite's steps are
 * yours to fix and nobody reading only the workflows would see them.
 *
 * @returns {Promise<{files:object[], missing:boolean, workflowPath:string, actionsPath:string}>}
 */
export async function collectSources({ root = '.', workflows = null } = {}) {
  const workflowPath = workflows ?? path.join(root, '.github', 'workflows');
  const actionsPath = path.join(root, '.github', 'actions');
  const files = [];

  let s = null;
  try {
    s = await stat(workflowPath);
  } catch {
    s = null;
  }
  let workflowFiles;
  if (s?.isFile()) {
    workflowFiles = [workflowPath];
  } else {
    workflowFiles = await walkFiles(workflowPath, (n) => WORKFLOW_EXT.test(n));
  }
  for (const file of workflowFiles ?? []) files.push({ file, kind: 'workflow' });

  const actionFiles = await walkFiles(actionsPath, (n) => ACTION_FILE.test(n));
  for (const file of actionFiles ?? []) files.push({ file, kind: 'action' });

  // The action this repository publishes is a step it owns too, which is the
  // same argument that puts `.github/actions` on the list: its `uses:` lines
  // run in everybody else's job, and nobody reading only the workflows sees them.
  const rootAction = await firstFile(ACTION_FILENAMES.map((n) => path.join(root, n)));
  if (rootAction) files.push({ file: rootAction, kind: 'action' });

  return {
    files,
    workflowPath,
    actionsPath,
    workflowsMissing: workflowFiles === null,
    missing: workflowFiles === null && actionFiles === null && !rootAction,
  };
}

/** The first of `paths` that is a readable file, or null. */
async function firstFile(paths) {
  for (const p of paths) {
    try {
      if ((await stat(p)).isFile()) return p;
    } catch {
      // next candidate
    }
  }
  return null;
}

/* ------------------------------------------------------------------- survey */

/**
 * The whole picture for one repository: every `uses:` reference, its runtime,
 * and what breaks on NODE20_REMOVAL_DATE.
 *
 * @param {object} opts
 * @param {string} opts.root repository root; `./` references resolve against it
 * @param {string|null} opts.workflows override for the workflow dir or file
 * @param {Date} opts.now
 * @param {boolean} opts.upgrades look up a replacement for each failing action
 * @returns {Promise<object>} the shape `--json` prints
 */
export async function surveyActions({
  root = '.',
  workflows = null,
  now = new Date(),
  upgrades = true,
  fetchText: ft = fetchText,
  fetchJson: fj = fetchJson,
} = {}) {
  const sources = await collectSources({ root, workflows });
  const reader = makeReader({ fetchText: ft, fetchJson: fj });
  const ctx = { root, reader, done: new Map() };

  const sites = [];
  const readErrors = [];
  for (const { file, kind } of sources.files) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      readErrors.push(`${displayPath(file, root)} could not be read — ${err.message}`);
      continue;
    }
    for (const site of extractUses(text, displayPath(file, root)))
      sites.push({ ...site, sourceKind: kind });
  }

  // One entry per distinct reference, carrying every place it is written.
  const byRef = new Map();
  for (const site of sites) {
    if (!byRef.has(site.ref)) byRef.set(site.ref, []);
    byRef.get(site.ref).push({ file: site.file, line: site.line, col: site.col });
  }

  const references = [];
  for (const [ref, where] of byRef) {
    references.push({ ...(await resolveRef(ref, ctx)), where });
  }

  if (upgrades) await attachUpgrades(references, reader);

  references.sort(byStatusThenRef);

  const days = daysUntil(NODE20_REMOVAL_DATE, now);
  const counts = {
    fail: references.filter((r) => r.status === REF_STATUS.FAIL).length,
    unknown: references.filter((r) => r.status === REF_STATUS.UNKNOWN).length,
    ok: references.filter((r) => r.status === REF_STATUS.OK || r.status === REF_STATUS.CYCLE)
      .length,
  };

  return {
    removalDate: NODE20_REMOVAL_DATE,
    defaultSwitchedAt: NODE24_DEFAULT_DATE,
    source: NODE20_SOURCE,
    checkedAt: now.toISOString(),
    daysLeft: days,
    root,
    workflowPath: displayPath(sources.workflowPath, root),
    actionsPath: displayPath(sources.actionsPath, root),
    files: sources.files.map(({ file, kind }) => ({ file: displayPath(file, root), kind })),
    missing: sources.missing,
    workflowsMissing: sources.workflowsMissing,
    readErrors,
    totalReferences: sites.length,
    uniqueReferences: references.length,
    counts,
    references,
    failing: counts.fail > 0,
  };
}

/**
 * A replacement for every node that is itself on a dead runtime, wherever it
 * sits in the tree. A composite fails because of a step inside it, so the
 * suggestion belongs on that step and not on the composite that pulled it in —
 * and a newer major of the composite cannot be checked the same way anyway,
 * since `using: composite` says nothing about what its steps will resolve to.
 */
async function attachUpgrades(references, reader) {
  const byRef = new Map();
  for (const root of references) {
    for (const node of walkNodes(root)) {
      if (node.kind !== 'remote' || classifyRuntime(node.using) !== REF_STATUS.FAIL) continue;
      const parsed = parseRef(node.ref);
      const key = refKey(parsed);
      if (!byRef.has(key)) byRef.set(key, { parsed, nodes: [] });
      byRef.get(key).nodes.push(node);
    }
  }
  for (const { parsed, nodes } of byRef.values()) {
    const upgrade = await findUpgrade(parsed, reader);
    for (const node of nodes) node.upgrade = upgrade;
  }
}

const STATUS_ORDER = [REF_STATUS.FAIL, REF_STATUS.UNKNOWN, REF_STATUS.OK, REF_STATUS.CYCLE];

function byStatusThenRef(a, b) {
  const rank = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
  return rank || a.ref.localeCompare(b.ref);
}
