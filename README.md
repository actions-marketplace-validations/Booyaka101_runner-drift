# runner-drift

[![npm](https://img.shields.io/npm/v/runner-drift?color=cb3837&logo=npm)](https://www.npmjs.com/package/runner-drift)
[![Marketplace](https://img.shields.io/badge/Marketplace-runner--drift-2ea44f?logo=github)](https://github.com/marketplace/actions/runner-drift)
[![ci](https://github.com/Booyaka101/runner-drift/actions/workflows/ci.yml/badge.svg)](https://github.com/Booyaka101/runner-drift/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](package.json)

**Your CI is pinned to `actions/checkout@v5` and `node@22`. It is not pinned to the
compiler.** GitHub rebuilds the hosted runner images roughly weekly and you cannot
select an older one — [the feature request was rejected](https://github.com/actions/runner-images/issues/13034#issuecomment-3350116604)
("there's no technical feasibility for implementation yet"), and GitHub staff have
said plainly that [it's impossible to specify an older runner image in a workflow](https://github.com/orgs/community/discussions/160655).
So when Clang, Python or CMake moves underneath you, the first sign is a red build
with no diff to blame.

`runner-drift` locks the tool versions your workflows actually use, diffs them on
every image bump, and names **the runner-images commit that shipped the change**.

It also answers the question every `ubuntu-22.04` user has right now — GitHub is
[deprecating that image from 2026-09-17, fully unsupported 2027-04-17, with four
brownouts starting 2027-03-23](https://github.com/actions/runner-images/issues/14254):
*what actually breaks if I move to `ubuntu-24.04`?*

```
$ npx runner-drift plan --from ubuntu-22.04 --to ubuntu-24.04
ubuntu-22.04 -> ubuntu-24.04 (images 20260720.234.2 -> 20260720.247.2)
ubuntu-22.04 is fully unsupported on 2027-04-17; brownouts begin 2027-03-23 (source: actions/runner-images#14254)
255 days left (230 until the first brownout) — deprecation began 2026-09-17; see https://github.com/actions/runner-images/issues/14254
brownout windows (14:00-00:00 UTC): 2027-03-23, 2027-03-30, 2027-04-06, 2027-04-13
announced migration targets: ubuntu-24.04, ubuntu-26.04, ubuntu-latest

Clang 13.0.1,14.0.0,15.0.7 -> 16.0.6,17.0.6,18.1.3  REMOVED: 13.0.1, 14.0.0, 15.0.7 / ADDED: 16.0.6, 17.0.6, 18.1.3
Python 3.10.12 -> 3.12.3  MINOR

2 of 3 detected tool(s) change; 1 unchanged (not shown)
```

That is real output against the live manifests. Note what is **not** there: CMake.
It is 3.31.6 on both images, so it is suppressed — the report is only the rows that
affect you, picked by scanning your own workflows for the tools your steps invoke.

Since 1.2.0 it answers the same question about the other half of the fleet.
GitHub enforces a minimum self-hosted **runner agent** version, and the rule is
rolling: you have 30 days from each `actions/runner` release to install it, or
[the Actions service stops queueing jobs to your runner](https://docs.github.com/en/actions/reference/runners/self-hosted-runners).
`runner-drift runners` reads the dates straight from GitHub's API and names the
runners that are about to go quiet. See
[Self-hosted agent versions](#5-runner-drift-runners--self-hosted-agent-versions).

Since 1.3.0 it watches a third clock, and this one is nearly out. GitHub
[removes Node 20 from the hosted runner images on 2026-09-23](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/),
and any action declaring `runs.using: node20` stops working that day. Your
workflow does not say which runtime it is asking for: `uses: actions/checkout@v4`
looks like a pin, and it is `node20`. So is `actions/upload-artifact@v4`.
`runner-drift actions` resolves every `uses:` to the runtime the action really
declares, follows composites and reusable workflows into whatever they call, and
names the step that breaks rather than the line you wrote. See
[which `uses:` survive](#6-runner-drift-actions--which-uses-survive-the-node-20-removal).

- No account, no hosted service, no paid tier. Two endpoints only:
  `raw.githubusercontent.com` and `api.github.com`.
- The image and action lanes run unauthenticated; `GITHUB_TOKEN` only raises the
  rate limit (and reaches actions in private repos).
  The `runners` lane is the exception: GitHub never serves the self-hosted runner
  endpoints anonymously, so it needs a token with administration read.
- Zero runtime dependencies. Node 22+, ESM.

---

## Install

```bash
npx runner-drift --help        # no install
npm i -D runner-drift          # or as a dev dependency
npm i -g runner-drift          # or globally
```

## Usage

### 1. `runner-drift init` — record a baseline

```bash
$ runner-drift init
Scanned 2 workflow file(s) in .github/workflows
Runner label: ubuntu-22.04 (image 20260720.234.2, 22.04.5 LTS)
Locked 3 tool(s): CMake, Clang, Python
Wrote runner-lock.json
Heads up: ubuntu-22.04 is fully unsupported on 2027-04-17 (https://github.com/actions/runner-images/issues/14254)
Preview the move:  runner-drift plan --from ubuntu-22.04 --to ubuntu-24.04
Next: add the guard step to your workflow (see the README) and commit runner-lock.json.
```

Commit `runner-lock.json`.

### 2. `runner-drift guard` — watch for drift in CI

Add the action to any job (it lives at the root of this repo, so it also works
straight from the Marketplace):

```yaml
      - uses: Booyaka101/runner-drift@v1
        with:
          fail-on: major        # omit to report only and never fail the job
```

Or call the CLI directly:

```yaml
      - run: npx runner-drift guard --fail-on major
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

The first run records the baseline and exits 0:

```
baseline recorded — ubuntu-22.04 image 20260623.199.1
  Terraform: 1.15.6 (from manifest)
  Kotlin: 2.4.0-release-281 (from manifest)
  CMake: 3.31.6 (from manifest)
Wrote runner-lock.json. Commit it so the next image bump can be diffed.
```

A later run, after GitHub has rolled four new images:

```
::warning title=runner-drift: Terraform patch::Terraform drifted on ubuntu-22.04: 1.15.6 -> 1.15.8 (PATCH) — shipped by 20260714.228.1 https://github.com/actions/runner-images/commit/f3d0fbf668c2d437a5a5a03e75206801e22e5e62
::warning title=runner-drift: Kotlin patch::Kotlin drifted on ubuntu-22.04: 2.4.0-release-281 -> 2.4.10-release-377 (PATCH) — shipped by 20260720.234.2 https://github.com/actions/runner-images/commit/3b7fa9c1aa1efb5fc0ba4b443dcfa69f47f53434
ubuntu-22.04 image 20260623.199.1 -> 20260720.234.2
  Terraform 1.15.6 -> 1.15.8  PATCH  [20260714.228.1] https://github.com/actions/runner-images/commit/f3d0fbf668c2d437a5a5a03e75206801e22e5e62
  Kotlin 2.4.0-release-281 -> 2.4.10-release-377  PATCH  [20260720.234.2] https://github.com/actions/runner-images/commit/3b7fa9c1aa1efb5fc0ba4b443dcfa69f47f53434
```

…and the same thing as a table in the job summary:

## runner-drift

`ubuntu-22.04` image `20260623.199.1` → `20260720.234.2`

| Tool | Locked | Now | Change | Shipped by |
| --- | --- | --- | --- | --- |
| `Terraform` | 1.15.6 | 1.15.8 | 🟡 PATCH | [20260714.228.1](https://github.com/actions/runner-images/commit/f3d0fbf668c2d437a5a5a03e75206801e22e5e62) |
| `Kotlin` | 2.4.0-release-281 | 2.4.10-release-377 | 🟡 PATCH | [20260720.234.2](https://github.com/actions/runner-images/commit/3b7fa9c1aa1efb5fc0ba4b443dcfa69f47f53434) |

Four image versions shipped between the lock and the run, and each tool is pinned
to the *specific* one that changed it — not just "the newest image". `CMake` did
not move, so it is not in the table.

### 3. `runner-drift plan` — before you migrate

```bash
runner-drift plan --from ubuntu-22.04 --to ubuntu-24.04
runner-drift plan --from macos-14 --to macos-15 --tools python,node,dotnet
runner-drift plan --from ubuntu-22.04 --to ubuntu-26.04 --json
```

### 4. Fail before the brownout

Deprecated images get scheduled brownouts before removal: `macos-14` jobs fail
14:00-00:00 UTC on eight dates starting 2026-10-05, then the label disappears on
2026-11-02 ([#13518](https://github.com/actions/runner-images/issues/13518));
`ubuntu-22.04` follows the same script from 2027-03-23
([#14254](https://github.com/actions/runner-images/issues/14254)). The first
brownout looks exactly like flaky CI, and by then the fix is urgent.

`guard --fail-on-retirement <days>` scans your workflow files for pinned
`runs-on:` labels and fails while the migration is still routine. It needs no
lock file and no hosted runner, so it works as a plain lint job:

```yaml
  runner-retirement:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: Booyaka101/runner-drift@v1
        with:
          fail-on-retirement: 60   # or: npx runner-drift guard --fail-on-retirement 60
```

Each hit is a file annotation on the exact `runs-on:` line, with the dates, the
announced migration targets and the source issue:

```
::error file=.github/workflows/release.yml,line=12,col=14,title=runner-drift: macos-14 retires in 82 days::macos-14 is fully unsupported on 2026-11-02 (82 days); next brownout 2026-10-05 (54 days). Migrate to macos-15, macos-26, macos-latest. See https://github.com/actions/runner-images/issues/13518
runner-drift: macos-14 is fully unsupported on 2026-11-02 (82 days) and --fail-on-retirement 60 is set.
```

When only a brownout falls inside the threshold the annotation is a `::warning`
(`runner-drift: <label> deprecation`), but the job still fails: those are the
dates your builds break. The step summary gets a table (Label, Where, Next
brownout, Fully unsupported, Migrate to, Source), `--json` gets a `retirement`
block, and a label already past its date always fails, whatever the threshold.
`ubuntu-latest` and friends float past retirements, so they are never flagged;
neither is `self-hosted`. `runs-on: ${{ matrix.os }}` is resolved from the
matrix values in the same file.

### 5. `runner-drift runners` — self-hosted agent versions

Two clocks run on a self-hosted runner. The image one does not apply, since you
built the machine. The **agent** one does. GitHub requires each new
`actions/runner` release to be installed within 30 days of publication, and the
docs state the consequence plainly: *"If you do not perform a software update
within 30 days, the GitHub Actions service will not queue jobs to your runner."*
On GitHub Enterprise Cloud the **brownouts have been running since 2026-08-24**
and full enforcement lands **2026-09-25**. GHEC with Data Residency was enforced
on 2026-07-31
([timeline](https://github.blog/changelog/2026-06-12-github-actions-minimum-version-enforcement-timeline-for-self-hosted-runners/)).
GitHub Enterprise Server is not covered.

Because the rule is rolling there is no minimum to hardcode. `2.337.0` shipped on
2026-08-26 and the next release moves the mark again, so `runner-drift` asks
[the API GitHub added on 2026-09-03](https://github.blog/changelog/2026-09-03-github-actions-early-september-2026-updates/):
`GET /{scope}/actions/runners/deprecations/{version}`, one lookup per distinct
version, cached for the run. Twenty runners on one version cost one call.

The command needs no lock file and no runner of its own, so it runs as a plain
lint job. Three runners, two baked into a container image at `2.335.1` and one
auto-updating at `2.337.0`, on 2026-09-09. The dates below are the values the
live API returned that day, and they will have moved since:

```
$ runner-drift runners --org acme --fail-on-deprecation 30
self-hosted runners — acme (3 runners, 2 versions)
  RUNTIME-DUE   2.335.1  x2  arc-linux-1, arc-linux-2
                runtime support ends 2026-09-24 (16 days) — jobs stop being queued
                update to 2.337.0, published 2026-08-26 — the newest stable actions/runner release
                ephemeral runners — change the actions-runner-controller image tag, not the host
  OK            2.337.0  x1  build-mac-1  (published 2026-08-26)
                no end date returned — this version is current
note: self-hosted runners auto-update by default — at risk are the ones registered with --disableupdate, baked into a VM or container image, or pinned by actions-runner-controller
note: enforcement covers github.com and GitHub Enterprise Cloud, not GitHub Enterprise Server
source: GET /orgs/acme/actions/runners/deprecations/2.335.1
source: GET /orgs/acme/actions/runners/deprecations/2.337.0
runner-drift: 2 self-hosted runner(s) on 2.335.1 lose runtime support on 2026-09-24 (16 days) and --fail-on-deprecation 30 is set.
```

That last line goes to stderr and the run exits 1, with an `::error` annotation
and the same rows as a table in the job summary. Drop `--fail-on-deprecation` and the annotation becomes a
`::warning` and the exit code goes back to 0. Only that flag can change the exit
code, and `EXPIRED` is the one exception: a date already past always fails, the
same rule the image lane uses for a label past its retirement.

Most repositories have no self-hosted runners at all. That is the normal answer,
not a failure:

```
$ runner-drift runners --repo Booyaka101/runner-drift
self-hosted runners — Booyaka101/runner-drift (0 runners)
no self-hosted runners registered — nothing to check; GitHub-hosted runners are not affected
source: GET /repos/Booyaka101/runner-drift/actions/runners
```

#### The statuses

| Status | Means | Fails the job? |
| --- | --- | --- |
| `OK` | no end date returned, or both dates beyond the window | never |
| `RUNTIME-DUE` | `runtime_deprecates_at` inside the window. Jobs stop being queued | with `--fail-on-deprecation` |
| `REGISTRATION-DUE` | `registration_deprecates_at` inside the window. It keeps running what it has but cannot be re-created | with `--fail-on-deprecation` |
| `EXPIRED` | a date already past | always, whatever the threshold |
| `UNKNOWN-VERSION` | `version` is `null` (never connected), or the API does not recognise the string | never |
| `PERMISSION` | the endpoint was refused, plus the permission that would fix it | never (`::warning`, exit 0) |

`RUNTIME-DUE` and `REGISTRATION-DUE` are separate on purpose. A runner past its
registration date still finishes the jobs it has, it just cannot come back. Fold
the two together and an ephemeral or ARC fleet reads as healthy right up to the
next scale-down.

Any row that is not `OK` also gets an update target, read from `actions/runner`'s
own release list. Drafts and prereleases are excluded, because `actions/runner`
really does publish them and pointing you at `v2.320.1` would be worse than
saying nothing. An `OK` row does not get one: it already prints why it is fine,
and nagging there would be the universal-deadline noise this report avoids.

#### Which of your jobs actually run there

A fleet report tells you a runner is about to go quiet. It does not tell you
whose build stops. If a workflow directory is present, `runners` closes that gap:
it reads every `runs-on:` set and matches it against each runner's labels using
GitHub's own rule, which is that a job lands on a runner only if that runner
carries **every** label in the set. The match is per runner, not per group, so a
job needing `[self-hosted, linux, gpu]` is not reported against a runner that
happens to sit next to a GPU box on the same version.

```
  RUNTIME-DUE   2.335.1  x2  arc-linux-1, arc-linux-2
                runtime support ends 2026-09-24 (16 days) — jobs stop being queued
                update to 2.337.0, published 2026-08-26 — the newest stable actions/runner release
                serves .github/workflows/bench.yml:9 (runs-on: self-hosted, linux, gpu) — arc-linux-1, arc-linux-2
                ephemeral runners — change the actions-runner-controller image tag, not the host
```

Each of those also becomes an `::error` on the exact `runs-on:` line, the same
way `--fail-on-retirement` annotates a pinned image label, so on a pull request
it shows up next to the job that is going to stop rather than only in the log. A
`runs-on: ${{ matrix.os }}` is skipped rather than guessed at, and a row that is
`OK` or `UNKNOWN-VERSION` annotates nothing. No workflow directory means no join
and no complaint: `runners` still needs no checkout.

The window defaults to GitHub's own 30 days, so the plain report still tells you
what is coming. `--fail-on-deprecation <days>` sets the window *and* makes it
count against the exit code.

#### As a lint job

```yaml
  runner-versions:
    runs-on: ubuntu-latest
    steps:
      - run: npx runner-drift runners --org acme --fail-on-deprecation 30
        env:
          GITHUB_TOKEN: ${{ secrets.RUNNER_ADMIN_TOKEN }}
```

#### The permission, which is the part that trips people up

The self-hosted runner endpoints are never readable anonymously, and the default
`GITHUB_TOKEN` cannot read them either. You need one of:

| Scope | Fine-grained token | Classic token |
| --- | --- | --- |
| `--repo owner/repo` | "Administration" repository permission, read | `repo` |
| `--org name` | "Self-hosted runners" organization permission, read | `admin:org` |

Without one, `runner-drift` says which permission is missing and which endpoint
it tried, then exits 0. A missing permission is not a deprecation, so it never
fails your build on its own. It does emit a `::warning`, so the run is not
silently green either.

```
$ runner-drift runners --repo actions/runner --fail-on-deprecation 30
self-hosted runners — actions/runner
PERMISSION  GET /repos/actions/runner/actions/runners was refused (HTTP 403)
            A fine-grained token needs the "Administration" repository permission (read);
            a classic token needs the `repo` scope. The default GITHUB_TOKEN has neither.
```

#### Who is actually at risk

Self-hosted runners auto-update by default, so most fleets fix themselves and
this command reports `OK` forever. The population it exists for is the one
GitHub's own required-actions list names: runners registered with
`--disableupdate`, runners baked into VM or container images, and runners pinned
by `actions-runner-controller`. Two or more runners reporting the identical
version, or any runner marked `ephemeral`, is the tell, and `runner-drift` says
to change the image tag rather than telling you to SSH in and rerun `config.sh`.
There is no universal deadline here, only your fleet's.

`guard` uses the same lookup for the runner it happens to be running on. Give it
a token with administration read and it matches `$RUNNER_NAME` against the
listing and reports that runner's own dates in the summary table and `--json`.
Without a token, or without the permission, it prints the same `::notice` it
printed in 1.1.0 and exits 0. That is the common case, not an error path.

### 6. `runner-drift actions` — which `uses:` survive the Node 20 removal

GitHub switched the hosted runners' default action runtime to Node 24 on
2026-06-16 and [removes Node 20 from the images on 2026-09-23](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/).
An action that declares `runs.using: node20` stops working that day. The catch is
that the runtime is not written in your workflow. `uses: actions/checkout@v4`
says nothing about Node, and `actions/checkout@v4` is `node20`, as is
`actions/upload-artifact@v4` (both read from the ref's own `action.yml` on
2026-09-13).

`runner-drift actions` resolves every `uses:` in the repository to the
`runs.using` of the action it really names.

```
$ npx runner-drift actions
scanned 1 workflow file, 3 action reference(s), 3 unique
Node 20 is removed from GitHub-hosted runners on 2026-09-23 (10 days)

WILL FAIL
  actions/checkout@v4          node20   -> actions/checkout@v7 (node24)
  actions/upload-artifact@v4   node20   -> actions/upload-artifact@v7 (node24)

ok
  actions/setup-node@v5        node24

2 of 3 action references stop working in 10 days.
```

That listing is the report. Like the other lanes, a real run prints its
`::error` annotations above it, one per failing `uses:` site, so a failure lands
on the line you wrote rather than in a wall of log.

What it reads:

- `.github/workflows/**/*.yml|yaml`, plus the `action.yml` of every composite
  under `.github/actions/**` and the one at the repository root, if there is one.
  A step you own is yours to fix, and nobody reading only the workflows would
  ever see it. The root file matters most: its steps run in everybody else's
  job.
- `owner/repo[/subdir]@ref` resolves to that exact ref's `action.yml` on
  `raw.githubusercontent.com`, falling back to `action.yaml`.
- `runs.using: composite` is followed into the composite's own `uses:` lines,
  five levels deep, and so is a reusable workflow
  (`owner/repo/.github/workflows/x.yml@ref`). A cycle stops at the repeat.
- `./path` is read from the checkout. `docker://image` is reported as `docker`
  and never fetched.

Because the whole chain is walked, the report names the step that actually
breaks and not just the line you wrote:

```
WILL FAIL
  acme/outer@v1                composite
    acme/inner@v2              composite
      acme/leaf@v3             node20   no published release declares node24
```

For each action on a dead runtime it makes one extra `api.github.com` call for
that repository's latest release, resolves the release's major tag, and reads
what the tag really declares. So the suggestion is `-> actions/checkout@v7
(node24)` rather than a guess that a newer major must be newer inside. Where no
release declares `node24`, it says so instead of inventing a target.

A 404, a private repository or a rate limit is reported as `unknown` with the
reason. It is never a crash, and never a silent pass:

```
unknown
  acme/private@v1   ?   no action.yml or action.yaml at acme/private@v1 — wrong ref, or a private repository (set GITHUB_TOKEN)
```

An `unknown` does not fail the run on its own, because a proxy or a rate limit
produces the same row as a genuine gap. `--fail-on-unknown` says the opposite:
in a repository where every reference is supposed to resolve, unchecked is not
good enough.

Exit 1 if anything will fail, 0 otherwise. `--warn-only` always exits 0, and
`--json` prints the structured result and nothing else. In a workflow:

```yaml
- uses: Booyaka101/runner-drift@v1
  with:
    mode: actions
```

which annotates every failing `uses:` line where it is written, writes a job
summary table, and sets a `will-fail-count` output.

## Configuration

### CLI

| Flag | Applies to | Default | Meaning |
| --- | --- | --- | --- |
| `--workflows <path>` | all | `.github/workflows` | Workflow directory **or** a single workflow file |
| `--lock-file <path>` | `init`, `guard` | `runner-lock.json` | Lock file location |
| `--tools <a,b,c>` | all | detected | Override detection. Aliases (`python`, `npx`, `clang++`, `g++`, `javac`, …) resolve to manifest names; anything else is matched against the manifest case-insensitively, so `--tools Terraform,Kotlin` works |
| `--label <label>` | `init` | detected | Explicit runner label |
| `--from` / `--to` | `plan` | — | Runner labels to compare (required) |
| `--fail-on <level>` | `guard` | never fail | `major`, `minor` or `any` |
| `--fail-on-retirement <days>` | `guard` | off | Fail when a pinned label retires or browns out within N days |
| `--org <name>` | `runners` | — | Organization to survey. Mutually exclusive with `--repo` |
| `--repo <owner/repo>` | `runners` | `$GITHUB_REPOSITORY` | Repository to survey |
| `--fail-on-deprecation <days>` | `runners`, `guard` | report only, window 30 | Set the window **and** fail when a runner version's support ends inside it |
| `--warn-only` | `actions` | off | Report every failing `uses:` and still exit 0 |
| `--fail-on-unknown` | `actions` | off | Also fail when a `uses:` cannot be resolved to a runtime |
| `--json` | all | off | Machine-readable output |
| `--no-summary` | `guard`, `runners`, `actions` | on | Skip the `$GITHUB_STEP_SUMMARY` write |
| `--no-update-lock` | `guard` | on | Report drift but leave the lock file untouched |

Exit codes: `0` success (including "drift found" without `--fail-on`, a refused
permission, and an empty fleet), `1` drift at or above the `--fail-on` threshold,
a label inside the `--fail-on-retirement` window, a runner version inside the
`--fail-on-deprecation` window, an `EXPIRED` runner version at any threshold, or
an action reference that stops working when Node 20 is removed (`actions`, unless
`--warn-only`), an unresolved reference under `--fail-on-unknown`, `2` usage /
configuration error.

### Action inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `mode` | `guard` | Which command the action runs: `guard`, `actions` or `runners` |
| `fail-on` | `''` | `major`, `minor`, `any`; empty means report only |
| `fail-on-retirement` | `''` | Days ahead to fail on a label retirement or brownout; empty disables |
| `fail-on-deprecation` | `''` | Days ahead to fail on this self-hosted runner's own agent version; empty disables. Needs `github-token` to carry administration read |
| `warn-only` | `false` | `mode: actions` only. Annotate and summarise every failing reference, but never fail the job |
| `fail-on-unknown` | `false` | `mode: actions` only. Treat a reference that could not be resolved as a failure |
| `tools` | `''` | Comma-separated override |
| `lock-file` | `runner-lock.json` | Lock file path |
| `workflows` | `.github/workflows` | Scanned when there is no lock yet |
| `version` | `1.3.0` | npm version of `runner-drift` to run |
| `package` | `''` | Override the npm spec, e.g. a `.tgz` built in the same job. Only useful for testing the action before the version it requests is published |
| `github-token` | `${{ github.token }}` | Rate limit, plus the runner listing for `fail-on-deprecation` (which the default token cannot read) |

Outputs: `lock-file` is the lock path that was read or written (`mode: guard`),
`will-fail-count` is how many action references stop working when Node 20 is
removed (`mode: actions`).

`mode` defaults to `guard`, so an existing `with:` block keeps doing exactly what
it did before 1.3.0. `mode: runners` surveys the repository the job is running in;
for a fleet-wide survey across an org, `runners` is a plain `run:` step, shown
[above](#as-a-lint-job).

### `runners --json`

The same keys on every path, so nothing has to branch on which shape it got. On a
refusal `groups` is empty and `message` / `hint` carry the reason; on success
`message` is `null` and `hint` is `[]`.

```json
{
  "scope": { "kind": "org", "name": "acme", "path": "/orgs/acme" },
  "runnersUrl": "https://api.github.com/orgs/acme/actions/runners",
  "windowDays": 30,
  "failOn": true,
  "checkedAt": "2026-09-09T00:00:00.000Z",
  "status": "OK",
  "message": null,
  "hint": [],
  "truncated": false,
  "surveyedCount": 3,
  "totalCount": 3,
  "failing": true,
  "ghesNote": "enforcement covers github.com and GitHub Enterprise Cloud, not GitHub Enterprise Server",
  "autoUpdateNote": "self-hosted runners auto-update by default — at risk are …",
  "source": "https://github.blog/changelog/2026-06-12-github-actions-minimum-version-enforcement-timeline-for-self-hosted-runners/",
  "groups": [
    {
      "version": "2.335.1",
      "count": 2,
      "names": ["arc-linux-1", "arc-linux-2"],
      "online": 2,
      "busy": 1,
      "ephemeral": true,
      "labels": ["self-hosted", "Linux", "X64", "gpu"],
      "status": "RUNTIME-DUE",
      "runtime": { "at": "2026-09-24T15:30:55Z", "date": "2026-09-24", "days": 16, "past": false },
      "registration": null,
      "unknownVersion": false,
      "unparsedDates": [],
      "source": "GET /orgs/acme/actions/runners/deprecations/2.335.1",
      "publishedAt": null,
      "updateTo": { "version": "2.337.0", "publishedAt": "2026-08-26T14:33:29Z" },
      "imagePinned": true,
      "workflowSites": [
        {
          "labels": ["self-hosted", "linux", "gpu"],
          "expression": false,
          "file": ".github/workflows/bench.yml",
          "line": 9,
          "col": 13,
          "runners": ["arc-linux-1", "arc-linux-2"]
        }
      ]
    }
  ]
}
```

`surveyedCount` is what was actually classified and `totalCount` is what the API
claims the fleet is. They differ when the listing was truncated at the page cap or
when `total_count` disagrees with the objects returned, and the text report says so
either way. `runtime.at` keeps the full timestamp; the text report trims it to the
date.

### `actions --json`

The whole survey, in the order the text report prints it: failing first, then
unknown, then ok. Trimmed here to one failing and one ok reference (the third,
`actions/upload-artifact@v4`, is the same shape as the first).

```json
{
  "removalDate": "2026-09-23",
  "defaultSwitchedAt": "2026-06-16",
  "source": "https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/",
  "checkedAt": "2026-09-13T00:00:00.000Z",
  "daysLeft": 10,
  "root": ".",
  "workflowPath": ".github/workflows",
  "actionsPath": ".github/actions",
  "files": [
    {
      "file": ".github/workflows/ci.yml",
      "kind": "workflow"
    }
  ],
  "missing": false,
  "workflowsMissing": false,
  "readErrors": [],
  "totalReferences": 3,
  "uniqueReferences": 3,
  "counts": {
    "fail": 2,
    "unknown": 0,
    "ok": 1
  },
  "references": [
    {
      "ref": "actions/checkout@v4",
      "kind": "remote",
      "using": "node20",
      "source": "https://raw.githubusercontent.com/actions/checkout/v4/action.yml",
      "children": [],
      "status": "fail",
      "where": [
        {
          "file": ".github/workflows/ci.yml",
          "line": 8,
          "col": 15
        }
      ],
      "upgrade": {
        "available": true,
        "checked": true,
        "ref": "actions/checkout@v7",
        "tag": "v7",
        "latestRelease": "v7.0.1",
        "using": "node24",
        "url": "https://raw.githubusercontent.com/actions/checkout/v7/action.yml"
      }
    },
    {
      "ref": "actions/setup-node@v5",
      "kind": "remote",
      "using": "node24",
      "source": "https://raw.githubusercontent.com/actions/setup-node/v5/action.yml",
      "children": [],
      "status": "ok",
      "where": [
        {
          "file": ".github/workflows/ci.yml",
          "line": 9,
          "col": 15
        }
      ]
    }
  ],
  "failing": true
}
```

`using` is what the action's own `action.yml` declares, `source` is the exact
file that was read, and `where` is every line the reference is written on, so a
reference used by six jobs is resolved once and still reports all six. A
composite carries its steps in `children`, recursively, and its `status` is the
worst status underneath it. `upgrade` is present only on a reference that will
fail: `available: false` with a `reason` means the lookup ran and there is no
release declaring `node24`, while `checked: false` means the lookup itself could
not be made.

### `runner-lock.json`

```json
{
  "schemaVersion": 1,
  "label": "ubuntu-22.04",
  "imageOS": "ubuntu22",
  "imageVersion": "20260623.199.1",
  "tools": {
    "Python": { "versions": ["3.10.12"], "source": "probe", "command": "python3 --version" },
    "Clang":  { "versions": ["13.0.1", "14.0.0", "15.0.7"], "source": "manifest" }
  },
  "updatedAt": "2026-08-05T02:52:15.070Z"
}
```

`source` records *how* the version was observed. `guard` probes the tool directly
(`python3 --version`, `clang --version`, `java -version`, …) when it can, because a
manifest says what the image was **built** with while a probe says what your job
will actually **execute**. Tools with no probe recipe fall back to the manifest for
that exact image version, and the source is recorded so a source change is never
mistaken for a version change.

## Supported labels

`ubuntu-22.04`, `ubuntu-24.04`, `ubuntu-26.04` (+ `-arm`), `windows-2022`,
`windows-2025`, `macos-14`, `macos-15`, `macos-26` (+ `-arm64`).

Deadline data covers the images with an announced retirement date:
`ubuntu-22.04` (+ arm) and `macos-14` (+ arm64, `-large`, `-xlarge`). The
large/xlarge labels have no public manifest, so they get the retirement
countdown and `--fail-on-retirement`, not the tool diff. Every other label
diffs fine, it just has no countdown.

## Limitations

- **Floating labels are refused, on purpose.** `ubuntu-latest` / `macos-latest`
  are re-pointed by GitHub without notice, so `plan` will not guess what they
  mean — pass the concrete label. `guard` does not need to guess: it reads the
  real label from the runner's `ImageOS` env var at run time.
- **Image deadlines are a hardcoded table; runner-version deadlines are not.**
  The `runs-on` label dates in `src/labels.mjs` are transcribed from
  [#14254](https://github.com/actions/runner-images/issues/14254) and
  [#13518](https://github.com/actions/runner-images/issues/13518) and printed with
  their source URL. GitHub publishes no machine-readable feed for those, so if it
  moves an image date the table needs a release. The self-hosted **runner agent**
  dates are the opposite: they come from
  `GET /{scope}/actions/runners/deprecations/{version}` on every run and are never
  stored, because the 30-day rule is rolling and any number baked into this package
  would be wrong by the next `actions/runner` release.
- **`registration_deprecates_at` is documented but not yet populated.** The
  [schema](https://docs.github.com/en/rest/actions/self-hosted-runners?apiVersion=2022-11-28)
  says string-or-null, and on 2026-09-09 the live API omitted the key entirely for
  every version from `2.325.0` to `2.337.0`, returning only
  `runtime_deprecates_at`. `REGISTRATION-DUE` is implemented and tested against
  that shape, and it will start firing the day GitHub fills the field in.
  Meanwhile a version below the `2.329.0` registration floor is called out on its
  own line.
- **Detection is a targeted line scan**, not a full YAML parse (the package has zero
  dependencies). It handles inline, flow-sequence and block-sequence `runs-on:`, and
  resolves `runs-on: ${{ matrix.os }}` by harvesting label-shaped values from the same
  file. If it misses something, `--tools` and `--label` override it completely.
- **Resolving `uses:` needs the network, and says so when it cannot.** Each unique
  remote reference is one `raw.githubusercontent.com` read of that exact ref's
  `action.yml`, plus, for the failing ones only, one `api.github.com` release
  lookup. A 404, a private repository, an offline box or a rate limit is reported
  as `unknown` with the reason on the row. It is never guessed and never silently
  counted as fine. Unauthenticated `api.github.com` allows 60 calls an hour, so a
  repository with many distinct failing actions wants `GITHUB_TOKEN` set.
- **A `${{ }}` reference is undecidable and is reported that way.** `uses:
  ${{ matrix.action }}` only has a value at run time, so there is no `action.yml`
  to read. Same for a private action you have no token for: 404 is indistinguishable
  from a typo in the ref, and the row says both possibilities.
- **What your own `action.yml` declares is not checked, only what it calls.**
  The root action's steps are read, so a composite of yours that calls
  `actions/checkout@v4` is caught. Its own `runs.using:` is not classified,
  because the question this command answers is which references stop working,
  and your action is not a reference here. A job with `uses: ./` makes it one,
  which is what this repository does.
- **Composites nest five levels deep, then stop.** A chain deeper than that, or a
  cycle, is `unknown` with the reason rather than a hang, and an unresolved chain
  counts against its parent instead of passing. Composites also get no
  `-> owner/repo@vN` of their own: `using: composite` says nothing about what its
  steps resolve to, so the upgrade sits on the child row that actually declares a
  runtime.
- **Self-hosted runners have their own lane, not a skip.** There is still no
  `ImageVersion` to diff, so `guard` prints its `::notice` about the image, then
  checks the runner's own **agent** version against GitHub's dates. That needs a
  token with administration read; without one it falls back to the 1.1.0 behaviour,
  which is the `::notice` and exit 0.
- **Repo and org scope only, because that is all there is.** The 2026-09-03
  changelog says the endpoint is callable at enterprise level too, and asking
  `api.github.com` for `/enterprises/{slug}/actions/runners/deprecations/{v}`
  does return a route-specific `documentation_url`. But GitHub's own
  [OpenAPI description](https://github.com/github/rest-api-description) for
  `api.github.com` contains **only** the `/orgs/` and `/repos/` deprecations
  paths, and `/enterprises/{enterprise}/actions/runners` appears solely in the
  GHES spec — where there is no deprecations endpoint at all and this enforcement
  does not apply. So there is nothing to call at enterprise scope on
  github.com or GHEC, and `--enterprise` is deliberately absent rather than
  pending. Checked 2026-09-09 against both published specs.
- **Source files are not scanned for pinned runner versions.** If your Dockerfile,
  Helm values or Terraform pins an `actions/runner` version, `runner-drift` will
  not find it there. It reads what your runners actually report. For the scanning
  angle, [`canblmz1/gh-runner-eol`](https://github.com/canblmz1/gh-runner-eol)
  already does it well.
- **A fleet larger than 1000 runners is reported as a prefix.** The listing
  follows pagination to ten pages of 100. Past that the report says how much it
  saw of how many, rather than quietly surveying the first slice. It also says so
  when the API's `total_count` disagrees with the objects it actually returned.
- **Azure DevOps is out of scope**, even though the same images and the same
  deprecation apply there.
- **No auto-fix.** `runner-drift` tells you exactly what moved and who moved it; the
  migration is yours.
- **Multi-version probes report one version.** `clang --version` reports the default
  clang, while the manifest lists all three. That is why the `source` field exists —
  compare like with like.

## Development

```bash
git clone https://github.com/Booyaka101/runner-drift
cd runner-drift
node --test          # 270 tests, fully offline against recorded real fixtures
```

Tests run against four **real** manifest snapshots in `test/fixtures/`
(`Ubuntu2204` at two different image versions, `Ubuntu2404`, `macos-15`), so the
golden `plan` output is deterministic while the live path re-fetches. The runner
lane works the same way: `test/fixtures/runners/deprecations-recorded.json` is
the verbatim live response for eight versions, recorded 2026-09-09, so the dates
the tests assert on are GitHub's own. The fleet listings alongside it are built
to the documented schema, because this account owns no self-hosted runners to
record; the empty listing in the recorded file is real.

The runner tests stub `globalThis.fetch` rather than the module boundary, so
`src/runners.mjs` is exercised *through* `src/http.mjs` and the 401, 403, 404 and
rate-limit paths are the real ones.

The action-runtime tests work off a fixture repository in
`test/fixtures/actions-repo/` and a routing table of `action.yml` bodies, which
covers what the live network cannot reproduce on demand: a nested composite whose
grandchild is `node20`, a cycle, a private repo that 404s, a reusable workflow, a
subdirectory action spelled `action.yaml`, and a SHA pin with a trailing version
comment. The runtimes the README claims for the real actions were read from the
live `action.yml` of each ref on 2026-09-13.

## License

MIT — see [LICENSE](LICENSE).
