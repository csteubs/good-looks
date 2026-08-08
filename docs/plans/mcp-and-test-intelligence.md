# MCP extension and test intelligence

Written 2026-08-07, against `main` at `46a5a63`.

> **Status, updated 2026-08-08.** **Phase 1** is implemented except **1c
> (capture parity)**, which is deferred — see §5. **Phases 2, 3 and 4 are
> implemented.** Phase 5 (emit adapters) is unstarted.
>
> Two assumptions did not survive contact and are corrected in place below:
> **secrets cannot be injected from the MCP at all** (§1.4), because
> `safeStorage` is a native app-only API; and **`step_metrics.ms` as specified
> would have measured the screenshot, not the step** (§3.2), which would have
> made §6.2 a chart of PNG write times. Five columns in §3.2 changed as a
> result; the schema in this document is annotated rather than rewritten, so the
> reasoning stays visible. All of it is recorded in `docs/DECISIONS.md` under
> 2026-08-07.
>
> The §1.3 risk is closed positively: `node:sqlite` works, and the packaged
> backend runs on the host's **pinned** runtime rather than the user's `PATH`
> node — so the NDJSON fallback is not needed.

Goal: turn the signals the app already collects and throws away into a durable,
queryable body of evidence — and make the MCP server a trustworthy way for an
agent to reach it.

Scope decisions taken with the maintainer before writing, recorded in
[§0](#0-constraints-taken-as-given) so later readers don't relitigate them.

---

## 0. Constraints taken as given

| Decision | Chosen |
|---|---|
| Audience | Paying customers, unattended agents, teammates (each with their own install), CI |
| MCP reach | Read + run + analyze. **No mutation** of tests, baselines, or settings |
| Shared logic | One pure core, consumed by both app and MCP |
| Data location | **Strictly local, per-machine** |
| Secrets in MCP runs | **Inject** — reach app parity |
| Storage | Local database, **derived shadow** of the JSON stores, rebuildable |
| Retention | **Roll up before pruning** |
| MCP query surface | **Curated tools only**, no SQL escape hatch |
| Integrations | **Emit** standard formats; something else forwards them |
| First slice | Close the MCP drift gaps |

The pains to weight for, in the maintainer's words:

1. *"Is this a real site problem or a test runner problem?"*
2. *"Is this flaky or actually broken?"*
3. *"Why is the suite slow?"*

---

## 1. What was measured, not assumed

### 1.1 The app persists twelve stores. The MCP reads three.

| Data | File | Reachable from MCP |
|---|---|---|
| Tests (steps, tags, speed, browser, variables, datasets, flows, thresholds, timeouts) | `tests.json` | partly |
| Runs (~20 fields incl. `healedSteps`, `a11yMs`, `captureOverheadMs`, `datasetId`, `replayOfRunId`) | `run-history.json` | 8 fields |
| Raw run output | `logs/*.log` | yes |
| Per-step screenshots, `manifest.json` (**`ms` per step**, action, target, element rect) | `artifacts/…` | no |
| `replay.json` (per-step status, visual diff **state + ratio**, a11y violations) | `artifacts/…` | no |
| Pinned baselines, diff PNGs | `artifacts/…` | no |
| `console.json` / `network.json` (per-step console, requests with status + **latency**) | `artifacts/…` | no |
| Heal journal (every locator Auto-Heal changed, with undo) | `heal-journal.json` | no |
| Batch history | `batch-history.json` | writes it, cannot read it |
| Step annotations | `annotations.json` | no |
| Trainer replay diagnostics | `debug-logs.json` | no |
| Encrypted secrets | `test-secrets.bin` | no |

Three analysis engines already exist, pure and tested — `flake-analysis.ts`,
`run-comparison.ts`, `capture-overhead.ts` — and none is reachable from MCP.

### 1.2 Real data volume on the development machine

```
32 tests · 336 runs · 164 artifact run dirs · 11 batches · 16 heal entries

artifacts        253 MB   (~1.5 MB per run)
browsers         971 MB   (not ours)
logs             1.4 MB
run-history.json 200 KB   (336 runs)
heal-journal     44 KB
```

A per-step metrics row costs roughly **60 bytes**. Those 336 runs at ~15 steps
each distil to **under 300 KB** — three orders of magnitude below the artifacts
they summarise. There is no storage tension in the rollup; screenshots can keep
aging out at 10 runs per test while the trend keeps every run ever executed.

### 1.3 The database needs no dependency

`package.json` already declares `engines: { "node": ">=24" }`, and **`node:sqlite`
is a Node builtin** on 24 (`DatabaseSync`, `StatementSync`, `backup`). Verified
on the development machine (v24.18.0). That gives one storage substrate usable
identically from the app's TypeScript backend and the standalone `mcp/*.mjs`,
with no native module to compile and no new package.

**Verify before committing to it:** `node:sqlite` must survive the Vite/tsc
build as an externalized builtin *in the packaged app*, not merely under `tsx`.
If it does not, the fallback is append-only NDJSON with an in-memory index —
the schema in §3 is deliberately flat enough to survive that substitution.

### 1.4 Four drift bugs in the MCP run path

`mcp/server.mjs`'s `executeTest` has diverged from `playwright-runner.ts`. All
four fail silently.

1. **Variables and secrets are never injected.** The env is only
   `PLAYWRIGHT_BROWSERS_PATH`, `NODE_PATH`, `PW_SLOWMO_MS`
   ([server.mjs:162](../../mcp/server.mjs)). The generated spec resolves secrets
   as `process.env.GLAZE_SECRET_X ?? ""`
   ([script-generator.ts:713](../../main/services/script-generator.ts)), so any
   test with a secret variable runs with **empty strings** and fails at the
   login form with nothing in the output explaining why. Dataset sweeps are
   likewise unreachable from MCP.

   > **Corrected 2026-08-07 during implementation.** Variables and datasets are
   > fixable and were fixed. **Secrets are not.** `variableEnv` reads
   > `testSecretsStore`, which decrypts `test-secrets.bin` through `safeStorage`
   > — a *native* API reached over the Glaze host bridge. A standalone
   > `node mcp/server.mjs` has no bridge, so no amount of work in this file
   > makes secret injection possible. The alternatives (broker the values from
   > the running app over a file protocol; delegate the whole run to the app's
   > runner) were weighed and rejected — see `docs/DECISIONS.md`. What shipped:
   > `run_test` refuses a secret-declaring test with an explanation, `run_batch`
   > skips it with a note, and `get_test` reports which variables are secret so
   > it is knowable before the call. That is a strict improvement on failing at
   > the login form, but it is not parity, and §0's "Secrets in MCP runs:
   > **Inject** — reach app parity" is not achievable as written.
2. **`testTimeoutMs` is ignored.** The per-test timeout added 2026-08-06 is not
   passed, so MCP runs silently use Playwright's default.
3. **No capture fixture.** No screenshots, no a11y, no console/network, no
   `replay.json` — so an MCP run never appears in the Visual tab, never seeds or
   diffs a baseline, and never engages run-time Auto-Heal. `run_test`'s response
   note documents the crawl-settle gap but not these.
4. **No redaction and no ANSI stripping.** The app redacts at one choke point
   (`emitOutput`, [playwright-runner.ts:507](../../main/services/playwright-runner.ts))
   and again on read for console/network
   ([artifact-store.ts:432](../../main/services/artifact-store.ts)). MCP writes
   raw child stdout/stderr straight to the `.log` file.

**These are ordered, not independent.** Bug 4 is harmless today *only because*
bug 1 exists — no secrets are injected, so none can leak. Fixing 1 without 4
creates a plaintext-credentials-on-disk path in a file the MCP will happily
serve back through `get_run_log`. They ship together or not at all.

---

## 2. Positioning: which of the three to lead with

The maintainer asked which framing to lead with, given all three are true.

**Lead with test health. Sell agent-native as how you use it. Keep the recorder
as the on-ramp.**

- **The recorder is table stakes.** Playwright ships `codegen` free; mabl,
  Testim and Reflect all record. The trainer here is genuinely better — auto-heal,
  refine selector, conditional logic, cookie steps — but it is the price of
  entry, not the moat. Worse, a recorder's value *ends* the moment the spec is
  generated, which writes off the 253 MB of post-generation evidence the app
  already collects.
- **Test health is where the accumulated assets actually are.** Per-step timing,
  network, console, visual ratios, a11y violations, heal events, dataset
  outcomes, cross-browser results. Nothing else in the category joins all of
  those, and the headline question — *is this the site's fault or the test's?* —
  is only answerable from that join. That is a test-health question, not a
  recorder question.
- **Agent-native is a distribution channel for test health, not an independent
  proposition.** An MCP over a thin recorder gives an agent nothing interesting
  to say. An MCP over the join lets an agent do in one call the triage a person
  does in twenty minutes.

One-liner: *records your tests, then tells you which failures are your site's
fault — and hands that answer to your agent.*

This also explains why "close the MCP drift gaps first" is the right first
slice: the channel is currently broken in ways that make the product
unsellable through it.

**The strategic risk to name honestly:** *strictly local, per-machine* is in
tension with both of the leading framings. Test-health value compounds with
history and with a team looking at the same history, and CI cannot reach a
per-machine data dir at all. That decision stands for this plan — but every
read path below goes through one small interface (§3.4) so a different backing
store can be substituted later without touching the analysis or the tools.

---

## 3. Architecture

### 3.1 The shared core, and where it lives

The app is TypeScript compiled by Vite/tsc against `@glaze/core`. The MCP is
standalone `.mjs` with no build step and no SDK. They cannot share a `.ts`
module directly.

The repo has already solved this twice: `mcp/select-tests.mjs` +
`select-tests.d.mts`, and `mcp/debug-shots.mjs` + `debug-shots.d.mts` — plain
`.mjs` with a hand-written declaration file beside it, imported by both sides
and type-checked by `npm run type-check`.

**Adopt that as the rule.** New directory `shared/`, at the repo root:

```
shared/
  metrics-schema.mjs   + .d.mts   table DDL, migrations, row shapes
  metrics-query.mjs    + .d.mts   the curated queries behind every tool and view
  triage.mjs           + .d.mts   the site-vs-runner classifier (§4)
  rollup.mjs           + .d.mts   run + artifacts → step-metric rows
```

Admission rule: **pure only** — no `fs`, no `@glaze/core`, no IPC. Anything
needing the filesystem stays on its own side of the boundary and hands data in.

Existing pure engines move opportunistically, not up front:
`flake-analysis.ts` moves when Phase 4 needs it from MCP; `run-comparison.ts`
and `capture-overhead.ts` when a tool or emitter calls for them. Moving all
three in Phase 1 is test churn bought for nothing.

The alternative — duplicate and pin with a comparison test, the `debug-shots`
precedent — is explicitly *not* chosen. That precedent exists because a socket
was impossible, and `main/services/debug-capture.test.ts` exists solely to
diff two hand-maintained copies. One instance of that is a workaround; five
is an architecture.

### 3.2 Schema

> **Amended during implementation, 2026-08-07.** The schema below is the
> ORIGINAL. Five things changed, and the reasoning is worth keeping visible:
>
> 1. **`ms` is not `ArtifactStepEntry.ms`.** That field times the *screenshot*
>    (`Date.now() - tShot` around `page.screenshot()`, summed into `captureMs`).
>    Reading it as step duration would make §6.2 a chart of how long PNGs take to
>    write. The capture fixture now records `stepMs` separately, around the
>    action itself, and the column reads that.
> 2. **`triage` / `triage_confidence` are gone.** A stored verdict is frozen at
>    the classifier version that wrote it, so improving the classifier leaves old
>    rows stale and a trend silently mixes generations. Triage is computed on
>    read.
> 3. **Three columns split**, because the halves carry opposite evidence:
>    `console_page_errors` from `console_errors`, `net_worst_api_status` from
>    `net_worst_status`, and `heal_failed` alongside `healed`. §4.1 asks for the
>    strong half of each; merged, each pair destroys its own signal.
> 4. **Added `test_timeout_ms` and `heal_failed_steps`** to `runs`, and
>    `action_index` to `step_metrics`. The first two are the only unrecoverable
>    fields in the whole design and shipped ahead of the DB; the third is the
>    join between the app's two step-index spaces, which was previously hiding in
>    a screenshot filename that is null on every a11y-only run.
> 5. **Added `has_artifacts`, `console_dropped`, `network_dropped`.** All three
>    exist so silence can be read correctly. The capture fixture caps logs
>    head/tail OVERALL rather than per step — one real run dropped 1861 of 2361
>    network entries — so "no failing request on that step" and "that step's
>    requests were discarded" would otherwise be the same answer.

```sql
CREATE TABLE runs (
  id                TEXT PRIMARY KEY,
  test_id           TEXT NOT NULL,
  test_name         TEXT NOT NULL,
  url               TEXT,
  status            TEXT NOT NULL,          -- passed | failed
  kind              TEXT NOT NULL DEFAULT 'run',
  started_at        INTEGER NOT NULL,
  duration_ms       INTEGER NOT NULL,
  browser           TEXT,
  speed             TEXT,
  headless          INTEGER,
  batch_id          TEXT,
  dataset_id        TEXT,
  dataset_name      TEXT,
  healed_steps      INTEGER,
  a11y_ms           INTEGER,
  a11y_checks       INTEGER,
  a11y_new_steps    INTEGER,
  capture_ms        INTEGER,
  shot_count        INTEGER,
  failed_step_id    TEXT,
  error_signature   TEXT,                   -- flake-analysis errorSignature()
  triage            TEXT,                   -- site | runner | mixed | unknown
  triage_confidence REAL,
  source            TEXT                    -- app | mcp | batch
);

CREATE TABLE step_metrics (
  run_id           TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_index       INTEGER NOT NULL,
  step_id          TEXT NOT NULL,
  label            TEXT,
  type             TEXT,
  status           TEXT,                    -- passed|failed|skipped|unknown
  ms               INTEGER,                 -- ArtifactStepEntry.ms
  diff_state       TEXT,
  diff_ratio       REAL,
  a11y_violations  INTEGER,
  a11y_new         INTEGER,
  healed           INTEGER,
  net_requests     INTEGER,
  net_failures     INTEGER,
  net_worst_status INTEGER,
  net_total_ms     INTEGER,
  console_errors   INTEGER,
  PRIMARY KEY (run_id, step_index)
);

CREATE INDEX idx_step_by_step  ON step_metrics(step_id, run_id);
CREATE INDEX idx_runs_by_test  ON runs(test_id, started_at);
```

Keyed on `(run_id, step_index)` with a secondary index on `step_id`, because
step ids are stable across runs while indices shift when a test is edited —
the same reasoning `run-comparison.ts` already applies when matching steps.

### 3.3 Ingest, rollup, and rebuild

Three write points, one function (`rollup.mjs`) so they cannot drift:

1. **On run completion** — `playwright-runner.ts`, `batch-runner.ts`, and the
   MCP's `executeTest`. Write-through, best-effort, never throwing into run
   teardown (the rule `retention.ts` already follows).
2. **Before pruning** — `artifactStore.pruneRuns` is where per-step evidence
   dies. The rollup hooks in *before* the delete. This is the whole point of
   the phase: after it lands, retention costs you pictures, not history.
3. **Backfill** — a one-time sweep over `run-history.json` plus whatever
   artifacts survive, so existing history joins the DB rather than starting
   from zero.

The DB is **derived and rebuildable**: `metrics:rebuild` drops and replays from
the JSON stores and surviving artifacts. Corruption is therefore never fatal
and never blocks a run, which is what makes it safe to treat as a cache rather
than a store of record.

*Timing note:* the 164 artifact dirs currently on disk across 32 tests average
~5 per test, below the default cap of 10 — so nothing is actively being lost
today. The backfill is not an emergency, but it is a one-time opportunity that
shrinks every time retention sweeps.

### 3.4 The read interface

Every tool and every view reads through one small module
(`metrics-query.mjs`) whose functions take a connection handle and return plain
objects. No SQL escapes into a tool body, a React component, or an emitter.

That is what makes the local-only decision reversible: swapping the backing
store later means reimplementing one file, not auditing every call site.

---

## 4. The centrepiece: site problem or runner problem

The maintainer's top pain, and it is fully answerable from data already on
disk. It has never been answered because nothing joins the five files involved.

### 4.1 The signal table

Evidence that the **site** is at fault:

| Signal | Source | Why |
|---|---|---|
| 5xx on the failing step | `network.json` | the server errored |
| 4xx on a non-navigational request | `network.json` | an API contract broke |
| `pageerror` on the failing step | `console.json` | the page's own JS threw |
| Fails on all three engines | `runs.browser` | not an engine quirk |
| Fails on every dataset row | `runs.dataset_id` | not the data |
| Auto-Heal tried candidates and all failed | heal journal | the element is gone under every locator |
| Visual `changed` on the same step that failed | `replay.json` | the page rendered differently too |

Evidence that the **test or runner** is at fault:

| Signal | Source | Why |
|---|---|---|
| Auto-Heal succeeded | heal journal | the element existed; the locator was stale |
| Fails on one engine only | `runs.browser` | engine-specific selector or timing |
| Failing step `ms` within ~10% of `testTimeoutMs` | `step_metrics.ms` + `TestRecord` | the budget, not the page |
| Fails only when capture is on | `runs.capture_ms` | instrumentation overhead crossed the ceiling |
| Fails on one dataset row only | `runs.dataset_id` | the data, not the site |
| Locator timeout with network all-2xx and console clean | joined | the page was healthy while we looked for the wrong thing |
| This step has healed ≥3 times before | heal journal | chronic locator decay |

### 4.2 Shape and rules

```
{ verdict: "site" | "runner" | "mixed" | "unknown",
  confidence: 0–1,
  evidence: [{ signal, direction, detail }],
  suggestedNext: string }
```

Four rules, each with a failure it is written against:

- **Evidence first, verdict second.** The evidence list is the product; the
  verdict is a summary of it. A confident wrong verdict during a real outage is
  far more expensive than an honest "unknown".
- **`unknown` is first-class.** A run with no capture artifacts has almost no
  signal, and must say so rather than guessing from status alone.
- **Never fatal.** The classifier never changes `runStatus` and never suppresses
  a failure — the same rule a11y follows, pinned there by a source-level
  assertion in `a11y-diff.test.ts`. Pin this one the same way.
- **Pure.** Takes a bundle of already-read records, returns a verdict. Every row
  in §4.1 becomes a test case, in both directions, and per CLAUDE.md each gets
  the revert check that proves it can fail.

### 4.3 Where it surfaces

MCP `triage_run` · a line in the run Output panel · a column in Step Health
(§6.1) · the body of an emitted ticket payload (§7).

---

## 5. Phases

### Phase 1 — Make the MCP trustworthy *(first, per the maintainer)*

Nothing else is worth building on a channel that lies.

- **1a. Secrets + variables + datasets, with redaction, as one change.** ✅ *(as
  amended)* Injects `GLAZE_VARS` exactly as `variableEnv` does; `datasetId` on
  `run_test` and dataset expansion on `run_batch` through the shared
  `buildQueue`; `stripAnsi` at the MCP's own single write point, and on read.
  **Secrets are refused, not injected** — see the correction in §1.4. That also
  settles the redaction pairing from the other side: nothing is injected, so
  there is nothing to redact.
- **1b. Honour `testTimeoutMs`.** ✅ Through the shared `resolveTestTimeoutMs`,
  crawl floor included, passed as an authoritative `--timeout`.
- **1c. Capture parity**, opt-in per call (`capture: true`) and defaulting to
  the test's own `captureArtifacts` — so an MCP run lands in the Visual tab and
  produces the artifacts everything downstream reads.
  **⏸ Deferred.** Landing in the Visual tab means producing `replay.json`, which
  is built by `replay-builder.ts` → `visual-diff.ts` (pixelmatch + pngjs) →
  `a11y-diff.ts` → `script-generator.ts`. Moving that chain into `shared/*.mjs`
  is a large refactor that would strip the types off the spec generator — the
  module CLAUDE.md names as a security boundary. Half-doing it is worse than
  not: a run that writes screenshots but no replay model still doesn't appear in
  the Visual tab, so it would look finished and not be. **The likely right shape
  when it is picked up:** have the MCP produce the raw artifacts (the fixtures
  write manifest/console/network/screenshots themselves) and have the APP build
  `replay.json` lazily when a run with artifacts and no replay is opened — a
  small app-side change instead of a large port. 1d is the honest stand-in
  meanwhile.
- **1d. Say what a run did *not* do.** ✅ Every `run_test` response carries a
  `fixtures` field, measured against what the test itself asks for rather than
  as a flat feature list. `run_batch` reports it once for the suite. Pinned by
  `check:mcp-parity`, so closing 1c has to change those messages rather than
  leave them lying.
- **1e. Read tools for data already on disk:** ✅ `get_visual_report`,
  `get_a11y_report`, `get_run_logs`, `list_heals`, `list_batches`,
  `compare_runs`. **`get_run_logs` withholds rather than redacts** — redaction
  needs the secret values, which this process cannot read, so console/network
  are served only when no test in the library declares a secret at all.

Ends with: an MCP run matches an app run in pacing, timeout, variables and log
hygiene; an agent can see the visual, a11y, console/network, heal and batch
evidence a person can; and where a run still differs, it says so.

### Phase 2 — The metrics DB ✅

Schema, `rollup.mjs`, the three ingest points, the prune hook, backfill,
`metrics:rebuild`. Verify `node:sqlite` in the packaged app first (§1.3).

Nothing user-visible ships here. Everything after it becomes cheap.

**Done 2026-08-07.** `shared/metrics-schema.mjs` + `rollup.mjs` +
`metrics-query.mjs` (pure), `main/services/metrics-store.ts` and
`mcp/metrics.mjs` (the two writers), the prune preflight, backfill on first
open, and `rebuild()`. `errorSignature` moved to `shared/` here rather than in
Phase 4, since `runs.error_signature` has to be computed at ingest — the log it
comes from is capped and pruned. Guarded by `check:metrics-db` (55 assertions
against a real database).

Measured on the development machine: 425 runs and 1024 steps in ~600ms,
byte-identical on a second pass, **540 KB on disk against 253 MB of artifacts**
— about half the plan's ~60 bytes/row estimate in row count but the same
conclusion by three orders of magnitude, so the rollup has no storage tension to
negotiate.

Two things about the DATA that only running it could show, both of which limit
what triage can conclude and are now recorded per run rather than left implicit:
logs are capped head/tail overall rather than per step (so a busy site loses
whole steps' worth of network), and only 98 of 207 failing runs yield a usable
error signature at all.

### Phase 3 — Triage ✅

`shared/triage.mjs`, the MCP `triage_run` tool, the run Output panel line, and
`check:triage`.

**Done 2026-08-08.** All four, plus `readHandle()` in `mcp/metrics.mjs` — the
MCP had no way to READ the database it writes, only a handle left over from its
own runs (see DECISIONS). `TRIAGE_COHORT` is exported from `shared/triage.mjs`
so the app and the MCP cannot drift on the sibling window.

The signal table in §4.1 landed as written, with one addition the design did not
have: **`limits`**, a list of what the capture did not record, costed against
confidence per entry. §4.2's four rules all survived contact; the shape gained
`limits` and `failingStepId` alongside them.

Measured across the 269 failed runs on the development machine: **53 site, 55
runner, 2 mixed, 159 unknown**. The unknowns are not a classifier gap — 114 of
them captured no artifacts at all, 124 have no identifiable failing step, and
141 were only ever run on one engine — but they do say plainly that this feature
is worth what capture is worth, and on this history capture is off more often
than on.

Two things only running it could show. The **clean-wait** signal (a timeout with
clean network and console) is the most frequently useful runner-ward signal and
also the only one argued from an absence, so it is gated on the dropped counters
— the first real run it was tried against had discarded 1,861 network entries.
And **"fails on every engine" fires far more often than expected**, because most
tests here have only ever run on chromium and firefox: two engines with no
passing engine between them satisfies "all", so the signal is reported at
MODERATE rather than STRONG below three.

### Phase 4 — The views the join makes possible ✅

Detailed in §6. Move `flake-analysis.ts` into `shared/` here so
`get_flake_report` can serve the same verdicts the app shows.

**Done 2026-08-08.** All three views (§6.1–6.3) as panels in Stats, the flake
move, and four MCP tools: `get_step_health`, `get_suite_cost`,
`get_browser_matrix`, `get_flake_report`. Two new queries
(`stepDurations`, `stepBrowserMatrix`) and a new pure module,
`shared/step-insights.mjs`, holding what the rows MEAN — divergence verdicts,
the slowdown threshold, the cost split — so the panel and the tool cannot
disagree.

The flake move retired a real copy: the renderer's hand-written mirror of the
verdict union and `MIN_RUNS_FOR_VERDICT`, which existed only because a renderer
cannot import from `main/`.

**What the real history says, and it changes how these read.** 305 steps, 534
runs on the development machine:

- **255 of 305 steps have only ever run on one engine.** So `insufficient` is
  the majority verdict, not an edge case, and the plan's implicit assumption
  that a step × engine matrix is mostly populated is wrong here. It is
  summarised as a count rather than listed, and it is kept strictly distinct
  from `clean` — the alternative gives a single-engine suite a clean bill of
  cross-browser health. 13 steps do diverge on one engine and 4 fail on all,
  which is the finding the view exists for.
- **No step has two full timing windows yet**, so the §6.2 trend has nothing to
  compare and reports *why* rather than "no slowdowns" — which on this history
  would read as reassurance. The attribution half works today and says
  instrumentation is **4% of 9,814s**: the honest answer is that capture is not
  what makes this suite slow.

Two implementation notes worth keeping. Percentiles are computed in JS, not SQL,
after SQLite accepted the `LIMIT 1 OFFSET <aggregate expression>` form for p95
and rejected it for p50 — which `metrics-query`'s never-throw `all()` turned
into a silent null. And the instrumentation figure excludes the speed setting:
derivable, but not recorded as a total, and an estimate beside two measurements
reads as a third measurement.

### Phase 5 — Emit adapters

Detailed in §7.

---

## 6. New stats views

### 6.1 Step Health — the biggest single synergy

One row per step, across all retained history, joining five signals that today
live in five panels keyed off five files:

| Step | Runs | Fail % | Heals | p50 ms | Trend | Visual drift | a11y |
|---|---|---|---|---|---|---|---|

Sortable by any column. The rows that matter — a step that never fails but has
healed four times, or one whose p50 doubled while still passing — are invisible
in every existing view, because each holds only one of the five columns.

This is also the most demoable screen in the plan, which is why it is worth
building *after* Phase 2 rather than before: without retained history it shows
ten runs and reads as a toy.

### 6.2 Suite slowness

Answers pain 3 directly, from `step_metrics.ms`:

- Per-step p50/p95 over the last N runs against the previous N — *"checkout
  submit went 1.2s → 4.8s over six runs."*
- Attribution: `net_total_ms` versus wait steps versus everything else.
- **Instrumentation cost, separated from the site.** `capture_ms`, `a11y_ms`,
  and `slowMo` are all either measured or exactly derivable (`SLOW_MO_MS` is a
  fixed table per speed). So the suite can report *"3m20s of your 5m suite is
  capture, a11y, and the Slow speed you chose"* — and give the exact number for
  what Fast with capture off would cost. `capture-overhead.ts` already does the
  screenshot third of this.

### 6.3 Cross-browser divergence

A test × engine matrix of per-step outcomes. Feeds triage §4.1 directly — "all
three engines" versus "only WebKit" is one of the strongest discriminators
available — and is worth surfacing on its own, since a step that fails only on
one engine is a different bug report from one that fails everywhere.

---

## 7. Emit adapters

All five are **emit, not send**: a file or a payload, no stored credentials, no
new outbound path, no auth to maintain. This keeps the app's current egress
posture intact — one opt-in summary-only webhook — and it is a better fit for
an agent-native product anyway: rather than building a Jira integration, emit a
ticket-shaped payload and let the customer's *existing* Jira MCP file it.

| Format | Consumer | Notes |
|---|---|---|
| JUnit XML | any CI | testsuite = batch, testcase = run, failure message = triage verdict + evidence |
| GitHub Actions annotations | PR review | `::error file=…,line=…::` — the step→spec-line map already exists in `playwright-runner.ts` |
| OTLP JSON trace | Datadog / Grafana / any OTel backend | run = trace, step = span (real `ms`, not synthetic), network request = child span |
| Ticket payload (markdown) | Jira / Linear / GitHub, via the customer's own MCP | triage verdict, failing step, error, artifact paths, network evidence |
| NDJSON / CSV of `step_metrics` | whatever BI they have | the rollup, unaggregated |

**Every emitter runs through `redactWithSnapshot`.** Emitted files leave the
machine by definition — that is what they are for — so this is the same
boundary `artifact-store.readLogs` guards, and it needs the same treatment at
every one of the five exits.

---

## 8. Testing

Per CLAUDE.md — new behaviour ships with tests, and each one is verified to
fail when the fix is reverted.

New `check:*` scripts:

- `check:metrics-db` — ✅ DDL applies, rollup is idempotent (the same run
  ingested twice yields one row set), rebuild reproduces a byte-equal result.
  Also pins the step-index translation (a step that captured nothing must be
  attributed nothing), the three column splits, the `stepMs`-not-`ms` duration,
  the `Error Context:` exclusion, and that every read tolerates an absent
  database — metrics are unavailable on a runtime without `node:sqlite`, and a
  view that crashes when the cache is missing is worse than one showing no data.
- `check:triage` — every row of §4.1, in both directions, plus the "no
  artifacts → unknown" case and a source-level assertion that the classifier
  cannot reach `runStatus`.
- `check:emit-formats` — emitted JUnit and OTLP parse as valid; every emitter
  redacts.
- `check:mcp-parity` — ✅ *written first, as planned.* Landed in a stronger form
  than described: rather than comparing the MCP's env against `variableEnv`'s
  keys, it RUNS the generator, pulls every `process.env.X` out of the spec that
  comes back, and checks the env against that set. A key-list comparison is
  still a comparison of two hand-maintained lists; the generator is the actual
  demand side. It also pins the §1d messages, the `get_run_logs` withholding
  rule, and the comparison verdicts. Each of the four §1.4 bugs was reverted in
  turn and confirmed to fail it.

Vitest covers the pure cores. `.d.mts` files beside every `shared/*.mjs` keep
`npm run type-check` as the real gate, since bundled checks do not type-check.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| **Local-only cannot serve CI or teammates** — the largest strategic risk, in direct tension with the two leading framings (§2) | Every read goes through `metrics-query.mjs`; swapping the store means one file |
| `node:sqlite` may not survive packaging | Verify in the packaged app before Phase 2 commits; NDJSON + in-memory index as fallback — the flat schema survives either |
| Triage stated too confidently | Evidence-first output, `unknown` first-class, never fatal, pinned by check |
| Injecting secrets into an agent-launched process | Ships only with redaction (§1.4); secrets never enter an emitted artifact; runs that used secrets are logged as having done so |
| Schema becomes a public contract | Curated tools only — the reason that answer was the right one |
| Five more surfaces to keep in sync between app and MCP | `shared/` from the start, rather than five more `debug-shots`-shaped comparison tests |

---

## 10. What this plan deliberately leaves out

- **Mutation from MCP.** No test authoring, no baseline acceptance, no settings
  changes. Test authoring in particular would put agent-produced JSON on the
  page-JSON → generated code → executed-in-Node path that CLAUDE.md identifies
  as a security boundary, and would need `normalizeRawStep` plus its own check
  before it could be considered.
- **A sync or server tier.** Named as the tension in §2, not designed here.
- **Native integrations that store credentials.** Emit only.
- **MCP Prompts and Resources.** Plausible later under the agent-native framing
  (`resource://test/<id>` for @-mentioning a test), but tools come first.
