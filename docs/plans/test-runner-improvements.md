# Test runner: mabl parity and improvement plan

Written 2026-08-21, against `main` at `5b92201`. Research only — no code changed.

This document compares Good Looks' test runner against mabl's, and proposes a
phased improvement plan. It is a plan, not a record of what shipped; read
[../ARCHITECTURE.md](../ARCHITECTURE.md) for what the code does now and
[../DECISIONS.md](../DECISIONS.md) for what actually landed.

## Method

The mabl side is the whole **Run tests** category (44 articles), plus the
**Integrate** category (65 articles: the CLI, the API, nine CI/CD integrations,
webhooks, the mabl MCP) and the **Get results** category (32 articles: test
output, statuses, failure reasons, trends). 141 articles in total, read in full
rather than skimmed, because the CI/CD story is distributed across all three —
the Continuous testing section describes the *shape*, and the Integrate section
holds the flags and payloads.

The Good Looks side is this repo, read directly. Every claim below was produced
by one pass and then **checked by a second pass whose instructions were to
refute it**. 102 findings went in; 96 survived unchanged, 6 had their verdict
corrected, and none were dropped as fabricated. Where the refuter corrected a
claim, the corrected version is what appears here.

### One correction to the existing docs — now applied

Two pages claimed the five emit adapters (JUnit XML, GitHub Actions
annotations, OTLP JSON, ticket markdown, NDJSON/CSV) were **not built**. They
exist: five formats over six `EMITTERS` rows in
[shared/emitters.mjs:91-273](../../shared/emitters.mjs:91), pure, redacted,
wired to `report:emit`, rendered by the Export panel under Cost in Stats.

The gap is not the formats. It is that `emitReport` cannot produce a file
without a person clicking a native save dialog
([report-emitter.ts:66](../../main/services/report-emitter.ts:66)) — which is
R1, the first item of Phase C0.

**Both pages were corrected on 2026-08-21, in the same commit as this
sentence.** `QA-KNOWN-GAPS.md`'s "Emit adapters" row is struck through and
dated, its "Stats → Report mode" row narrowed to what is still genuinely
absent, and `ARCHITECTURE.md`'s "Not yet wired to any surface" line replaced.

Worth noting how the drift happened, because the shape recurs: that
`ARCHITECTURE.md` line was written on **2026-08-12, the same day the Export
panel shipped**, and sat directly below the entry describing that panel. The
document contradicted itself on adjacent lines for nine days. Nothing in the
gate reads prose, so only a person comparing two paragraphs would ever have
caught it.

---

## 1. What the comparison actually shows

Three things, and only the third is the one people expect.

**Good Looks is ahead on diagnosis and behind on absorption.** The evidence a
run collects here — the heal journal with undo, uniqueness-rejecting candidate
ranking, what-the-locator-actually-matched evidence, transition-based flake
verdicts, deterministic triage with published confidence limits, measured
capture overhead — is at or beyond what mabl offers, and some of it has no mabl
equivalent at all. What mabl does better is *absorb* instability before it
becomes a failure: learned per-step wait budgets, retries, a confidence floor
under a heal, per-step heal opt-out. Good Looks tells you precisely why the run
went red; mabl more often stops it going red.

**The scale ceiling is structural and not worth chasing.** mabl runs a plan
stage 50-wide by default against an account ceiling of 1000 concurrent browsers.
Good Looks runs on one laptop, capped at
`MAX_BATCH_CONCURRENCY = 16` ([types.ts:2809](../../main/recorder/types.ts:2809)).
That difference is elastic infrastructure versus one machine and no plan closes
it. What *is* closable is that the shipped defaults give away roughly an order
of magnitude before the hardware limit is even approached:
`defaultBatchConcurrency: 1`, `defaultRunHeadless: false`, and every newly
recorded test stamped `speed: "slow"` — a 1200 ms delay before every action
([recorder-settings-store.ts:152,170,187](../../main/services/recorder-settings-store.ts:152)).
A 100-test suite of 20-action tests runs about 70 minutes on those defaults and
single-digit minutes with three switches flipped, and nothing in the product
tells the user those switches exist.

**Nothing outside this machine can start a run, and nothing it can run reports
failure as a process exit status.** `package.json` has no `bin`. The only
externally startable process is `node mcp/server.mjs`, an MCP stdio server whose
only two `process.exit` calls are at startup. A failing suite there is
`isError: true` inside a tool result — a protocol flag an agent reads, not
something `set -e` can test. This is the whole CI/CD gap, and section 3 is about
closing it.

### The scoping decisions taken

Confirmed with the maintainer before this plan was written, recorded here so
they are not relitigated:

| Question | Decision |
|---|---|
| CI execution model | **Headless CLI shipped from this repo.** Not eject-to-Playwright (kept as a companion), not a remote-trigger daemon (deferred) |
| Test storage | **Optional export/sync to a repo.** The local store stays the source of truth; an explicit action writes a portable bundle CI can consume |
| Scope of "test runner" | **Execution plus results.** The engine, orchestration, run configuration and environments, and what the user sees after a run |
| Deliverable | This document, plus a published memo |

---

## 2. Ranked backlog

Merged from 102 findings (the same change often appeared under three themes).
Ranked by user value × confidence ÷ effort, with a deliberate thumb on the scale
for CI/CD.

**Verdicts marked done were each confirmed against the code, not against
memory.** That distinction is the whole point of #254: this table said `missing`
for R4 while most of it shipped, and DECISIONS records the nine days the
emit-adapter rows spent claiming five things did not exist after they landed. A
row is only moved here with a file and a symbol behind it.

| # | Item | Area | Verdict | Effort |
|---|---|---|---|---|
| R1 | Give `report:emit` a non-interactive destination, scoped to a run or batch | CI | **built — no caller yet, see §2a** | S |
| R2 | Exit non-zero when a run fails, on a documented contract | CI | **done 2026-08-25** | S |
| R3 | Add a `bin` and a headless `run` command | CI | **done 2026-08-25** | L |
| R4 | Make the runner reachable without Electron and without `safeStorage` | CI | **mostly built — see §3.3a** | S |
| R5 | Add a per-run base-URL override | CI / Env | missing | M |
| R6 | Record commit, branch and job provenance on each run | CI | missing | M |
| R7 | Provision secrets from the environment for CI runs | CI | **done 2026-08-25** | M |
| R8 | Ship the run fixtures with the CI runner | CI | **done 2026-08-25** | M |
| R9 | Selector-based selection with a dry run, and a distinct empty-match outcome | CI | **done 2026-08-25** | M |
| R10 | Export the library as a portable bundle; stop storing absolute script paths | CI | **resolution done 2026-08-25**; the export command remains | L |
| R11 | Install browsers from the CI entry point | CI | **done 2026-08-25** | S |
| R12 | Ingest CI run results back into the local library | CI | missing | L |
| R13 | Put the failing step in the JUnit message and make annotations point somewhere | CI | **done 2026-08-26** — app runs by label, CI runs by index | S |
| R14 | Ship a GitHub Action and workflow templates | CI | missing | S |
| R15 | Ship the MCP server inside the packaged app | CI | **done 2026-08-22** | S |
| R16 | Add an Environment record and store | Env | missing | L |
| R17 | Stop sweeping every test's artifacts after every run | Perf | **done 2026-08-25** | S |
| R18 | Change the shipped batch defaults; add a run-level speed override | Perf | **done 2026-08-25** | M |
| R19 | Record why a run ended, not just whether it passed | Stab | **done 2026-08-21** | M |
| R20 | Segment stability analysis by browser | Stab | **done 2026-08-25** | M |
| R21 | Decouple page-settling from the Crawl speed | Stab | partial | M |
| R22 | Put a score floor under an applied heal | Stab | missing | M |
| R23 | Add a per-step Auto-Heal opt-out | Stab | missing | M |
| R24a | Attempt-key the run evidence (prerequisite for R24; unblocks R27/R29) | Stab | missing | M |
| R24 | Add opt-in retries, marked on the RunRecord | Stab | missing | L |
| R25 | Emit per-step timeouts for action and assertion steps | Stab | **done 2026-08-21** | S |
| R26 | Learn per-step wait budgets from run history | Stab | missing | L |
| R27 | Rerun failed tests from a finished batch or routine | UX | missing | M |
| R28 | Persist the failing step for every run, not only capture runs | UX | partial | M |
| R29 | Compare a failed run against the last run that passed, in the app | UX | partial | M |
| R30 | Put a deep link in the alert webhook payload | CI | **done 2026-08-21** | S |
| R31 | Add a Runs tab to the test detail view | UX | missing | S |
| R32 | Add Run to library row and folder context menus | UX | missing | S |
| R33 | Record how a run was triggered | UX | **done 2026-08-22** | S |
| R34 | Environment variables, credentials, and per-environment state keying | Env | missing | L |
| R35 | Add HTTP basic auth | Env | **done 2026-08-23** | S |
| R36 | Add locale, timezone and custom headers | Env | missing | M |
| R37 | Parallelise the fan-out inside one test | Perf | missing | L |
| R38 | Per-group concurrency in Routines | Perf | missing (blocker cleared — §2a) | M |
| R39 | One concurrency budget across the app and the MCP | Stab | missing | M |
| R40 | Run a test N times in one action | Stab | missing | S |
| R41 | Live output and per-test stop during a routine run | UX | missing | M |
| R42 | A routine-run result page, with one diagnosis per run | UX | partial | M |
| R43 | Render a run's captured console and network output | UX | missing | L |
| R44 | Per-step run findings and a step filter on the Steps tab | UX | missing | L |
| R45 | Show a suite's expected duration before it runs | Perf | missing | M |
| R46 | Lean diagnostics mode for the app | Perf | partial | M |
| R47 | Fix heal candidate scores above 1 being reported as 0 | Stab | **done 2026-08-25** | S |
| R48 | Finish the Batch-to-Routine rename in UI copy | UX | partial | S |
| R49 | Run the heal fixture for MCP-driven runs | Stab | **done 2026-08-25** — guard, then feature | M |
| R50 | Export a run as a shareable PDF | UX | missing | M |
| R51 | Move the recorder's locator engine into `shared/` | Stab | **done 2026-08-25** — R49 and CI overlay rules unblocked | L |
| R52 | Write `glaze-dismiss.mjs` on an unattended run, and arm the rules | Stab | **done 2026-08-25** — was also a load failure, see DECISIONS | M |
| N1 | A bounded site sweep (link crawler) | New | missing | L |
| N2 | Report which pages the suite never touches | New | missing | M |
| N3 | Mobile-web device emulation | New | missing | M |
| N4 | One write on the MCP: `create_test` | New | missing | M |

### 2a. Correction, 2026-08-25 — eight rows re-verified against the code

**Every open row in the table above was re-checked against `main` after #263.**
Six claimed work that had already shipped, one was a defect rather than a
missing feature, and one had a blocker that no longer exists. This is the same
drift #254 was written about, and in three cases the shipping commit *predates
this table's own verdict pass* — R25 landed roughly four hours before this file
was first committed.

| Row | Said | Is | Evidence |
| --- | --- | --- | --- |
| R25 | missing | **done** | Per-step timeouts: `timeoutParts` at [script-generator.ts:110](../../main/services/script-generator.ts:110), threaded into every emission site, normalized at [types.ts:1722](../../main/recorder/types.ts:1722), round-trips through the parser. `077af4d` (#214), 2026-08-21 |
| R30 | missing | **done** | The run alert carries the deep link, built by the same `n` the issue-tracker path uses ([alert-service.ts](../../main/services/alert-service.ts)); pinned by `check:alerts`. `fa497be` (#221), 2026-08-21 |
| R33 | missing | **done** | `trigger?: RunTrigger` at [types.ts:2585](../../main/recorder/types.ts:2585), one spelling in `shared/run-trigger.mjs`, all four writers wired, pinned by `check:mcp-parity`. `0801e3f` (#224), 2026-08-22 |
| R35 | missing | **done** | `shared/basic-auth.mjs` scopes the credential by origin; emitted as `test.use({ httpCredentials, origin })` at [script-generator.ts:2189](../../main/services/script-generator.ts:2189); trainer and live-page handled too; `check:basic-auth` + `e2e/basic-auth.spec.ts`. `f1eb226` (#244), 2026-08-23 |
| R1 | partial | **built, uncalled** | `emitReportTo` and the full `EmitScope` — `{testId?, batchId?, since?, until?, runIds?}` — exist at [report-emitter.ts:146](../../main/services/report-emitter.ts:146) and `:63`. What is missing is a CALLER: `report:emit` still narrows to `{testId}`, and the CLI has no `--junit` |
| R13 | partial | **done 2026-08-26** | `failedStepLabel` was persisted for app runs only. The CI residue turned out to have a cause: the step reporter was WRITTEN on every unattended run and never LOADED, so no marker was emitted and no run could say which step failed. Loading it, stripping its markers and mapping the reported line to a step index closes it — by index, because `describeStep` is app-side and a second phrasing is the drift this plan keeps naming |
| R38 | missing | blocker cleared | [types.ts:3419](../../main/recorder/types.ts:3419) defers the `parallel` flag pending "the same barrier machinery `wait` does". That machinery shipped 2026-08-13 (`shared/routine-plan.mjs`). Re-rank it |
| R49 | missing | **a defect** | See below — this one is not a missing feature |

**R49 is not missing. It is on, and inert, and the gate cannot see it.**
R8 turned run-time healing on for the MCP and CLI path
([run-tests.mjs:396](../../mcp/run-tests.mjs:396) sets `GLAZE_HEAL = "1"`) and
the capture fixture installs it. But the two halves disagree about the file:
the app writes `<runId>.heal-map.json`
([playwright-runner.ts:1513](../../main/services/playwright-runner.ts:1513)),
while this path points `GLAZE_HEAL_MAP` at `<testId>.heal.json`
([run-tests.mjs:408](../../mcp/run-tests.mjs:408)) — and that assignment is the
**only** occurrence of that filename in the repository. Nothing writes it, so
every unattended run installs a heal map that does not exist, heals nothing, and
records no evidence of having tried.

`check:ci-fixtures` pins the SWITCH and never the MAP
([ci-fixtures.check.ts:159](../../main/services/__tests__/ci-fixtures.check.ts:159)),
which is why the gate stayed green through it. **Fix the check first** — assert
that `GLAZE_HEAL="1"` implies a non-empty map file — because that guard is what
stops the same shape recurring; the feature fix rides on the `shared/`
locator-engine extraction that overlay dismissal also waits on, and is a dozen
lines behind it.

This is the failure mode §3.3a names, one layer down: not a wrong answer, a
confident one about nothing.

**Done, 2026-08-25 — both halves.** The FEATURE followed R51: the probe builder
and the map builder are in `shared/`, the unattended runner writes the map under
`healMapFileName(runId)`, and the check's "on" arm — a switch that is not `"0"`
implies a map named through `shared/heal-artifacts.mjs` AND a writer for it — is
the arm that now runs. Its evidence is converted into `step-matches.json` and
`heal-failures.json` like an app run's, because "healed nothing and recorded no
evidence of having tried" is two failures and fixing one would have left the
other. The only difference from an app run is `stepLabel`, which is empty
because `describeStep` is still app-side; the fixture falls back to the step id.

**The guard, earlier the same day.**
`check:ci-fixtures` now asserts the implication in BOTH arms — written only for
the "on" arm it would be satisfied by disabling the feature, which is the same
shape again — so "off" has to prove the map and the heal directory are absent
too, and that every `ran.autoHeal` is false so `describeRun` prints the caveat
it already carried. `shared/heal-artifacts.mjs` is now the only place either
artifact is named, which makes a third spelling impossible rather than merely
detectable. Healing is `"0"` on this path until **R51**: the map holds a probe
script per step from `buildHealProbeScript`, which embeds the recorder's locator
engine, and a plain-`.mjs` server cannot import compiled TypeScript. Both
capabilities blocked on that extraction now name it from the policy table, so
they read as one job rather than two omissions.

---

## 3. CI/CD — the deep section

The maintainer's judgement is that this is where the commercial value is, and
the research supports it: every one of mabl's nine packaged CI integrations
resolves to the same single CLI call, and mabl says so outright — the Bitbucket
article states that "the mabl deployment pipe relies on the mabl CLI." The
integrations are marketing surface over one primitive. Good Looks needs that
primitive first.

### 3.1 What mabl actually does

Four mechanisms, in the order they matter.

**The deployment event is a selector, not a test list.** CI POSTs an
application id and/or environment id, optionally plan labels, and mabl resolves
which plans that means. Because "no plans matched" is otherwise indistinguishable
from "everything passed", there is a dedicated dry run: the same payload with
`?preview=true` returns `triggered_plan_run_summaries` listing what *would* run.
An entire troubleshooting section is titled "Deployment succeeded but no tests
ran". This is the single failure mode mabl's docs spend the most words on.

**The CI Runner is the CLI in headless mode inside the customer's container.**
Prerequisites are a Node LTS and a chromium browser; mabl ships
`mablhq/mabl-cli-chromium` with one baked in. The application under test and the
tests both run inside the CI container. mabl publishes its degradation honestly
as a matrix: no parallelism, pass/fail artifacts only, no auto-heal writeback.

**Blocking and exit status are explicit and opt-in.**
`mabl deployments create --await-completion` blocks and returns non-zero when
plan runs fail; `--fast-failure` exits on the first failure; GitLab exposes
`MABL_FAIL_STAGE_ON_TEST_FAIL=false` as the opt-out. A release note records a
bug where "zero exit code could be emitted on failure" — they take this
seriously because it is the property everything else depends on.

**Preview environments are handled by separating configuration from target.**
`mabl deployments create -e {preview-env-id} --app-url {url}`, with the split
spelled out in the docs: the `-e` flag selects the environment's variables and
configuration and does *not* change the target URL; `--app-url` is required to
override it. That separation is the design detail worth copying exactly.

And after a failure, the path from pipeline to failing step is three clicks or
fewer: the step goes red, a check appears on the commit (bound by
`--revision {sha}`), its Details page lists every test, and clicking one opens
the run output with screenshot, DOM snapshot, network calls and a generated
failure analysis. In parallel a Slack card carries the analysis and a JUnit file
lands in the CI's own test tab.

### 3.2 What Good Looks has, precisely

Better than it looks in three places and worse in one.

**Already CI-ready, and nobody has aimed it at CI.** `GOOD_LOOKS_USERDATA`
overrides the data directory
([user-data-rules.mjs:28](../../shared/user-data-rules.mjs:28)), `chooseDataDir`
is pure and shared by both processes, `mcp/data-dir.mjs` has win32 and linux
branches written expressly so the server is drivable off macOS, resolution
failure throws a diagnostic naming every path tried and exits 1 rather than
serving an empty library, `--print-data-dir` exists, and `check:mcp-boot`
actually spawns the server against a throwaway store. Good Looks needs no
account, no API key and no network egress to run a suite — which is a real
advantage over every product in the corpus, and worth stating in the docs.

**The run is already pure Node work.** The runner materialises its scaffolding —
`playwright.config.ts`, `step-reporter.mjs`, `glaze-runtime.mjs`, the heal map —
from compiled string modules into the scripts dir at run time
([playwright-runner.ts:249-269](../../main/services/playwright-runner.ts:249)),
then spawns `process.execPath` with `ELECTRON_RUN_AS_NODE=1` and parses markers
off stdout. Under plain Node that spawn works identically without the flag.
Electron supplies exactly three things: the userData path, `safeStorage`, and the
logger. A second non-Electron execution path already exists and is exercised —
the MCP server spawns Playwright itself, with `mcp/run-plan.mjs` supplying env
and argv, `mcp/run-pool.mjs` supplying bounded concurrency and
`shared/batch-queue.mjs` supplying selection expansion.

**The generated artifact is a runnable `@playwright/test` spec.** The config
retains a trace specifically so a hand-run outside the app works
([playwright-config-source.mjs:96-104](../../shared/playwright-config-source.mjs:96)).
This is a stronger position than mabl's, whose `--format playwright` export
refuses mabl-generated tests entirely and drops twelve step types.

**The blockers, each verified.**

1. **No entry point.** No `bin`; `main` is `build/main/index.js` and `start` is
   `electron .`. No `--run`/`--report` argv anywhere in product code.
2. **Playwright CLI resolution.** The app scans two `node_modules` roots
   relative to its own bundle
   ([playwright-runner.ts:117-146](../../main/services/playwright-runner.ts:117));
   the MCP looks only at the source checkout's. Neither can be pointed elsewhere.
3. **Browsers.** `isBrowserInstalled` reads `<userData>/recorder/browsers` and
   only the app ever installs. The MCP refuses to run when an engine is missing.
4. **Secrets.** Values live in one `safeStorage` blob decryptable only by the app
   process. `mcp/run-plan.mjs:104` states there is "deliberately NO
   `GLAZE_SECRET_*` key here, and there cannot be one". A machine-bound keychain
   blob does not survive a copy into a container.
5. **Test portability.** `TestRecord.scriptPath`, `sourceDir` and `sourceRoot`
   are absolute ([types.ts:616-629](../../main/recorder/types.ts:616)). There is
   an import channel and no export counterpart.
6. **Fixtures.** Every fixture-borne capability arrives by rewriting line 1 of a
   temp spec copy from `@playwright/test` to `./glaze-capture.mjs`
   ([playwright-runner.ts:559-573](../../main/services/playwright-runner.ts:559)).
   A run that skips that path gets no screenshots, no axe, no console or network,
   no Auto-Heal, no settle, no step progress.
7. **Reports.** The emitters are correct; `emitReport` opens a save dialog.
8. **Exit codes.** Nothing exits non-zero because a test failed.

Headless, notably, is *not* a blocker — it already exists per-test and globally,
and scheduled runs force it.

### 3.3 The proposed shape

`good-looks` as an npm-installable CLI, built as a **third caller** of the
modules `mcp/` already uses rather than a third implementation of the runner.
That framing is the load-bearing design decision, because
[run-plan.mjs:10-16](../../mcp/run-plan.mjs:10) records that the app's runner and
the MCP's had already silently diverged in four ways by 2026-08-07, and
`check:mcp-parity` exists to stop a third. A CLI is the third, and it must be
pinned the same way from the first commit.

```
good-looks run     [--id … | --tag … | --group … | --all]
                   [--base-url URL] [--var name=value] [--secrets-file f.json]
                   [--browser chromium|firefox|webkit] [--speed fast|medium|slow|crawl]
                   [--parallel N] [--retries N] [--fail-fast]
                   [--junit report.xml] [--results-out dir] [--dry-run] [--json]
good-looks install <chromium|firefox|webkit> [--with-deps]
good-looks report  <junit|github|otlp|ticket|ndjson|csv> --out PATH [--batch ID]
good-looks export  --out DIR        # portable bundle
good-looks eject   --out DIR        # standalone Playwright project
good-looks ingest  DIR              # results back into the local library
good-looks data-dir
```

### 3.3a Correction, 2026-08-25 — R4 is mostly already built

**R4 was ranked `missing` / L, and that is wrong.** The Electron-free run path
exists today, in `mcp/`, and has since before this plan was written. A CLI does
not have to make the runner reachable without Electron; it has to CALL what
already is:

| What R4 asks for | Where it already lives |
| --- | --- |
| Spawn Playwright from plain Node | `mcp/server.mjs` `executeTest` — `spawn(cliPath, runArgs(...))`, no Electron anywhere on the path |
| Find the library without `app.getPath` | `mcp/data-dir.mjs` `resolveDataDir`, sharing its rules with the app through `shared/user-data-rules.mjs` |
| Plan a queue and bound concurrency | `mcp/run-plan.mjs`, `mcp/run-pool.mjs` |
| Write run history | `mcp/run-history.mjs` `saveRunRecord` |
| Write the Playwright config both callers read | `shared/playwright-config-source.mjs` |

**The `safeStorage` half is real but is R7, not R4.** Nothing on the run path
needs `safeStorage` — it is needed only to decrypt a test's SECRET values, and
the MCP's answer today is to refuse by name any test that declares one
([server.mjs:650](../../mcp/server.mjs:650)). That refusal is correct and
deliberate; replacing it with an environment contract is exactly what R7
describes, and it is already ranked separately.

**So what Phase C1 actually costs is smaller than the ranking implies, and its
first step is different from the one listed.** Before `good-looks run` can be
written, the run routine has to come OUT of `mcp/server.mjs`: it is
module-private inside a 2,150-line file that boots a server on import, so
nothing can call it. Extracting it is the change that makes the CLI a third
CALLER rather than a third implementation, which §3.3 already names as the
load-bearing decision. Sequenced: extract → `bin` + `run` (R3) → the exit
contract (R2) → R11, R9, R8, R7.

**Status, 2026-08-25 — PHASE C1 IS COMPLETE.** Every item in it has landed:
the extraction, `bin` + `run` (R3), the exit contract (R2), the installer (R11),
the dry run (R9), the fixtures (R8) and the secret contract (R7). `good-looks
run` exists, refuses rather than guessing, installs its own browser, says what
it would do before doing it, gets the same fixtures an app run gets, and can be
handed a credential it will also redact.

**Two things Phase C2 should know before it starts.**

*R14 depends on R10, which the ranking does not say.* A test's `scriptPath` is an
ABSOLUTE path from the authoring machine, so a library copied to a CI runner
resolves through `path.relative` to a spec seven directories above the runner's
scripts dir. Playwright finds no tests. Shipping a GitHub Action (R14, ranked S)
before the portable bundle (R10, ranked L) means shipping a workflow template
that cannot work.

**That half of R10 landed 2026-08-25.** `shared/script-path.mjs` resolves a
record's spec against the scripts dir of whichever machine is reading, so a
copied library finds its own specs — recorded and imported alike — and the spec
argument the runner builds no longer escapes. Nothing changes on the authoring
machine and there is no migration. **R14 is unblocked on this point**; what
remains of R10 is the export COMMAND that packages a library into something you
can hand a runner, which is a feature rather than a fix.

*That dependency had a bug underneath it.* Until #261, a run in which every test
was skipped exited 0 — so the copied-library case above would have reported a
green pipeline that executed nothing. Worth remembering as the shape to look for
in C2: the failure mode of this whole area is not a wrong answer, it is a
confident one about nothing.

**Earlier status, kept for the record.** Everything up to and including R9 had
landed when this paragraph was first written. The
extraction is `mcp/store.mjs` + `mcp/run-tests.mjs` (#255); the CLI is `bin/` +
`cli/` with R3, R2, R11 and R9 in it (#257). One finding is worth carrying
forward, because it changed the estimate: the batch driver was **not** a move.
It returned MCP tool content at every exit, so nothing that was not an MCP tool
could call it — `runSelection` returns a discriminated result now, and the tool
renders it. **R8 and R7 remain**, and they are the two the section below calls
non-obvious for good reason.

**What the extraction actually involves, measured rather than estimated.** About
534 lines across four groups, and only three of them are a move:

| Lines | What | Shape of the change |
| --- | --- | --- |
| 108–192 (85) | The `dataDir` readers — `listTests`, `readSettings`, `readSignatures`, `readOverlayRules`, `saveRunRecord`, `saveBatchRecord` | Move. They are one-liners over `readJsonFile`, and the other tools need them too, so they want their own module rather than to ride along with the runner |
| 193–269 (77) | `findPlaywrightCli`, `isBrowserInstalled`, `ensureModuleResolution`, `ensurePlaywrightConfig` | Move |
| 270–437 (168) | `executeTest` | Move — it already returns a structured result, not MCP content |
| 1123–1326 (204) | The batch driver | **NOT a move — a split.** It returns MCP tool content (`{content:[{type:"text"}], isError}`) at three exits, so a CLI cannot call it as it stands. The selection, planning, pooling and summarising have to come out as a function returning a RESULT, with the MCP tool left as the thing that renders that result into text |

That last row is the whole reason this is its own change rather than a step
inside the CLI's first commit: the split has to preserve every one of the tool's
current answers — including the empty-selection message that names the selector
that actually applied — while giving the CLI the same facts in a form it can
turn into an exit code. Doing it under `check:mcp-boot`, `check:mcp-parity`,
`check:mcp-run-history` and `check:mcp-select`, with no behaviour change, is what
makes the CLI's own first commit small enough to review.

Exit-code contract, pinned by a `check:cli-exit` script:

| Code | Meaning |
|---|---|
| 0 | Every selected test passed |
| 1 | At least one test failed |
| 2 | The selector matched nothing |
| 3 | The run could not start (missing browser, missing secret, no base URL) |

Code 2 is the one that matters most and is easiest to get wrong. mabl devotes a
whole troubleshooting section to the silently-empty pipeline; today the
equivalent already exists here — a tag that matches nothing produces a batch of
zero and a summary byte-identical in shape to a clean pass, and `run_batch` only
sets `isError` when `summary.failed > 0`. Rename a tag from `smoke` to `Smoke`
and the pipeline stays green while testing nothing.

### 3.4 CI phasing

**Phase C0 — value before the CLI exists** (days, not weeks). Every item here
is independently useful to someone running Routines on their own machine, and
each is a prerequisite for the CLI.

- **R1** Split `emitReport` into `buildReport()` plus two destinations, and widen
  the scope options from `{testId}` to `{testId?, batchId?, since?, until?,
  runIds?}`. Today `build()` reads the entire retained run history and filters
  only by testId, so a JUnit file emitted after a 12-test routine describes every
  run the machine has ever kept. Both halves are needed: a non-interactive
  destination without scoping produces a technically valid file nobody can use.
- **R13** Carry `failedStepLabel`, `failureReason` and `firstErrorLine` into the
  emitters. JUnit currently writes `message="exit N · log <path>"`, where the
  path is dead on any other machine. The decision not to inline the whole log is
  recorded and correct; a step label is not a log.

  **This is two changes, not one, and the first was missed in an earlier draft
  of this plan.** `failedLabel` is a *local variable* in
  [playwright-runner.ts:1658](../../main/services/playwright-runner.ts:1658) that
  is never persisted — its only consumers are `notifyRunOutcome` and `sendAlert`.
  `RunRecord` has no such field, and `shared/emitters.mjs` never references one:
  `junitXml` builds its message unconditionally at
  [emitters.mjs:108](../../shared/emitters.mjs:108), as does `githubAnnotations`
  at :143. So the label must be **persisted on `RunRecord`** before the emitters
  can read it, and turning capture on buys nothing for the JUnit file by itself.
  Note also that this is a redaction path, not a formatting change: a step label
  can *be* the credential — the repo's own fixture uses
  `getByLabel("Password").fill("hunter2-secret")` as a `failedLabel`
  (`main/services/__tests__/variables.check.ts:203`).
- **R30** Put the deep link in the alert webhook payload. `buildDeepLink` already
  exists and is already used by the issue-tracker path, so there is no second
  spelling to maintain.
- **R6** Add optional `provenance` to `RunRecord` — revision, branch,
  repositoryUrl, jobUrl. Populated from `GITHUB_SHA` and friends when present.
  Treat every field as untrusted text: a fork's branch name is attacker-chosen,
  and this repo already has a recorded design for that.
- **R15** Add `mcp/**` to electron-builder's `extraResources`. The MCP server is
  written, tested and documented, and is simply not in the box — anyone who
  installed the packaged app rather than cloning the repo cannot reach any of it.

**Phase C1 — the CLI.** R3, R4, R2, R11, R9, R8, R7. The order inside this phase
is: make the runner Electron-free, then add the `bin`, then the exit contract,
then browsers, then selection with the dry run, then fixtures, then secrets.
**Corrected 2026-08-25 — the first step is already done and the real one is
different: see §3.3a.** The Electron-free path exists in `mcp/`; what stands in
the way of a CLI is that it is module-private inside `mcp/server.mjs`. Two
non-obvious requirements:

- **Fixtures are not optional.** A CLI that runs fixture-free is a CLI that
  reports failures the app would have healed, and the team's conclusion will be
  that the CI integration is flaky. The fixture sources are TypeScript modules
  exporting *strings*, so a plain Node process can write them, and `writeIfChanged`
  is a dozen lines. Decide per capability, in writing, which are on in CI —
  capture and a11y are useful as CI artifacts, Auto-Heal in suggest mode is safe,
  Auto-Heal in apply mode must be off because it would write back to a
  `tests.json` that dies with the container.
- **Secrets need a documented contract and a refusal path.**
  `GOOD_LOOKS_SECRET_<TESTID>_<NAME>` or `--secrets-file`, resolved
  explicit-env → safeStorage-if-available → refuse-by-name. The same values must
  feed the redaction snapshot, or the CLI's own log output and any emitted report
  will contain the credential.

**Phase C2 — the loop closes.** R10 (export bundle), R12 (ingest), R14
(templates), plus the artifact bundle. R12 is the item that stops CI making the
product worse: without it, a suite that runs 40 times a week in a container
produces 40 run histories that die with their containers, while the Stability,
flake and step-health screens — the surfaces that make the app worth opening —
are built from the handful of runs someone triggered by hand.

**Explicitly deferred.** A remote-trigger daemon. It would introduce the first
listening socket in the product, the first authentication surface, and would make
a laptop a build dependency; it also inverts the deep link's recorded contract
that it "never runs a test, never writes, never deletes". Build the
outbound-invocable path and document a recipe instead. Revisit only for the
narrow case of a private environment only one machine can reach.

### 3.5 The redaction boundary is the budget

Every CI proposal above adds an egress path: a file written without a dialog, an
artifact zip, a wider webhook, a second emitter caller in `mcp/`. Redaction here
is currently a structural property with three source-level guards — the emitters
are pure functions with nowhere to send anything, `report:emit` is a verb
returning `{path, bytes}` so the renderer never holds the text, and
`check:emit-redaction` pins all three halves. Each new egress path must extend
that check's scan set in the same commit that adds it. For the two paths that
cannot reach `redactWithSnapshot` at all — the artifact bundler and any MCP emit
tool — the honest answer is the one the MCP already gives for console logs:
refuse when a secret exists rather than emit unredacted.

This is also a selling point rather than only a constraint. A team that cannot
let test output leave a machine can use this product and cannot use mabl.

---

## 4. Environments

The prerequisite for the preview-URL half of the CI story, and independently the
largest usability gap in the product.

There is no environment object anywhere — no record, store, type, id or picker.
What exists instead is a set of orthogonal, differently-scoped knobs: one
optional `TestRecord.baseUrl` surfaced *only* for imported tests, per-test
variables, datasets and secrets, per-test login sessions, and a global proxy.
mabl makes the environment the join between a test set and a deployable target:
a plan binds to environment plus application, the environment carries variables,
credentials, interaction speed, locale, timezone, basic auth, headers and a
tunnel, and every test in a plan runs once per environment.

So "60 tests against dev, staging, prod, plus a PR preview" has a clean answer in
mabl and no answer here. A recorded test bakes its absolute URL into every `goto`
step, so re-targeting 60 tests is 60 tests × N hand edits — and cookies, saved
sessions, the proxy and the Shopify signature host are separately configured and
none of them follow a URL change.

**Two pieces of plumbing already exist end to end and should be the spine of the
work.** `PW_BASE_URL` travels record → runner env → the single shared generated
config, and is set identically by the MCP. And every `goto` URL already
interpolates `${var}` through the one traversal that defines interpolatable
fields. What is missing is a scope above the test to hold values, a way to pick
that scope at run time, and environment-keying of the per-test state a run
*writes*.

**That last one is where a naive environment feature silently corrupts data**,
and it is the part to get right first:

- A saved login session is keyed by testId alone. Run the login test against
  staging, then the suite against production, and every consumer test starts from
  the staging `storageState` — the production site drops the cookies and twelve
  tests fail at the first auth check.
- Visual baselines, a11y baselines and the heal journal are keyed the same way. A
  heal learned against staging silently changes what runs against production.
  mabl scopes element history per environment for exactly this reason.

**Phasing.** R5 first and alone — a per-run base-URL override, resolving as
override → environment → `record.baseUrl`, validated through the same
`normalizeBaseUrl` gate every other path uses, and recorded on the RunRecord so a
run's history is not misleading. It is cheap, it unblocks the PR-preview story,
and it does not require the environment record. Then R16 (the record and store),
then R34 (variables, credentials, and the per-environment keying of sessions and
baselines), then the settings that ride on it: R36 locale/timezone/headers,
per-environment proxy, and environment selection on Routines.

---

## 5. Stability

Good Looks' diagnosis is at or ahead of parity. Four gaps in absorption, plus
two measurement-hygiene defects that manufacture the very signal the Stability
panel exists to give.

**The two defects first, because they are cheap and they corrupt data.**

- **R19 — record why a run ended.** Status is derived purely from the exit code:
  `exitCode === 0 ? "passed" : "failed"`. A user pressing Stop SIGKILLs the child
  and lands in the same bucket as a genuine failure. Press Stop three times over a
  week on a test with eight runs and the panel calls the test flaky.
- **R20 — segment stability by browser.** `analyseFlake` groups strictly by
  testId and counts every consecutive-status disagreement as a transition. Dataset
  rows are already segmented, for exactly this reason. A test that passes on
  Chromium and Firefox and fails consistently on WebKit reads as pass, pass, fail,
  pass, pass, fail — so the cross-browser matrix makes the stability signal worse
  the more it is used.

**The four absorption gaps.**

- **R21 — decouple page-settling from the Crawl speed.** The settle fixture is
  the app's only dynamic waiting, and it is gated exclusively on
  `speed === "crawl"` — a speed that also inserts 2.5 s before every action and
  raises the test timeout floor to five minutes. So the fix for a load race is a
  setting nobody can afford to leave on. Split the install condition from the
  speed and consider a cheaper default profile.

  **R21 is a product fix, not a technical prerequisite for the CLI.** The
  coupling to crawl exists only in the app's runner
  ([playwright-runner.ts:1271](../../main/services/playwright-runner.ts:1271))
  and in the MCP's `describeRun`. The fixture itself reads an independent env
  var — `const ON = process.env.GLAZE_SETTLE === "1"`
  ([settle-fixture-source.ts:55](../../main/services/settle-fixture-source.ts:55))
  — so a CLI writing its own env can set `GLAZE_SETTLE=1` with `PW_SLOWMO_MS=0`
  today. Do not sequence CI work behind this.
- **R25 + R26 — per-step timeouts, then learned budgets.** `Step.timeoutMs`
  exists but is wired only for `waitUntil` steps; a click, fill or assert inherits
  the fixed global 10 s expect timeout. Widening it is small, and it is the
  mechanism a learned budget writes into. Then derive per-step p95 from passing
  runs in the metrics DB, segmented by browser. The data mabl learns from is
  already being collected here — Step Health has the numbers — it is simply never
  fed back into the run.
- **R22 + R23 — a confidence floor and a per-step opt-out.** The heal probe ranks
  candidates and the fixture acts on the first three that work, whatever the score;
  the only rejection is uniqueness. mabl fails the step rather than heal to a
  low-confidence match, and offers "Disable auto-heal" per step. The app's own
  settings copy explains why this matters: a wrong heal usually still succeeds,
  because clicking the wrong button rarely raises an error. Without an opt-out, a
  reverted mis-heal recurs on the very next run.
- **R24 — retries.** This asks to revisit a decision recorded twice, and the
  recorded reasoning names its own condition for revisiting:
  [ROUTINES.md:288](../ROUTINES.md:288) — "If retry is added later it must mark the
  resulting `RunRecord` so flake analysis can exclude or count it deliberately."
  Opt-in, default 0, `attempt` and `passedOnRetry` on the record from the first
  commit, flake analysis excluding retried attempts by default. The
  counter-argument in ROUTINES is correct about what a *naive* retry destroys; it
  is not an argument against a marked one.

  **But that condition is necessary and not sufficient, and an earlier draft of
  this plan was wrong to imply otherwise.** It governs the `RunRecord`, which is
  not where a retry does its damage. See §11 decision 1 — the evidence layer has
  no attempt dimension at all, and **R24a below is a hard prerequisite.**

- **R24a — attempt-key the run evidence.** Independently worth doing: it is most
  of what R27 (rerun failed) and R29 (compare against last pass) need, and it is
  testable before retries exist. Four changes:
  add the attempt dimension to the artifact path or the manifest
  ([artifact-store.ts:3](../../main/services/artifact-store.ts:3),
  [capture-fixture-source.ts:512](../../main/services/capture-fixture-source.ts:512));
  make `stepStatusMaps` attempt-aware
  ([playwright-runner.ts:924](../../main/services/playwright-runner.ts:924));
  read `result.retry` in both reporter copies, where the parameter is already
  present and underscore-prefixed
  ([step-reporter.ts:51](../../main/services/step-reporter.ts:51));
  and change the trace-salvage gate at
  [playwright-runner.ts:1602](../../main/services/playwright-runner.ts:1602)
  from "exit code" to "any attempt failed".

**R47** is a small, separate defect: heal candidate scores are a sum that can
reach ~2.45, and `normalizeStepStructures` drops anything outside 0–1 to zero —
so the AI-debug prompt prints `(score 0.00)` for the *strongest* candidates and
the model reads the list as ranked worst-first. Normalise at the source.

**Protect while doing all of the above.** Suggest is the default and a heal does
not rewrite the stored test. `identifiesOnly` rejects an ambiguous candidate.
The heal journal supports undo and records what the locator actually matched.
Adding a score floor must not weaken uniqueness; adding retries must not let
attempt 2 overwrite attempt 1's evidence.

---

## 6. Performance

**R17 is a defect, not a feature, and it is the largest self-inflicted overhead
in the codebase.** `applyRetention()` sits unconditionally in the run's `finally`
and calls `artifactStore.pruneAllTests`, which calls `usage()` twice. With 100
tests × 10 retained runs × ~20 screenshots that is roughly 20,000 files stat'd
twice after *every* run — in a 100-test batch, millions of synchronous stat calls
on the main process, the same thread servicing the `runner:output` stream. Keep
the cheap per-test prune on the run path; move the library-wide sweep to startup
and an idle trigger.

**R18 is the cheapest wall-clock win in the plan.** Seed
`defaultBatchConcurrency` from the machine rather than from the constant 1,
default a *batch* to headless, stop stamping every newly recorded test `slow`,
and add a run-level speed override so "run the suite fast, run this one test slow
while I watch it" is expressible. A first-time user who ticks 60 tests today gets
them one at a time, in visible windows that steal focus, at 1200 ms per action —
and every ingredient of the fast path already exists behind a picker they have
not found.

**R37 is where parallelism evaporates.** `buildLanes` partitions the queue into
one lane per distinct testId and clamps concurrency to the lane count. So the two
things that most often multiply a queue — a dataset sweep and a multi-engine row
— are strictly serial no matter what the picker says. A 20-row dataset with the
picker on "All at once" runs 20 times, one after another, because
`clampBatchConcurrency(16, 1)` returns 1. The fix is the change `batch-runner.ts`
names and rejects: key a live run by a fresh id rather than by testId, which the
MCP already does.

**R39** is worth doing before anyone leans on the MCP: two independent limiters
of 16 on one machine, each unaware of the other, so a 40-test batch plus an
agent-driven `run_batch` puts 24 browsers on one laptop and both sides file the
resulting timeouts as test failures.

**Protect:** the measured cost breakdown. The capture fixture times the
screenshot separately from the action and axe separately again, so Speed & cost
can say "3m20s of your 5m suite is capture, accessibility and the Slow speed you
picked" from measurement rather than estimate. mabl's equivalent is a human
playbook. This has no mabl counterpart and is worth extending, not trading.

---

## 7. Usability of running and reading results

The single highest-value cluster, because it is what a user touches daily.

- **R27 — rerun failed.** Absent entirely. A 60-test routine finishes with 4
  failures; verifying a fix means re-running all 60 or hand-ticking 4 rows while
  remembering which engine and dataset row each failed on. This is the most-used
  button on any suite runner.
- **R28 — persist the failing step for every run.** Step-level outcome is written
  only when the run was capturing. Run a 40-step test with capture off — the
  default for a quick check — and after switching away and back, the step list
  shows nothing and the panel says "Failed" with no indication of where.
- **R29 — compare against the last passing run.** `compareRuns` is fully built,
  tested, and exposed on IPC and MCP, and the app calls it in exactly one place:
  after a Visual-view re-run. The highest-value question after a failure is
  already implemented and reachable only by an MCP client.
- **R43** — console and network capture is genuinely rich, redacted on read, and
  completely invisible in the UI. A test fails on a click that should have
  submitted an order; the run recorded a 503 from the payments host, and the user
  can only reach it by asking the local model or querying MCP.
- **R31, R32, R33, R48** are all small and all remove daily friction: no Runs tab
  on a test, no Run item on a library row or folder, no record of what triggered a
  run, and a half-applied Batch→Routine rename that tells a user "A batch is
  already running" about a thing they created called a routine.

**Protect:** triage computed on read rather than stored, with a confidence
ceiling and a first-class `limits` array — improving the classifier improves every
historical run — and the six-state run vocabulary that shows amber for a run that
passed after healing.

---

## 8. Net-new

Four worth building, four declined.

**N1 — a bounded site sweep.** The one capability in the corpus that finds a real
defect with zero authoring. A theme update breaks three footer links; no recorded
test clicks a footer link, so the suite stays green for a week and no surface in
Good Looks would notice. Build it as a distinct run kind, not a test: a start URL,
same-origin only, hard caps on pages and links, reusing the settle fixture and the
five-minute timeout floor.

**N2 — coverage** depends on N1 for the denominator; the numerator is already on
disk in each run's `network.json` document entries. On a 30-test suite "58%
covered" is a vanity number, but "nothing touches these 12 pages" is a to-do list.

**N3 — mobile-web device emulation.** Viewport is already a recorded concept, but
it is the only device property, so a responsive storefront serves the desktop
template to the run and the recorded steps stop matching. Narrow, sharply felt by
a large slice of who records tests at all.

**N4 — one write on the MCP: `create_test`.** All 23 tools read or run, recorded
as a decision. Worth revisiting on its own terms rather than around it: a user in
Claude Code can have an agent read every test, run any of them and triage a
failure, but must switch to the app and re-describe the same thing to get a new
test into the library.

**Declined, with reasons.**

- *Native mobile app testing.* Playwright does not drive native apps. This is a
  second product with its own build store, simulator plumbing and device farm.
- *Agentic runtime recovery.* mabl turned it off everywhere after early access,
  and this codebase's own reasoning predicts the failure mode: an agent taking
  unnamed corrective actions mid-run produces a pass nobody can audit, on a
  product whose entire heal design is built around that hazard.
- *Ingesting results from a foreign runner.* Presupposes a server for someone
  else's CI to POST into. The desktop user's version of the problem is already
  solved from the other direction — import the spec and run it here.
- *An auto-created home-page monitor.* The scheduler honestly states it cannot
  promise unattended runs, because the app is not always running.

---

## 9. Where Good Looks is ahead

Worth stating explicitly, because several items above could erode these if built
carelessly, and because they are the strongest answers in a comparison.

| Property | Why it beats the mabl equivalent |
|---|---|
| Private and localhost targets | Runs are a local child process, so localhost, `/etc/hosts`, RFC1918 and VPN hosts work by typing the URL. mabl needs a Link Agent, an API key and a tunnel lifecycle |
| TOTP-backed credentials | A secret can carry a base32 setup key and the generator emits a getter deriving the current code. mabl's documented answer to an MFA login is a WAF bypass rule |
| No identity, no key, no egress | A suite runs with a directory and an env var. Every mabl CLI operation requires an authenticated hosted account |
| Vanilla Playwright specs | The stored artifact is already runnable outside the app. mabl's Playwright export refuses mabl-generated tests and drops twelve step types |
| Redaction as structure | Three source-level guards, not a policy. mabl's results live server-side by construction |
| Triage on read | Deterministic, retroactive, with published confidence limits and no model call |
| Measured overhead | The app measures its own instrumentation cost per run. mabl offers a manual playbook |
| Heal evidence | Suggest-by-default, uniqueness rejection, undo, and a record of what the locator actually matched |

---

## 10. Sequencing

Four foundational changes unlock most of the rest:

1. **A non-Electron run path** (R4) → the CLI, and cleaner MCP parity.
2. **Scoped, non-interactive report emission** (R1) → every CI integration, the
   run-end report, the PDF export.
3. **An Environment record** (R16) → preview URLs, per-environment state keying,
   routine targeting, credentials, locale, proxy.
4. **Richer RunRecord fields** — provenance (R6), `endedBy` (R19), `trigger`
   (R33), `attempt` (R24) → correct flake analysis, CI joins, and honest history.
   Three of these four cannot be backfilled, so they are cheapest to add early
   and most expensive to regret: see §11 decision 5.

A fifth is worth naming because it is not obviously foundational and turns out to
be: **R24a, attempt-keying the run evidence.** It gates retries (§11 decision 1)
and supplies most of what R27 and R29 need, so it pays for itself twice before
any retry flag exists.

Suggested order: Phase C0 and the Phase 0 defects (R17, R18, R19, R20, R47) run
concurrently and are all small. Then R5 and the CLI. Then environments. Then
stability absorption. Usability items can be slotted between phases — most are
independent, and R27, R29 and R31 are the ones users will notice first.

## 11. Decisions taken

Decided 2026-08-21. Each was grounded in the repo's own recorded reasoning and
then checked by a pass instructed to refute it. Three of the five confirm the
existing decision **for a different reason than the one recorded** — which
matters, because the recorded reason is what a future reader will use to judge
when it stops applying. Anything here that survives into implementation belongs
in `docs/DECISIONS.md` at that point.

### 1. Retries — build them, but the recorded condition is not sufficient

**Decision: yes, opt-in, and R24a lands first. Not CLI-only.**

[ROUTINES.md:288](../ROUTINES.md:288) requires a retry to mark the `RunRecord`.
That governs the *statistics*. It does not touch the *evidence*, and the evidence
layer has no attempt dimension anywhere:

- The capture fixture is a **`page` fixture**
  ([capture-fixture-source.ts:447](../../main/services/capture-fixture-source.ts:447)),
  so Playwright re-enters it on every attempt, and it resets `index: 0` into a
  fixed `GLAZE_ARTIFACT_DIR` (:512). Attempt 2 overwrites attempt 1's
  screenshots, `manifest.json`, `console.json` and `network.json`. **The failing
  attempt is destroyed by the passing one.**
- Trace salvage is gated `if (!outputDir || exitCode === 0) return false`
  ([playwright-runner.ts:1602](../../main/services/playwright-runner.ts:1602)).
  A run that passes on retry exits 0, so the failing attempt's trace is deleted
  with the scratch dir.
- `stepStatusMaps` is `Record<number, …>` keyed by step index and last-write-wins
  ([playwright-runner.ts:924](../../main/services/playwright-runner.ts:924)), so
  `buildReplay` yields `failedIndex === null` and the replay reports that nothing
  failed. (This one bites only capture runs — but those are exactly the runs that
  also lose their PNGs, so the two damages coincide.)

Build R24 as first described and the result is a correctly-labelled record
pointing at evidence of only the attempt that succeeded — on the product whose
claim is that it is better at diagnosis than at absorption.

**Order:** R24a (attempt-key the evidence) → `attempt`/`passedOnRetry` on the
record, teaching the four consumers explicitly (`shared/flake-analysis.mjs`,
`shared/period-digest.mjs`, `renderer/lib/cost-model.ts`,
`renderer/lib/run-summary.ts`) → the `--retries=N` flag beside `--timeout` at
[playwright-runner.ts:1527](../../main/services/playwright-runner.ts:1527) →
Routines last. Never in `shared/playwright-config-source.mjs`: both processes
write that file into a shared directory and last-writer-wins.

For the flake maths, follow the precedent already set for heals: a retried pass
contributes a **failed** entry to the transition series and a **passed** entry to
the outcome, the way `healedSteps` produces "passed, conditionally" and
`run-summary.ts` makes `healed` beat `retry`. Do not widen `status`.

**CLI-only is not a containment boundary**, and should not be argued as one: the
CLI ships `good-looks ingest`, so CLI results land in the same `runHistoryStore`
the flake analysis reads. The data work is unconditional. Routines goes last for
a different reason — `stopRoutine`/`skipGroup` key on "a step failed", a
definition a retried pass silently escapes, and the alert would report a clean
pass for a run that went red once, on the notification ROUTINES calls "often the
only thing seen of it".

**Add a check.** Nothing in the 72-script chain would notice any of the above. A
`check:retry-evidence` asserting that two attempts leave two sets of artifacts
and one marked record is the guard; `check:flake-analysis` should gain a row
where a retried run is present.

### 2. What a CI run captures by default — match the honesty, not the capability

**Decision: a narrow default set, published as a matrix.**

The decisive reason is that screenshots — the most expensive fixture, and the one
everyone assumes CI wants most — are provably worthless in a container today:
[replay-builder.ts:249](../../main/services/replay-builder.ts:249) seeds a new
baseline on every run, so a CI run would pay full capture cost and perform zero
comparisons. Enabling it by default ships something that looks like visual
regression testing and structurally cannot be one.

| Capability | Default | Why |
|---|---|---|
| Step-progress reporting | **on** | Free; already in the app's argv, absent from the MCP's |
| Auto-Heal, suggest | **on** | Zero cost on the happy path — work happens only in `catch`. The biggest app-vs-CI verdict divergence |
| Console + network | **on, with a refusal path** | Bounded at 500+500 entries × 2000 chars. The only evidence of a failure nobody can reproduce locally |
| Screenshots | **off** | No baseline in a container, so no diff. Revisit when R10 ships baselines in the bundle |
| a11y per-step capture | **off** | Highest per-step cost, reporting-only, cannot change the exit code |
| Settle | **off** | A default, not a limitation — see the R21 note in §5; the CLI *can* enable it |
| AI visual checks | **off, and not a bare flag** | Unattended LLM egress. Needs an explicit flag plus its own guard, analogous to `check:insights-egress` |
| Auto-Heal, apply | **refused, exit 3** | Writes `tests.json` — a locator rewrite nobody reviewed, into a store that dies with the container |

Flags, all off by default: `--screenshots`, `--a11y`, `--settle`,
`--baseline-dir`, `--ai-checks` (guarded), `--no-heal`, `--no-logs`. Add
`--all-fixtures` meaning "the app's behaviour", so the capability side is one
word and nobody has to argue with the defaults.

**Copy the shape of mabl's matrix, not its content** — and the shape already
exists here. Every CLI run should print, and every emitted report carry, the
`describeRun` list computed against what the test asked for
([run-plan.mjs:181](../../mcp/run-plan.mjs:181)), pinned by a `check:cli-parity`
sibling to `check:mcp-parity`. Two things must be added to that list before it is
honest for CI: **AI checks silently no-op'ing**, and **the a11y gate running at
its strictest** because `GLAZE_A11Y_BASELINE` is absent. Both are invisible today.

**The one-way door: redact on write, or refuse.** If the first release writes
`console.json` into a directory a workflow template uploads, the credential is in
the CI provider's artifact store — possibly on a public fork's run — and you will
not know it happened. The MCP's existing rule is the model: when the library
declares a secret the process cannot decrypt, write nothing and say why.

The novel part worth recording: **a fixture whose output is only readable by the
app, or only meaningful against state the container does not have, is not a
default in CI no matter how cheap it is.**

### 3. The export bundle does not become the source of truth

**Decision: no. Keep the local store authoritative, and ship a one-way export of
the generated specs. `tests.json` is not committed.**

Making the bundle authoritative turns `tests.json` from the app's own output into
a git-supplied input that decides **which file the machine executes in Node**:
the runner takes the spec path straight off the record
([playwright-runner.ts:1205](../../main/services/playwright-runner.ts:1205)) and
`readScript` reads the stored path with no containment check
([test-store.ts:201](../../main/services/test-store.ts:201)) — while `writeScript`
and `remove` both guard. Every other input on that path in this codebase has a
named boundary and a `check:` script. This would be a third, arriving through a
nested JSON diff that is a strictly worse review surface than the `.spec.ts` it
replaces.

**The blocker for a bidirectional design is `runFlow`.** A flow's steps are baked
into every caller's spec at generation time
([test-store.ts:109](../../main/services/test-store.ts:109)), so a committed
flow-caller spec re-parses into N inlined steps where the record held one
`runFlow` step — and `regenerateCallers` would overwrite a human's edit on the
next unrelated save of the flow. Composition does not survive the round trip.

**Ship instead:** commit the *generated specs* — deterministic, one per test,
already vanilla Playwright, already the thing a reviewer can read — and have CI
run them from the repo. Add a `--check` mode that fails when a committed spec
does not match what the store would generate, which makes "the repo and the app
agree" a testable property instead of a merge problem. The app exports; the app
never imports its own export.

If bidirectional, PR-authored tests are ever wanted, choose that architecture up
front: it needs content-derived step ids, per-record files or a merge driver, a
versioned envelope, and a normalizing reader. Retrofitting re-mints every step id
on installed machines and orphans every visual baseline, a11y baseline and
annotation on disk.

### 4. The MCP does not gain a write. Ship `propose_test` or nothing

**Decision: no MCP-side `create_test`.**

The decisive reason is practical rather than philosophical. `spec-parser.ts` and
the `normalizeStep` family are compiled TypeScript under `main/services/`
(~5,500 lines with the generator); `mcp/server.mjs` is plain `.mjs` with no build
step and imports nothing from `main/`. So every `create_test` a `.mjs` process
can actually implement either ports the generator out of TypeScript — the
refactor [DECISIONS.md:6693](../DECISIONS.md:6693) already refused by name,
because it "would strip the types off the spec generator" — or takes
model-authored source text and drops it into `scripts/`, where `run_test`
executes it. The second is cheap *because* it skips the boundary.

**Two arguments in the recorded rationale should be dropped, because they are
false.** "The MCP never writes" — it already writes `run-history.json`,
`batch-history.json` and `metrics.db`. "The first path by which code a human
never saw reaches a child process" — `tests:createFromPrompt`
([handlers/index.ts:1254](../../main/handlers/index.ts:1254)) already writes
LLM-generated spec source via `testStore.writeScript`. What survives is narrower
and real: `tests.json` is single-writer today (the MCP only reads it), a lost
test record is lost **user work** — `remove` deletes the spec file too, so a
resurrection leaves a broken record — and `writeAll` is a plain `writeFileSync`
while the MCP's own writers use tmp+rename.

**The alternative worth shipping** is `propose_test`: the MCP writes a candidate
spec into `userData/recorder/proposed/<id>/` and returns "open the app to
accept". The request/response file protocol for this already exists in
`debug-shots` / `debug-capture.ts`. It keeps `generateSpec` in TypeScript, keeps
`tests.json` single-writer, keeps the human gate the import path already insists
on, and still removes the pain N4 names — the user accepts rather than
re-describes.

**Run the zero-code experiment first.** An agent can write a spec anywhere with
ordinary file tools and the user imports it in two clicks via `tests:importFiles`.
That works today and nothing tells anyone it exists; say so in
[MCP-GUIDE.md](../MCP-GUIDE.md) and see whether demand appears before building.

If this is ever overruled, two conditions are non-negotiable: source-text-only
with `steps: []` and `scriptEdited: true` (never a structured-steps-to-generator
path from `.mjs`), and a `check:mcp-readonly`-style guard landing in the same
commit pinning that it is the *only* mutation tool — the rule has no enforcement
today, and one unenforced exception is how a surface grows.

### 5. No listening port

**Decision: no, and for this product's shape, effectively never.**

The usual reason given for this is wrong and should not be recorded. It is *not*
that a port would be newly reachable: `app.setAsDefaultProtocolClient`
([deep-link.ts:69](../../main/shell/deep-link.ts:69)) already makes the app an
unauthenticated inbound endpoint that any web page the user visits can reach via
`goodlooks://`.

The pattern this product actually follows is **capability restriction instead of
authentication**. The deep link's mitigation is that "it selects a view"
([deep-link.mjs:11](../../shared/deep-link.mjs:11)), not that nobody can reach
it. `debug-capture`'s only verb is *screenshot*, behind a default-off toggle, and
its header already answers this exact question: "No new socket, no port, nothing
to leave running."

A run trigger is a dangerous verb by construction — it decrypts a password and a
TOTP code and types them at production. **So it fails the app's own rule
regardless of transport**, which is a stronger argument than the threat-model one
and survives the observation that stdio already grants the same capability.

The genuine use case — a private environment only one machine can reach — has a
better answer that is not a product feature: put a self-hosted CI runner on that
machine and have it invoke the CLI locally. That works when the app is closed,
which a port does not.

**If an inbound trigger is ever wanted, the shape is already in the codebase and
it is not a socket:** `debug-capture`'s request-file protocol, default-off, with
the watcher existing only while the toggle is on. Filesystem permission becomes
the authorization — the same reasoning that makes stdio safe.

**Hard prerequisite either way: R6 and R33 land first.** `RunRecord` cannot say a
run was not started by a person, and [DECISIONS.md:1783](../DECISIONS.md:1783)
records that this class of field cannot be backfilled — every row written before
it exists is unclassifiable forever. An ingress path must also extend the
existing ingress-guard family (`check:step-ingest`, `check:capture-egress`,
`check:deep-link`) in the same commit that adds it.
