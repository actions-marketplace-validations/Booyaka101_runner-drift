/**
 * Workflow scanning: .github/workflows/*.y[a]ml -> { labels[], tools[] }.
 *
 * Deliberately a targeted line scanner rather than a full YAML parse — this
 * package has zero runtime dependencies, and the two constructs it needs
 * (`runs-on:` values and `run:` block scalars) are unambiguous at line level.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { COMMAND_ALIASES, SETUP_ACTION_ALIASES, canonicalTool } from './tools.mjs';
import { isFloating, normaliseLabel } from './labels.mjs';
import { lookup } from './tables.mjs';

const WORKFLOW_EXT = /\.ya?ml$/i;
const LABEL_SHAPE = /^(ubuntu|windows|macos)-[a-z0-9.-]+$/i;

export const SELF_HOSTED = 'self-hosted';

const USES_KEY = 'uses:';

export function indentOf(line) {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

/**
 * A YAML scalar as written on a line: `'node20'  # comment` -> `node20`.
 *
 * YAML only starts a comment where the `#` follows whitespace, so `a@b#c` is a
 * ref and not a truncated one. Written without a regex because the shape that
 * fits — `(.*)` before an anchor — is the quadratic one (LESSONS 2026-09-09).
 */
export function readScalar(raw) {
  let value = String(raw ?? '');
  const comment = value.search(/[ \t]#/);
  if (comment !== -1) value = value.slice(0, comment);
  value = value.trim();
  if (value.startsWith('#')) return '';
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/**
 * Every `run:` step in a document: the script text, and the 0-indexed lines the
 * steps occupy, block scalar bodies included.
 *
 * Two consumers, one walk. `extractRunScripts` wants the scripts;
 * `extractUses` wants the line set, because a `uses:` written inside a heredoc,
 * or anywhere else in a shell command, is text and not a reference to anything.
 *
 * Same linear-time shape as scanRunsOn below, for the same reason. CodeQL did
 * not flag this one, but it was the identical `\s*(.*)$` pattern.
 */
function scanRunSteps(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const scripts = [];
  const body = new Set();
  for (let i = 0; i < lines.length; i++) {
    // The dash has to be inside the optional group, not beside it. `[ \t]*-?[ \t]*`
    // is two runs over the same class with nothing mandatory between them, so on
    // a long indent that never reaches `run:` the engine tries every way to split
    // the spaces. Requiring the `-` inside the group removes the ambiguity.
    const m = lines[i].match(/^[ \t]*(?:-[ \t]*)?run:[ \t]*([^\r\n]*)/);
    if (!m) continue;
    body.add(i);
    const baseIndent = indentOf(lines[i]);
    const inline = m[1].trim();
    if (inline && !/^[|>][-+0-9]*$/.test(inline)) {
      scripts.push(inline.replace(/^['"]|['"]$/g, ''));
      continue;
    }
    const block = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') {
        block.push('');
        continue;
      }
      if (indentOf(l) <= baseIndent) break;
      block.push(l.trim());
      body.add(j);
      i = j;
    }
    if (block.length) scripts.push(block.join('\n'));
  }
  return { lines, scripts, body };
}

/** Collect the raw text of every `run:` step in a workflow document. */
export function extractRunScripts(text) {
  return scanRunSteps(text).scripts;
}

/** Pull invoked command names out of a shell script body. */
export function commandsInScript(script) {
  const found = new Set();
  const statements = String(script ?? '')
    .split(/\r?\n|&&|\|\||[;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    let s = stmt.replace(/^[-@(]+\s*/, '');
    // Drop leading env assignments and privilege wrappers.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const next = s.replace(/^(?:sudo(?:\s+-[^\s]+)*|env|time|xargs|[A-Za-z_][A-Za-z0-9_]*=\S*)\s+/, '');
      if (next === s) break;
      s = next;
    }
    const token = s.split(/\s+/)[0];
    if (!token) continue;
    const base = token.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '');
    if (lookup(COMMAND_ALIASES, base.toLowerCase())) found.add(base.toLowerCase());
  }
  return [...found];
}

/**
 * Drop a YAML inline comment: a `#` at the start of the line or after a space.
 *
 * Found by searching rather than matching to the end of the line, for the same
 * reason `readScalar` does: `[^\r\n]*$` before an anchor is the quadratic shape,
 * and a line holding a stray CR makes every `#` rescan to it (LESSONS
 * 2026-09-09).
 */
function stripComment(text) {
  if (text.startsWith('#')) return '';
  const at = text.search(/[ \t]#/);
  return at === -1 ? text : text.slice(0, at + 1);
}

/** 1-indexed column of the label inside a raw scalar that may be padded or quoted. */
function labelColumn(start, raw) {
  const lead = raw.length - raw.trimStart().length;
  return start + lead + (/^['"]/.test(raw.trim()) ? 1 : 0) + 1;
}

/**
 * One `runs-on:`-shaped value, from the line its key is on: a scalar, a flow
 * sequence, or a block list below. Returns the last line index it consumed.
 *
 * `runs-on:` also takes a mapping of `group:` and `labels:`, and the labels
 * under it are written in those same three shapes, so that branch calls back in
 * here rather than repeating them. A group names a pool, not a label, and is
 * the one key whose value must never be read as one.
 */
function readTarget(lines, i, baseIndent, rawValue, push) {
  const raw = stripComment(rawValue);
  const value = raw.trim();
  const valueStart = lines[i].length - rawValue.length;
  let expression = false;

  if (value.includes('${{')) return { end: i, expression: true };

  if (value.startsWith('[')) {
    let offset = valueStart + lines[i].slice(valueStart).indexOf('[') + 1;
    for (const part of value.replace(/^\[|\]$/g, '').split(',')) {
      if (part.includes('${{')) expression = true;
      else push(part, i + 1, labelColumn(offset, part));
      offset += part.length + 1;
    }
    return { end: i, expression };
  }

  if (value) {
    push(value, i + 1, labelColumn(valueStart, raw));
    return { end: i, expression };
  }

  let end = i;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === '') continue;
    if (indentOf(l) <= baseIndent) break;
    const mapping = l.match(/^([ \t]*)(group|labels):[ \t]*([^\r\n]*)/);
    if (mapping) {
      if (mapping[2] === 'labels') {
        const inner = readTarget(lines, j, mapping[1].length, mapping[3], push);
        expression = expression || inner.expression;
        j = inner.end;
      }
      end = j;
      continue;
    }
    const dash = l.match(/^([ \t]*-[ \t]*)([^\r\n]*)/);
    const item = stripComment(dash ? dash[2] : l.trim()).trim();
    if (item.includes('${{')) expression = true;
    else push(item, j + 1, labelColumn(dash ? dash[1].length : indentOf(l), item));
    end = j;
  }
  return { end, expression };
}

/**
 * Every `runs-on:` value in a document, positioned. `expression` reports
 * whether any value was a `${{ … }}` reference, which is what makes the
 * matrix fallback below kick in.
 *
 * Two shapes are load-bearing for linear time, and both were quadratic
 * before 1.2.0 (CodeQL js/polynomial-redos). Indentation is `[ \t]`, not `\s`,
 * and the value is `([^\r\n]*)` with no `$`. The pair matters: `\s*(.*)$` lets
 * both quantifiers match a space, and `$` can fail because `.` excludes line
 * terminators, so one stray carriage return on a long line makes the engine try
 * every split of the whitespace between them. Without a `$` there is nothing to
 * fail, so nothing to backtrack. For a line with no terminator in it — which is
 * every line, since the caller split on newlines — both captures are unchanged.
 */
function scanRunsOn(lines) {
  const found = [];
  // `found` is flat, one entry per label, because the retirement lane annotates
  // each pinned label where it sits. `targets` keeps the labels of one `runs-on:`
  // together, which is what decides whether a given runner can take the job:
  // GitHub only schedules onto a runner carrying every label in the set.
  const targets = [];
  let target = null;
  let expression = false;
  const push = (raw, line, col) => {
    const label = normaliseLabel(raw);
    if (!label) return;
    found.push({ label, line, col });
    target?.labels.push(label);
  };

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)runs-on:[ \t]*([^\r\n]*)/);
    if (!m) continue;

    // Anchored on the `runs-on:` line itself: the set is the target, so pointing
    // at one item of a block list would be arbitrary.
    target = {
      labels: [],
      expression: false,
      line: i + 1,
      col: lines[i].length - m[2].length + 1,
    };
    targets.push(target);

    const read = readTarget(lines, i, m[1].length, m[2], push);
    if (read.expression) expression = target.expression = true;
    i = read.end;
  }
  return { found, targets, expression };
}

/**
 * An expression `runs-on:` -> the label-shaped scalars elsewhere in the file.
 *
 * Which one a given runner serves is not decidable from the file, so this is
 * deliberately broad: `${{ matrix.os }}`, `${{ inputs.runner }}` and
 * `${{ env.RUNNER }}` all resolve to values written somewhere above.
 *
 * Broad, but not everything. Comments, block scalars and the keys that hold
 * prose or shell rather than a value (`run:`, `name:`, `run-name:`, `if:`,
 * `description:`) are skipped: a label named there is not a runner the workflow
 * asks for, and an annotation has to land on a line someone can act on.
 */
const PROSE_KEYS = new Set(['run', 'name', 'run-name', 'if', 'description']);

/**
 * Whether the lines under an empty prose key are its body rather than a map.
 * `inputs.name.default` is a value a `runs-on:` expression can resolve to; the
 * indented text under a step's `name:` is the title continued.
 */
function foldsOver(lines, i, indent) {
  for (let j = i + 1; j < lines.length; j++) {
    const text = stripComment(lines[j]);
    if (!text.trim()) continue;
    if (indentOf(text) <= indent) return false;
    return !/^[ \t]*(-[ \t]+)?[^:\s][^:\r\n]*:([ \t]|$)/.test(text);
  }
  return false;
}

function matrixLabels(lines) {
  const found = [];
  let scalar = null;
  let matrixAt = null;
  let strategyAt = null;
  for (let i = 0; i < lines.length; i++) {
    const text = stripComment(lines[i]);
    if (scalar !== null) {
      if (!text.trim() || indentOf(text) > scalar) continue;
      scalar = null;
    }
    // The key cannot start with a space: nothing mandatory separates it from the
    // indent, and both matching whitespace is how a line of spaces with no colon
    // went quadratic in 1.2.0.
    const key = text.match(/^([ \t]*)(-[ \t]+)?([^:\s][^:\r\n]*)?:([^\r\n]*)$/);
    if (key) {
      // `run: |` and friends: the body below is shell or prose, not YAML values.
      // A prose key owns its indented lines the same way whether or not it was
      // written with a block marker, since a plain scalar folds over them too.
      // A dashed key owns the column the dash sits in, so the step's own
      // siblings (`env:`, `with:`) are not read as part of the script.
      const value = key[4].trim();
      const owns = key[1].length + (key[2]?.length ?? 0);
      const name = (key[3] ?? '').trim().toLowerCase();
      // Under `matrix:` every key is a dimension the job varies over, so a
      // `matrix.name` of image labels is values, not a step title.
      if (matrixAt !== null && key[1].length <= matrixAt) matrixAt = null;
      if (strategyAt !== null && key[1].length <= strategyAt) strategyAt = null;
      const prose = matrixAt === null && PROSE_KEYS.has(name);
      // Only `strategy.matrix` is one. A job may be called `matrix`, and its
      // steps still have titles.
      if (name === 'matrix' && strategyAt !== null && key[1].length > strategyAt) {
        matrixAt = key[1].length;
      }
      if (name === 'strategy') strategyAt = key[1].length;
      if (/^[|>]/.test(value) || (prose && (value || foldsOver(lines, i, owns)))) {
        scalar = owns;
        continue;
      }
    }
    for (const tok of text.matchAll(/[A-Za-z][A-Za-z0-9.-]*/g)) {
      if (LABEL_SHAPE.test(tok[0])) {
        found.push({ label: tok[0].toLowerCase(), line: i + 1, col: tok.index + 1 });
      }
    }
  }
  return found;
}

/**
 * One pass over a document for everything the label scanners want: the
 * positioned `runs-on:` values, the sets they came in, the matrix fallback and
 * the job id per line. The last two are lazy because only some callers want
 * them, and `analyseWorkflow` hands one walk to all four rather than repeating
 * it per extractor.
 */
function walkLabels(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const scan = scanRunsOn(lines);
  let matrix = null;
  let jobs = null;
  return {
    ...scan,
    lines,
    get matrix() {
      return (matrix ??= scan.expression ? matrixLabels(lines) : []);
    },
    get jobs() {
      return (jobs ??= jobKeys(lines));
    },
  };
}

/** Pull `runs-on:` labels (inline scalar, inline flow list, block list, matrix refs). */
export function extractLabels(text) {
  return labelsIn(walkLabels(text));
}

function labelsIn({ lines, found, expression, matrix }) {
  const labels = new Set(found.map((f) => f.label));
  if (expression) {
    for (const { label } of matrix) labels.add(label);
    for (const line of lines) {
      if (/(^|\s)self-hosted(\s|$|,|\]|')/.test(line) && /runs-on|matrix|os:|- /.test(line)) {
        labels.add(SELF_HOSTED);
      }
    }
  }
  return [...labels];
}

/**
 * The job id every line belongs to, 0-indexed to match `lines`.
 *
 * `guard` reads one runner's image, and that image says something about a label
 * only if the job it is running asked for that label. The job id is the one
 * thing in the file that ties a `runs-on:` to the `GITHUB_JOB` a runner exports.
 */
function jobKeys(lines) {
  const at = new Array(lines.length).fill(null);
  let jobsIndent = null;
  let jobIndent = null;
  let current = null;
  let ended = false;
  for (let i = 0; i < lines.length; i++) {
    const m = ended ? null : lines[i].match(/^([ \t]*)([^-\s#][^:\r\n]*):/);
    if (m) {
      const indent = m[1].length;
      const key = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (jobsIndent === null) {
        // Top level only: `on.workflow_dispatch.inputs.jobs` is not the map.
        if (key === 'jobs' && indent === 0) jobsIndent = indent;
      } else if (indent <= jobsIndent) {
        // The next top-level key closes the map. A key further down at the job
        // indent belongs to that key, and inventing a job id for it can put a
        // runner's image on a job that GITHUB_JOB names somewhere else.
        current = null;
        ended = true;
      } else if (jobIndent === null || indent === jobIndent) {
        jobIndent = indent;
        current = key;
      }
    }
    at[i] = current;
  }
  return at;
}

/**
 * Where each `runs-on` label sits: `{label, file, line, col, job}` per
 * occurrence, 1-indexed, `col` on the label text so a `file=,line=,col=`
 * annotation lands on it. `keep` decides which labels are worth a site, because
 * the two lanes that want one want disjoint halves of the same walk.
 *
 * `viaMatrix` marks a label read out of a matrix rather than off a `runs-on:`
 * line. Its job is right, but which leg of the matrix any one runner is serving
 * is not written anywhere in the file. A `workflow_call` input default and a
 * top-level `env:` value sit above the jobs map and so have no job of their own;
 * they carry `jobs`, the ids whose `runs-on:` is an expression, instead.
 */
function labelSitesWhere(walk, file, keep) {
  const { found, expression, matrix, targets, jobs } = walk;
  const jobOf = (line) => jobs[line - 1] ?? null;

  // The matrix fallback is a whole-file token scan, so it only says which job a
  // label sits in, not which job could be scheduled by it. A job whose own
  // `runs-on:` is a plain label is scheduled by that label and nothing else, and
  // a label-shaped `env:` value under it is not a runner it asks for. A job with
  // no `runs-on:` at all is a `uses:` call, and the label it hands the callee in
  // `with:` is still a runner this file asks for.
  const asks = expression
    ? new Set(targets.filter((t) => t.expression).map((t) => jobOf(t.line)))
    : new Set();
  const names = new Set(targets.map((t) => jobOf(t.line)));

  // A label an expression resolves to need not sit in the jobs map at all: a
  // `workflow_call` input default and a top-level `env:` value both live above
  // it. The jobs it can serve are the ones whose `runs-on:` is an expression.
  const viaExpression = [...asks].filter(Boolean);

  const seen = new Set();
  const sites = [];
  const all = expression ? [...found, ...matrix.map((m) => ({ ...m, viaMatrix: true }))] : found;
  for (const { label, line, col, viaMatrix } of all) {
    if (!keep(label)) continue;
    const key = `${label}@${line}:${col}`;
    if (seen.has(key)) continue;
    const job = jobOf(line);
    if (viaMatrix && job !== null && names.has(job) && !asks.has(job)) continue;
    seen.add(key);
    const site = { label, file, line, col, job };
    if (viaMatrix) site.viaMatrix = true;
    // One annotation per position, so the jobs a label off the map can serve
    // travel with it rather than becoming a site each.
    if (viaMatrix && job === null && viaExpression.length) site.jobs = viaExpression;
    sites.push(site);
  }
  return sites;
}

const isPinned = (label) => label !== SELF_HOSTED && !isFloating(label);

/** Pinned image labels: what the retirement lane dates. */
export function extractLabelSites(text, file = null) {
  return labelSitesWhere(walkLabels(text), file, isPinned);
}

/** Floating labels: what the migration lane dates, and nothing else can. */
export function extractFloatingSites(text, file = null) {
  return labelSitesWhere(walkLabels(text), file, isFloating);
}

/**
 * The workflow file and job id of the job this process is running in, or null
 * outside Actions. `GITHUB_WORKFLOW_REF` is
 * `owner/repo/.github/workflows/ci.yml@refs/heads/main`; only the file name is
 * kept, since the scan may have been pointed at a copy of the directory.
 */
export function runningJob(env = process.env) {
  const job = env.GITHUB_JOB || null;
  if (!job) return null;
  const ref = env.GITHUB_WORKFLOW_REF || '';
  return { job, file: ref ? path.basename(ref.split('@')[0]) : null };
}

/**
 * Where the running job sits in a scan: what to match sites against, and
 * whether that identity picks out one job.
 *
 * The file name is dropped from the comparison when no scanned site carries
 * this job id in the file the run reports: a job inside a reusable workflow
 * reports the calling file in `GITHUB_WORKFLOW_REF` while its id lives in the
 * callee, and a scan pointed at a copy of the directory need not match either.
 * The job id still has to agree, but on its own it is only unique within a
 * file, so `pinned` is false and the caller is looking at every job in the
 * repository that shares the id.
 */
export function jobScope(here, sites = []) {
  if (!here) return { at: null, pinned: false, match: () => false };
  const pinned = Boolean(here.file) && sites.some((site) => siteInJob(site, here));
  const at = pinned ? here : { ...here, file: null };
  return { at, pinned, match: (site) => siteInJob(site, at) };
}

/** A predicate for "this site is one the running job was scheduled from". */
export function jobMatcher(here, sites = []) {
  return jobScope(here, sites).match;
}

/**
 * Who asked for `label` here, and whether anything else asks for `observed` too.
 *
 * `sites` are this label's, `others` is every other site the scan found. Both
 * are needed to place the running job: a job id is unique within a file, not
 * across a repository, so the file has to decide when two files use the same id.
 *
 * Without a running job every site in the repository is in scope, and the
 * caller has to decide how much that is worth. `placed` is the stronger claim
 * that the job id picked out one job.
 * `direct` is a plain `runs-on: <label>`, `asked` includes reaching the label
 * through a matrix, and `rival` is another site naming `observed`, which the
 * runner is as likely to be serving as the floating one. `named` says that
 * rival is a plain `runs-on:` rather than a matrix leg, which is the difference
 * between two jobs sharing an id and one job with two legs. `alone` is whether
 * every file holding a job of this id asks for `label` in it, which is what an
 * unplaced `direct` is worth: one of two `build` jobs runs on Windows, and the
 * run cannot say which one it is.
 *
 * Inside one job the only rival is a matrix leg, since a job has one `runs-on:`.
 * That needs the job to be pinned to a file. A job id alone can name a job in
 * every file that uses it, and then a plain `runs-on: <observed>` under the
 * same id is as good an explanation as this label, exactly as it is when there
 * is no job id at all.
 */
export function labelOwnership({ label, observed = null, sites = [], others = [], here = null }) {
  const { match, pinned } = jobScope(here, [...sites, ...others]);
  const inScope = here ? match : () => true;
  const mine = sites.filter((site) => site.label === label && inScope(site));
  const rivals = others.filter((site) => site.label === observed && inScope(site));
  const asking = new Set(mine.map((site) => site.file));
  const alone = [...sites, ...others]
    .filter((site) => inScope(site))
    .every((site) => asking.has(site.file));
  return {
    placed: pinned,
    direct: mine.some((site) => !site.viaMatrix),
    asked: mine.length > 0,
    rival: observed !== null && (pinned ? rivals.some((site) => site.viaMatrix) : rivals.length > 0),
    named: observed !== null && rivals.some((site) => !site.viaMatrix),
    alone: pinned || alone,
  };
}

/** Is this `runs-on:` site the one the running job was scheduled from? */
export function siteInJob(site, here) {
  const owns = site?.job ? site.job === here?.job : Boolean(site?.jobs?.includes(here?.job));
  if (!here || !owns) return false;
  if (!here.file || !site.file) return true;
  return path.basename(site.file).toLowerCase() === here.file.toLowerCase();
}

/**
 * One entry per `runs-on:`, with its label SET intact: `{labels, file, line, col}`.
 *
 * This is the shape the self-hosted lane needs, because GitHub schedules a job
 * onto a runner only if that runner carries every label in the set. Targets
 * whose value is a `${{ … }}` expression are reported with `expression: true`
 * and no labels, since which runner serves them is not decidable from the file.
 */
export function extractRunsOnTargets(text, file = null) {
  return targetsIn(walkLabels(text), file);
}

function targetsIn({ targets }, file) {
  return targets.map((t) => ({
    labels: [...new Set(t.labels)],
    expression: t.expression,
    file,
    line: t.line,
    col: t.col,
  }));
}

/** True when everything left of `end` on the line is space or tab. */
function blankBefore(line, end) {
  for (let i = end - 1; i >= 0; i--) {
    if (line[i] !== ' ' && line[i] !== '	') return false;
  }
  return true;
}

/**
 * Every `uses:` key on one line, as `{raw, start}`: the value as written and the
 * index it begins at.
 *
 * Normally there is one, at the head of a block-mapping entry. Flow style
 * (`steps: [{uses: actions/setup-node@v5}]`) puts them mid-line after a `{` or a
 * `,`, and there the value ends at the collection's punctuation rather than at
 * the end of the line. Anything else in front of `uses:` is shell or prose.
 *
 * indexOf rather than a regex: the value is `(.*)` up to a terminator, which is
 * the quadratic shape (LESSONS 2026-09-09).
 */
function usesOnLine(line) {
  const found = [];
  for (let at = line.indexOf(USES_KEY); at !== -1; at = line.indexOf(USES_KEY, at + USES_KEY.length)) {
    // One character back, not a slice of the prefix: the prefix would be re-read
    // for every `uses:` on the line, which is quadratic on a long one.
    let k = at - 1;
    while (line[k] === ' ' || line[k] === '	') k--;
    const prev = k < 0 ? '' : line[k];
    const flow = prev === '{' || prev === ',';
    if (!flow && prev !== '' && !(prev === '-' && blankBefore(line, k))) continue;
    const start = at + USES_KEY.length;
    let raw = line.slice(start);
    if (flow) {
      const end = raw.search(/[,}\]]/);
      if (end !== -1) raw = raw.slice(0, end);
    }
    found.push({ raw, start });
  }
  return found;
}

/**
 * Every `uses:` in a document, ref intact and positioned:
 * `{ref, file, line, col}`, 1-indexed, `col` on the reference text.
 *
 * One pass serves both consumers. The setup-* tool detection below wants only
 * the `owner/repo` prefix, and the runtime lane in runtimes.mjs wants the whole
 * `owner/repo/subdir@ref`, so the ref is kept whole here and narrowed by the
 * caller.
 *
 * Lines inside a `run:` block scalar are skipped. A workflow that writes another
 * workflow from a heredoc has `- uses: actions/checkout@v4` in its shell, and
 * reading that as a reference fails the job over a line nobody runs.
 */
export function extractUses(text, file = null) {
  const { lines, body } = scanRunSteps(text);
  const sites = [];
  for (let i = 0; i < lines.length; i++) {
    if (body.has(i)) continue;
    for (const { raw, start } of usesOnLine(lines[i])) {
      const ref = readScalar(raw);
      if (ref) sites.push({ ref, file, line: i + 1, col: labelColumn(start, raw) });
    }
  }
  return sites;
}

/** `actions/setup-node@v5` -> `actions/setup-node`; a subdir action keeps two segments. */
function actionSlug(ref) {
  return ref.split('@')[0].split('/').slice(0, 2).join('/').toLowerCase();
}

/** The setup-* actions among a set of `uses:` sites, as canonical tool names. */
export function setupTools(usesSites) {
  const tools = new Set();
  for (const { ref } of usesSites) {
    const tool = lookup(SETUP_ACTION_ALIASES, actionSlug(ref));
    if (tool) tools.add(tool);
  }
  return [...tools];
}

/** `uses: actions/setup-node@v5` -> Node.js (any version suffix; only the owner/repo matters) */
export function extractSetupActions(text) {
  return setupTools(extractUses(text));
}

/** Analyse one workflow document. */
export function analyseWorkflow(text, file = null) {
  const walk = walkLabels(text);
  const labels = labelsIn(walk);
  const sites = labelSitesWhere(walk, file, () => true);
  const labelSites = sites.filter((s) => isPinned(s.label));
  const floatingSites = sites.filter((s) => isFloating(s.label));
  const runsOnTargets = targetsIn(walk, file);
  const uses = extractUses(text, file);
  const commands = new Set();
  for (const script of extractRunScripts(text)) {
    for (const c of commandsInScript(script)) commands.add(c);
  }
  const tools = new Set([...commands].map((c) => canonicalTool(c)));
  for (const t of setupTools(uses)) tools.add(t);
  return {
    file,
    labels,
    labelSites,
    floatingSites,
    runsOnTargets,
    uses,
    commands: [...commands].sort(),
    tools: [...tools].sort(),
  };
}

async function listWorkflowFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return entries
    .filter((e) => e.isFile() && WORKFLOW_EXT.test(e.name))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/**
 * Scan a directory of workflows (or a single workflow file).
 * @returns {{dir:string, files:string[], labels:string[], labelSites:object[],
 *            floatingSites:object[], tools:string[], perFile:object[],
 *            missing:boolean}}
 */
export async function detect(workflowsPath) {
  const target = workflowsPath || path.join('.github', 'workflows');
  let files;
  let s = null;
  try {
    s = await stat(target);
  } catch {
    s = null;
  }
  if (s?.isFile()) {
    files = [target];
  } else {
    files = await listWorkflowFiles(target);
    if (files === null) {
      return {
        dir: target,
        files: [],
        labels: [],
        labelSites: [],
        floatingSites: [],
        runsOnTargets: [],
        uses: [],
        tools: [],
        perFile: [],
        missing: true,
      };
    }
  }

  const perFile = [];
  const labels = new Set();
  const labelSites = [];
  const floatingSites = [];
  const runsOnTargets = [];
  const uses = [];
  const tools = new Set();
  for (const f of files) {
    const text = await readFile(f, 'utf8');
    const r = analyseWorkflow(text, f);
    perFile.push(r);
    for (const l of r.labels) labels.add(l);
    labelSites.push(...r.labelSites);
    floatingSites.push(...r.floatingSites);
    runsOnTargets.push(...r.runsOnTargets);
    uses.push(...r.uses);
    for (const t of r.tools) tools.add(t);
  }

  return {
    dir: target,
    files,
    labels: [...labels].sort(),
    labelSites,
    floatingSites,
    runsOnTargets,
    uses,
    tools: [...tools].sort(),
    perFile,
    missing: false,
  };
}
