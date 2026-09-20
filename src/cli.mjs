#!/usr/bin/env node
/**
 * runner-drift — lock the tool versions your CI actually uses, diff them on
 * every runner-image bump, and plan a label migration before the deadline.
 */

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DriftError, errorText } from './http.mjs';
import {
  IMAGE_OS_TO_LABEL,
  deadlineFor,
  isFloating,
  knownLabels,
  labelForImageOS,
  migratingLabels,
  migrationFails,
  migrationBetween,
  migrationFor,
  migrationStatus,
  normaliseLabel,
} from './labels.mjs';
import { diffManifestTools, loadManifest, resolveManifestVersions } from './manifest.mjs';
import { imageDiffs, surveyMigration } from './migration.mjs';
import { attribute, commitWindow, attributeChanges, listManifestCommits, manifestAtSha } from './history.mjs';
import { detect, labelOwnership, runningJob, SELF_HOSTED } from './detect.mjs';
import { canonicalTool, knownTools, MANIFEST_CANDIDATES } from './tools.mjs';
import { probeTool, isProbeable } from './probe.mjs';
import { diffTool, shouldFail, maxSeverity } from './diff.mjs';
import { lookup } from './tables.mjs';
import { readLock, writeLock, lockPayload, DEFAULT_LOCK_FILE, toolsEntry, toVersionMap } from './lock.mjs';
import {
  planReport,
  stepSummaryMarkdown,
  annotations,
  notice,
  plural,
  retirementFindings,
  retirementAnnotations,
  retirementSummaryMarkdown,
  migrationAnnotations,
  migrationMessage,
  migrationReport,
  migrationSummaryMarkdown,
  runnersReport,
  runnersAnnotations,
  runnersSummaryMarkdown,
  actionsReport,
  actionsAnnotations,
  actionsSummaryMarkdown,
  writeStepSummary,
  writeOutput,
} from './report.mjs';
import { REF_STATUS, surveyActions } from './runtimes.mjs';
import {
  DEFAULT_DEPRECATION_WINDOW_DAYS,
  SURVEY_STATUS,
  resolveScope,
  statusFails,
  surveyRunners,
} from './runners.mjs';

export { resolveManifestVersions };

export const EXIT_OK = 0;
export const EXIT_DRIFT = 1;
export const EXIT_USAGE = 2;

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function version() {
  try {
    const pkg = JSON.parse(await readFile(path.join(HERE, '..', 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    return '1.4.1';
  }
}

const USAGE = `runner-drift — GitHub Actions runner-image tool drift, locked and attributed.

Usage:
  runner-drift init  [options]                 Record a baseline runner-lock.json
  runner-drift guard [options]                 (in-workflow) diff live runner vs the lock
  runner-drift plan  --from <label> --to <label>   Preview a runner label migration
  runner-drift plan  --from <floating label>   Preview the move GitHub has announced
                                               for that label (e.g. ubuntu-latest)
  runner-drift runners [--org <name> | --repo <owner/repo>]
                                               Self-hosted runner agent versions vs
                                               GitHub's end-of-support dates
  runner-drift actions [path]                  Which uses: references stop working
                                               when Node 20 leaves the runners

Options:
  --workflows <path>    workflow dir or file          (default: .github/workflows)
  --lock-file <path>    lock file path                (default: ${DEFAULT_LOCK_FILE})
  --tools <a,b,c>       override tool detection       (e.g. --tools python,cmake,clang)
  --label <label>       explicit runner label         (init)
  --from <label>        source runner label           (plan)
  --to <label>          target runner label           (plan)
  --fail-on <level>     major | minor | any           (guard, default: never fail)
  --fail-on-retirement <days>   fail if a pinned label retires within N days (guard)
  --fail-on-migration <days>    report, and fail on, an announced floating-label
                                migration starting within N days (guard)
  --org <name>          organization to survey             (runners)
  --repo <owner/repo>   repository to survey               (runners, default: $GITHUB_REPOSITORY)
  --fail-on-deprecation <days>  fail if a runner version's support ends within N days
                                (runners, guard; default window ${DEFAULT_DEPRECATION_WINDOW_DAYS})
  --warn-only           report but always exit 0             (actions)
  --fail-on-unknown     fail when a uses: cannot be resolved (actions)
  --as-of <date>        evaluate every countdown as if it were this date, e.g.
                        --as-of 2026-10-19 (guard, plan, runners, actions)
  --json                machine-readable output
  --no-summary          do not write $GITHUB_STEP_SUMMARY (guard, runners, actions)
  --no-update-lock      do not rewrite the lock file  (guard)
  -h, --help            this text
  -v, --version         print version

Known labels: ${knownLabels().join(', ')}
Known tools:  ${knownTools().join(', ')}

Docs: https://github.com/Booyaka101/runner-drift
`;

export const OPTIONS = {
  workflows: { type: 'string' },
  'lock-file': { type: 'string' },
  tools: { type: 'string' },
  label: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  'fail-on': { type: 'string' },
  'fail-on-retirement': { type: 'string' },
  'fail-on-migration': { type: 'string' },
  'fail-on-deprecation': { type: 'string' },
  'as-of': { type: 'string' },
  org: { type: 'string' },
  repo: { type: 'string' },
  'warn-only': { type: 'boolean', default: false },
  'fail-on-unknown': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  summary: { type: 'boolean', default: true },
  'update-lock': { type: 'boolean', default: true },
  // parseArgs has no `--no-` negation, so the documented negative forms have to
  // be declared in their own right and folded in by resolveNegations().
  'no-summary': { type: 'boolean', default: false },
  'no-update-lock': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

/** `--no-summary` -> `summary: false`, for each documented negative form. */
function resolveNegations(opts) {
  for (const [negative, positive] of [
    ['no-summary', 'summary'],
    ['no-update-lock', 'update-lock'],
  ]) {
    if (opts[negative]) opts[positive] = false;
    delete opts[negative];
  }
  return opts;
}

/* ------------------------------------------------------------------ shared */

function parseToolList(csv) {
  if (!csv) return null;
  const list = String(csv)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => canonicalTool(s));
  return [...new Set(list)];
}

/**
 * Reduce a raw `runs-on` label set to the hosted-image labels worth resolving.
 * Self-hosted runners carry arbitrary extra tags (`linux`, `gpu`, `x64`), so
 * when `self-hosted` is present every non-image tag alongside it is dropped;
 * an unknown but image-shaped label is kept so the user gets told about it.
 */
function concreteLabels(labels) {
  const known = new Set(knownLabels());
  const selfHosted = labels.includes(SELF_HOSTED);
  return labels.filter((l) => {
    if (l === SELF_HOSTED || isFloating(l)) return false;
    if (known.has(l)) return true;
    if (selfHosted) return false;
    return /^(ubuntu|windows|macos)-/i.test(l);
  });
}

function out(stream, line) {
  stream.write(`${line}\n`);
}

const ISO_WHEN = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * An ISO instant, reading a date or a zone-less time as UTC, or NaN.
 *
 * UTC is the calendar every countdown in the output is measured in. Left to
 * `Date.parse`, a naive time is local, so `--as-of 2026-10-19T00:00:00` lands
 * on the 18th west of Greenwich and reports the window as a day away rather
 * than open. Anything `Date.parse` would read in local time is refused for the
 * same reason, rather than silently landing a day out.
 */
function isoInstant(raw) {
  const m = raw.match(ISO_WHEN);
  if (!m) return NaN;
  return Date.parse(m[2] ? `${m[1]}T${m[2]}${m[3] ?? 'Z'}` : `${m[1]}T00:00:00Z`);
}

/**
 * `--as-of`: the date every countdown is measured from. Nothing here is
 * inferred from it, so it answers "what will this say on the 19th?" without
 * pretending the run happened then.
 * @returns {{now?:Date}|null} null once the error is reported
 */
function asOf(opts, io) {
  if (opts['as-of'] === undefined) return {};
  const raw = String(opts['as-of']);
  const at = isoInstant(raw);
  if (!Number.isFinite(at)) {
    out(io.stderr, `--as-of needs a date such as 2026-10-19 (got "${raw}")`);
    return null;
  }
  return { now: new Date(at) };
}

/** A `--fail-on-*` threshold in whole days, or null once the error is reported. */
function wholeDays(value, flag, io) {
  const raw = String(value);
  if (!/^\d+$/.test(raw)) {
    out(io.stderr, `${flag} needs a whole number of days >= 0 (got "${raw}")`);
    return null;
  }
  return Number(raw);
}

/** One deduped stderr line per finding, for whichever lane produced them. */
function summarise(io, items, keyOf, lineOf) {
  const seen = new Set();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out(io.stderr, lineOf(item));
  }
}

/** Run `fn` at most once, however many lanes ask for its answer. */
function once(fn) {
  let pending = null;
  return () => (pending ??= fn());
}

/**
 * One workflow scan per command. Both lint lanes, the tool fallback, the label
 * fallback, the drift explanation and the runner lane want the same directory,
 * and reading it five times to get the same answer is five times the IO for
 * nothing.
 */
function scanner(opts) {
  return once(() => detect(opts.workflows ?? path.join('.github', 'workflows')));
}

/**
 * One manifest read per label per run. Mid-window the migration lane and the
 * drift diff both want the old image's manifest, which is a 300KB read.
 */
export function loaderFor(load) {
  const seen = new Map();
  return (label, opts) => {
    const key = `${label}@${opts?.ref ?? 'main'}`;
    if (!seen.has(key)) {
      // A failed read is not kept. The lane that asked second would replay the
      // rejection with no request of its own, and a manifest that was merely
      // unreachable for a moment reads as every locked tool having been removed.
      const read = Promise.resolve()
        .then(() => load(label, opts))
        .catch((err) => {
          seen.delete(key);
          throw err;
        });
      seen.set(key, read);
    }
    return seen.get(key);
  };
}

/**
 * The `--json` document for a run that never reached the drift diff: whatever
 * the lanes that do not need a lock file found, and nothing invented.
 */
function laneDocument({ runners = null, retirement = null, migration = null }) {
  const payload = {};
  if (runners) payload.runners = runners;
  if (retirement) payload.retirement = retirement;
  if (migration) payload.migration = migration;
  return payload;
}

/**
 * The workflow scan the two lint lanes start from, or null when there is no
 * workflow directory — which is a notice on both streams, not an error.
 */
async function scanForLane(scan, io, nothingToCheck) {
  const scanned = await scan();
  if (!scanned.missing) return scanned;
  // The scan is memoized for the run, so the second lane to ask about the same
  // missing directory carries the first one's mark and says nothing. One
  // condition, one notice.
  if (!scanned.said) {
    scanned.said = true;
    const msg = `No workflow directory at ${scanned.dir} — ${nothingToCheck}.`;
    out(io.stdout, notice(msg));
    out(io.stdout, msg);
  }
  return null;
}

/**
 * `--fail-on-retirement`: every pinned label that retires or browns out inside
 * the window. Reads the workflow files alone, so it works in a lint job with no
 * lock file and no hosted runner. Returns null on a bad value, already reported.
 */
async function checkRetirement(opts, io, now, scan) {
  const days = wholeDays(opts['fail-on-retirement'], '--fail-on-retirement', io);
  if (days === null) return null;
  const scanned = await scanForLane(scan, io, 'no pinned labels to check for retirement');
  if (!scanned) return { days, findings: [] };

  const findings = retirementFindings(scanned.labelSites, { now, days });
  for (const line of retirementAnnotations(findings)) out(io.stdout, line);
  if (findings.length && opts.summary) {
    await writeStepSummary(retirementSummaryMarkdown(findings));
  }
  return { days, findings };
}

/** One stderr line per retiring label, whatever else the run reported. */
function reportRetirement(io, { days, findings }) {
  summarise(
    io,
    findings,
    (f) => f.status.label,
    ({ status: s }) =>
      s.retired
        ? `runner-drift: ${s.label} has been fully unsupported since ${s.fullyUnsupported} (retired ${plural(Math.abs(s.daysToUnsupported), 'day')} ago) and --fail-on-retirement ${days} is set.`
        : `runner-drift: ${s.label} is fully unsupported on ${s.fullyUnsupported} (${plural(s.daysToUnsupported, 'day')}) and --fail-on-retirement ${days} is set.`,
  );
}

/**
 * `--fail-on-migration`: every floating label in the workflows that GitHub has
 * announced a move for, classified against its window and diffed across the two
 * images it names. Opt-in like the retirement gate, and like it, useful in a
 * plain lint job with no runner and no lock file.
 */
async function checkMigration(opts, io, now, imageOS, env, scan, lock, deps) {
  const days = wholeDays(opts['fail-on-migration'], '--fail-on-migration', io);
  if (days === null) return null;
  const scanned = await scanForLane(scan, io, 'no floating labels to check for migration');
  if (!scanned) return { days, surveys: [] };

  const byLabel = new Map();
  for (const site of scanned.floatingSites) {
    if (!migrationFor(site.label)) continue;
    if (!byLabel.has(site.label)) byLabel.set(site.label, []);
    byLabel.get(site.label).push(site);
  }
  const locked = lock?.tools ? Object.keys(lock.tools) : null;
  const asked = parseToolList(opts.tools);
  const tools = asked?.length ? asked : (locked?.length ? locked : scanned.tools);
  const load = deps.loadManifest ?? loadManifest;
  const here = runningJob(env);
  // Every other site in the scan, not just the pinned ones: the job this run
  // came from may be on a different floating label, and the ownership rule
  // needs the whole scan to tell one job id from the same id in another file.
  const elsewhere = (label) => [
    ...scanned.floatingSites.filter((site) => site.label !== label),
    ...scanned.labelSites,
  ];
  const surveys = await Promise.all(
    [...byLabel].map(([label, sites]) =>
      surveyMigration({ label, now, imageOS, tools, sites, others: elsewhere(label), here, load }),
    ),
  );

  for (const line of migrationAnnotations(surveys)) out(io.stdout, line);
  if (surveys.length && opts.summary) {
    await writeStepSummary(migrationSummaryMarkdown(surveys));
  }
  return { days, surveys };
}

/**
 * The announced migration that explains a lock-to-runner jump, or null.
 *
 * Only a job scheduled from the floating label can have been moved by the
 * window: a repo that pins its runner and bumps the pin by hand did its own
 * upgrade, and being told GitHub did it is worse than being told nothing. With
 * no `GITHUB_JOB` to match on, the label appearing anywhere in the workflows is
 * taken as enough.
 *
 * The scan only happens for a jump the table already recognises, which is rare,
 * so the common path still reads no workflow files it did not need.
 */
async function explainDrift({ migration, lock, label, scan, env }) {
  const survey = migration?.surveys.find(
    (s) => s.done && s.observed === s.to && lock.label === s.from && label === s.to,
  );
  if (survey) return survey;

  const m = migrationBetween(lock.label, label);
  if (!m) return null;
  const scanned = await scan();
  const here = runningJob(env);
  // `label` is this runner's own: a matrix leg naming it is a pin the repo
  // chose, not the window moving the job, so the explanation is withheld.
  const { asked, rival } = labelOwnership({
    label: m.label,
    observed: label,
    sites: scanned.floatingSites,
    others: scanned.labelSites,
    here,
  });
  // A pin to this runner's own label under the same job id is as good an
  // explanation as the window, whether it is a matrix leg of the job this run
  // came from or a job of that id in a file the run cannot be placed in.
  return asked && !rival ? m : null;
}

/** One stderr line per floating label whose migration fails the gate. */
function reportMigration(io, { days, surveys }) {
  summarise(
    io,
    surveys.filter((s) => migrationFails(s, days)),
    (s) => s.label,
    (s) =>
      `runner-drift: ${migrationMessage(s)}` +
      (s.anomaly ? '' : ` --fail-on-migration ${days} is set.`),
  );
}

/** The same, one line per runner version whose support window has closed. */
function reportDeprecation(io, survey) {
  summarise(
    io,
    survey.groups.filter((g) => statusFails(g.status, { failOn: survey.failOn })),
    (g) => g.version,
    (g) => {
      const fleet = `${g.count} self-hosted runner(s) on ${g.version}`;
      const because = survey.failOn
        ? ` and --fail-on-deprecation ${survey.windowDays} is set`
        : '';
      if (g.runtime) {
        return g.runtime.past
          ? `runner-drift: ${fleet} lost runtime support on ${g.runtime.date} (${plural(Math.abs(g.runtime.days), 'day')} ago) — jobs are no longer queued to them.`
          : `runner-drift: ${fleet} lose runtime support on ${g.runtime.date} (${plural(g.runtime.days, 'day')})${because}.`;
      }
      return g.registration.past
        ? `runner-drift: ${fleet} lost registration on ${g.registration.date} (${plural(Math.abs(g.registration.days), 'day')} ago) — they cannot reregister.`
        : `runner-drift: ${fleet} lose registration on ${g.registration.date} (${plural(g.registration.days, 'day')})${because}.`;
    },
  );
}

/**
 * The `runs-on:` targets on disk, so the runner lane can name the jobs an
 * at-risk runner actually serves. Absent workflows are silent: `runners` is
 * documented as needing no repository checkout.
 */
async function runsOnTargetsFor(scan) {
  const scanned = await scan();
  return scanned.missing ? [] : scanned.runsOnTargets;
}

/**
 * `--fail-on-deprecation`: the classification window, and whether it may change
 * the exit code. Absent, the window is still GitHub's own 30 days so the report
 * names what is coming; only the flag turns that into a failure.
 * @returns {{days:number, failOn:boolean}|null} null once the error is reported
 */
function deprecationWindow(opts, io) {
  if (opts['fail-on-deprecation'] === undefined) {
    return { days: DEFAULT_DEPRECATION_WINDOW_DAYS, failOn: false };
  }
  const days = wholeDays(opts['fail-on-deprecation'], '--fail-on-deprecation', io);
  return days === null ? null : { days, failOn: true };
}

/* -------------------------------------------------------------------- init */

export async function runInit(opts, io = process) {
  const workflows = opts.workflows ?? path.join('.github', 'workflows');
  const lockFile = opts['lock-file'] ?? DEFAULT_LOCK_FILE;
  const detected = await detect(workflows);

  if (detected.missing && !opts.tools) {
    out(io.stderr, `No workflow directory at ${detected.dir}.`);
    out(io.stderr, 'Pass --workflows <path> or --tools <a,b,c> to continue.');
    return EXIT_USAGE;
  }

  const tools = parseToolList(opts.tools) ?? detected.tools;
  if (!tools.length) {
    out(io.stderr, `No known tools detected in ${detected.files.length} workflow file(s) under ${detected.dir}.`);
    out(io.stderr, `Pass them explicitly, e.g. --tools python,cmake,clang`);
    out(io.stderr, `Recognised tools: ${knownTools().join(', ')}`);
    return EXIT_USAGE;
  }

  let label = normaliseLabel(opts.label ?? '');
  if (!label) {
    const found = concreteLabels(detected.labels);
    if (detected.labels.includes(SELF_HOSTED) && !found.length) {
      out(io.stdout, `Only self-hosted runners found in ${detected.dir} — nothing to lock. Skipping.`);
      return EXIT_OK;
    }
    if (!found.length) {
      const floating = detected.labels.filter((l) => isFloating(l));
      if (floating.length) {
        out(io.stderr, `Your workflows use the floating label(s) ${floating.join(', ')}.`);
        out(io.stderr, 'GitHub re-points those without notice, so runner-drift will not guess which image they mean.');
        out(io.stderr, 'Either pass the concrete label:  runner-drift init --label ubuntu-24.04');
        out(io.stderr, 'or just add the guard step to your workflow — `runner-drift guard` reads the real');
        out(io.stderr, 'label from the runner\'s ImageOS env var and writes the baseline itself.');
        const migrating = floating.filter((l) => migrationFor(l));
        if (migrating.length) {
          out(io.stderr, '');
          out(io.stderr, `Note: ${migrating.join(', ')} has an announced migration. Preview what changes:`);
          out(io.stderr, `  runner-drift plan --from ${migrating[0]}`);
        }
        return EXIT_USAGE;
      }
      out(io.stderr, `No runner label found in ${detected.dir}. Pass --label <label>.`);
      return EXIT_USAGE;
    }
    if (found.length > 1) {
      out(io.stderr, `Multiple runner labels found: ${found.join(', ')}.`);
      out(io.stderr, 'Pick one with --label <label> (one lock file per label).');
      return EXIT_USAGE;
    }
    label = found[0];
  }

  if (isFloating(label)) {
    out(io.stderr, `"${label}" floats — pass a concrete label such as ubuntu-24.04.`);
    return EXIT_USAGE;
  }

  const manifest = await loadManifest(label);
  if (manifest.skipped) {
    out(io.stderr, manifest.reason);
    out(io.stderr, `Known labels: ${knownLabels().join(', ')}`);
    return EXIT_USAGE;
  }

  const { map, missing } = resolveManifestVersions(manifest, tools);
  const lockTools = Object.create(null);
  for (const [t, versions] of Object.entries(map)) {
    lockTools[t] = toolsEntry(versions, 'manifest');
  }

  const written = await writeLock(
    {
      label,
      imageOS: Object.keys(IMAGE_OS_TO_LABEL).find((k) => IMAGE_OS_TO_LABEL[k] === label) ?? null,
      imageVersion: manifest.imageVersion,
      tools: lockTools,
      updatedAt: new Date().toISOString(),
    },
    lockFile,
  );

  if (opts.json) {
    out(io.stdout, JSON.stringify({ lockFile, detected: { labels: detected.labels, tools }, lock: written, missing }, null, 2));
    return EXIT_OK;
  }

  out(io.stdout, `Scanned ${detected.files.length} workflow file(s) in ${detected.dir}`);
  out(io.stdout, `Runner label: ${label} (image ${manifest.imageVersion}, ${manifest.osVersion})`);
  out(io.stdout, `Locked ${Object.keys(lockTools).length} tool(s): ${Object.keys(lockTools).join(', ') || '(none)'}`);
  if (missing.length) {
    out(io.stdout, `Not listed on the ${label} manifest (skipped): ${missing.join(', ')}`);
  }
  out(io.stdout, `Wrote ${lockFile}`);
  const dl = deadlineFor(label);
  if (dl) {
    out(io.stdout, `Heads up: ${label} is fully unsupported on ${dl.fullyUnsupported} (${dl.source})`);
    out(io.stdout, `Preview the move:  runner-drift plan --from ${label} --to ${dl.migrateTo[0]}`);
  }
  out(io.stdout, `Next: add the guard step to your workflow (see the README) and commit ${lockFile}.`);
  return EXIT_OK;
}

/* ------------------------------------------------------------------- guard */

/**
 * `guard` on a self-hosted runner: this runner's own agent version against the
 * deprecations API, matched by $RUNNER_NAME.
 *
 * Returns null whenever the lookup cannot even be attempted — no runner name, or
 * no token. That is the common case, not an error path, and the caller then
 * behaves exactly as it did before this lane existed.
 */
async function checkOwnRunner(opts, io, env, deps, window, scan) {
  const name = env.RUNNER_NAME;
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || env.INPUT_GITHUB_TOKEN;
  if (!name || !token) return null;
  const { scope } = resolveScope({ repo: opts.repo, org: opts.org, env });
  if (!scope) return null;

  const survey = await surveyRunners(scope, {
    ...window,
    now: deps.now ?? new Date(),
    onlyRunnerName: name,
    runsOnTargets: await runsOnTargetsFor(scan),
    fetch: deps.fetchJson,
  });
  if (survey.status === SURVEY_STATUS.OK && !survey.groups.length) {
    // Listed fine, but this runner is not in it: an enterprise-level runner, or
    // one registered to a different scope. Nothing to report, nothing to fail.
    return null;
  }
  for (const line of runnersAnnotations(survey)) out(io.stdout, line);
  if (opts.summary) await writeStepSummary(runnersSummaryMarkdown(survey));
  if (!opts.json) out(io.stdout, runnersReport(survey));
  return survey;
}

export async function runGuard(opts, io = process, env = process.env, deps = {}) {
  const lockFile = opts['lock-file'] ?? DEFAULT_LOCK_FILE;
  const scan = scanner(opts);
  const load = loaderFor(deps.loadManifest ?? loadManifest);
  // The migration lane diffs the tools the lock watches, which is not always
  // what the workflow files mention. It reads the lock leniently: a lock this
  // version cannot parse is an error for the drift lane below, which is the
  // only lane that cannot work without it, and only once there is an image to
  // diff at all.
  const getLock = once(() => readLock(lockFile));
  // Writing the lock is the default; `main` resolves --no-update-lock into it,
  // but runGuard is exported and a caller building options by hand has neither.
  const updateLock = opts['update-lock'] !== false;
  const failOn = (opts['fail-on'] ?? 'none').toLowerCase();
  if (!['none', 'major', 'minor', 'any'].includes(failOn)) {
    out(io.stderr, `--fail-on must be one of: major, minor, any (got "${opts['fail-on']}")`);
    return EXIT_USAGE;
  }

  // Validated up front, not where it is used: on a hosted runner the runner-agent
  // check never runs, and a bad flag value must still be a usage error there.
  const window = deprecationWindow(opts, io);
  if (!window) return EXIT_USAGE;

  // Retirement runs before the drift logic: it needs only the workflow files,
  // so a lint job on any runner gets the deadline warning.
  let retirement = null;
  if (opts['fail-on-retirement'] !== undefined) {
    retirement = await checkRetirement(opts, io, deps.now ?? new Date(), scan);
    if (!retirement) return EXIT_USAGE;
  }
  const retiring = retirement?.findings.length ? retirement : null;

  const imageVersion = env.ImageVersion ?? env.IMAGE_VERSION ?? null;
  const imageOS = env.ImageOS ?? env.IMAGE_OS ?? null;

  // Migration needs only the workflow files too, but it does want ImageOS: on a
  // hosted runner mid-window that is the difference between "the same label is
  // two images right now" and "this job ran on the new one".
  let migration = null;
  if (opts['fail-on-migration'] !== undefined) {
    const known = await getLock().catch(() => null);
    migration = await checkMigration(opts, io, deps.now ?? new Date(), imageOS, env, scan, known, {
      ...deps,
      loadManifest: load,
    });
    if (!migration) return EXIT_USAGE;
    if (!opts.json && migration.surveys.length) {
      out(io.stdout, migrationReport(migration.surveys));
    }
  }
  const migrating = migration?.surveys.some((s) => migrationFails(s, migration.days))
    ? migration
    : null;

  // A GitHub-hosted runner has no agent version of its own to check, so the flag
  // does nothing here. Say so: the action passes it to every job, and a flag that
  // silently no-ops reads as a broken flag.
  if (imageVersion && window.failOn) {
    out(
      io.stdout,
      notice(
        `--fail-on-deprecation ${window.days} does not apply on a GitHub-hosted runner: ` +
          'the agent version is GitHub\'s to manage. Use `runner-drift runners` for a self-hosted fleet.',
      ),
    );
  }

  if (!imageVersion) {
    const msg =
      'No ImageVersion environment variable — this is not a GitHub-hosted runner ' +
      '(self-hosted runner or local shell). runner-drift guard has nothing to compare; skipping.';
    out(io.stdout, notice(msg));
    out(io.stdout, msg);
    // No hosted image to diff, but a self-hosted runner still has an agent
    // version with a date on it. Without a token this is a no-op and the skip
    // above is the whole output, exactly as in 1.1.0.
    const own = await checkOwnRunner(opts, io, env, deps, window, scan);
    const doc = laneDocument({ runners: own, retirement, migration });
    if (opts.json && Object.keys(doc).length) out(io.stdout, JSON.stringify(doc, null, 2));
    if (retiring) reportRetirement(io, retiring);
    if (migrating) reportMigration(io, migrating);
    if (own?.failing) reportDeprecation(io, own);
    return retiring || migrating || own?.failing ? EXIT_DRIFT : EXIT_OK;
  }

  const lock = await getLock();
  let label = labelForImageOS(imageOS) || lock?.label || null;

  if (!label) {
    const detected = await scan();
    label = concreteLabels(detected.labels)[0] ?? null;
  }
  if (!label) {
    const msg = `Unknown runner label (ImageOS="${imageOS ?? '(unset)'}") — skipping. Known: ${knownLabels().join(', ')}`;
    out(io.stdout, `::warning title=runner-drift::${msg}`);
    out(io.stdout, msg);
    const doc = laneDocument({ retirement, migration });
    if (opts.json && Object.keys(doc).length) out(io.stdout, JSON.stringify(doc, null, 2));
    if (retiring) reportRetirement(io, retiring);
    if (migrating) reportMigration(io, migrating);
    return retiring || migrating ? EXIT_DRIFT : EXIT_OK;
  }

  // Which tools to watch.
  let tools = parseToolList(opts.tools);
  if (!tools?.length && lock?.tools && Object.keys(lock.tools).length) {
    tools = Object.keys(lock.tools);
  }
  if (!tools?.length) {
    const detected = await scan();
    tools = detected.tools;
  }
  if (!tools.length) {
    out(io.stderr, 'No tools detected in your workflows and none in the lock file.');
    out(io.stderr, 'Pass them explicitly: runner-drift guard --tools python,cmake,clang');
    // The two label gates read the workflow files, not the tool list, so they
    // have already found whatever they were going to find.
    const doc = laneDocument({ retirement, migration });
    if (opts.json && Object.keys(doc).length) out(io.stdout, JSON.stringify(doc, null, 2));
    if (retiring) reportRetirement(io, retiring);
    if (migrating) reportMigration(io, migrating);
    return retiring || migrating ? EXIT_DRIFT : EXIT_USAGE;
  }

  // Observe the live runner: probe first, manifest as the fallback.
  const observed = Object.create(null);
  const probeNotes = [];
  const needManifest = [];
  for (const t of tools) {
    const p = isProbeable(t) ? probeTool(t) : { ok: false, reason: 'no probe recipe' };
    if (p.ok) {
      observed[t] = toolsEntry(p.versions, 'probe', { command: p.command });
      probeNotes.push(`${t}: ${p.versions.join(', ')} (${p.command})`);
    } else {
      needManifest.push(t);
    }
  }

  let manifest = null;
  let attribution0 = null;
  let approximate = false;
  const infraWarnings = [];
  // Tools nothing could observe this run. Unobserved is not removed: a rate
  // limit must not diff as REMOVED, nor drop the tool from the lock so that the
  // next run reads it as ADDED.
  const unobserved = new Set();

  if (needManifest.length) {
    // Pinning the manifest to the commit that shipped this image version is an
    // improvement on the label's current readme, not a prerequisite for it. A
    // rate limit here used to abort the fallback too, and a tool that went
    // unobserved is reported as REMOVED, which --fail-on major reds the build
    // over.
    try {
      attribution0 = await attribute(label, imageVersion);
      if (attribution0?.commit) {
        approximate = attribution0.approximate;
        manifest = await manifestAtSha(label, attribution0.commit.sha);
      }
    } catch (err) {
      infraWarnings.push(errorText(err));
    }
    if (!manifest) {
      try {
        const m = await load(label);
        manifest = m.skipped ? null : m;
      } catch (err) {
        infraWarnings.push(errorText(err));
      }
    }
    if (manifest) {
      const { map, missing } = resolveManifestVersions(manifest, needManifest);
      for (const [t, versions] of Object.entries(map)) {
        observed[t] = toolsEntry(versions, 'manifest');
      }
      for (const t of missing) {
        // A tool with a probe recipe was looked for on this machine and not
        // found, so a manifest that does not list it either is evidence it has
        // gone. A tool with no recipe had the manifest as its only observer,
        // and the readme is a curated list under headings that get renamed, so
        // absence from it is not a removal worth reddening a build over.
        if (isProbeable(t)) {
          infraWarnings.push(`${t}: not found on this runner and not listed on the ${label} manifest.`);
        } else {
          unobserved.add(t);
          infraWarnings.push(
            `${t}: no probe recipe here and not listed on the ${label} manifest — not compared.`,
          );
        }
      }
    } else {
      for (const t of needManifest) {
        unobserved.add(t);
        infraWarnings.push(
          `${t}: not probeable here and the ${label} manifest could not be fetched — not compared.`,
        );
      }
    }
  }

  for (const w of infraWarnings) out(io.stdout, `::warning title=runner-drift::${w}`);

  // First run: record the baseline and stop.
  if (!lock) {
    const baseline = { label, imageOS, imageVersion, tools: observed, updatedAt: new Date().toISOString() };
    // --no-update-lock covers the first run too. A job that asked for a report
    // and got a file it then has to decide whether to commit is a surprise.
    const written = updateLock ? await writeLock(baseline, lockFile) : lockPayload(baseline);
    const summary = stepSummaryMarkdown({
      label,
      toImage: imageVersion,
      diffs: Object.keys(observed),
      baseline: true,
      written: updateLock,
      lockFile,
    });
    if (opts.summary) await writeStepSummary(summary);
    if (opts.json) {
      out(
        io.stdout,
        JSON.stringify(
          {
            baseline: true,
            written: updateLock,
            lock: written,
            ...(retirement ? { retirement } : {}),
            ...(migration ? { migration } : {}),
          },
          null,
          2,
        ),
      );
    } else {
      out(io.stdout, `baseline ${updateLock ? 'recorded' : 'observed'} — ${label} image ${imageVersion}`);
      for (const n of probeNotes) out(io.stdout, `  ${n}`);
      const manifestOnly = Object.entries(observed).filter(([, v]) => v.source === 'manifest');
      for (const [t, v] of manifestOnly) out(io.stdout, `  ${t}: ${v.versions.join(', ')} (from manifest)`);
      out(
        io.stdout,
        updateLock
          ? `Wrote ${lockFile}. Commit it so the next image bump can be diffed.`
          : `Nothing written: --no-update-lock is set. Drop it to record ${lockFile} as the baseline.`,
      );
    }
    if (retiring) reportRetirement(io, retiring);
    if (migrating) reportMigration(io, migrating);
    return retiring || migrating ? EXIT_DRIFT : EXIT_OK;
  }

  // Diff against the lock.
  const lockedMap = toVersionMap(lock.tools);
  const observedMap = toVersionMap(observed);
  const watched = tools.filter(
    (t) => !unobserved.has(t) && (Object.hasOwn(lockedMap, t) || Object.hasOwn(observedMap, t)),
  );
  const diffs = watched.map((t) => diffTool(t, lookup(lockedMap, t), lookup(observedMap, t)));
  const changed = diffs.filter((d) => d.changed);

  // A lock recorded on another label is a different operating system, not an
  // image bump: the version in it was never a version of this label, and no
  // commit in this label's history shipped the difference. During the
  // `ubuntu-latest` migration that is the ordinary case, not an edge one.
  const movedLabel = Boolean(lock.label) && lock.label !== label;
  const imageRange = movedLabel
    ? `${lock.label} image ${lock.imageVersion} -> ${label} image ${imageVersion}`
    : `${label} image ${lock.imageVersion} -> ${imageVersion}`;

  // Attribute each change to the runner-images commit that shipped it.
  let attributionMap = Object.create(null);
  if (changed.length && !movedLabel && lock.imageVersion && lock.imageVersion !== imageVersion) {
    try {
      const commits = await listManifestCommits(label);
      const window = commitWindow(commits, lock.imageVersion, imageVersion);
      if (!window.length) {
        const near = await attribute(label, imageVersion, { commits });
        if (near?.commit) {
          approximate = approximate || near.approximate;
          for (const d of changed) {
            attributionMap[d.tool] = {
              sha: near.commit.sha,
              url: near.commit.url,
              imageVersion: near.commit.imageVersion,
              date: near.commit.date,
              exact: !near.approximate,
            };
          }
        }
      } else {
        attributionMap = await attributeChanges(label, diffs, window, {
          candidates: MANIFEST_CANDIDATES,
        });
      }
    } catch (err) {
      const msg = errorText(err);
      out(io.stdout, `::warning title=runner-drift::Attribution unavailable — ${msg}`);
    }
  }

  const explained = await explainDrift({ migration, lock, label, scan, env });

  const summary = stepSummaryMarkdown({
    label,
    explains: explained,
    fromLabel: movedLabel ? lock.label : null,
    fromImage: lock.imageVersion ?? '(unknown)',
    toImage: imageVersion,
    diffs,
    attribution: attributionMap,
    approximate,
    written: updateLock,
    lockFile,
  });
  if (opts.summary) await writeStepSummary(summary);

  for (const line of annotations(diffs, attributionMap, label)) out(io.stdout, line);

  if (updateLock) {
    const kept = Object.create(null);
    for (const t of unobserved) {
      const entry = lookup(lock.tools ?? {}, t);
      if (entry) kept[t] = entry;
    }
    await writeLock(
      { label, imageOS, imageVersion, tools: { ...observed, ...kept }, updatedAt: new Date().toISOString() },
      lockFile,
    );
  }

  if (opts.json) {
    const payload = { label, fromLabel: lock.label ?? null, from: lock.imageVersion, to: imageVersion, approximate, written: updateLock, diffs, attribution: attributionMap };
    // The tools missing from `diffs` and why, or a consumer reading the document
    // sees a shorter list than the lock holds with the reason only on stdout.
    if (unobserved.size) payload.notCompared = [...unobserved];
    payload.explains = explained?.label ?? null;
    if (retirement) payload.retirement = retirement;
    if (migration) payload.migration = { ...migration, explains: explained?.label ?? null };
    out(io.stdout, JSON.stringify(payload, null, 2));
  } else if (!changed.length) {
    out(io.stdout, `No drift — ${imageRange}, ${diffs.length} tool(s) unchanged.`);
  } else {
    out(io.stdout, `${imageRange}${approximate ? ' (attribution approximate)' : ''}`);
    if (explained) {
      out(
        io.stdout,
        `Explained by the scheduled ${explained.label} migration ${explained.from} -> ${explained.to}` +
          ` (${explained.starts} to ${explained.ends}); the tool versions below moved with the image.`,
      );
    }
    for (const d of changed) {
      const a = lookup(attributionMap, d.tool);
      out(
        io.stdout,
        `  ${d.tool} ${d.from.join(',') || '(absent)'} -> ${d.to.join(',') || '(absent)'}  ${d.detail}` +
          (a ? `  [${a.imageVersion ?? a.sha.slice(0, 7)}${a.exact ? '' : ' approx'}] ${a.url}` : ''),
      );
    }
  }

  const driftFail = shouldFail(diffs, failOn);
  if (driftFail) {
    out(io.stderr, `runner-drift: ${maxSeverity(diffs).toUpperCase()} drift detected and --fail-on ${failOn} is set.`);
  }
  if (retiring) reportRetirement(io, retiring);
  if (migrating) reportMigration(io, migrating);
  return driftFail || retiring || migrating ? EXIT_DRIFT : EXIT_OK;
}

/* -------------------------------------------------------------------- plan */

export async function runPlan(opts, io = process, deps = {}) {
  const load = deps.loadManifest ?? loadManifest;
  const now = deps.now ?? new Date();

  let from = normaliseLabel(opts.from ?? '');
  let to = normaliseLabel(opts.to ?? '');

  // A floating --from on its own is the announced migration: resolve it to the
  // two concrete labels the window names. With an explicit --to the user has
  // already said what to compare, so the refusal below still applies.
  const migration = from && !to ? migrationStatus(from, { now }) : null;
  if (migration) {
    from = migration.from;
    to = migration.to;
  }

  if (!from || !to) {
    out(io.stderr, 'plan needs both --from <label> and --to <label>.');
    out(io.stderr, 'e.g. runner-drift plan --from ubuntu-22.04 --to ubuntu-24.04');
    out(io.stderr, `Floating labels with an announced migration need only --from: ${migratingLabels().join(', ')}`);
    return EXIT_USAGE;
  }
  for (const [flag, label] of [['--from', from], ['--to', to]]) {
    if (isFloating(label)) {
      out(io.stderr, `${flag} ${label} is a floating label — GitHub re-points it without notice.`);
      out(io.stderr, 'Pass the concrete label you want to compare, e.g. ubuntu-24.04 or ubuntu-26.04.');
      if (migrationFor(label)) {
        out(io.stderr, `Or drop --to: runner-drift plan --from ${label} diffs the two images GitHub announced.`);
      }
      return EXIT_USAGE;
    }
  }

  const workflows = opts.workflows ?? path.join('.github', 'workflows');
  const detected = deps.detected ?? (await detect(workflows));
  let tools = parseToolList(opts.tools);
  if (!tools?.length) {
    if (detected.missing) {
      out(io.stderr, `No workflow directory at ${detected.dir}.`);
      out(io.stderr, 'Pass --workflows <path>, or name the tools directly with --tools python,cmake,clang');
      return EXIT_USAGE;
    }
    tools = detected.tools;
  }
  if (!tools.length) {
    out(io.stderr, `No known tools detected in ${detected.files.length} workflow file(s) under ${detected.dir}.`);
    out(io.stderr, 'Pass them explicitly: --tools python,cmake,clang');
    out(io.stderr, `Recognised tools: ${knownTools().join(', ')}`);
    return EXIT_USAGE;
  }

  const [a, b] = await Promise.all([load(from), load(to)]);
  for (const m of [a, b]) {
    if (m.skipped) {
      out(io.stderr, m.reason);
      out(io.stderr, `Known labels: ${knownLabels().join(', ')}`);
      return EXIT_USAGE;
    }
  }

  const { diffs, notOnManifest: missingBoth } = diffManifestTools(a, b, tools);

  if (opts.json) {
    out(
      io.stdout,
      JSON.stringify(
        {
          from,
          to,
          fromImage: a.imageVersion,
          toImage: b.imageVersion,
          deadline: deadlineFor(from),
          migration,
          tools,
          image: imageDiffs(a, b).filter((d) => d.changed),
          diffs: diffs.filter((d) => d.changed),
          unchanged: diffs.filter((d) => !d.changed).map((d) => d.tool),
          notOnManifest: missingBoth,
        },
        null,
        2,
      ),
    );
    return EXIT_OK;
  }

  out(
    io.stdout,
    planReport({
      from,
      to,
      fromImage: a.imageVersion,
      toImage: b.imageVersion,
      diffs,
      image: imageDiffs(a, b),
      migration,
      detected: { missingFromManifest: missingBoth },
      now,
    }),
  );
  return EXIT_OK;
}

/* ----------------------------------------------------------------- runners */

/**
 * `runner-drift runners` — the self-hosted agent-version lane. Needs no lock
 * file and no runner of its own, so it runs as a plain lint job beside
 * `guard --fail-on-retirement`.
 */
export async function runRunners(opts, io = process, env = process.env, deps = {}) {
  const resolved = resolveScope({ repo: opts.repo, org: opts.org, env });
  if (resolved.error) {
    out(io.stderr, resolved.error);
    if (resolved.detail) out(io.stderr, resolved.detail);
    return EXIT_USAGE;
  }
  const window = deprecationWindow(opts, io);
  if (!window) return EXIT_USAGE;

  const survey = await surveyRunners(resolved.scope, {
    ...window,
    now: deps.now ?? new Date(),
    runsOnTargets: await runsOnTargetsFor(scanner(opts)),
    fetch: deps.fetchJson,
  });

  for (const line of runnersAnnotations(survey)) out(io.stdout, line);
  if (opts.summary) await writeStepSummary(runnersSummaryMarkdown(survey));
  out(io.stdout, opts.json ? JSON.stringify(survey, null, 2) : runnersReport(survey));

  if (survey.status !== SURVEY_STATUS.OK) return EXIT_OK;
  if (!survey.failing) return EXIT_OK;
  reportDeprecation(io, survey);
  return EXIT_DRIFT;
}

/* ----------------------------------------------------------------- actions */

/**
 * `runner-drift actions` — the action-runtime lane. Resolves every `uses:` in
 * the repository to the `runs.using` of the action it names, following
 * composites into their own steps, so the report names the reference that
 * actually stops working rather than the one you wrote.
 */
export async function runActions(opts, io = process, deps = {}) {
  const survey = await surveyActions({
    root: deps.root ?? '.',
    workflows: opts.workflows ?? null,
    now: deps.now ?? new Date(),
    fetchText: deps.fetchText,
    fetchJson: deps.fetchJson,
  });

  if (opts.json) {
    out(io.stdout, JSON.stringify(survey, null, 2));
  } else {
    for (const line of actionsAnnotations(survey)) out(io.stdout, line);
    out(io.stdout, actionsReport(survey));
  }
  if (opts.summary) await writeStepSummary(actionsSummaryMarkdown(survey));
  await writeOutput('will-fail-count', String(survey.counts.fail));

  const reasons = [];
  if (survey.failing) {
    const failing = survey.references.filter((r) => r.status === REF_STATUS.FAIL).map((r) => r.ref);
    reasons.push(
      `runner-drift: ${failing.length} action reference(s) stop working when Node 20 leaves the runners on ${survey.removalDate}: ${failing.join(', ')}`,
    );
  }
  // Opt-in, because "could not resolve" is a proxy or a private repo as often as
  // it is a real gap, and a tool that fails the build on a network blip is a
  // tool people disable.
  if (opts['fail-on-unknown'] && survey.counts.unknown) {
    const unresolved = survey.references
      .filter((r) => r.status === REF_STATUS.UNKNOWN)
      .map((r) => r.ref);
    reasons.push(
      `runner-drift: ${unresolved.length} action reference(s) could not be resolved, and --fail-on-unknown treats unchecked as failing: ${unresolved.join(', ')}`,
    );
  }
  for (const line of reasons) out(io.stderr, line);

  if (!reasons.length) return EXIT_OK;
  return opts['warn-only'] ? EXIT_OK : EXIT_DRIFT;
}

/* ---------------------------------------------------------------- dispatch */

export async function main(argv = process.argv.slice(2), io = process) {
  let parsed;
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;
  const rest = command ? argv.slice(1) : argv;
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    out(io.stderr, `runner-drift: ${err.message}`);
    out(io.stderr, '');
    out(io.stderr, USAGE);
    return EXIT_USAGE;
  }
  const opts = resolveNegations(parsed.values);

  if (opts.version) {
    out(io.stdout, await version());
    return EXIT_OK;
  }
  if (opts.help || !command) {
    out(opts.help ? io.stdout : io.stderr, USAGE);
    return opts.help ? EXIT_OK : EXIT_USAGE;
  }

  const deps = asOf(opts, io);
  if (!deps) return EXIT_USAGE;

  try {
    switch (command) {
      case 'init':
        return await runInit(opts, io);
      case 'guard':
        return await runGuard(opts, io, process.env, deps);
      case 'plan':
        return await runPlan(opts, io, deps);
      case 'runners':
        return await runRunners(opts, io, process.env, deps);
      case 'actions':
        return await runActions(opts, io, { ...deps, root: parsed.positionals[0] });
      case 'help':
        out(io.stdout, USAGE);
        return EXIT_OK;
      default:
        out(io.stderr, `Unknown command "${command}".`);
        out(io.stderr, '');
        out(io.stderr, USAGE);
        return EXIT_USAGE;
    }
  } catch (err) {
    if (err instanceof DriftError) {
      out(io.stderr, `runner-drift: ${err.message}`);
      if (err.hint) out(io.stderr, err.hint);
      return EXIT_USAGE;
    }
    out(io.stderr, `runner-drift: unexpected error — ${err?.message ?? err}`);
    if (process.env.RUNNER_DRIFT_DEBUG) out(io.stderr, err?.stack ?? '');
    out(io.stderr, 'Please report this at https://github.com/Booyaka101/runner-drift/issues');
    return EXIT_USAGE;
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`runner-drift: fatal — ${err?.stack ?? err}\n`);
      process.exitCode = EXIT_USAGE;
    });
}
