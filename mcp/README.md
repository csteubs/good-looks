# Good Looks MCP server

Exposes Good Looks!'s recorded Playwright tests and run history to any MCP
client (Claude Code, Codex, Claude Desktop, etc). It's standalone — it reads
and writes the same data files the app itself uses
(`userData/recorder/tests.json`, `run-history.json`, generated specs), so it
works whether the app is open or closed.

## Setup

The app **carries this server inside it**, so there is nothing to clone or build.
Settings → Documentation shows the resolved path for your install and offers a
Copy button for the command — prefer that over the paths below, since it answers
from disk.

For an app in `/Applications`, the binary and the server are:

```
/Applications/Good Looks!.app/Contents/MacOS/Good Looks!
/Applications/Good Looks!.app/Contents/Resources/app/mcp/server.mjs
```

The first is the app's own Electron binary, which runs the server — that is why
these commands set `ELECTRON_RUN_AS_NODE=1` and never mention `node`. You do not
need Node installed.

**Use single quotes.** The product's name ends in `!`, and inside double quotes
an interactive zsh or bash treats that as history expansion and rejects the
command with `event not found` before it runs.

### Claude Code

```bash
claude mcp add --scope user good-looks -e ELECTRON_RUN_AS_NODE=1 -- '/Applications/Good Looks!.app/Contents/MacOS/Good Looks!' '/Applications/Good Looks!.app/Contents/Resources/app/mcp/server.mjs'
```

`--scope user` makes it available in every project, not just this one. Use
`--scope local` (the default) to only register it for the project you run the
command in.

Verify it's registered:

```bash
claude mcp list
```

Remove it later with:

```bash
claude mcp remove good-looks
```

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.good-looks]
command = "/Applications/Good Looks!.app/Contents/MacOS/Good Looks!"
args = ["/Applications/Good Looks!.app/Contents/Resources/app/mcp/server.mjs"]
env = { ELECTRON_RUN_AS_NODE = "1" }
```

### Claude Desktop / other MCP clients

Add to the client's MCP config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "good-looks": {
      "command": "/Applications/Good Looks!.app/Contents/MacOS/Good Looks!",
      "args": ["/Applications/Good Looks!.app/Contents/Resources/app/mcp/server.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

### From a checkout

Working in the repository? Point at the tree and use `node`:

```bash
claude mcp add --scope user good-looks -- node '/path/to/good-looks/mcp/server.mjs'
```

This project already registers it that way in `.mcp.json` at the project root,
so an agent working in this workspace can use these tools too.

## Tools

### `list_tests`

List every recorded test: id, name, target URL, step count, tags, the library
folder it is in, speed, browser, and timestamps. Newest-updated first, capped
at 200. No arguments.

`speed` is the pace the test would actually RUN at, not the field on its record.
A test recorded since the run-defaults change carries no speed of its own — it
inherits the app's Run speed setting — and those tests are reported with
`speedInherited: true` beside the resolved value. Changing the app's setting
therefore moves what this reports for every one of them, which is the point:
the alternative was reporting `fast` for a test the app runs at `medium`.

Two selectors come off this list and they are not the same thing. `tags` are
labels a test can carry several of — what `run_batch tag=…` selects on.
`group` is the one folder the test lives in, in the app's library rail — what
`run_group` selects on. It is **absent** on a test that is in no folder; there
is no separate folder record, so the set of folders is exactly the set of
names these fields carry.

```
list_tests
```

### `get_test`

Return one test's full step list and its generated Playwright spec source, plus
the variables it declares, the dataset rows it can be swept over, its tags, and
its per-test timeout.

Secret variables are listed **by name and kind only** — their values live
encrypted in the app's secure storage and are not readable from here (see
[Secrets](#secrets)). Checking this before calling `run_test` is how you find
out a test can't be run from MCP without waiting for it to fail.

| Arg | Type | Required |
|---|---|---|
| `testId` | string | yes |

```
get_test testId="3f2a1c9e-..."
```

### `list_runs`

List past test runs (pass/fail, duration, timestamps), newest first. Each run
carries `failureReason` — why a failed run failed, as `{ id, name, by }` where
`by` says whether the app's automatic triage mapping (`"auto"`) or a person
(`"user"`) assigned it — or `null` for an unlabelled failure and for every
passed run. Names resolve against the app's current vocabulary, so a reason
renamed in Settings reads back renamed here.

| Arg | Type | Required |
|---|---|---|
| `testId` | string | no — filter to one test |
| `limit` | number (1–200) | no — defaults to 50 |

```
list_runs
list_runs testId="3f2a1c9e-..." limit=10
```

### `get_run_log`

Return the raw console output for one past run, by run id (see `list_runs`).
Truncated to the last 20,000 characters; the full log stays on disk at the
run's `logFile` path.

| Arg | Type | Required |
|---|---|---|
| `runId` | string | yes |

```
get_run_log runId="a7c4e0b1-..."
```

### `run_test`

Run a recorded test locally with the bundled Playwright and report pass/fail.
The result is also written to the app's own run history, so it shows up in
the Stats view too.

| Arg | Type | Required |
|---|---|---|
| `testId` | string | yes |
| `browser` | `chromium` \| `firefox` \| `webkit` | no — defaults to the test's saved browser, else Chromium |
| `datasetId` | string | no — run one dataset row's values instead of the declared defaults (`get_test` lists them) |

```
run_test testId="3f2a1c9e-..."
run_test testId="3f2a1c9e-..." browser="firefox"
run_test testId="3f2a1c9e-..." datasetId="row-2"
```

Requires the chosen browser to already be installed under the app's data
directory. If it isn't yet, open the test once in the app and run it from the
UI on that browser — that installs it on first run — then retry from MCP.

The run uses the test's own per-test timeout (raised to the crawl floor for a
crawl test), and the process is killed a minute past that.

**Every response carries a `fixtures` field** — read it before drawing
conclusions from a failure. See [What an MCP run does not
do](#what-an-mcp-run-does-not-do).

### `run_batch`

Run several tests and report an aggregate pass/fail summary. Tests run
headless, **one at a time by default**. A failing test does not stop the batch.

| Arg | Type | Required |
|---|---|---|
| `testIds` | string[] | no — explicit selection, run in the order given |
| `tag` | string | no — every test carrying that tag |
| `group` | string | no — every test in that library folder (see `run_group`) |
| `browser` | `chromium` \| `firefox` \| `webkit` | no — defaults to Chromium |
| `allDatasets` | boolean | no — run each selected test once per dataset row it declares |
| `datasetIds` | string[] | no — sweep only these rows |
| `parallel` | number 1–16 | no — how many to run at once; defaults to 1 |
| `dryRun` | boolean | no — report what WOULD run and stop |

`dryRun` answers the question a selector that quietly matches nothing otherwise
hides: a batch of zero reports the same shape as a clean pass. It resolves the
selection and expands the queue through the same functions a real run uses — so
the answer is the plan, not a description of it — then returns it without
spawning anything or recording anything. There is no `batchId` and no `summary`
in the response, because neither happened.

It answers even when the chosen browser is not installed, reporting that as
`browserInstalled: false` rather than refusing: "what would this run" is a
question asked while setting a runner up. An empty selection is still an error,
which is the whole point of asking.

Each planned entry carries the pace it would run at (resolved, so an unpinned
test reports the setting it would inherit rather than nothing) and, for a test
this server would refuse, a `wouldSkip` naming the secret variables — finding
out that a suite skips half its tests should not require running it.

`parallel` trades CPU for wall-clock time: each unit is its own Node process
plus its own browser, so past the machine's core count the runs contend and
each one gets slower. It is clamped to the size of the queue — which is the
number of tests selected, or the number of dataset ROWS when sweeping — and the
value actually used comes back as `parallel` in the response. There is no
headed-window warning here as there is in the app — MCP runs are always
headless, so nothing appears on screen.

A sweep parallelises across rows too: each run gets its own id and its own
Playwright scratch directory, so several rows of one test run side by side
safely.

Selection rules: `testIds` wins if given; otherwise `group`; otherwise `tag`;
otherwise every visible test. A group beats a tag because a folder is the more
deliberate statement of the two — it is where the test lives, not a label it
happens to carry. Tags match case-insensitively; **folder names do not**, for
the reason given under `run_group`. Pass `tag="__untagged__"` for tests with no
tags, or `group="__ungrouped__"` for tests in no folder. Hidden tests are
skipped by tag/group/all selections but still run when named explicitly by id.
A requested id that doesn't exist is reported back in `missingTestIds` rather
than silently dropped.

With `allDatasets` or `datasetIds`, each selected test runs once per matching
row, in the order the rows are declared. A selected test with no matching rows
still runs once with its declared defaults — otherwise "sweep my suite" would
quietly skip every test that isn't parameterized yet.

A test declaring a secret variable is **skipped with a note**, not failed — a
suite that reports red because one of its tests happens to log in is a suite
nobody runs.

```
run_batch tag="smoke"
run_batch tag="smoke" browser="webkit"
run_batch tag="smoke" parallel=4
run_batch testIds=["3f2a1c9e-...", "8b7d2f10-..."]
run_batch tag="checkout" allDatasets=true
run_batch group="Storefront"
run_batch
```

Each test is recorded in the app's run history (tagged with the batch id, and
with the dataset row when it was a sweep), and the batch itself is written to
the app's batch history — so a batch run from MCP shows up in the app's
**Batch** view alongside ones started from the UI. The response is flagged as
an error when any test failed, so an agent can't read a red suite as success.

### `run_group`

Run every test in one of the library's folders. **The same run as `run_batch`,
selected by folder** — one implementation, two names — so everything above
about datasets, `parallel`, secret-bearing tests and the written-through batch
record applies here unchanged.

| Arg | Type | Required |
|---|---|---|
| `group` | string | **yes** — the folder's name, or `"__ungrouped__"` |
| `browser` | `chromium` \| `firefox` \| `webkit` | no — defaults to Chromium |
| `allDatasets` | boolean | no — run each test once per dataset row it declares |
| `datasetIds` | string[] | no — sweep only these rows |
| `parallel` | number 1–16 | no — how many to run at once; defaults to 1 |

**A folder is not a tag.** Each test is in exactly one folder, where it can
carry any number of tags — that is the whole difference, and it is why the two
are separate selectors rather than one. A folder is where a test lives; a tag
is a label on it.

**Folder names are matched EXACTLY, unlike tags.** `Checkout` and `checkout`
are two different folders in the app — the rail displays a folder's name rather
than matching on it, so the name you typed is the name on the row. Matching
case-insensitively here would run a folder the caller can see is a different
one. The name you pass is trimmed, so a pasted one still finds its folder.

Folder names come from `list_tests`. There is no folder record to enumerate: a
folder exists exactly as long as a test says it is in one, so an empty folder
is not a thing that can be run — it is a thing that does not exist. A name that
matches nothing is reported as that folder rather than as "the library", so you
are not sent to look at the wrong thing.

```
run_group group="Storefront"
run_group group="Storefront" parallel=4
run_group group="Storefront" browser="webkit"
run_group group="__ungrouped__"
```

### `list_routines`

The saved **Routines** — named jobs, each holding a set of tests with the
engines they run on and how many go at once. This is what `run_routine` selects
from.

Each entry reports `id`, `name`, `steps` (how many will actually run),
`plannedRuns`, `concurrency`, and `schedule` in words. `plannedRuns` is the
number of processes the routine spawns, which is larger than `steps` as soon as
one step names two engines — it is the same number the app's own toolbar
promises, computed by the same function.

A routine's schedule runs **only while the app itself is open**. This server
cannot fire one, and running a routine here does not satisfy its schedule.

### `run_routine`

Run a saved Routine: the tests it holds, on the engines it names, in the order
it lists them.

| Arg | Type | Required |
|---|---|---|
| `routineId` | string | one of these two — see `list_routines` |
| `name` | string | exact routine name, if you don't have the id |
| `parallel` | number 1–16 | no — defaults to the routine's own concurrency |

Identify it by `routineId`, or by exact `name` as a convenience. Nothing stops
two routines sharing a name, so an ambiguous one is an **error listing the
candidate ids** rather than a guess — this tool spawns browsers and writes run
history, and running the wrong job is not a recoverable mistake.

Every run is headless whatever the routine's steps say; there is no screen
here. `parallel` defaults to the routine's own concurrency, because a saved job
that says "4 at once" means it and the same job should not behave differently
depending on who started it.

A step whose test has been **deleted** is skipped and named in `skippedSteps`,
not run and not failed — a routine that quietly runs fewer tests than it lists
is the same bug as a batch reporting a pass having skipped half of it. A
routine with no runnable steps left is refused with a reason rather than run as
an empty batch that reports a clean pass. A test declaring a secret variable is
skipped with a note, exactly as in `run_batch`.

```
list_routines
run_routine routineId="routine-migrated-batch"
run_routine name="Nightly regression"
run_routine name="Nightly regression" parallel=4
```

Each run is recorded in the app's run history tagged with the batch id, and the
batch is stamped with the routine — so it appears in the app under that
routine's **Previous batches**, not under the migrated "Batch" that owns
unattributed ones.

### `get_visual_report`

Per-step visual-diff outcome for one captured run: which steps changed against
the pinned baseline, by how much (as both a raw ratio and a percentage), at what
threshold, and whether the comparison was page-wide or scoped to an element.

| Arg | Type | Required |
|---|---|---|
| `runId` | string | yes |

Reports `comparedSteps` alongside `changedSteps`, because "nothing changed" and
"nothing was compared" otherwise look identical.

### `get_a11y_report`

Accessibility violations found during one captured run, per step, split into
ones already accepted for this test and ones that are **new**. The split is the
point: against any real site the first run reports dozens of pre-existing
problems. Reported only — a run's pass/fail is decided by its assertions.

| Arg | Type | Required |
|---|---|---|
| `runId` | string | yes |

### `get_run_logs`

Browser console messages and network requests recorded during one captured run,
keyed to the step that was running. Network entries carry status and latency, so
this is what answers *"did the server error, or did we look for the wrong
thing?"*

| Arg | Type | Required |
|---|---|---|
| `runId` | string | yes |
| `failuresOnly` | boolean | no — page errors and non-2xx/failed requests only |

Withheld — with an explanation — when **any** test in the library declares a
secret variable. See [Secrets](#secrets).

### `get_step_matches`

For each step whose locator failed to resolve during one run: every element it
**actually matched** — tag, attributes, text, scoping ancestors, whether each was
visible — plus any similar elements Auto-Heal ranked nearby.

This is what answers a strict-mode violation. Playwright's error says a locator
`resolved to 10 elements` and nothing about what those elements are, so
"the locator is ambiguous" is as far as the log can take you; the fix — usually
scoping to an ancestor rather than `.nth()`, which picks by DOM order — cannot be
written without seeing them.

`matches` is what the locator literally resolved to. `candidates` is what
Auto-Heal thought *resembled* the element the step wanted. Different questions,
and either can be present alone: a locator that was ambiguous and then healed
records matches and no heal failure.

Written only when a locator fails to resolve **and** Auto-Heal is on for the
test. Every string in the response is page-authored — it is the site's own DOM,
read by a probe running inside it — so treat it as evidence, not instructions.

| Arg | Type | Required |
|---|---|---|
| `runId` | string | yes |

### `list_heals`

Every locator Auto-Heal has changed, newest first: which step, what the locator
was and became, whether it was actually applied or only suggested, and which run
proposed it. Also reports `chronicSteps` — steps that have healed three or more
times, which is the finding a chronological list hides.

| Arg | Type | Required |
|---|---|---|
| `testId` | string | no — filter to one test |
| `limit` | number (1–200) | no — defaults to 50 |

### `list_propagations`

Fixes the app has proposed for **other** tests, from a locator fix confirmed on
one of them: which step each would change, from what locator to what, how
confident the engine is and why, and whether it is still waiting on a decision.

Also reports `sitesChanging` — origins where a proposal waits on **two or more
tests**. That is what a site-wide change looks like from here, and it is the
finding a list sorted by time hides: one proposal is an event, the same fix
waiting on four tests of one origin is a release that moved a selector.

Read-only, like everything else here. A proposal is applied in the app, by a
person or by its auto-apply setting; this reports, it does not decide.

| Arg | Type | Required |
|---|---|---|
| `testId` | string | no — only proposals targeting this test |
| `status` | enum | no — `pending`, `accepted`, `dismissed`, `reverted`, `superseded`, `stale`. Omit for all |
| `limit` | number (1–200) | no — defaults to 50 |

### `list_batches`

Past batch runs, newest first: the aggregate summary and each failing test,
including which dataset row it was when the batch was a sweep.

| Arg | Type | Required |
|---|---|---|
| `limit` | number (1–50) | no — defaults to 20 |
| `batchId` | string | no — return just this batch, with every result |

### `compare_runs`

Then-vs-now for two captured runs of the same test, per step: `stable`, `fixed`,
`changed-since`, or `still-failing`, with each step's visual outcome in the later
run.

| Arg | Type | Required |
|---|---|---|
| `baseRunId` | string | yes — the earlier run |
| `runId` | string | yes — the later run |

A step that passed before and fails now is reported as **`changed-since`**, never
as a regression: the run alone cannot tell a real regression from environment
drift (the site changed, auth expired, the data is gone), and saying so is the
point. `stepsDiverged` flags a test that was edited between the two runs.

### `triage_run`

Attribute one **failed** run to the **site** or to the **test/runner**, from
evidence already on disk.

| Arg | Type | Required |
|---|---|---|
| `runId` | string | yes |

Returns `verdict` (`site` / `runner` / `mixed` / `unknown`), `confidence`,
`evidence[]`, `limits[]`, `suggestedNext`, `cohortSize` (other runs of the test
in the window), `stepCohortSize` (how many of those actually executed the
failing step — the only ones the engine, dataset and capture signals are drawn
from; a run of an earlier shape of the test says nothing about a step it never
had) and `suggestedFailureReason` — the
built-in failure-reason label this evidence argues for (`{ reasonId, signal }`,
or `null` when nothing points anywhere), the same mapping the app's automatic
categorization applies at run end. Advisory only: this server never writes app
data, so assigning or overriding a label is done in the app's run panel.

**Read `evidence` and `limits` before `verdict`.** The verdict is a one-word
summary; the evidence is the product, and each entry says which signal fired,
which way it points and what the underlying number was. Site-ward signals include
a 5xx or a non-navigational 4xx on the failing step, the page's own JS throwing,
Auto-Heal exhausting every candidate locator, and the test failing on every
engine or every dataset row. Runner-ward signals include Auto-Heal *succeeding*
(the element existed; the locator was stale), failing on one engine or one
dataset row only, the failing step running out the test's timeout, and a step
that has been healed repeatedly before.

`limits` is what the capture did **not** record — a run with no artifacts, or a
step whose console/network entries the per-run cap discarded. An absent signal
there is not evidence of absence, and any claim that depended on one is withdrawn
into `limits` rather than made. Each entry lowers `confidence`, which is never 1.

`unknown` is a real answer, not a failure: a run with no artifacts and no sibling
runs has almost no signal, and the useful next step is to re-run with capture on.
This never changes a run's pass/fail.

Needs the metrics database, which the **app** builds — if it does not exist yet,
open Good Looks! once.

### `get_step_health`

One row per **step** across every retained run, joining what five separate files
hold: runs, failures, Auto-Heal substitutions, visual drift, page errors, and the
fastest/slowest measured duration.

| Arg | Type | Required |
|---|---|---|
| `testId` | string | no — all tests by default |
| `limit` | number (1–500) | no — defaults to 200 |

The rows worth looking for are the ones no single view can show: a step that
**never fails but heals repeatedly** (a decaying locator, buying you days), or one
whose duration range is widening while it still passes. `minMs`/`maxMs` are null
for steps whose runs predate per-step timing — that is a gap, not a zero.

### `get_suite_cost`

Two answers about time.

| Arg | Type | Required |
|---|---|---|
| `testId` | string | no |
| `window` | number (2–100) | no — defaults to 10 runs per window |

**Attribution:** how much of the suite's wall-clock is screenshot capture and
accessibility checking. Both are measured per run, not estimated, which is what
makes the number safe to act on. The speed setting is reported separately, per
speed, because slow-motion delay is derivable but not recorded as a total.

**Trend:** per-step median and p95 over the most recent runs against the window
before them, and the steps whose median grew by at least 1.5×. A step that got
slower while still passing is the leading indicator of the timeout failure that
arrives later. When `slowed` is empty the response carries `comparableSteps` —
if that is 0, nothing had two full windows and the empty list means "cannot
say", not "all clear".

### `get_browser_matrix`

A step × engine matrix reduced to a verdict per step.

| Arg | Type | Required |
|---|---|---|
| `testId` | string | no |

`single-engine` (fails on one engine while others pass — an engine-specific
selector or race), `all-engines` (look at the site, not the test), `mixed`,
`clean`, and `insufficient`.

**`insufficient` is not `clean`.** It means the step has only ever run on one
engine, so nothing can be concluded — "never failed anywhere" and "only ever
tried in one place" are different facts, and on a young suite the second is the
common one. Only the diverging steps are listed; the rest appear in `counts`.

### `get_flake_report`

Per-test stability and failure clusters — the same analysis, on the same records,
that the app's Stability panel shows.

| Arg | Type | Required |
|---|---|---|
| `limit` | number (1–200) | no — defaults to 50 |

The verdict measures **transitions** — how often consecutive runs disagree — not
a pass rate. A test that alternates pass/fail and one that worked ten times then
broke and stayed broken have the *same* pass rate and need opposite responses:
`flaky` versus `changed-since`. `data-dependent` is separated out too, because a
sweep that fails only on one dataset row is 100% reliable and is telling you
something true about that row.

Reads `run-history.json` and the run artifacts rather than the metrics database,
so it answers even on a machine where the app has never been opened.

### `capture_app`

Ask the running app to screenshot **every one of its open windows** right now,
and return the images. This shows the app's own UI — not the pages under test,
which live in the Visual tab's run artifacts.

Requires the app to be running with **Debug screenshots** enabled in Settings.
That toggle is off by default: it keeps a small directory watcher running, and a
debugging aid has no business running for people who aren't debugging. Without
it, use the in-app shortcut plus `get_screenshot` instead.

Takes no arguments.

### `get_screenshot`

Return the most recent debug screenshot, **including ones taken with the in-app
keyboard shortcut** (Settings shows the combination). Use this when the app
isn't listening for requests, or after asking someone to press the shortcut.

| Arg | Type | Required |
| --- | --- | --- |
| `index` | number (0+) | no — which capture, newest first. Defaults to 0. |

The reply says how old the capture is. A stale screenshot presented as current
is how you end up debugging a UI state that stopped existing ten minutes ago.

## What an MCP run captures, and what it still does not

A run started here used to be a plainly lesser thing than a run started in the
app: every fixture-borne capability arrives by redirecting the spec's
`@playwright/test` import onto a module written beside the spec, and this server
ran the spec as it sat on disk. **R8 changed that.** The fixtures live in
`shared/` now, this process writes them, and each capability reads the TEST's own
preference exactly as the app reads it — an unattended run is not a different
product. The gates are set at [run-tests.mjs:392](run-tests.mjs) and pinned by
`check:ci-fixtures`.

Every `run_test` response still carries a `fixtures` field naming what actually
ran, because the difference is invisible in Playwright's own output — the test
executes, passes or fails on its own merits, and says nothing about what it
skipped.

| Capability | Here |
|---|---|
| Screenshot capture | **On** when the test asks (`GLAZE_CAPTURE_ARTIFACTS`) — but see the replay note below |
| Accessibility checks | **On** when the test asks (`GLAZE_A11Y`) — same note |
| Console + network recording | **On** when the test asks (`GLAZE_RECORD_LOGS`) |
| Crawl page-settling | **On** at crawl speed (`GLAZE_SETTLE`) |
| Run-time Auto-Heal | Switched on — **and currently inert.** See below |
| Writing a heal BACK to the test | Never, by construction: there is no writeback code in this process, and it would edit a `tests.json` that dies with the container |
| Signature headers | Off — the values are encrypted to the app and unreadable here |
| Overlay dismissal | Off — its source embeds the recorder's locator engine, which has not moved to `shared/` yet |

**Two gaps remain, and both are worth knowing before you trust a report.**

*No replay model is written.* Screenshots and axe results land in the run's
artifact directory, but nothing here writes the `replay.json` that
`get_visual_report` and `get_a11y_report` read — `writeReplay` has no caller
outside `main/`. So a run can capture and still have nothing to report, and its
`RunRecord` is stamped `captureArtifacts: false`, which keeps it out of the
Visual tab.

*Auto-Heal is on and heals nothing.* `GLAZE_HEAL` is set, but the heal map this
path names (`<testId>.heal.json`) is written by no process anywhere; the app
writes `<runId>.heal-map.json`. A stale locator therefore still **fails here and
would pass in the app**, exactly as before R8 — the switch moved, the effect did
not. Tracked as R49 in `docs/plans/test-runner-improvements.md` §2a.

The report is measured against what the *test* asks for, so a test that never
wanted screenshots is not told it didn't get any.

What an MCP run also matches: the test's speed, its per-test timeout
(crawl floor included), its variables and dataset rows, and a log with terminal
escape sequences stripped.

"The test's speed" means the resolved one — the test's own pin if it has one,
otherwise the app's Run speed setting. It read the record's field directly until
2026-08-25, which stopped being the same thing when recordings stopped stamping
their speed: every test recorded after that ran at `fast` here and at the user's
default in the app, and nothing reported the difference.

## Secrets

Secret variable values live in `test-secrets.bin`, encrypted through the
operating system's secure storage. Only the app process can decrypt them — this
server has no route to that API — so:

- **`run_test` refuses** a test declaring a secret variable, and says why. It
  does not run it: the generated spec resolves an unset secret to `""`, so the
  test would type empty strings into the login form and fail several steps later
  with nothing connecting the two.
- **`run_batch` / `run_group` skip** such a test with a note and carry on.
- **`get_test`** lists secret variables by name so this is knowable up front.
- **`get_run_logs` withholds** every run's console and network whenever *any*
  test in the library declares a secret. Those files are stored raw and the app
  redacts secret values when it reads them; this server cannot, and a recorded
  request header or URL can carry one. The rule is library-wide for the same
  reason the app's redaction covers every secret it knows: any run's log can
  contain any test's secret.

Run these tests from the app. Everything else about them — steps, spec source,
past runs and their logs — stays readable from here.

## Example prompts

- "List my recorded tests."
- "Show me the steps and generated script for the checkout flow test."
- "What were the last 5 runs of the login test, and did any fail?"
- "Get the full log for that failed run and tell me what broke."
- "Run the signup test and tell me if it passes."
- "Run all my smoke tests and tell me which ones failed."
- "Sweep the checkout test over every dataset row and tell me which rows fail."
- "That run failed — check the network log and tell me whether the server errored or we looked for the wrong element."
- "Which steps changed visually in the last run of the homepage test, and by how much?"
- "Compare the last two captured runs of the checkout test and tell me what moved."
- "Which locators has Auto-Heal been changing repeatedly? Those are the ones worth rewriting."
- "Did something ship on the shop site? Show me the fixes waiting on other tests."
- "Screenshot the app and tell me if the Variables tab looks right."
- "I just pressed the capture shortcut — grab the screenshot and tell me what's wrong with this dialog."

## Notes

- Read-only tools (`list_tests`, `get_test`, `list_runs`, `get_run_log`,
  `list_routines`,
  `get_visual_report`, `get_a11y_report`, `get_run_logs`, `list_heals`,
  `list_propagations`,
  `list_batches`, `compare_runs`, `triage_run`, `get_step_health`,
  `get_suite_cost`, `get_browser_matrix`, `get_flake_report`, `get_step_matches`,
  `get_screenshot`)
  never modify app data. The metrics-backed ones open the metrics database but
  never create it — it is the app's to build.
  `run_test`, `run_batch`, `run_group` and `run_routine` execute Playwright and append run
  records; the latter two also write a batch record and persist progress after
  every test, so an interrupted batch keeps the results it already collected.
  `run_routine` does not edit the routine it runs — not even its schedule.
- There is **no mutation surface**: nothing here edits a test, accepts a
  baseline, or changes a setting. Retention and pruning stay the app's business,
  so two processes can't disagree about what they mean.
- The reports read artifacts only a **captured** run produces, and the app
  prunes older run directories per its retention setting — so "no artifacts" is
  an ordinary answer, and the tools say which of the two it is.
- Everything shared with the app (pacing, timeouts, dataset expansion, queue
  expansion, what a routine runs, ANSI stripping, the generated
  `playwright.config.ts`, run comparison) lives in `shared/*.mjs` and is
  imported by both sides rather than transcribed. `npm run check:mcp-parity`
  pins that the environment this server builds satisfies what the generated
  spec actually reads, and that `run_routine` plans, queues and records a
  routine the way the app does.
- `capture_app` and `get_screenshot` talk to the app through plain files in
  `userData/recorder/debug-shots` — a request/response pair, no socket and no
  port. Both halves of that protocol are duplicated (TypeScript in the app,
  JavaScript here), and a drift between them produces no error on either side,
  so `main/services/debug-capture.test.ts` compares the two implementations
  directly. Captures are pruned to the newest 10 and downscaled to 1400px.
- Data directory resolution (`mcp/data-dir.mjs`) reaches the same answer the
  app does, because **both processes write** — this server appends run history
  and batch history, so a disagreement means the app reads a library the server
  is not writing to. The order is: `GOOD_LOOKS_USERDATA` if set, else the
  directory Electron would use (`productName` under the platform's app-data
  root), else the newest Glaze-era store beside it, adopted in place. The rules
  live in `shared/user-data-rules.mjs` so the two cannot drift; the probing is
  each side's own, and `check:mcp-parity` drives both against one fixture tree.

  Set `GOOD_LOOKS_USERDATA` to point the server somewhere explicit — the escape
  hatch when the layout is unusual, and the way to run it off macOS.

  `node mcp/server.mjs --print-data-dir` prints where it resolved to, and on
  failure explains what it looked for rather than throwing a stack trace.
