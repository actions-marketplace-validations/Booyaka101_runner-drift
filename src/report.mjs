/**
 * Output formatting: plain-text plan report, GitHub step-summary markdown,
 * and ::warning workflow annotations.
 *
 * Two lanes share every primitive below — hosted-image retirements (dates from
 * the table in labels.mjs) and self-hosted runner-version deprecations (dates
 * from the API, via runners.mjs). Countdown wording, annotation escaping and
 * table rendering are written once here and called from both.
 */

import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { daysUntil } from './dates.mjs';
import {
  MIGRATION_STATE,
  deadlineFor,
  retirementStatus,
} from './labels.mjs';
import { REF_STATUS } from './runtimes.mjs';
import { lookup } from './tables.mjs';
import {
  MINIMUM_REGISTRATION_VERSION,
  RUNNER_STATUS,
  SURVEY_STATUS,
  belowRegistrationMinimum,
  endpointLabel,
  statusFails,
} from './runners.mjs';

export { daysUntil };

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `(82 days)` / `(60 days ago)` — the countdown suffix both lanes print. */
export function countdown(days) {
  if (days === null || days === undefined) return '';
  return days < 0 ? `(${plural(Math.abs(days), 'day')} ago)` : `(${plural(days, 'day')})`;
}

/** `2026-11-02 (82 days)`. A full ISO date-time is trimmed to its date. */
export function dateWithCountdown(date, days) {
  return `${String(date ?? '').slice(0, 10)} ${countdown(days)}`.trim();
}

function joinVersions(list) {
  return list.join(',');
}

/** `Python 3.10.12 -> 3.12.3  MINOR` */
export function planRow(d) {
  const from = d.from.length ? joinVersions(d.from) : '(absent)';
  const to = d.to.length ? joinVersions(d.to) : '(absent)';
  return `${d.tool} ${from} -> ${to}  ${d.detail}`;
}

/**
 * The deadline block for the source label, or null when the label has no
 * announced deadline.
 */
export function deadlineLines(label, now = new Date()) {
  const dl = deadlineFor(label);
  if (!dl) return null;
  const lines = [];
  const brownout = dl.brownouts?.[0];
  lines.push(
    brownout
      ? `${label} is fully unsupported on ${dl.fullyUnsupported}; brownouts begin ${brownout} (source: ${dl.sourceRef})`
      : `${label} is fully unsupported on ${dl.fullyUnsupported} (source: ${dl.sourceRef})`,
  );
  const left = daysUntil(dl.fullyUnsupported, now);
  const untilBrownout = brownout ? daysUntil(brownout, now) : null;
  const countdownLine =
    left === null
      ? null
      : left > 0
        ? `${plural(left, 'day')} left${untilBrownout !== null && untilBrownout > 0 ? ` (${plural(untilBrownout, 'day')} until the first brownout)` : ''}`
        : `retired ${plural(Math.abs(left), 'day')} ago`;
  if (countdownLine) {
    lines.push(`${countdownLine} — deprecation began ${dl.deprecationStart}; see ${dl.source}`);
  }
  if (dl.brownoutWindow && dl.brownouts?.length) {
    lines.push(`brownout windows (${dl.brownoutWindow}): ${dl.brownouts.join(', ')}`);
  }
  if (dl.migrateTo?.length) {
    lines.push(`announced migration targets: ${dl.migrateTo.join(', ')}`);
  }
  return lines;
}

/**
 * Full `plan` report. `image` is the manifest-header diff (OS, kernel, systemd)
 * and `migration` the survey that resolved a floating label, both optional.
 * @returns {string}
 */
export function planReport({
  from,
  to,
  fromImage,
  toImage,
  diffs,
  image = [],
  migration = null,
  detected,
  now = new Date(),
}) {
  const out = [];
  // The migration headline first: when `plan` resolved a floating label, it is
  // the reason these two concrete labels are being compared at all.
  if (migration) out.push(...migrationHeader(migration));
  out.push(`${from} -> ${to} (images ${fromImage} -> ${toImage})`);
  const dl = deadlineLines(from, now);
  if (dl) out.push(...dl);
  else out.push(`${from} has no announced deprecation deadline in runner-drift's table.`);
  out.push('');

  const imageChanged = image.filter((d) => d.changed);
  if (imageChanged.length) {
    for (const d of imageChanged) out.push(planRow(d));
    out.push('');
  }

  const changed = diffs.filter((d) => d.changed);
  if (!changed.length) {
    out.push(`No change to any of the ${diffs.length} tool(s) your workflows use.`);
  } else {
    for (const d of changed) out.push(planRow(d));
    out.push('');
    const unchanged = diffs.length - changed.length;
    out.push(
      `${changed.length} of ${diffs.length} detected tool(s) change` +
        (unchanged ? `; ${unchanged} unchanged (not shown)` : ''),
    );
  }
  if (detected?.missingFromManifest?.length) {
    out.push(
      `Not listed on either image manifest (skipped): ${detected.missingFromManifest.join(', ')}`,
    );
  }
  return out.join('\n');
}

const SEVERITY_BADGE = {
  major: '🔴 MAJOR',
  minor: '🟠 MINOR',
  patch: '🟡 PATCH',
  none: '⚪ none',
};

/** GitHub step-summary markdown for a `guard` run. */
export function stepSummaryMarkdown({
  label,
  fromLabel = null,
  fromImage,
  toImage,
  diffs,
  attribution = {},
  approximate = false,
  baseline = false,
  written = true,
  explains = null,
  lockFile,
}) {
  const lines = [];
  lines.push('## runner-drift');
  lines.push('');
  if (baseline) {
    const count = Object.keys(diffs).length || diffs.length;
    lines.push(
      written
        ? `Baseline recorded for \`${label}\` at image \`${toImage}\` — ${count} tool(s) locked in \`${lockFile}\`.`
        : `Baseline observed for \`${label}\` at image \`${toImage}\` — ${count} tool(s). Nothing written: \`--no-update-lock\` is set.`,
    );
    lines.push('');
    lines.push(
      written
        ? 'The next run on a bumped image will diff against this baseline.'
        : `Drop the flag to record \`${lockFile}\`, and the next run on a bumped image has something to diff against.`,
    );
    return `${lines.join('\n')}\n`;
  }

  const changed = diffs.filter((d) => d.changed);
  lines.push(
    fromLabel && fromLabel !== label
      ? `\`${fromLabel}\` image \`${fromImage}\` → \`${label}\` image \`${toImage}\``
      : `\`${label}\` image \`${fromImage}\` → \`${toImage}\``,
  );
  if (approximate) {
    lines.push('');
    lines.push(
      '> ⚠️ **approximate** — this image version has no matching commit in the runner-images readme history yet (the readme lags the rollout), so attribution uses the nearest earlier commit.',
    );
  }
  lines.push('');
  if (!changed.length) {
    lines.push(`No tool drift across ${diffs.length} locked tool(s).`);
    return `${lines.join('\n')}\n`;
  }

  if (explains) {
    lines.push(
      `> 📅 Explained by the scheduled \`${explains.label}\` migration \`${explains.from}\` → ` +
        `\`${explains.to}\` (${explains.starts} to ${explains.ends}). The tools below moved with the image.`,
    );
    lines.push('');
  }

  const rows = changed.map((d) => {
    const a = lookup(attribution, d.tool);
    const shipped = a
      ? `[${a.imageVersion ?? a.sha.slice(0, 7)}](${a.url})${a.exact ? '' : ' _(approx)_'}`
      : '—';
    const badge = SEVERITY_BADGE[d.severity] ?? d.severity;
    const change = d.detail === d.severity.toUpperCase() ? badge : `${badge} — ${d.detail}`;
    return [`\`${d.tool}\``, d.from.join(', ') || '—', d.to.join(', ') || '—', change, shipped];
  });
  lines.push(...markdownTable(['Tool', 'Locked', 'Now', 'Change', 'Shipped by'], rows));
  lines.push('');
  lines.push(
    written
      ? `Lock file \`${lockFile}\` updated to image \`${toImage}\`.`
      : `Lock file \`${lockFile}\` left at image \`${fromImage}\`: \`--no-update-lock\` is set.`,
  );
  return `${lines.join('\n')}\n`;
}

function escapeAnnotation(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * A `file=` value GitHub can actually resolve.
 *
 * It matches the value against the repository tree, so the path has to be
 * repo-relative and POSIX-separated. Two ways that goes wrong on a real runner
 * and neither is obvious, because a bad path is not an error — the annotation
 * just quietly attaches to the step instead of the line:
 *   - `action.yml` passes `--workflows` as an absolute path, so every path
 *     `detect()` builds from it is absolute too.
 *   - on a Windows runner `path.join` yields backslashes.
 */
export function annotationPath(file, env = process.env) {
  const raw = String(file ?? '');
  const root = env.GITHUB_WORKSPACE || process.cwd();
  let out = raw;
  if (path.isAbsolute(raw)) {
    const rel = path.relative(root, raw);
    // Outside the workspace: nothing better to offer, so leave it alone rather
    // than emit a `../..` path GitHub would reject either way.
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) out = rel;
  }
  return out.replaceAll('\\', '/');
}

/**
 * One workflow-log annotation. `site` ({file,line,col}) makes it a file
 * annotation; without one GitHub attributes it to the step.
 */
export function annotation(kind, title, message, site = null) {
  const where = site
    ? `file=${escapeAnnotation(annotationPath(site.file))},line=${site.line},col=${site.col},`
    : '';
  return `::${kind} ${where}title=${escapeAnnotation(title)}::${escapeAnnotation(message)}`;
}

/** `::warning ...` lines for the workflow log. */
export function annotations(diffs, attribution = {}, label = '') {
  return diffs
    .filter((d) => d.changed)
    .map((d) => {
      const a = lookup(attribution, d.tool);
      const where = a ? ` — shipped by ${a.imageVersion ?? a.sha.slice(0, 7)} ${a.url}` : '';
      const sev = d.severity.toUpperCase();
      const detail = d.detail === sev ? sev : `${sev}: ${d.detail}`;
      const msg = `${d.tool} drifted on ${label}: ${d.from.join(', ') || '(absent)'} -> ${d.to.join(', ') || '(absent)'} (${detail})${where}`;
      return annotation('warning', `runner-drift: ${d.tool} ${d.severity}`, msg);
    });
}

export function notice(message) {
  return annotation('notice', 'runner-drift', message);
}

/**
 * Header, separator and body rows of a GitHub-flavoured markdown table. Cells
 * are escaped, because runner names are user-controlled and a bare `|` silently
 * splits the row into the wrong columns.
 */
export function markdownTable(headers, rows) {
  const cell = (v) => String(v).replaceAll('|', '\\|');
  return [
    `| ${headers.map(cell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ];
}

/**
 * One finding per label site that retires, browns out or is already retired
 * within `days`. A retired label always fires, whatever the threshold.
 */
export function retirementFindings(labelSites, { now = new Date(), days } = {}) {
  const findings = [];
  for (const site of labelSites ?? []) {
    const status = retirementStatus(site.label, now);
    if (!status) continue;
    const retiring = status.retired || status.daysToUnsupported <= days;
    const brownoutSoon = status.daysToBrownout !== null && status.daysToBrownout <= days;
    if (!retiring && !brownoutSoon) continue;
    findings.push({ ...site, status, trigger: retiring ? 'retirement' : 'brownout' });
  }
  return findings;
}

function retirementMessage(s) {
  const migrate = `Migrate to ${s.migrateTo.join(', ')}.`;
  if (s.retired) {
    return `${s.label} retired ${plural(Math.abs(s.daysToUnsupported), 'day')} ago — fully unsupported since ${s.fullyUnsupported}. ${migrate} See ${s.source}`;
  }
  const brownout = s.nextBrownout
    ? `; next brownout ${dateWithCountdown(s.nextBrownout, s.daysToBrownout)}`
    : '';
  return `${s.label} is fully unsupported on ${dateWithCountdown(s.fullyUnsupported, s.daysToUnsupported)}${brownout}. ${migrate} See ${s.source}`;
}

/**
 * `::error file=,line=,col=` lines pointing at each pinned label. A brownout
 * inside the threshold with retirement still beyond it is a ::warning.
 */
export function retirementAnnotations(findings) {
  return findings.map((f) => {
    const s = f.status;
    let kind = 'error';
    let title = `runner-drift: ${s.label} retires in ${plural(s.daysToUnsupported, 'day')}`;
    if (s.retired) {
      title = `runner-drift: ${s.label} retired ${plural(Math.abs(s.daysToUnsupported), 'day')} ago`;
    } else if (f.trigger === 'brownout') {
      kind = 'warning';
      title = `runner-drift: ${s.label} deprecation`;
    }
    return annotation(kind, title, retirementMessage(s), f);
  });
}

/** Step-summary table for retirement findings. */
export function retirementSummaryMarkdown(findings) {
  const rows = findings.map((f) => {
    const s = f.status;
    return [
      `\`${s.label}\``,
      `\`${annotationPath(f.file)}:${f.line}\``,
      s.nextBrownout ? dateWithCountdown(s.nextBrownout, s.daysToBrownout) : '—',
      s.retired
        ? `${s.fullyUnsupported} (retired ${plural(Math.abs(s.daysToUnsupported), 'day')} ago)`
        : dateWithCountdown(s.fullyUnsupported, s.daysToUnsupported),
      s.migrateTo.map((m) => `\`${m}\``).join(', '),
      `[${s.sourceRef}](${s.source})`,
    ];
  });
  const lines = [
    '## runner-drift — retirement',
    '',
    ...markdownTable(
      ['Label', 'Where', 'Next brownout', 'Fully unsupported', 'Migrate to', 'Source'],
      rows,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------ floating-label migration */

/**
 * One sentence per state. Wording is the point of this lane: the same window
 * means something different depending on whether the runner has moved yet, and
 * a single generic warning would hide exactly that.
 */
const MIGRATION_SENTENCE = {
  [MIGRATION_STATE.PENDING]: (s) =>
    `${s.label} moves from ${s.from} to ${s.to}. The rollout starts ${dateWithCountdown(s.starts, s.daysToStart)} and finishes ${dateWithCountdown(s.ends, s.daysToEnd)}.`,
  [MIGRATION_STATE.MOVED_EARLY]: (s) =>
    `${s.label} already served ${s.to}, ahead of the announced rollout starting ${dateWithCountdown(s.starts, s.daysToStart)}.`,
  [MIGRATION_STATE.NOT_YET_MIGRATED]: (s) =>
    `${s.label} is migrating from ${s.from} to ${s.to} and this runner served ${s.from}. The rollout finishes ${dateWithCountdown(s.ends, s.daysToEnd)}; until then the same label is either image.`,
  [MIGRATION_STATE.MIGRATED]: (s) =>
    `The scheduled ${s.label} migration has reached this runner: ${s.from} -> ${s.to}, rollout ${s.starts} to ${s.ends}.`,
  [MIGRATION_STATE.AMBIGUOUS]: (s) =>
    `${s.label} is mid-rollout from ${s.from} to ${s.to}, finishing ${dateWithCountdown(s.ends, s.daysToEnd)}. Until then the label means either image, and which one a job gets depends on the runner it lands on.`,
  [MIGRATION_STATE.SETTLED]: (s) =>
    `${s.label} finished migrating from ${s.from} to ${s.to} on ${dateWithCountdown(s.ends, s.daysToEnd)}; it now means ${s.to}.`,
  [MIGRATION_STATE.STALE]: (s) =>
    `${s.label} served ${s.from}, but its migration to ${s.to} closed on ${dateWithCountdown(s.ends, s.daysToEnd)}. A runner still on the retired image after the window is an anomaly, not drift.`,
  [MIGRATION_STATE.UNEXPECTED]: (s) =>
    `${s.label} served ImageOS="${s.imageOS}", which is neither ${s.from} nor ${s.to}. runner-drift's migration window (${s.starts} to ${s.ends}) may be out of date.`,
};

const MIGRATION_KIND = {
  [MIGRATION_STATE.PENDING]: 'notice',
  [MIGRATION_STATE.MOVED_EARLY]: 'notice',
  [MIGRATION_STATE.NOT_YET_MIGRATED]: 'warning',
  [MIGRATION_STATE.MIGRATED]: 'notice',
  [MIGRATION_STATE.AMBIGUOUS]: 'warning',
  [MIGRATION_STATE.SETTLED]: 'notice',
  [MIGRATION_STATE.STALE]: 'error',
  [MIGRATION_STATE.UNEXPECTED]: 'error',
};

const MIGRATION_TITLE = {
  [MIGRATION_STATE.PENDING]: (s) => `${s.label} becomes ${s.to} in ${plural(s.daysToStart, 'day')}`,
  [MIGRATION_STATE.MOVED_EARLY]: (s) => `${s.label} is already ${s.to}`,
  [MIGRATION_STATE.NOT_YET_MIGRATED]: (s) => `${s.label} migration under way`,
  [MIGRATION_STATE.MIGRATED]: (s) => `${s.label} is now ${s.to}`,
  [MIGRATION_STATE.AMBIGUOUS]: (s) => `${s.label} migration under way`,
  [MIGRATION_STATE.SETTLED]: (s) => `${s.label} is now ${s.to}`,
  [MIGRATION_STATE.STALE]: (s) => `${s.label} still serving ${s.from}`,
  [MIGRATION_STATE.UNEXPECTED]: (s) => `unrecognised image on ${s.label}`,
};

// Keyed by state, not by phase: after the window a runner still on the old
// image is the anomaly this lane exists to catch, and the calendar alone would
// badge it settled next to its own ::error.
const MIGRATION_BADGE = {
  [MIGRATION_STATE.PENDING]: '🗓 pending',
  [MIGRATION_STATE.MOVED_EARLY]: '🟠 moved early',
  [MIGRATION_STATE.NOT_YET_MIGRATED]: '🟠 not yet',
  [MIGRATION_STATE.AMBIGUOUS]: '🟠 in window',
  [MIGRATION_STATE.MIGRATED]: '✅ migrated',
  [MIGRATION_STATE.SETTLED]: '✅ settled',
  [MIGRATION_STATE.STALE]: '🔴 stale',
  [MIGRATION_STATE.UNEXPECTED]: '🔴 unexpected',
};

/** The one sentence that describes a survey. No source link; callers add it. */
export function migrationMessage(survey) {
  return MIGRATION_SENTENCE[survey.state](survey);
}

/** The sentence and its source: the two lines every format leads with. */
export function migrationHeader(survey) {
  return [
    migrationMessage(survey),
    `announced ${survey.announced}; source ${survey.sourceRef} ${survey.source}`,
  ];
}

/**
 * Plain-text block for one survey: the sentence, the source, and whatever the
 * manifests could tell us about the difference between the two images.
 */
export function migrationLines(survey) {
  const lines = migrationHeader(survey);
  const rows = [...survey.image, ...survey.toolDiffs];
  if (rows.length) {
    lines.push(`${survey.from} -> ${survey.to}:`);
    for (const d of rows) lines.push(`  ${planRow(d)}`);
  }
  if (survey.notOnManifest.length) {
    lines.push(`Not listed on either image manifest (skipped): ${survey.notOnManifest.join(', ')}`);
  }
  for (const n of survey.notes) lines.push(n);
  return lines;
}

/** The whole `guard` migration block, one paragraph per floating label. */
export function migrationReport(surveys) {
  return surveys.flatMap((s, i) => (i ? ['', ...migrationLines(s)] : migrationLines(s))).join('\n');
}

/**
 * `::notice`/`::warning`/`::error` per `runs-on:` site, so the message lands on
 * the line that owns the floating label. A survey built without a scan behind
 * it has no line to point at and gets one step-level annotation instead; in
 * `guard` that cannot happen, since the scan is what finds the label at all.
 */
export function migrationAnnotations(surveys) {
  return surveys.flatMap((s) => {
    const kind = MIGRATION_KIND[s.state];
    const title = `runner-drift: ${MIGRATION_TITLE[s.state](s)}`;
    const message = `${migrationMessage(s)} See ${s.source}`;
    const sites = s.sites.length ? s.sites : [null];
    return sites.map((site) => annotation(kind, title, message, site));
  });
}

/** Step-summary table for migration surveys, with the image diff underneath. */
export function migrationSummaryMarkdown(surveys) {
  const rows = surveys.map((s) => [
    `\`${s.label}\``,
    MIGRATION_BADGE[s.state],
    `\`${s.from}\` → \`${s.to}\``,
    `${dateWithCountdown(s.starts, s.daysToStart)} → ${dateWithCountdown(s.ends, s.daysToEnd)}`,
    s.observed ? `\`${s.observed}\`` : '—',
    `[${s.sourceRef}](${s.source})`,
  ]);
  const lines = [
    '## runner-drift — floating label migration',
    '',
    ...markdownTable(['Label', 'Status', 'Move', 'Window', 'This runner', 'Source'], rows),
  ];
  for (const s of surveys) {
    lines.push('', migrationMessage(s));
    // The "This runner" cell is a dash whenever the image could not be read or
    // could not be attributed, and the note is the difference between the two.
    for (const n of s.notes) lines.push('', n);
    const diffRows = [...s.image, ...s.toolDiffs];
    if (!diffRows.length) continue;
    lines.push(
      '',
      ...markdownTable(
        [`\`${s.from}\` → \`${s.to}\``, 'From', 'To', 'Change'],
        diffRows.map((d) => [
          d.tool,
          d.from.join(', ') || '(absent)',
          d.to.join(', ') || '(absent)',
          SEVERITY_BADGE[d.severity] ?? d.severity,
        ]),
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Append markdown to $GITHUB_STEP_SUMMARY when running inside Actions. */
export async function writeStepSummary(markdown) {
  return appendToEnvFile('GITHUB_STEP_SUMMARY', `${markdown}\n`);
}

/**
 * Set a step output when running inside Actions.
 *
 * The heredoc form rather than `name=value`, because a value containing a
 * newline silently truncates in the plain form and the delimiter is what
 * GitHub documents for it.
 */
export async function writeOutput(name, value) {
  const delimiter = `rd_${randomUUID()}`;
  return appendToEnvFile('GITHUB_OUTPUT', `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

async function appendToEnvFile(variable, body) {
  const file = process.env[variable];
  if (!file) return false;
  try {
    await appendFile(file, body, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------- self-hosted runner versions */

const RUNNER_BADGE = {
  [RUNNER_STATUS.EXPIRED]: '🔴 EXPIRED',
  [RUNNER_STATUS.RUNTIME_DUE]: '🟠 RUNTIME-DUE',
  [RUNNER_STATUS.REGISTRATION_DUE]: '🟡 REGISTRATION-DUE',
  [RUNNER_STATUS.UNKNOWN_VERSION]: '❔ UNKNOWN-VERSION',
  [RUNNER_STATUS.OK]: '⚪ OK',
};

/**
 * `x2` / `x2 (1 offline)`. Whether the group is in service changes how urgent it
 * is — an EXPIRED version on a runner still reporting online is the case that
 * matters most, and an offline one may just need recreating from a newer image.
 */
function runnerCount(group) {
  const offline = Number.isFinite(group.online) ? group.count - group.online : 0;
  return offline > 0 ? `x${group.count} (${offline} offline)` : `x${group.count}`;
}

/** At most five names, then a count — a 200-runner fleet is one version group. */
function nameList(names, max = 5) {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/**
 * The `runs-on:` sites worth pointing at: only where a date is actually moving,
 * so an UNKNOWN-VERSION row does not annotate files over a version nobody can
 * date, and an OK row does not annotate them at all.
 */
function dueSites(group) {
  const dated =
    group.status === RUNNER_STATUS.RUNTIME_DUE ||
    group.status === RUNNER_STATUS.REGISTRATION_DUE ||
    group.status === RUNNER_STATUS.EXPIRED;
  return dated ? (group.workflowSites ?? []) : [];
}

/**
 * The detail lines under one version row: what ends when, and why this group is
 * probably not something you fix by hand.
 */
export function runnerGroupDetail(group, { windowDays, sites = true } = {}) {
  const lines = [];
  const { runtime, registration } = group;
  // On an OK row the date is reassurance, so it says why rather than restating
  // the consequence; on a due or expired row the consequence is the point.
  const ok = group.status === RUNNER_STATUS.OK;
  const beyond = Number.isFinite(windowDays) ? `beyond the ${windowDays}-day window` : 'not yet due';
  if (runtime) {
    lines.push(
      runtime.past
        ? `runtime support ended ${dateWithCountdown(runtime.at, runtime.days)} — jobs are no longer queued to it`
        : `runtime support ends ${dateWithCountdown(runtime.at, runtime.days)} — ${ok ? beyond : 'jobs stop being queued'}`,
    );
  }
  if (registration) {
    lines.push(
      registration.past
        ? `registration ended ${dateWithCountdown(registration.at, registration.days)} — it cannot reregister`
        : `registration ends ${dateWithCountdown(registration.at, registration.days)} — ${ok ? beyond : 'cannot register or reregister'}`,
    );
  }
  if (group.status === RUNNER_STATUS.UNKNOWN_VERSION) {
    lines.push(
      group.version === null
        ? 'no version reported — the runner has never connected, so there is nothing to date'
        : `the deprecations API does not recognise version ${group.version} — reporting only, never failing`,
    );
    if (belowRegistrationMinimum(group.version)) {
      lines.push(
        `${group.version} is below the ${MINIMUM_REGISTRATION_VERSION} registration minimum — it cannot register or reregister`,
      );
    }
  }
  if (group.status === RUNNER_STATUS.OK && !runtime && !registration && group.version !== null) {
    lines.push('no end date returned — this version is current');
  }
  for (const field of group.unparsedDates ?? []) {
    lines.push(`the API sent a \`${field}\` this build could not parse — treated as no date, so do not read this row as safe`);
  }
  // Only on a row that is actually actionable. An OK row already prints why it
  // is fine, and "update anyway" on it would be the universal-deadline nagging
  // this report exists to avoid. The value stays in --json either way.
  if (group.updateTo && !ok) {
    const published = group.updateTo.publishedAt
      ? `, published ${group.updateTo.publishedAt.slice(0, 10)}`
      : '';
    lines.push(`update to ${group.updateTo.version}${published} — the newest stable actions/runner release`);
  }
  if (sites) {
    for (const site of dueSites(group)) {
      lines.push(
        `serves ${annotationPath(site.file)}:${site.line} (runs-on: ${site.labels.join(', ')}) — ${nameList(site.runners, 3)}`,
      );
    }
  }
  if (group.status !== RUNNER_STATUS.OK && group.status !== RUNNER_STATUS.UNKNOWN_VERSION && group.imagePinned) {
    lines.push(
      group.ephemeral
        ? 'ephemeral runners — change the actions-runner-controller image tag, not the host'
        : 'these look image-pinned; update the image or template, not the host',
    );
  }
  return lines;
}

/**
 * Anything the run cannot stand behind about how much of the fleet it saw. The
 * header counts what was actually classified, so a shortfall is said out loud
 * rather than papered over with the number the API claimed.
 */
function countNotes(survey) {
  if (survey.truncated) {
    return [
      `note: the runner listing was cut off after ${survey.surveyedCount} of ${survey.totalCount} — this is a prefix of the fleet, not all of it`,
    ];
  }
  if (Number.isFinite(survey.totalCount) && survey.totalCount !== survey.surveyedCount) {
    return [
      `note: the API reported ${plural(survey.totalCount, 'runner')} but returned ${survey.surveyedCount} — only what it returned was checked`,
    ];
  }
  return [];
}

/** Plain-text `runners` report. Mirrors planReport()'s shape for the other lane. */
export function runnersReport(survey) {
  const out = [];
  const head = `self-hosted runners — ${survey.scope.name}`;

  if (survey.status !== SURVEY_STATUS.OK) {
    out.push(head);
    out.push(`${survey.status}  ${survey.message}`);
    for (const line of survey.hint ?? []) {
      out.push(`${' '.repeat(survey.status.length + 2)}${line}`);
    }
    return out.join('\n');
  }

  if (!survey.groups.length) {
    out.push(`${head} (${plural(survey.surveyedCount ?? 0, 'runner')})`);
    out.push('no self-hosted runners registered — nothing to check; GitHub-hosted runners are not affected');
    out.push(...countNotes(survey));
    out.push(`source: ${endpointLabel(survey.runnersUrl)}`);
    return out.join('\n');
  }

  out.push(
    `${head} (${plural(survey.surveyedCount, 'runner')}, ${plural(survey.groups.length, 'version')})`,
  );

  const statusWidth = Math.max(13, ...survey.groups.map((g) => g.status.length)) + 1;
  const versionWidth = Math.max(...survey.groups.map((g) => (g.version ?? '(none)').length)) + 2;
  for (const g of survey.groups) {
    const published =
      g.status === RUNNER_STATUS.OK && g.publishedAt
        ? `  (published ${g.publishedAt.slice(0, 10)})`
        : '';
    out.push(
      `  ${g.status.padEnd(statusWidth)}${(g.version ?? '(none)').padEnd(versionWidth)}${runnerCount(g)}  ${nameList(g.names)}${published}`,
    );
    const indent = ' '.repeat(2 + statusWidth);
    for (const line of runnerGroupDetail(g, { windowDays: survey.windowDays })) {
      out.push(`${indent}${line}`);
    }
  }

  out.push(...countNotes(survey));
  if (survey.groups.some((g) => g.status !== RUNNER_STATUS.OK)) {
    out.push(`note: ${survey.autoUpdateNote}`);
  }
  out.push(`note: ${survey.ghesNote}`);
  for (const source of [...new Set(survey.groups.filter((g) => g.source).map((g) => g.source))]) {
    out.push(`source: ${source}`);
  }
  return out.join('\n');
}

/**
 * Workflow-log annotations for a survey. A refused or unreachable endpoint is a
 * ::warning so the log is not silently green; only a real deprecation escalates.
 */
export function runnersAnnotations(survey) {
  if (survey.status !== SURVEY_STATUS.OK) {
    return [
      annotation(
        'warning',
        `runner-drift: ${survey.status}`,
        [`${survey.message}.`, ...(survey.hint ?? [])].join(' '),
      ),
    ];
  }
  const lines = [];
  for (const g of survey.groups) {
    if (g.status === RUNNER_STATUS.OK) continue;
    const fails = statusFails(g.status, { failOn: survey.failOn });
    const kind = fails ? 'error' : g.status === RUNNER_STATUS.UNKNOWN_VERSION ? 'notice' : 'warning';
    const detail = runnerGroupDetail(g, { windowDays: survey.windowDays }).join('; ');
    const which = g.version
      ? `${g.count} self-hosted runner(s) on ${g.version}`
      : `${g.count} self-hosted runner(s) with no version reported`;
    lines.push(
      annotation(
        kind,
        `runner-drift: runner ${g.version ?? '(no version)'} ${g.status}`,
        `${which} (${nameList(g.names)}): ${detail}. ${survey.ghesNote}.`,
      ),
    );
    // And on the exact `runs-on:` line of every job those runners serve, which
    // is where the person who has to fix it is looking. Same idea as the image
    // lane annotating a pinned label.
    // Without the `serves` lines: this annotation is already on that line.
    const onSite = runnerGroupDetail(g, { windowDays: survey.windowDays, sites: false }).join('; ');
    for (const site of dueSites(g)) {
      lines.push(
        annotation(
          kind,
          `runner-drift: this job's runners are on ${g.version}`,
          `${which} serve this job (${nameList(site.runners, 3)}): ${onSite}.`,
          site,
        ),
      );
    }
  }
  return lines;
}

/** Step-summary table for a survey. */
export function runnersSummaryMarkdown(survey) {
  const lines = ['## runner-drift — self-hosted runners', ''];
  if (survey.status !== SURVEY_STATUS.OK) {
    lines.push(`\`${survey.scope.name}\` — **${survey.status}**: ${survey.message}`);
    for (const line of survey.hint ?? []) lines.push('', `> ${line}`);
    return `${lines.join('\n')}\n`;
  }
  const caveats = countNotes(survey).map((n) => `> ⚠️ ${n.replace(/^note: /, '')}`);
  if (!survey.groups.length) {
    lines.push(
      `\`${survey.scope.name}\` has no self-hosted runners registered — nothing to check.`,
    );
    for (const c of caveats) lines.push('', c);
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    `\`${survey.scope.name}\` — ${plural(survey.surveyedCount, 'runner')} on ${plural(survey.groups.length, 'version')}, window ${plural(survey.windowDays, 'day')}.`,
  );
  for (const c of caveats) lines.push('', c);
  lines.push('');
  const rows = survey.groups.map((g) => [
    `\`${g.version ?? '(none)'}\``,
    `${runnerCount(g)} ${nameList(g.names, 3)}`,
    RUNNER_BADGE[g.status] ?? g.status,
    g.runtime ? dateWithCountdown(g.runtime.at, g.runtime.days) : '—',
    g.registration ? dateWithCountdown(g.registration.at, g.registration.days) : '—',
    // Same rule as the text report: a target only where the row is actionable.
    g.updateTo && g.status !== RUNNER_STATUS.OK ? `\`${g.updateTo.version}\`` : '—',
  ]);
  lines.push(
    ...markdownTable(
      ['Version', 'Runners', 'Status', 'Runtime ends', 'Registration ends', 'Update to'],
      rows,
    ),
  );
  // One version serves many jobs, so this is a list rather than a table column.
  const affected = survey.groups.flatMap((g) =>
    dueSites(g).map(
      (site) =>
        `- \`${annotationPath(site.file)}:${site.line}\` (\`runs-on: ${site.labels.join(', ')}\`) — ${nameList(site.runners, 3)} on \`${g.version}\``,
    ),
  );
  if (affected.length) {
    lines.push('');
    lines.push('**Jobs these runners serve:**');
    lines.push('');
    lines.push(...affected);
  }

  // The endpoint is cited once per version rather than as a column: it is the
  // same path on every row bar the version, which column one already shows.
  const sources = [...new Set(survey.groups.filter((g) => g.source).map((g) => g.source))];
  if (sources.length) {
    lines.push('');
    lines.push(`Source: ${sources.map((s) => `\`${s}\``).join(', ')}`);
  }
  lines.push('');
  lines.push(`> ${survey.autoUpdateNote}`);
  lines.push('>');
  lines.push(`> ${survey.ghesNote} — see [the enforcement timeline](${survey.source}).`);
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------- action runtimes */

const REF_BADGE = {
  [REF_STATUS.FAIL]: '🔴 WILL FAIL',
  [REF_STATUS.UNKNOWN]: '❔ unknown',
  [REF_STATUS.OK]: '⚪ ok',
  [REF_STATUS.CYCLE]: '⚪ ok',
};

/** `3 workflow files and 1 action file` — what was actually read. */
function sourceCount(files) {
  const parts = [];
  for (const [kind, word] of [['workflow', 'workflow file'], ['action', 'action file']]) {
    const n = files.filter((f) => f.kind === kind).length;
    if (n) parts.push(plural(n, word));
  }
  return parts.join(' and ') || 'no workflow or action files';
}

/** The middle column: what `runs.using` said, or what stood in for it. */
function runtimeCell(node) {
  if (node.status === REF_STATUS.CYCLE) return 'cycle';
  if (node.using) return node.using;
  return node.kind === 'docker' ? 'docker' : '?';
}

/**
 * The right-hand column: where to move to, or why there is no answer. A failing
 * reference always gets one, because an empty cell there reads as nothing to do.
 */
function adviceCell(node) {
  if (node.status === REF_STATUS.UNKNOWN || node.status === REF_STATUS.CYCLE) {
    return node.reason ?? '';
  }
  if (node.status !== REF_STATUS.FAIL) return '';
  // A composite is only failing because of a step under it, and that step has
  // the fix on its own row.
  if (node.children?.length) return '';
  if (node.kind !== 'remote') return 'local action — set runs.using: node24 and rebuild it';
  const up = node.upgrade;
  if (!up) return '';
  if (up.available) return `-> ${up.ref} (${up.using})`;
  return up.checked ? up.reason : `upgrade target unknown — ${up.reason}`;
}

/**
 * One row per reference, plus the chain beneath it that explains the verdict.
 *
 * A composite only ever fails because of a step inside it, so naming the
 * composite alone leaves the reader with nothing to fix. Children that agree
 * with the parent's verdict are listed under it, recursively; an ok subtree
 * stays collapsed, because every row in it would say the same thing.
 */
export function referenceRows(node, depth = 0) {
  const rows = [{ node, depth }];
  if (node.status === REF_STATUS.OK) return rows;
  for (const child of node.children ?? []) {
    if (child.status !== REF_STATUS.OK) rows.push(...referenceRows(child, depth + 1));
  }
  return rows;
}

/** `2 of 3 action references stop working in 10 days.` */
function removalSentence(subject, days) {
  if (days === null) return `${subject} stop working on the removal date.`;
  if (days > 0) return `${subject} stop working in ${plural(days, 'day')}.`;
  if (days === 0) return `${subject} stop working today.`;
  return `${subject} stopped working ${plural(Math.abs(days), 'day')} ago.`;
}

function countdownSuffix(days) {
  return days === null ? '' : ` ${countdown(days)}`;
}

/** Plain-text `actions` report. Mirrors planReport()/runnersReport() for the third lane. */
export function actionsReport(survey) {
  const out = [];
  out.push(
    `scanned ${sourceCount(survey.files)}, ${survey.totalReferences} action reference(s), ${survey.uniqueReferences} unique`,
  );
  const removed = survey.daysLeft !== null && survey.daysLeft < 0;
  out.push(
    `Node 20 ${removed ? 'was' : 'is'} removed from GitHub-hosted runners on ${survey.removalDate}${countdownSuffix(survey.daysLeft)}`,
  );
  for (const err of survey.readErrors) out.push(`warning: ${err}`);

  if (!survey.uniqueReferences) {
    out.push('');
    out.push(
      survey.missing
        ? `no ${survey.workflowPath} and no ${survey.actionsPath} — nothing to check`
        : 'no `uses:` references found — every step runs a script, so nothing here depends on a Node runtime',
    );
    return out.join('\n');
  }

  const bucket = (status) =>
    survey.references.filter((r) =>
      status === REF_STATUS.OK
        ? r.status === REF_STATUS.OK || r.status === REF_STATUS.CYCLE
        : r.status === status,
    );
  const sections = [
    [REF_STATUS.FAIL, 'WILL FAIL'],
    [REF_STATUS.UNKNOWN, 'unknown'],
    [REF_STATUS.OK, 'ok'],
  ].map(([status, heading]) => [bucket(status).flatMap((r) => referenceRows(r)), heading]);

  // Widths come from every section at once, so the columns line up down the
  // whole report rather than per block.
  const all = sections.flatMap(([rows]) => rows);
  const refWidth = Math.max(...all.map(({ node, depth }) => node.ref.length + depth * 2)) + 3;
  const runtimeWidth = Math.max(...all.map(({ node }) => runtimeCell(node).length)) + 3;

  for (const [rows, heading] of sections) {
    if (!rows.length) continue;
    out.push('');
    out.push(heading);
    for (const { node, depth } of rows) {
      const ref = `${'  '.repeat(depth + 1)}${node.ref}`.padEnd(refWidth + 2);
      const advice = adviceCell(node);
      out.push(`${ref}${runtimeCell(node).padEnd(advice ? runtimeWidth : 0)}${advice}`.trimEnd());
    }
  }

  out.push('');
  if (survey.counts.fail) {
    out.push(
      removalSentence(
        `${survey.counts.fail} of ${survey.uniqueReferences} action references`,
        survey.daysLeft,
      ),
    );
  } else if (survey.counts.unknown) {
    out.push(
      `Nothing resolved to a runtime the removal takes, but ${plural(survey.counts.unknown, 'reference')} could not be resolved — read those as unchecked, not as safe.`,
    );
  } else {
    out.push(
      `All ${plural(survey.uniqueReferences, 'action reference')} survive the ${survey.removalDate} removal.`,
    );
  }
  return out.join('\n');
}

/**
 * The path from a reference down to the node that explains its verdict, e.g.
 * `[acme/outer@v1, acme/inner@v2, acme/leaf@v3]`. A composite fails because of
 * a step inside it, so the end of the path is what to fix and the path itself
 * is how the reader gets there from the line they wrote.
 */
function verdictPath(node) {
  const worse = (node.children ?? []).filter((c) => c.status !== REF_STATUS.OK);
  if (!worse.length) return [node];
  const next = worse.find((c) => c.status === node.status) ?? worse[0];
  return [node, ...verdictPath(next)];
}

/**
 * `::error` on every line that writes a failing reference, `::warning` on one
 * that could not be resolved. Both name the whole chain, because the line says
 * `acme/outer@v1` and the reason may be three composites below it.
 */
export function actionsAnnotations(survey) {
  const lines = [];
  for (const ref of survey.references) {
    const failing = ref.status === REF_STATUS.FAIL;
    if (!failing && ref.status !== REF_STATUS.UNKNOWN) continue;
    const path = verdictPath(ref);
    const leaf = path[path.length - 1];
    const via = path.length === 1 ? '' : ` (via ${path.map((n) => n.ref).join(' -> ')})`;
    const advice = adviceCell(leaf);
    const message = failing
      ? `${leaf.ref} runs on ${runtimeCell(leaf)}${via}, which GitHub removes from the hosted runners on ${survey.removalDate}${countdownSuffix(survey.daysLeft)}. ${advice ? `${advice}. ` : ''}See ${survey.source}`
      : `${ref.ref} could not be resolved${via}: ${leaf.reason ?? 'no reason recorded'}. Read it as unchecked, not as safe.`;
    const title = failing
      ? `runner-drift: ${leaf.ref} is ${runtimeCell(leaf)}`
      : `runner-drift: ${ref.ref} unresolved`;
    for (const site of ref.where) {
      lines.push(annotation(failing ? 'error' : 'warning', title, message, site));
    }
  }
  return lines;
}

/** Step-summary table for an `actions` run. */
export function actionsSummaryMarkdown(survey) {
  const lines = ['## runner-drift — action runtimes', ''];
  lines.push(
    `Node 20 leaves the GitHub-hosted runners on **${survey.removalDate}**${countdownSuffix(survey.daysLeft)}. ` +
      `Scanned ${sourceCount(survey.files)}, ${survey.totalReferences} action reference(s), ${survey.uniqueReferences} unique.`,
  );
  for (const err of survey.readErrors) lines.push('', `> ⚠️ ${err}`);
  if (!survey.uniqueReferences) {
    lines.push('');
    lines.push('No `uses:` references found — nothing here depends on a Node runtime.');
    return `${lines.join('\n')}\n`;
  }
  lines.push('');
  const rows = survey.references.flatMap((ref) =>
    referenceRows(ref).map(({ node, depth }) => [
      `${'↳ '.repeat(depth)}\`${node.ref}\``,
      depth ? '' : REF_BADGE[ref.status] ?? ref.status,
      `\`${runtimeCell(node)}\``,
      adviceCell(node).replace(/^-> /, '→ '),
      depth ? '' : ref.where.map((w) => `\`${annotationPath(w.file)}:${w.line}\``).join(', '),
    ]),
  );
  lines.push(...markdownTable(['Reference', 'Status', 'Runtime', 'Fix', 'Used at'], rows));
  lines.push('');
  lines.push(
    survey.counts.fail
      ? removalSentence(
          `**${survey.counts.fail} of ${survey.uniqueReferences}** action references`,
          survey.daysLeft,
        )
      : `All ${plural(survey.uniqueReferences, 'action reference')} survive the removal.`,
  );
  lines.push('');
  lines.push(`> Source: [GitHub changelog](${survey.source}).`);
  return `${lines.join('\n')}\n`;
}
