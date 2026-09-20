/**
 * The floating-label migration lane.
 *
 * labels.mjs answers the calendar half from the MIGRATIONS table — where today
 * sits in the window, and which image the runner actually served. This module
 * answers the other half from the live manifests: what is different between the
 * image the label means today and the one it will mean when the window closes.
 *
 * The diff is the whole point. A warning that says "ubuntu-latest moves to
 * Ubuntu 26.04 next month" is a calendar entry; "your kernel goes 6.17 -> 7.0
 * and Node.js 22 -> 24" is something you can act on before it happens.
 */

import { labelForImageOS, migrationFor, migrationStatus } from './labels.mjs';
import { labelOwnership } from './detect.mjs';
import { diffManifestTools, loadManifest } from './manifest.mjs';
import { diffTool } from './diff.mjs';
import { errorText } from './http.mjs';

/**
 * Image-level facts that are not installed tools but change with the OS. They
 * live in the manifest header, so nothing in the tool table records them.
 */
export const IMAGE_FIELDS = [
  ['OS', 'osVersion'],
  ['Kernel', 'kernelVersion'],
  ['Systemd', 'systemdVersion'],
];

const one = (v) => (v ? [v] : null);

/**
 * Diff the manifest headers of two images. A field either side does not publish
 * (Windows manifests carry no kernel line, and only Linux publishes systemd) is
 * not a removal, so it diffs to `missing` and the `changed` filter drops it.
 */
export function imageDiffs(from, to) {
  return IMAGE_FIELDS.map(([name, field]) => {
    const a = from?.[field];
    const b = to?.[field];
    return a && b ? diffTool(name, one(a), one(b)) : diffTool(name, null, null);
  });
}

/**
 * Whether this runner's `ImageOS` says anything about this label, and why not.
 *
 * One runner serves one job. Its image is evidence about `ubuntu-latest` only if
 * the job it is running asked for `ubuntu-latest`; a lint job pinned to
 * `ubuntu-22.04` that happens to scan a repo using the floating label would
 * otherwise report the whole migration as having gone somewhere unexpected.
 *
 * Two weaker cases attribute anyway, but only when the image is one of the two
 * the window names, which is evidence the runner did come from this label: a
 * matrix leg (the file cannot say which leg this runner is), and a run with no
 * `GITHUB_JOB` to match against (`guard` invoked outside a workflow job).
 *
 * Neither weak case can report an image from outside the window, so the
 * `unexpected` anomaly needs a job id. That is deliberate: with no job to scope
 * to, an unscanned workflow or a `runs-on:` built from an expression would put
 * an image on this runner that no site in the scan accounts for, and calling
 * that a broken migration would be an error raised at the wrong repository.
 */
export function attributeImageOS({ label, imageOS, sites = [], others = [], here = null }) {
  if (!imageOS) return { imageOS: null, note: null };
  const m = migrationFor(label);
  const observed = labelForImageOS(imageOS);
  const { direct, asked, rival, placed, named, alone } = labelOwnership({
    label, observed, sites, others, here,
  });

  // A plain `runs-on:` in the job this run came from settles it, as long as the
  // job id picked out one job. A job a reusable workflow reports is matched on
  // the id alone, and an id is unique in a file, not in a repository, so a
  // second file whose job of that id runs somewhere else takes the claim back.
  if (here && direct && !rival && alone) return { imageOS, note: null };
  const endpoint = !rival && (observed === m?.from || observed === m?.to);

  if (!here) {
    if (endpoint) return { imageOS, note: null };
    if (rival) {
      return {
        imageOS: null,
        note: named
          ? `These workflows ask for ${observed} by name, so this runner is not evidence about ${label}.`
          : `A matrix in these workflows can be scheduled onto ${observed}, so this runner is not `
            + `evidence about ${label}.`,
      };
    }
    return {
      imageOS: null,
      note: `No GITHUB_JOB says which job this check ran in, and ${observed ?? imageOS} is neither `
        + `image in the ${label} window, so this runner is not evidence about it.`,
    };
  }

  if (asked) {
    if (endpoint) return { imageOS, note: null };
    // Two jobs sharing an id, rather than one job with two legs: only an
    // unplaceable run can be in another file at all, and this job's own
    // `runs-on:` rules the matrix wording out whenever it is a plain label.
    if (rival && !placed && (named || direct)) {
      const how = named ? `asks for ${observed} by name` : `can be scheduled onto ${observed}`;
      return {
        imageOS: null,
        note: `More than one workflow has a job called "${here.job}", and one of them ${how}, `
          + 'so this runner may be that job instead.',
      };
    }
    if (!alone) {
      return {
        imageOS: null,
        note: `More than one workflow has a job called "${here.job}" and they do not all run on `
          + `${label}, so this runner may be one of the others.`,
      };
    }
    return {
      imageOS: null,
      note: rival
        ? `Job "${here.job}" reaches ${label} through a matrix that also asks for ${observed} `
          + 'by name, so this runner may be serving that leg instead.'
        : `Job "${here.job}" reaches ${label} through a matrix and ran on ${observed ?? imageOS}, `
          + 'which is neither image in the window, so this runner is treated as a different matrix leg.',
    };
  }
  return {
    imageOS: null,
    note: `The job that ran this check ("${here.job}") did not run on ${label}, `
      + 'so its ImageOS is not evidence about the migration.',
  };
}

/**
 * One floating label, classified and (where it helps) diffed.
 *
 * `plan` calls this for the label the user named; `guard` calls it for every
 * floating label its workflows actually use. Both get the same object, so the
 * report renderers do not need to know which lane they are serving.
 *
 * Network failures and 404s land in `notes` rather than throwing: the notice is
 * worth printing even when the manifests cannot be read, which is exactly the
 * degraded case the brief calls for.
 *
 * @returns {Promise<object|null>} null when the label has no announced migration
 */
export async function surveyMigration({
  label,
  now = new Date(),
  imageOS = null,
  tools = [],
  sites = [],
  others = [],
  here = null,
  load = loadManifest,
} = {}) {
  const attributed = attributeImageOS({ label, imageOS, sites, others, here });
  const status = migrationStatus(label, { now, imageOS: attributed.imageOS });
  if (!status) return null;

  const survey = {
    ...status,
    sites,
    images: null,
    image: [],
    toolDiffs: [],
    notOnManifest: [],
    notes: attributed.note ? [attributed.note] : [],
  };

  // Once the label already means `to`, the lock diff in `guard` is the real
  // before/after and this one would only restate it from the manifests.
  if (status.done) return survey;

  let a;
  let b;
  try {
    [a, b] = await Promise.all([load(status.from), load(status.to)]);
  } catch (err) {
    survey.notes.push(`Manifest diff unavailable: ${errorText(err)}`);
    return survey;
  }
  for (const m of [a, b]) {
    if (m.skipped) survey.notes.push(`Manifest diff unavailable: ${m.reason}`);
  }
  if (a.skipped || b.skipped) return survey;

  survey.images = { from: a.imageVersion, to: b.imageVersion };
  survey.image = imageDiffs(a, b).filter((d) => d.changed);

  const compared = diffManifestTools(a, b, tools);
  survey.notOnManifest = compared.notOnManifest;
  survey.toolDiffs = compared.diffs.filter((d) => d.changed);

  return survey;
}
