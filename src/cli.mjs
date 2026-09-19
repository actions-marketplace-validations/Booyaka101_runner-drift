#!/usr/bin/env node
/**
 * runner-drift — lock the tool versions your CI actually uses, diff them on
 * every runner-image bump, and plan a label migration before the deadline.
 */

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DriftError } from './http.mjs';
import {
  IMAGE_OS_TO_LABEL,
  deadlineFor,
  isFloating,
  knownLabels,
  normaliseLabel,
} from './labels.mjs';
import { loadManifest, lookupTool } from './manifest.mjs';
import { attribute, commitWindow, attributeChanges, listManifestCommits, manifestAtSha } from './history.mjs';
import { detect, SELF_HOSTED } from './detect.mjs';
import { canonicalTool, manifestCandidates, knownTools, MANIFEST_CANDIDATES } from './tools.mjs';
import { probeTool, isProbeable } from './probe.mjs';
import { diffTool, shouldFail, maxSeverity } from './diff.mjs';
import { readLock, writeLock, DEFAULT_LOCK_FILE, toolsEntry, toVersionMap } from './lock.mjs';
import {
  planReport,
  stepSummaryMarkdown,
  annotations,
  notice,
  retirementFindings,
  retirementAnnotations,
  retirementSummaryMarkdown,
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

export const EXIT_OK = 0;
export const EXIT_DRIFT = 1;
export const EXIT_USAGE = 2;

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function version() {
  try {
    const pkg = JSON.parse(await readFile(path.join(HERE, '..', 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    return '1.3.0';
  }
}

const USAGE = `runner-drift — GitHub Actions runner-image tool drift, locked and attributed.

Usage:
  runner-drift init  [options]                 Record a baseline runner-lock.json
  runner-drift guard [options]                 (in-workflow) diff live runner vs the lock
  runner-drift plan  --from <label> --to <label>   Preview a runner label migration
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
  --org <name>          organization to survey             (runners)
  --repo <owner/repo>   repository to survey               (runners, default: $GITHUB_REPOSITORY)
  --fail-on-deprecation <days>  fail if a runner version's support ends within N days
                                (runners, guard; default window ${DEFAULT_DEPRECATION_WINDOW_DAYS})
  --warn-only           report but always exit 0             (actions)
  --fail-on-unknown     fail when a uses: cannot be resolved (actions)
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
  'fail-on-deprecation': { type: 'string' },
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

/** Resolve canonical tool names against a parsed manifest. */
export function resolveManifestVersions(manifest, tools) {
  const map = {};
  const missing = [];
  for (const t of tools) {
    const hit = lookupTool(manifest, manifestCandidates(t));
    if (hit) map[t] = hit.versions;
    else missing.push(t);
  }
  return { map, missing };
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

/**
 * `--fail-on-retirement`: every pinned label that retires or browns out inside
 * the window. Reads the workflow files alone, so it works in a lint job with no
 * lock file and no hosted runner. Returns null on a bad value, already reported.
 */
async function checkRetirement(opts, io, now) {
  const days = wholeDays(opts['fail-on-retirement'], '--fail-on-retirement', io);
  if (days === null) return null;
  const scanned = await detect(opts.workflows ?? path.join('.github', 'workflows'));
  if (scanned.missing) {
    const msg = `No workflow directory at ${scanned.dir} — no pinned labels to check for retirement.`;
    out(io.stdout, notice(msg));
    out(io.stdout, msg);
    return { days, findings: [] };
  }
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
        ? `runner-drift: ${s.label} has been fully unsupported since ${s.fullyUnsupported} (retired ${Math.abs(s.daysToUnsupported)} days ago) and --fail-on-retirement ${days} is set.`
        : `runner-drift: ${s.label} is fully unsupported on ${s.fullyUnsupported} (${s.daysToUnsupported} days) and --fail-on-retirement ${days} is set.`,
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
          ? `runner-drift: ${fleet} lost runtime support on ${g.runtime.date} (${Math.abs(g.runtime.days)} days ago) — jobs are no longer queued to them.`
          : `runner-drift: ${fleet} lose runtime support on ${g.runtime.date} (${g.runtime.days} days)${because}.`;
      }
      return g.registration.past
        ? `runner-drift: ${fleet} lost registration on ${g.registration.date} (${Math.abs(g.registration.days)} days ago) — they cannot reregister.`
        : `runner-drift: ${fleet} lose registration on ${g.registration.date} (${g.registration.days} days)${because}.`;
    },
  );
}

/**
 * The `runs-on:` targets on disk, so the runner lane can name the jobs an
 * at-risk runner actually serves. Absent workflows are silent: `runners` is
 * documented as needing no repository checkout.
 */
async function runsOnTargetsFor(opts) {
  const scanned = await detect(opts.workflows ?? path.join('.github', 'workflows'));
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
  const lockTools = {};
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
async function checkOwnRunner(opts, io, env, deps, window) {
  const name = env.RUNNER_NAME;
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || env.INPUT_GITHUB_TOKEN;
  if (!name || !token) return null;
  const { scope } = resolveScope({ repo: opts.repo, org: opts.org, env });
  if (!scope) return null;

  const survey = await surveyRunners(scope, {
    ...window,
    now: deps.now ?? new Date(),
    onlyRunnerName: name,
    runsOnTargets: await runsOnTargetsFor(opts),
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
    retirement = await checkRetirement(opts, io, deps.now ?? new Date());
    if (!retirement) return EXIT_USAGE;
  }
  const retiring = retirement?.findings.length ? retirement : null;

  const imageVersion = env.ImageVersion ?? env.IMAGE_VERSION ?? null;
  const imageOS = env.ImageOS ?? env.IMAGE_OS ?? null;

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
    const own = await checkOwnRunner(opts, io, env, deps, window);
    if (opts.json && own) {
      const payload = { runners: own };
      if (retirement) payload.retirement = retirement;
      out(io.stdout, JSON.stringify(payload, null, 2));
    }
    if (retiring) reportRetirement(io, retiring);
    if (own?.failing) reportDeprecation(io, own);
    return retiring || own?.failing ? EXIT_DRIFT : EXIT_OK;
  }

  const lock = await readLock(lockFile);
  let label = (imageOS && IMAGE_OS_TO_LABEL[imageOS.toLowerCase()]) || lock?.label || null;

  if (!label) {
    const detected = await detect(opts.workflows ?? path.join('.github', 'workflows'));
    label = concreteLabels(detected.labels)[0] ?? null;
  }
  if (!label) {
    const msg = `Unknown runner label (ImageOS="${imageOS ?? '(unset)'}") — skipping. Known: ${knownLabels().join(', ')}`;
    out(io.stdout, `::warning title=runner-drift::${msg}`);
    out(io.stdout, msg);
    if (retiring) {
      reportRetirement(io, retiring);
      return EXIT_DRIFT;
    }
    return EXIT_OK;
  }

  // Which tools to watch.
  let tools = parseToolList(opts.tools);
  if (!tools?.length && lock?.tools && Object.keys(lock.tools).length) {
    tools = Object.keys(lock.tools);
  }
  if (!tools?.length) {
    const detected = await detect(opts.workflows ?? path.join('.github', 'workflows'));
    tools = detected.tools;
  }
  if (!tools.length) {
    out(io.stderr, 'No tools detected in your workflows and none in the lock file.');
    out(io.stderr, 'Pass them explicitly: runner-drift guard --tools python,cmake,clang');
    return EXIT_USAGE;
  }

  // Observe the live runner: probe first, manifest as the fallback.
  const observed = {};
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

  if (needManifest.length) {
    try {
      attribution0 = await attribute(label, imageVersion);
      if (attribution0?.commit) {
        approximate = attribution0.approximate;
        manifest = await manifestAtSha(label, attribution0.commit.sha);
      }
      if (!manifest) {
        const m = await loadManifest(label);
        manifest = m.skipped ? null : m;
      }
    } catch (err) {
      infraWarnings.push(err instanceof DriftError ? `${err.message}${err.hint ? ` ${err.hint}` : ''}` : String(err));
    }
    if (manifest) {
      const { map, missing } = resolveManifestVersions(manifest, needManifest);
      for (const [t, versions] of Object.entries(map)) {
        observed[t] = toolsEntry(versions, 'manifest');
      }
      for (const t of missing) {
        infraWarnings.push(`${t}: not probeable here and not listed on the ${label} manifest — skipped.`);
      }
    } else {
      for (const t of needManifest) {
        infraWarnings.push(`${t}: not probeable here and the ${label} manifest could not be fetched — skipped.`);
      }
    }
  }

  for (const w of infraWarnings) out(io.stdout, `::warning title=runner-drift::${w}`);

  // First run: record the baseline and stop.
  if (!lock) {
    const written = await writeLock(
      { label, imageOS, imageVersion, tools: observed, updatedAt: new Date().toISOString() },
      lockFile,
    );
    const summary = stepSummaryMarkdown({
      label,
      toImage: imageVersion,
      diffs: Object.keys(observed),
      baseline: true,
      lockFile,
    });
    if (opts.summary) await writeStepSummary(summary);
    if (opts.json) {
      out(
        io.stdout,
        JSON.stringify(
          retirement ? { baseline: true, lock: written, retirement } : { baseline: true, lock: written },
          null,
          2,
        ),
      );
    } else {
      out(io.stdout, `baseline recorded — ${label} image ${imageVersion}`);
      for (const n of probeNotes) out(io.stdout, `  ${n}`);
      const manifestOnly = Object.entries(observed).filter(([, v]) => v.source === 'manifest');
      for (const [t, v] of manifestOnly) out(io.stdout, `  ${t}: ${v.versions.join(', ')} (from manifest)`);
      out(io.stdout, `Wrote ${lockFile}. Commit it so the next image bump can be diffed.`);
    }
    if (retiring) {
      reportRetirement(io, retiring);
      return EXIT_DRIFT;
    }
    return EXIT_OK;
  }

  // Diff against the lock.
  const lockedMap = toVersionMap(lock.tools);
  const observedMap = toVersionMap(observed);
  const watched = tools.filter((t) => t in lockedMap || t in observedMap);
  const diffs = watched.map((t) => diffTool(t, lockedMap[t] ?? null, observedMap[t] ?? null));
  const changed = diffs.filter((d) => d.changed);

  // Attribute each change to the runner-images commit that shipped it.
  let attributionMap = {};
  if (changed.length && lock.imageVersion && lock.imageVersion !== imageVersion) {
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
      const msg = err instanceof DriftError ? `${err.message}${err.hint ? ` ${err.hint}` : ''}` : String(err);
      out(io.stdout, `::warning title=runner-drift::Attribution unavailable — ${msg}`);
    }
  }

  const summary = stepSummaryMarkdown({
    label,
    fromImage: lock.imageVersion ?? '(unknown)',
    toImage: imageVersion,
    diffs,
    attribution: attributionMap,
    approximate,
    lockFile,
  });
  if (opts.summary) await writeStepSummary(summary);

  for (const line of annotations(diffs, attributionMap, label)) out(io.stdout, line);

  if (opts['update-lock']) {
    await writeLock(
      { label, imageOS, imageVersion, tools: observed, updatedAt: new Date().toISOString() },
      lockFile,
    );
  }

  if (opts.json) {
    const payload = { label, from: lock.imageVersion, to: imageVersion, approximate, diffs, attribution: attributionMap };
    if (retirement) payload.retirement = retirement;
    out(io.stdout, JSON.stringify(payload, null, 2));
  } else if (!changed.length) {
    out(io.stdout, `No drift — ${label} image ${lock.imageVersion} -> ${imageVersion}, ${diffs.length} tool(s) unchanged.`);
  } else {
    out(io.stdout, `${label} image ${lock.imageVersion} -> ${imageVersion}${approximate ? ' (attribution approximate)' : ''}`);
    for (const d of changed) {
      const a = attributionMap[d.tool];
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
  return driftFail || retiring ? EXIT_DRIFT : EXIT_OK;
}

/* -------------------------------------------------------------------- plan */

export async function runPlan(opts, io = process, deps = {}) {
  const load = deps.loadManifest ?? loadManifest;
  const now = deps.now ?? new Date();

  const from = normaliseLabel(opts.from ?? '');
  const to = normaliseLabel(opts.to ?? '');
  if (!from || !to) {
    out(io.stderr, 'plan needs both --from <label> and --to <label>.');
    out(io.stderr, 'e.g. runner-drift plan --from ubuntu-22.04 --to ubuntu-24.04');
    return EXIT_USAGE;
  }
  for (const [flag, label] of [['--from', from], ['--to', to]]) {
    if (isFloating(label)) {
      out(io.stderr, `${flag} ${label} is a floating label — GitHub re-points it without notice.`);
      out(io.stderr, 'Pass the concrete label you want to compare, e.g. ubuntu-24.04 or ubuntu-26.04.');
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

  const ra = resolveManifestVersions(a, tools);
  const rb = resolveManifestVersions(b, tools);
  const missingBoth = tools.filter((t) => ra.missing.includes(t) && rb.missing.includes(t));
  const comparable = tools.filter((t) => !missingBoth.includes(t));
  const diffs = comparable.map((t) => diffTool(t, ra.map[t] ?? null, rb.map[t] ?? null));

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
          tools,
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
    runsOnTargets: await runsOnTargetsFor(opts),
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

  try {
    switch (command) {
      case 'init':
        return await runInit(opts, io);
      case 'guard':
        return await runGuard(opts, io);
      case 'plan':
        return await runPlan(opts, io);
      case 'runners':
        return await runRunners(opts, io);
      case 'actions':
        return await runActions(opts, io, { root: parsed.positionals[0] });
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
