# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.1] — 2026-09-20

### Fixed

- **`runs-on:` in its mapping form is now scanned** ([#12](https://github.com/Booyaka101/runner-drift/issues/12)).
  A job that targets a runner group writes its labels under a mapping:

  ```yaml
  runs-on:
    group: default
    labels: [ubuntu-22.04]
  ```

  The scanner took whatever followed `runs-on:` as the label text, so this form
  yielded nothing and the job was skipped in silence. A repo on a runner group
  pinning a retiring image was told it had nothing to migrate, and the same job
  never showed up in the `ubuntu-latest` migration lane either. It had been that
  way since 1.0.0.

  `labels:` takes the same three shapes `runs-on:` does (scalar, flow sequence,
  block list), so the read loop was extracted into one function that calls back
  into itself for the mapping rather than growing a fourth copy of those branches.
  `group:` names a pool, not a label, and is never read as one. The annotation
  points at the label where it sits, the same as every other form, and the labels
  under one mapping stay one target, so `--label` matching and the migration lane
  treat them as the set a runner has to carry.

## [1.4.0] — 2026-09-20

### Added

- **The `ubuntu-latest` migration lane.** GitHub's changelog of 2026-09-17: *"The
  ubuntu-latest label will migrate from Ubuntu 24.04 to Ubuntu 26.04. This
  migration will roll out gradually between October 19 and November 19, 2026."*
  ([actions/runner-images#14748](https://github.com/actions/runner-images/issues/14748)).

  For that month `ubuntu-latest` is two different operating systems depending on
  which runner the job lands on, and no workflow file changes. The kernel goes
  `6.17.0-1022-azure` -> `7.0.0-1012-azure` and systemd `255.4-1ubuntu8.17` ->
  `259.5-0ubuntu3.4`, while Docker Buildx, the AWS and Azure CLIs, Rust and Java
  17 are the same on both images. That is exactly the kind of change this tool
  exists to show you before it lands.

  `MIGRATIONS` in `src/labels.mjs` records the announced moves: the floating
  label, the two concrete labels it moves between, the window and the source
  issue. It sits beside the retirement `DEADLINES` table rather than inside it,
  and shares no keys with it: a retirement is an end date for one image, a
  migration is a dated window between two live ones. Today it has one entry.
  `windows-latest` and `macos-latest` are a data addition when GitHub announces
  them.

- **`plan --from <floating label>`** no longer refuses. Where `MIGRATIONS` names
  both ends, `plan` resolves them and diffs the two concrete images, so the
  output is the kernel and systemd deltas rather than a bare warning:

  ```
  $ runner-drift plan --from ubuntu-latest
  ubuntu-latest moves from ubuntu-24.04 to ubuntu-26.04. The rollout starts 2026-10-19 (18 days) and finishes 2026-11-19 (49 days).
  announced 2026-09-17; source actions/runner-images#14748 https://github.com/actions/runner-images/issues/14748
  ubuntu-24.04 -> ubuntu-26.04 (images 20260907.300.1 -> 20260907.131.1)
  ubuntu-24.04 has no announced deprecation deadline in runner-drift's table.

  OS 24.04.5 LTS -> 26.04.1 LTS  MAJOR
  Kernel 6.17.0-1022-azure -> 7.0.0-1012-azure  MAJOR
  Systemd 255.4-1ubuntu8.17 -> 259.5-0ubuntu3.4  MAJOR
  ```

  A floating `--to`, or a floating `--from` with no announced migration, is
  refused exactly as before. `plan` also gained the three image-header rows (OS,
  kernel, systemd) for every comparison, not just this one, since they were being
  parsed already and dropped.

- **`guard --fail-on-migration <days>`**, and the matching `fail-on-migration`
  action input. Off by default, like `fail-on-retirement`: without it `guard`
  does not fetch the two manifests at all. With it, each floating `runs-on:` line
  is annotated according to where today sits in the window and which `ImageOS`
  the runner exported: pending, this runner has not moved yet, the migration has
  reached this runner, done, or, past the window on the old image, an anomaly.
  A rollout running past its announced end is annotated `::error` and reported,
  and does not fail the build: GitHub ran both previous `latest` moves late, and
  a failure no threshold turns off is one people remove the check over. An image
  that is neither end of the window does fail whatever the threshold, because
  that is the label meaning something nobody announced.

  `ImageOS` describes one runner, and that runner is serving one job, so it is
  read as evidence about a floating label only when the job it is running asked
  for that label: `GITHUB_JOB` and `GITHUB_WORKFLOW_REF` say which job, and the
  scan already knows which job each `runs-on:` belongs to. A lint step pinned to
  `ubuntu-22.04` in a repo that uses `ubuntu-latest` elsewhere reports the window
  from the calendar alone and says why, instead of announcing that
  `ubuntu-latest` has gone somewhere unrecognised. Where the label is reached
  through a matrix, or the check runs with no `GITHUB_JOB` at all, the image is
  still attributed if it is one of the two the window names.

  When the observed image explains the tool drift `guard` just found, the report
  says so, rather than leaving a page of major bumps looking unexplained. That
  line needs no input, only the job that was actually moved: a lock recorded on
  one side of an announced move, a runner on the other, and a workflow that asked
  for the floating label. A repo that bumps a pinned `ubuntu-24.04` to
  `ubuntu-26.04` by hand is not told GitHub did it.

  ```
  Explained by the scheduled ubuntu-latest migration ubuntu-24.04 -> ubuntu-26.04 (2026-10-19 to 2026-11-19); the tool versions below moved with the image.
  ```

  `--fail-on`, `--fail-on-retirement` and `--fail-on-deprecation` are untouched,
  and so are all four output formats' existing contents: the migration is a new
  annotation group, a new step-summary table (Label, Status, Move, Window, This
  runner, Source) and a new `migration` key in `--json`.

- **`--as-of <date>`** on every command that counts down to something (`guard`, `plan`, `runners`, `actions`). It moves the clock every countdown is
  measured from and nothing else, so `plan --from ubuntu-latest --as-of
  2026-10-19` answers what the report will say on the first day of the rollout
  without pretending the run happened then. A date, or a time with no zone, is
  read as UTC, which is the calendar the countdowns themselves use. It is also
  what makes the migration tests deterministic.

- `init` refusing a floating label now points at the migration when there is one,
  instead of only saying "pass a concrete label".

### Changed

- Every countdown is now whole calendar days from today, not hours divided by 24
  and rounded. A deadline dated 2026-11-19 reads "0 days" for the whole of the
  19th rather than flipping to "1 day ago" at midday, and the printed date and
  the number beside it can no longer disagree. Some `runners` countdowns move by
  a day: `2.335.1 runtime ends 2026-09-24` was "(16 days)" on 2026-09-09 and is
  now "(15 days)", which is the number of days you can actually still run it.
  `--fail-on-deprecation` and `--fail-on-retirement` compare against that same
  number, so a threshold sitting exactly on a boundary can fire a day later than
  it did in 1.3.0.

- The exported `runGuard` now writes the lock file unless the caller passes
  `{ 'update-lock': false }`, on the drift path as well as the first run. It used
  to write on a first run and stay silent on a drift run, because the drift path
  read the key as a plain boolean and a caller building options by hand has
  neither the flag nor the parser default. The CLI is unaffected: it sets the key
  either way.

- `resolveManifestVersions` moved from `src/cli.mjs` to `src/manifest.mjs`, where
  the rest of the manifest reading lives, and is re-exported from `cli.mjs` so
  the public surface is unchanged. The migration lane needed it and importing it
  from the CLI would have made a cycle.

### Fixed

- `guard --no-update-lock` wrote the lock file anyway on the very first run, when
  there was nothing to update yet. The README said the flag leaves the lock file
  untouched, so a lint job that asked for a report got a file to decide about.
  It now writes nothing, says so, and still reports the baseline it observed;
  `--json` gained a `written` boolean, on the drift payload as well as the
  baseline one, so a reader can tell a report from a recorded run, and the step
  summary no longer says the tools were "locked in" a file that does not exist.

- A workflow whose `runs-on:` is a matrix expression had every label-shaped word
  in the file read as a runner it asks for, including the ones in comments, in
  `run:` scripts and in step names. That put retirement and migration
  annotations on lines nobody can act on, and, once the migration lane existed,
  could attribute a runner's image to a label the repo never uses. Comments,
  block scalars and the prose keys (`run`, `name`, `if`) are now skipped, and a
  prose key takes the indented lines below it with it, since a plain scalar
  wraps onto them as readily as a `|` block does. The
  rest of the file is still read, because a label reaches `runs-on:` through a
  `workflow_call` input default or an `env:` value as well as through `matrix:`.

- A trailing comment on a `runs-on:` line was part of the label:
  `runs-on: ubuntu-latest  # floating on purpose` parsed as the whole string, so
  the line was not a floating site and the migration lane had nothing to say
  about it. Both scanners strip the comment first.

- The step summary on a drift run said "Lock file `x` updated to image `y`"
  under `--no-update-lock`, which had left the file alone. It now says the file
  was left where it was, and why.

- The line that credits the migration for the tool drift followed the same job
  rule as the annotations only by label. A matrix leg that names the new image
  itself, next to the floating label, was GitHub moving you; now it is your own
  pin, and the line is withheld.

- A key at the job indent under a *later* top-level block was recorded as a job
  id. `x-templates:` after the jobs map, with a `build:` under it, produced
  `runs-on:` sites labelled as job `build`, which is a real job id in the same
  file. A fabricated id can match `GITHUB_JOB`, so it could have pointed the
  migration lane at the wrong `runs-on:` line. The map now ends where YAML ends
  it, at the next top-level key.

- The line that credits the migration for tool drift read `direct` without a job
  id, so a repo with one job on `ubuntu-latest` and another pinned to
  `ubuntu-26.04` was told GitHub moved it when the pinned job was the one that
  ran. With no `GITHUB_JOB` either job explains the image, and the lane that
  attributes `ImageOS` has always said so. Now both do.

- Every countdown said "(1 days)" on the last day before the date it counts to,
  including the annotation titles and the retirement lane's "1 days left".

- `--tools constructor`, or a lock file with a tool of that name, crashed in the
  manifest resolver: the candidate-names table answered with a function, and a
  function is not a list of names. Every table keyed by a tool or a command reads
  as data now, like the label ones. That includes the three the scanner and the
  prober use, so a `run:` step calling conda's `constructor` CLI, or a
  `uses: constructor@v1`, no longer becomes a detected tool whose probe recipe
  is a function.

- A manifest read that failed was remembered as failed. The run reads each
  manifest once, and the memo held the rejected promise, so the lane that asked
  second got the first one's network error without a request of its own. A 502
  in the migration lane could have left the drift lane with no manifest at all,
  which reads as every locked tool having been removed. Only a read that worked
  is kept.

- A refused or rate-limited attribution lookup took the manifest read down with
  it. Pinning the manifest to the commit that shipped this exact image version
  is an improvement on the label's current readme, not a prerequisite, but both
  sat in one `try`, so a 403 left every manifest-only tool unobserved and the
  diff reported each of them as REMOVED, which is MAJOR. `--fail-on major` red
  the build over a rate limit. The readme fallback now runs whatever the API
  did.

- A tool nothing could observe was still diffed as REMOVED. When both manifest
  reads fail, every manifest-only tool in the lock was warned about as skipped
  and then reported as removed in the same run, so `--fail-on major` red the
  build over an `ECONNRESET` even with the readme fallback in place. Unobserved
  is not removed: those tools are left out of the diff, and they keep the entry
  the lock already has so the next run does not read them as added either.

  A tool the manifest did answer for, by not listing it, is the same case when
  nothing else could have seen it: with no probe recipe the readme is its only
  observer, and the readme is a curated page whose headings get renamed. Those
  are left out of the diff too. A tool that does have a probe recipe was looked
  for on the machine and not found, so a manifest that does not list it either
  is still reported as REMOVED. `--json` names everything left out under
  `notCompared`, since the `diffs` array would otherwise be quietly shorter than
  the lock with the reason only on stdout.

- A job id the run could not be placed by let one workflow file speak for
  another. Inside a reusable workflow `GITHUB_WORKFLOW_REF` names the caller,
  so the job is matched on its id alone, and an id is unique in a file rather
  than in a repository. A `build` job pinned to `ubuntu-26.04` in `release.yml`
  could not veto the `build` job on `ubuntu-latest` in `ci.yml`, because only a
  matrix leg counted as a rival explanation. A run that cannot be placed in one
  file now treats any job of that id pinned to the observed image as the nearer
  explanation, exactly as it does when there is no job id at all, and says so
  rather than reporting the label as migrated.

- A repo with no tools to watch exited 2 from `guard` before the retirement and
  migration gates could report, so the annotation was printed, the reason line
  was not, and CI saw a usage error instead of a failed check. Both gates read
  the workflow files rather than the tool list, so they now report and decide the
  exit code; the advice about `--tools` is still printed.

- A manifest header field one side does not publish was reported as a removal.
  `plan --from ubuntu-24.04 --to windows-2025` said the kernel and systemd had
  gone, in MAJOR red, when Windows manifests simply have no such line.

- A run that could not be placed in a file took a plain `runs-on: ubuntu-latest`
  from any file with a job of the same id. Two `build` jobs, one on
  `ubuntu-latest` and one on `windows-latest`, and a run reporting a caller the
  scan does not hold: the Windows runner's image was attributed to
  `ubuntu-latest` and reported as an image nobody announced, an `::error` that
  fails at any threshold, annotated on a workflow the run never touched. A job id
  that names jobs in files which do not all ask for the label now settles
  nothing, and the run says so.

- With no `GITHUB_JOB`, a matrix leg that can be scheduled onto the observed
  image was reported as a workflow asking for it by name.

- A `uses:` job passing a runner label to a reusable workflow lost it whenever
  the file also had a matrix job. Such a job has no `runs-on:` of its own, so the
  `with:` value is the only record of the runner the file asks for, and the
  retirement lane stopped naming it.

- One matrix job let every label-shaped value in the file speak for the job it
  sat in. The fallback is a token scan, so a sibling job pinned to
  `runs-on: ubuntu-latest` with an `env:` naming `ubuntu-26.04` looked like a job
  reaching the floating label through a matrix with a rival leg: the runner's own
  image was discarded and `--fail-on-migration` failed a runner that had already
  moved. A job whose `runs-on:` is a plain label is scheduled by that label and
  takes nothing from the fallback. The retirement lane stops annotating those
  `env:` values as pinned images too.

- A matrix axis called `name`, `run` or `if` was read as prose and dropped, so a
  `runs-on: ${{ matrix.name }}` over image labels found nothing. Under `matrix:`
  every key is a dimension the job varies over, and the prose keys only hold
  prose outside it.

- A job called `matrix` turned off the prose keys for its whole body, since the
  scan matched the key name anywhere. Only `strategy.matrix` is a matrix now, so
  a step title in that job is prose like any other.

- Running both lint lanes with no workflow directory reported the one missing
  directory twice. The scan is memoized for the run, and the notice is too.

- A workflow title mentioning a label was read as a runner the workflow asks
  for. `run-name: nightly build on ubuntu-22.04` annotated the title line with a
  retirement `::error` for an image the file never uses, as did an input's
  `description:`. Both are prose keys now, alongside `run`, `name` and `if`.
  This one predates 1.4.0: the unfiltered scan read them the same way.

- A label written under a key named `name`, `run` or `if` was dropped even when
  that key held a map rather than prose. 1.4.0 taught the matrix fallback to skip
  the keys that hold shell and titles, and an empty one swallowed everything
  indented under it, so a `workflow_call` input called `name` took its `default:`
  with it and both `--fail-on-retirement` and `--fail-on-migration` went silent
  for that file. An empty prose key now only owns a body that is not itself a
  map.

- `--as-of` accepted a date `Date.parse` reads in local time, which is the
  off-by-a-day the flag normalises to UTC to avoid: `--as-of "Oct 19 2026"`
  measured from the 18th east of Greenwich. It takes ISO dates and date-times
  now, with or without a zone, and refuses the rest.

- The migration step-summary table badged the phase, not the outcome, so a runner
  still serving the old image after the window closed showed `✅ settled` in the
  row beside its own `::error`. The column is headed Status now and names the
  state: moved early, not yet, in window, migrated, settled, stale, unexpected.

- A `runs-on:` taken from an expression resolved outside the jobs map lost its
  job. A `workflow_call` input default and a top-level `env:` value both sit
  above `jobs:`, so the line the label was read from carried no job id, and with
  `GITHUB_JOB` set the runner's image was discarded with the note that the job
  had not run on the floating label. On a reusable build workflow that had
  already migrated, `--fail-on-migration` reddened the build for the whole
  rollout month, and only when run inside a job, which read as flakiness. Such a
  label now belongs to every job whose `runs-on:` is an expression.

- The same sentence was used when this run's own job asks for the floating label
  outright and the namesake job reaches the observed image through a matrix. It
  claimed a matrix this job does not have and a pin the other one does not have.
  A namesake is now described by what it can be scheduled onto when it is not a
  plain pin.

- A job that reaches the floating label through its own matrix was explained as
  two workflows sharing a job id whenever the run could not be placed in a file,
  which is every run with no `GITHUB_WORKFLOW_REF` and every run inside a
  reusable workflow. Withholding the image was right, the sentence was not: a
  namesake job now has to ask for the observed label with a plain `runs-on:`
  before it is named as one.

- Mid-migration, the drift lane attributed the change to the wrong image's
  history. A lock recorded on `ubuntu-24.04` and a runner on `ubuntu-26.04` are
  two operating systems, but guard looked the locked image version up in the
  26.04 commit list, found nothing, and fell back to the nearest 26.04 commit,
  so every moved tool was stamped with a commit that did not ship it. The header
  had the same shape: `ubuntu-26.04 image 20260720.247.2 -> 20260907.131.1`,
  where the first version is a 24.04 image. A run whose label moved names both
  labels now and attributes nothing, in the log, the step summary and `--json`,
  which gained `fromLabel`.

- A tool named after a property of `Object` crashed the drift diff. The maps the
  diff is built from are keyed by tool name, which comes from the lock file,
  `--tools` or the scanner, and they were plain objects: `'constructor' in
  lockedMap` was true, `diffTool` got a function where a version list belongs,
  and guard exited 2 with a report-this-bug prompt. The attribution map had the
  same hole and was the next line to crash. Those maps have no prototype now,
  and the two that arrive as arguments to a public function are read as data,
  so such a tool diffs like any other. `__proto__` was worse than a crash: the
  entry was silently dropped on the way in, so a locked tool of that name was
  never compared at all.

- Every table keyed by a runner label answered `__proto__` and `constructor`
  with something truthy, so `plan --from constructor` took the resolved-migration
  branch and then reported that `--from` was missing. `deadlineFor`,
  `pathForLabel`, `migrationFor`, `nextBrownout` and `retirementStatus` all read
  their tables as data now. The last two returned a deadline with no migration
  targets, and `guard --fail-on-retirement` crashed writing the annotation that
  tells you where to move.

- `ImageOS=__proto__` resolved to a label. The env value indexed the
  `ImageOS` -> label table directly, so any property of `Object.prototype` came
  back truthy, and the migration lane called it an image nobody announced:
  `::error`, exit 1, and a summary cell containing a function body. The lookup
  is an own-key check now, in one place both lanes use.

- A job id that two workflow files both use was told apart by the file only when
  the scan happened to hold a pinned site in the file this run came from. The
  migration lane handed the ownership rule the pinned sites and one floating
  label's, so a `build` job on `windows-latest` in `release.yml` could claim the
  `build` job on `ubuntu-latest` in `ci.yml`, and report an image from outside
  the window: an `::error` and a failed build, in a repo where nothing was wrong.

- A job running inside a reusable workflow had its image discarded. Actions
  reports the *calling* workflow in `GITHUB_WORKFLOW_REF` while `GITHUB_JOB` is
  the id inside the callee, and the scan matched the file first, so the real
  `runs-on:` line was rejected as somebody else's job. The job id now decides,
  and the file is only used to break a tie when the caller has a job of the same
  name.

- With no `GITHUB_JOB` to scope to, a runner's image was read as evidence about
  the floating label whenever it was one of the two the window names, even
  though a sibling job pinned to that exact image explains it just as well. A
  repo with a `compat:` job on `ubuntu-26.04` could report `ubuntu-latest` as
  migrated a fortnight early. Any `runs-on:` naming the observed image now takes
  the evidence away, and the note that used to assert "this check did not run on
  ubuntu-latest", which nothing in that case knew, says what is actually missing.

- `guard --fail-on-migration` diffed the tools named in the workflow files even
  when the lock file listed a different set. The drift lane has always preferred
  the lock, since that is the list it is about to compare. Both lanes now read
  `--tools`, then the lock, then the scan.

[1.4.1]: https://github.com/Booyaka101/runner-drift/releases/tag/v1.4.1
[1.4.0]: https://github.com/Booyaka101/runner-drift/releases/tag/v1.4.0

## [1.3.0] — 2026-09-13

### Added

- **`runner-drift actions`** — the action-runtime lane, for the deadline that is
  ten days out.

  GitHub switched the hosted runners' default action runtime to Node 24 on
  2026-06-16 and
  [removes Node 20 from the images on 2026-09-23](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/).
  An action whose `action.yml` declares `runs.using: node20` stops working that
  day. Nothing in your workflow says which runtime you are asking for, which is
  the whole problem: `uses: actions/checkout@v4` looks like a pin and resolves to
  `node20`, and so does `actions/upload-artifact@v4` (both read from the ref's own
  `action.yml` on 2026-09-13, along with `actions/setup-node@v5`, which is already
  `node24`).

  The command walks `.github/workflows/**`, `.github/actions/**` and the
  `action.yml` at the repository root if there is one, resolves
  every `uses:` to the `runs.using` of the action it actually names, and prints
  the failures first with the days remaining. `owner/repo[/subdir]@ref` is read
  from that exact ref on `raw.githubusercontent.com` (`action.yml`, then
  `action.yaml`); `./path` comes off the checkout; `docker://` is reported as
  `docker` and never fetched. `runs.using: composite` is followed into the
  composite's own steps, five levels deep, and so is a reusable workflow, so the
  report names the grandchild that breaks rather than the line you wrote:

  ```
  WILL FAIL
    acme/outer@v1                composite
      acme/inner@v2              composite
        acme/leaf@v3             node20   no published release declares node24
  ```

  For each reference on a dead runtime it makes one `api.github.com` call for the
  repository's latest release, then reads what that release's major tag really
  declares, so the suggestion is `-> actions/checkout@v7 (node24)` and not an
  assumption that a newer major must be newer inside. Where no release declares
  `node24`, it says so. A 404, a private repository, a cycle, a `${{ }}`
  reference or a rate limit is reported as `unknown` with the reason on the row,
  and an unresolved child counts against its parent rather than passing.

  Exit 1 when anything will fail, 0 otherwise. `--warn-only` always exits 0,
  `--fail-on-unknown` also fails on a reference that could not be resolved, and
  `--json` prints the whole survey and nothing else.

- **The action has a `mode` input**, one of `guard` (the default), `actions` or
  `runners`. It defaults to `guard`, so every existing `with:` block keeps doing
  exactly what it did before this release. `mode: actions` annotates each failing
  `uses:` on its own line, writes the job summary table and sets a
  `will-fail-count` output; `warn-only` and `fail-on-unknown` carry the two flags
  of the same name.

  The step inside the action is now `id: drift` rather than `id: guard`, which is
  only visible to someone reading the action's source.

### Changed

- A failed HTTP response now has its body drained before the error is raised. A
  `Response` whose body is never read holds its socket open, so the process would
  sit there after reporting the failure instead of exiting. The new lane makes a
  404 routine, since every action is tried as `action.yml` and then `action.yaml`,
  which is what turned a latent leak into a hot path.

- `src/detect.mjs` yields the full `uses:` reference with its ref intact, and
  `setup-*` tool detection now reads from that same pass instead of its own scan.
  One walk, and a more careful one: it skips the body of a `run:` block, so a
  `- uses:` written inside a heredoc is no longer read as a reference, and it
  reads flow style (`steps: [{uses: actions/setup-go@v5}]`), which the old
  tool-detection regex caught by accident and a line-anchored scan would have
  dropped.

[1.3.0]: https://github.com/Booyaka101/runner-drift/releases/tag/v1.3.0

## [1.2.1] — 2026-09-09

### Fixed

- **The README said GitHub Enterprise Cloud enforcement "was 2026-09-25".** It is
  2026-09-25, which was sixteen days away when 1.2.0 shipped. The past tense told
  a reader the deadline had already gone when they still had time to act, and it
  buried the more urgent half: the brownouts have been running since 2026-08-24,
  so an affected GHEC fleet is already losing jobs intermittently. Reworded, and
  every other date in the README audited against the current date while there.

  Shipped as a patch rather than left for the next release because the npm page
  renders the published README, and that is the surface most people read before
  installing a CLI.

- The `user-agent` and `action.yml`'s `version` default are now asserted against
  `package.json` by tests. The user-agent said `runner-drift/1.0.2` for the whole
  of 1.1.0 because nothing tied the two together; 1.2.0 corrected it by hand,
  which would have rotted again on the next release.

[1.2.1]: https://github.com/Booyaka101/runner-drift/releases/tag/v1.2.1

## [1.2.0] — 2026-09-09

### Added

- **`runner-drift runners`** — the self-hosted **runner agent** version lane.

  GitHub's minimum-version rule is rolling, which is why there is no number to
  hardcode. Registration needs `2.329.0` or later, and beyond that
  [the docs](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
  require each release to be installed within 30 days of publication: *"If you do
  not perform a software update within 30 days, the GitHub Actions service will
  not queue jobs to your runner."* `actions/runner` `2.337.0` shipped on
  2026-08-26 and the next release moves every version's mark again, so a table
  like the image deadlines in `src/labels.mjs` would be stale within weeks.

  On 2026-09-03 GitHub shipped the feed that makes it checkable
  ([changelog](https://github.blog/changelog/2026-09-03-github-actions-early-september-2026-updates/)):
  `GET /repos/{owner}/{repo}/actions/runners/deprecations/{version}` and the
  `/orgs/{org}/` equivalent, returning `runner_version`,
  `registration_deprecates_at` and `runtime_deprecates_at`. The versions to look
  up come from `GET /{scope}/actions/runners`, which `runner-drift` could already
  reach. The command lists the fleet for `--repo <owner/repo>` (default
  `$GITHUB_REPOSITORY`) or `--org <name>`, groups it by version, resolves each
  version once, and classifies each group `OK`, `RUNTIME-DUE`,
  `REGISTRATION-DUE`, `EXPIRED` or `UNKNOWN-VERSION`. `REGISTRATION-DUE` is its
  own status, never folded into `RUNTIME-DUE`: a runner past its registration
  date keeps running what it has and simply cannot come back, which is the
  failure mode of an ephemeral or `actions-runner-controller` fleet.

  Enforcement dates, from the
  [2026-06-12 timeline](https://github.blog/changelog/2026-06-12-github-actions-minimum-version-enforcement-timeline-for-self-hosted-runners/):
  GHEC with Data Residency was fully enforced on 2026-07-31 (brownouts from
  2026-06-29). On GHEC the brownouts have been running since 2026-08-24 and full
  enforcement lands 2026-09-25. **GitHub Enterprise Server is not covered**, and
  the report says so on every run.

- **`--fail-on-deprecation <days>`** on `runners` and on `guard`. It sets the
  classification window and makes it count against the exit code; without it the
  window is still GitHub's own 30 days so the report names what is coming, and the
  exit code stays 0. `EXPIRED` is the one exception and always fails, the same
  rule the image lane already applies to a label past its retirement date.
  Action input `fail-on-deprecation`, shaped like `fail-on-retirement`.

- **`guard` no longer skips self-hosted runners.** There is still no
  `ImageVersion` to diff, so the 1.1.0 `::notice` is unchanged and still comes
  first; after it, `guard` matches `$RUNNER_NAME` against the runner listing and
  reports that runner's own agent dates in the step summary and `--json`. With no
  token, or a token without the permission, the fallback is byte-for-byte the
  1.1.0 output and exit 0. That fallback is the common case, not an error path.

- Scope honesty, in the output rather than only in the docs. Self-hosted runners
  auto-update by default, so the population at risk is the one GitHub's own
  required-actions list names: `--disableupdate`, VM and container images, and
  runners pinned by `actions-runner-controller`. Where two or more runners report
  the identical version, or a runner is `ephemeral`, the report says to change the
  image tag rather than the host. There is no universal deadline printed anywhere.

- New exports: `src/runners.mjs` in full, plus `annotation`, `countdown`,
  `dateWithCountdown`, `markdownTable`, `runnerGroupDetail`, `runnersReport`,
  `runnersAnnotations` and `runnersSummaryMarkdown` from `src/report.mjs`,
  `compareDottedNumbers` from `src/diff.mjs`, and `MS_PER_DAY`, `daysFromMs`
  and `isPast` from the new `src/dates.mjs`.

- **Every row that is not `OK` names what to update to**, read from
  `actions/runner`'s own release list and cited with its publication date. The
  image lane has always printed "Migrate to macos-15, macos-26"; the runner lane
  said what breaks and when but never what to install. Drafts and prereleases are
  excluded from the target: `actions/runner` publishes prereleases (`v2.320.1` and
  nine others as of 2026-09-09) and pointing at one would be worse than silence.
  An `OK` row is left alone, because it already prints why it is fine.

- **The report names the jobs an at-risk runner serves**, and annotates their
  `runs-on:` lines. A fleet report says a runner is going quiet; it does not say
  whose build stops. `runners` now reads every `runs-on:` set from the workflow
  directory and matches it against each runner's labels by GitHub's own rule, a
  job lands on a runner only when that runner carries every label in the set.
  The match is per runner rather than per version group, because the union of a
  group's labels would claim a job can run on a box that cannot take it. That
  needed a new `extractRunsOnTargets()` in `src/detect.mjs`: the existing
  `labelSites` is flat, one entry per label, and drops `self-hosted` outright,
  so `[self-hosted, linux, gpu]` came out as two useless sites. A
  `runs-on: ${{ … }}` is skipped rather than guessed at, an `OK` or
  `UNKNOWN-VERSION` row annotates nothing, and no workflow directory means no
  join and no complaint.

- Action input `package`, to override the npm spec with a local `.tgz`. The
  composite step body is the surface most users touch and the one `node --test`
  cannot reach, and until now CI could only exercise it against a version that
  does not exist on npm yet. It now runs against the tarball the same job builds.
  Handles the trap that a `.tgz` needs a relative spec and a scratch `package.json`
  or `npx` exits 0 having installed nothing. The registry-spec step stays as well,
  because only that reproduces the `npx`-resolves-the-CWD collision 1.0.2 fixed,
  but it now skips itself until the version is on npm. 1.1.0 shipped with that
  step expected-red on the release candidate, which is how you learn to ignore a
  red X on the run you are about to tag.

### Fixed

- **Nine `js/polynomial-redos` findings, six of them open on `main` since 2026-08-14.**
  CodeQL flagged `\s*(.*)$` in the `runs-on:` and block-list scanners (present
  since 1.0.0) and `/\?.*$/` in the new `endpointLabel`. The pair is what costs:
  both quantifiers can match a space, and `$` can fail because `.` excludes line
  terminators, so one stray carriage return on a long line makes the engine try
  every split of the whitespace between them. Indentation is now an explicit
  space-or-tab class and the value stops at a line terminator instead of
  anchoring on `$`, so there is nothing to fail and nothing to backtrack.
  `extractRunScripts` had the identical shape and CodeQL did not flag it; fixed
  too, rather than left sitting beside a fixed one. Measured on the
  inputs CodeQL named: 60k characters went from 3.5s to under a millisecond, and
  640k now takes 1.3ms. Output is byte-identical on every fixture, because for a
  line with no terminator in it the captures do not change.

  The other six were in the manifest parser and had been open on `main` since
  before 1.1.0 shipped. Same class, same treatment. The worst two were the
  trailing-parenthesis note stripper and the version cleaner, both spelled
  `\s*(...)\s*`: the leading whitespace run is re-tried from every start position
  when the rest cannot match, so an unclosed parenthesis after a long stretch of
  spaces went quadratic. 240k characters took 45 seconds and now take about a
  millisecond. The note stripper is no longer a regex at all, since indexing from
  the last `(` expresses the same rule in linear time. Verified by parsing all
  four real manifest snapshots before and after: 791 tool entries and 912 version
  strings, identical to the byte. Also fixed a
  `js/incomplete-url-substring-sanitization` in a test assertion, which is a
  false positive but a tighter assertion once anchored.

- **`abs()` in `action.yml` did not recognise a Windows-absolute path.** `shell: bash`
  on `windows-latest` is Git Bash, where an absolute path can arrive as
  `D:\a\_temp\…`; only a leading `/` was treated as absolute, so `$PWD` was glued
  onto the front of anything else. Reachable through `lock-file`, `workflows` and
  the new `package` input.

- **`file=` in a workflow annotation was not a path GitHub could resolve, so
  1.1.0's file annotations never actually worked through the action.** GitHub
  matches the value against the repository tree, which means repo-relative and
  POSIX-separated. Two things broke that, and neither surfaced as an error
  because a path GitHub cannot match is not rejected, it just silently attaches
  the annotation to the step instead of the line:
  - `action.yml` passes `--workflows` as an **absolute** path (it has to, since
    `npx` runs from a neutral directory), so every path `detect()` built from it
    was absolute. Anyone using `fail-on-retirement` through
    `uses: Booyaka101/runner-drift@v1` — the documented way — got step-level
    annotations, not the "annotation on the exact `runs-on:` line" the README
    promises. Only a direct `run: npx runner-drift guard …` with the default
    relative path ever worked.
  - on `windows-latest`, `path.join` yields backslashes.

  Both are handled by a new `annotationPath()` that relativises against
  `$GITHUB_WORKSPACE` and converts separators, used by `annotation()` so it fixes
  the image lane and the runner lane at once. A path outside the workspace is left
  as it was, there being nothing better to offer.

- **`--no-summary` and `--no-update-lock` never worked.** Both have been in the
  README table and in `--help` since 1.0.0, and both exited 2 with
  `Unknown option '--no-summary'`: `parseArgs` has no `--no-` negation and the
  options were only declared in their positive form. Every existing test set
  `{ 'update-lock': false }` on `runGuard` by hand, so nothing ever exercised the
  parse layer where the bug lived. The negative forms are now declared and folded
  in, there is a test that drives them through `main()`, and a second test asserts
  that every flag `--help` advertises actually parses.

- **`registration_deprecates_at` values GitHub sends but this build cannot parse**
  were silently dropped to null, which made the row read as safe. They are now
  reported on their own line. `isoOrNull` also requires a `YYYY-MM-DD` prefix
  rather than merely something `Date.parse` accepts, since the rendered date is a
  substring of it.

- **A version not shaped like `X.Y.Z` was reported as below the 2.329.0
  registration floor.** `Number('v2')` is `NaN`, which sorts low, so `v2.337.0`
  and any junk string compared below the minimum. Shape is checked first now.

- **A scope name went straight into the request path.** `--org 'acme?per_page=1'`
  built `https://api.github.com/orgs/acme?per_page=1/actions/runners` and
  `--repo a/..` built a path that normalises away. Owner, repo and org names are
  validated against GitHub's naming rules and rejected with exit 2.

- **A runner name containing `|` broke the step-summary table.** `markdownTable`
  escapes cells now, which also covers the image lane.

- **The report counted runners the API claimed rather than runners it checked.**
  When `total_count` disagreed with the objects returned, or the listing was
  truncated at the page cap, the header printed the larger number. It now counts
  what was classified and states the shortfall.

- `guard --fail-on-deprecation` on a GitHub-hosted runner said nothing, so the
  flag looked broken. It now prints one `::notice` explaining that a hosted
  runner's agent version is GitHub's to manage, and points at `runners`. A bad
  value for the flag is also a usage error on every runner, not only where the
  check would have run.

### Changed

- `daysUntil()` now accepts a full ISO date-time as well as `YYYY-MM-DD`, because
  the API returns timestamps where the image table holds dates. Text output trims
  to the date; `--json` keeps the timestamp.
- `runners --json` has the same keys on every path, success or refusal, so a
  consumer never has to branch on which shape it got.
- A `401` from `api.github.com` is now its own `DriftError` code with a "set
  `GITHUB_TOKEN`" hint, instead of a generic `Unexpected HTTP 401`. The runner
  endpoints are never readable anonymously, so this was the most likely first
  experience of the new command.
- The `user-agent` string said `runner-drift/1.0.2` through all of 1.1.0. It now
  matches the package version.

### Notes

**Prior art.** [`canblmz1/gh-runner-eol`](https://github.com/canblmz1/gh-runner-eol),
a `gh` CLI extension published 2026-09-05, already reads the same deprecations
endpoint at repo, org **and enterprise** scope, and additionally greps
Dockerfiles, Helm values, Terraform, Packer, Ansible and Chef for pinned runner
versions, with table, JSON and SARIF output. It is good, it got there first, and
`runner-drift` is not the first or only tool doing this. The endpoint is what is
new; `runner-drift` reads it, and its own angle is covering the hosted-image axis
and the self-hosted agent axis in one report, from one lock file, with one exit
code. Source-file scanning is deliberately out of scope for 1.2.0: that is their
lane, and duplicating it would be exactly the clone-the-neighbour pattern this
release spent effort avoiding at the function level.

**Where the shared-mechanism line was drawn.** The countdown wording, the
annotation writer, the markdown-table renderer and the day-count validator were
extracted and both lanes now call them: `countdown()` / `dateWithCountdown()`,
`annotation()` (which `annotations()`, `retirementAnnotations()`, `notice()` and
the new runner annotations all route through), `markdownTable()` (three callers),
`wholeDays()` and `summarise()` in `src/cli.mjs`. `compareRunnerVersions` came
out at 66.7% line similarity against `compareImageVersions`, so the tuple compare
moved to `compareDottedNumbers()` in `src/diff.mjs` and both call it.

Adding a third caller for the day arithmetic also made an existing duplication
untenable. `labels.mjs` carried its own copy under a comment reading "Duplicated
from report.mjs, which imports this module"; the rounding is what every countdown
in the output is built on, so all three now come from `src/dates.mjs` and that
comment is gone. `daysUntil` is still exported from `src/report.mjs` for
compatibility.

Left separate on purpose: `runRunners` and `checkOwnRunner` measured 34.8% and
are two genuinely different workflows onto one survey, a fleet report and a
single-runner check, so merging them would need a parameter for every difference.
And `retirementMessage`'s "retired N days ago" phrasing keeps its own shape
rather than being contorted through `dateWithCountdown`.

**Nothing changed for existing users except two bug fixes.** `init`, `guard` and
`plan` output was recorded byte-for-byte over the existing manifest fixtures
across 38 scenarios before this release and again after, including every JSON
payload, every exit code and the self-hosted `::notice`. **33 of the 38 are
byte-identical**, apart from the new lines in `--help`. The five that moved are
the two fixes above and nothing else:

- `guard --no-update-lock`, which used to print `Unknown option` and exit 2.
- four retirement scenarios whose `file=` went from an absolute,
  platform-separated path to `file=test/fixtures/workflows-retirement/pinned.yml`.

All 137 pre-1.2.0 tests pass unmodified, and the suite is now 221.

**Enterprise scope is absent because there is nothing to call.** The 2026-09-03
changelog says the endpoint is callable at repository, organization *or
enterprise* level, and `api.github.com` does answer
`/enterprises/{slug}/actions/runners/deprecations/{v}` with a route-specific
`documentation_url`. Both published OpenAPI descriptions say otherwise: the
`api.github.com` spec contains only the `/orgs/` and `/repos/` deprecations
paths, and `/enterprises/{enterprise}/actions/runners` exists solely in the GHES
spec, which has no deprecations endpoint at all and is not covered by this
enforcement anyway. So `--enterprise` is a decision, not a backlog item.

**`registration_deprecates_at` is documented but not yet populated.** The
[schema](https://docs.github.com/en/rest/actions/self-hosted-runners?apiVersion=2022-11-28)
says string-or-null. On 2026-09-09 the live API omitted the key entirely for every
version from `2.325.0` to `2.337.0`, returning only `runtime_deprecates_at`, so
`REGISTRATION-DUE` cannot fire against today's API. It is implemented and tested
against both shapes and will start firing when GitHub fills the field in. Until
then, a version below the `2.329.0` registration floor gets its own line.

[1.2.0]: https://github.com/Booyaka101/runner-drift/releases/tag/v1.2.0

## [1.1.0] — 2026-08-12

### Added

- **`--fail-on-retirement <days>`** on `guard`: scans the workflow files for
  pinned `runs-on:` labels and fails the job (exit 1) when any of them retires,
  or hits a scheduled brownout, within N days. Each hit is a
  `::error file=,line=,col=` annotation pointing at the exact `runs-on` line
  (a `::warning` when only a brownout falls inside the threshold), plus a
  retirement table in the step summary and a `retirement` block in `--json`.
  The check needs no lock file and no hosted runner, so it works in a plain
  lint job; a label already past its retirement date always fails, whatever
  the threshold. Without the flag, `guard` behaves exactly as in 1.0.2.
- `nextBrownout(label, now)` and `retirementStatus(label, now)` exported from
  the package, and `labelSites` ({label, file, line, col} per `runs-on`
  occurrence) on `detect()` / `analyseWorkflow()`.
- Action input `fail-on-retirement`, passed straight through to the flag.

### Fixed

- `macos-14` and `macos-14-arm64` carried an empty brownout list. The
  announcement ([actions/runner-images#13518](https://github.com/actions/runner-images/issues/13518))
  schedules eight windows (14:00-00:00 UTC) before removal on 2026-11-02:
  2026-10-05, -12, -16, -19, -23, -26, -29 and -30. Those dates are now in the
  table. Also added the `macos-14-large` and `macos-14-xlarge` deadline rows
  from the same issue. They have no runner-images manifest, so they get the
  countdown and the retirement check, and manifest lookups skip them cleanly.

[1.1.0]: https://github.com/Booyaka101/runner-drift/releases/tag/v1.1.0

## [1.0.2] — 2026-08-05

### Fixed

- The action failed with `sh: 1: runner-drift: not found` (exit 127) when run
  inside a checkout whose own `package.json` is named `runner-drift` at the same
  version the action requests — i.e. this repo dogfooding itself. `npx` resolves
  a bin against the current directory's `package.json` first, decides the package
  is already present, looks for `node_modules/.bin/runner-drift`, and dies before
  any install has happened. It worked in every other repo, which is why it went
  unnoticed until the guard ledger surfaced the red run.
  The action now invokes `npx` from an empty temp directory and passes absolute
  paths for `--lock-file` and `--workflows`. Note `npx --package=` does **not**
  fix this — it is the working directory that decides, not the package spec.

## [1.0.1] — 2026-08-05

### Fixed

- `action.yml`'s `description` was 168 characters; the GitHub Marketplace rejects
  anything 125 or longer, so the listing could not be published. Shortened to 113.

### Changed

- `action.yml` `version` input now defaults to `1.0.1`.

[1.0.1]: https://github.com/Booyaka101/runner-drift/releases/tag/v1.0.1

## [1.0.0] — 2026-08-05

First release.

### Added

- **`runner-drift init`** — scans `.github/workflows/*.y[a]ml`, detects the
  `runs-on:` labels and the tools your `run:` steps actually invoke, and writes
  `runner-lock.json` from the live runner-images manifest for that label.
- **`runner-drift guard`** — runs inside a workflow. Reads the runner's
  `ImageVersion` / `ImageOS`, probes the real installed version of each locked
  tool (falling back to the image manifest for tools with no probe recipe),
  diffs against the lock, attributes every change to the `actions/runner-images`
  commit that shipped it, writes a markdown table to `$GITHUB_STEP_SUMMARY` plus
  `::warning` annotations, updates the lock, and exits 0 — exiting 1 only under
  `--fail-on major|minor|any`.
- **`runner-drift plan --from <label> --to <label>`** — fetches both image
  manifests, intersects them with the tools your workflows use, prints only the
  affected rows plus a countdown to the source label's retirement date.
- Composite GitHub Action at the repo root (`action.yml`) wrapping `guard`,
  with `fail-on`, `tools`, `lock-file` and `workflows` inputs.
- Manifest parser covering every shape the real readmes use: `CMake 3.31.6`,
  `Clang: 13.0.1, 14.0.0, 15.0.7`, `AzCopy 10.32.4 - available by …`,
  bare-version lists under `#### Go`, `| CMake | 3.22.1<br>3.31.5 |` tables, and
  the name-less `| Version | Environment Variable |` Java table.
- `ImageVersion -> SHA` index built from runner-images rollout commit messages,
  with blob-at-SHA snapshots and a nearest-earlier-commit fallback for when the
  readme lags the rollout (rows are labelled *approximate*).
- Deprecation deadline table for `ubuntu-22.04` (+ arm) and `macos-14`, each
  printed with its source issue URL.
- Clean skips with a clear message for: self-hosted runners, unknown labels,
  labels whose manifest path 404s, floating labels (`ubuntu-latest`), zero
  detected tools, a missing workflow directory, and API rate limiting.

[1.0.0]: https://github.com/Booyaka101/runner-drift/releases/tag/v1.0.0
