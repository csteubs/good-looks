# CLAUDE.md

Working rules for **Good Looks!** (a Playwright test recorder). This file, `docs/ARCHITECTURE.md`, and `docs/DECISIONS.md` are the three docs that matter; all three are versioned and hand-maintained in this repo.

The codebase is developed here — from a terminal or editor in this folder — and changes land through branches and pull requests (see "Making a change"). The Glaze app is still the **build and launch host**: it is the only thing that can package the native shell, run the app, and show you the UI. It no longer *develops* the code.

## What this app does

Records interactions on any website (clicks, typing, navigation, assertions) and generates runnable `@playwright/test` specs from them.

- **`docs/ARCHITECTURE.md`** — the per-file map of what exists and why. **Read it before any non-trivial change**; it is the fastest way to find the module that already does what you were about to write.
- **`docs/DECISIONS.md`** — the dated record of *why* each feature landed the way it did. When something looks over-built, this usually names the failure it was built against.

## Architecture

- **Frontend** (React 19 + Vite, `renderer/`) renders in a macOS WebView.
- **Backend** (Node.js, `main/`) calls native Swift host APIs through the Glaze SDK.
- **`shared/`** holds logic the app AND the standalone MCP server both need. They can't share a `.ts` module — the app is compiled against `@glaze/core`, the MCP is plain `.mjs` with no build step — so these are `.mjs` with a hand-written `.d.mts` beside them, which keeps `type-check` a real gate over every TypeScript caller. **Pure only** (no `fs`, no `@glaze/core`, no IPC, no `process`); anything needing the filesystem stays on its own side and hands data in. Reach for this before transcribing a constant into `mcp/` — a copy is right the day it's written and silent forever after.
- They talk over a JSON-RPC 2.0 IPC bridge (handlers registered in `main/handlers/`, called from the renderer via `window.glazeAPI.*` exposed in a preload script).
- The SDK, `@glaze/core`, mirrors much of Electron's API surface. Treat Electron knowledge as a starting point only — verify each API/option is actually implemented here (see SDK reference below) rather than assuming parity.

## Directory map

```
main/handlers/      IPC handler registration
main/services/      business logic (recorder, playwright-runner, llm, spec-parser, visual-pipeline)
main/services/llm/  local + hosted LLM chat integration (Ollama, LM Studio, Claude)
main/recorder/       recording-session logic (script injection, step capture)
main/windows/        BrowserWindow creation/config
renderer/main/       primary views (home, recording/trainer, script view, ai-debug-panel, stats)
renderer/settings/   settings window UI
renderer/components/ reusable UI wrapping the @glaze/core design system
renderer/lib/        shared frontend utilities (llm-prompts, etc.)
shared/              the ONE pure core both the app and the MCP import (.mjs + hand-written
                     .d.mts). Pure only: no fs, no @glaze/core, no IPC, no process
mcp/                 standalone MCP server exposing the test library to external MCP clients
                     (list_tests, get_test, list_runs, get_run_log, run_test, run_batch,
                      get_visual_report, get_a11y_report, get_run_logs, list_heals,
                      list_batches, compare_runs, capture_app, get_screenshot)
                     — see mcp/README.md
docs/                ARCHITECTURE.md (per-file map) + DECISIONS.md (dated rationale)
.github/             PR template, hygiene workflow, and the script it runs
glaze.ts             thin wrapper that resolves the Glaze CLI relative to this folder's SDK install
vitest.config.ts     test runner config (node + jsdom projects, @glaze/core aliasing)
*.test.ts(x)         Vitest tests, colocated with the code they cover
main/services/__tests__/  standalone check:* scripts + the @glaze/core/backend stub
renderer/__tests__/setup.ts  jsdom setup (browser-API stubs, sonner/toast stub)
```

## Commands

- `npm install --include=dev` — install deps (plain `npm install` under `NODE_ENV=production` prunes devDeps)
- `npm run lint` / `npm run type-check` / `npm run test:all` — must pass before considering a change done
- `npm run build` — runs the SDK's build pipeline (Vite + tsc). This only compiles; it does not package or launch the native app shell — that happens in the Glaze app (see "Making a change").
- `npm run dev` / `npm run dev:renderer` — dev servers
- `npm test` (Vitest, one pass) / `npm run test:watch` / `npm run test:coverage`
- `npm run test:checks` — the standalone `check:*` scripts; `npm run test:all` runs those **and** Vitest
- `npm run check:repo-hygiene` — repo-level checks (no generated files committed, no absolute paths, no secrets, lockfile in sync). This is the only part of the gate CI can run.

## Testing

**Two systems, one command.** `npm run test:all` = the standalone `check:*` scripts, then Vitest. Both must pass. 1463 Vitest tests and 30 checks as of 2026-08-07.

- **Vitest** (`vitest.config.ts`) has two projects. **`node`**: `main/**/*.test.ts`, `mcp/**/*.test.ts`, `renderer/lib/**/*.test.ts`. **`dom`** (jsdom): `renderer/**/*.test.tsx` plus `main/**/*.dom.test.ts` — that suffix is for BACKEND code needing a document (the injected replayer and Auto-Heal probe are evaluated for real). The node project explicitly excludes `*.dom.test.ts`; without that they match both globs and run again with no DOM, failing for unrelated reasons.
- **`check:*` scripts** predate Vitest and are kept, not migrated — they catch real bugs and a rewrite would risk that for tooling neatness. Plain assertions + a non-zero exit; no runner. Two are deliberately *source-level* (`check:ai-debug-scroll`, `check:scroll-layout`) because they guard layout contracts that jsdom cannot observe.
- **Adding a check?** Anything importing `@glaze/core/backend` must be bundled with esbuild + `--alias:@glaze/core/backend=./main/services/__tests__/glaze-backend-stub.ts`; pure logic can run under `tsx`. **Bundled checks do NOT type-check — `npm run type-check` is the real gate for them.**

### Conventions that matter

- **Touching the AI debug feature? Extend `renderer/main/ai-debug-icons.test.tsx`.** The status icon's colour (blue ready / orange thinking / green ready-for-review / red failed) is the whole contract of a minimized job, and a wrong colour is silent: the panel works perfectly while the icon lies, so the user walks away from a finished answer or waits on a dead one. Nothing else catches it — not lint, not type-check, not the panel's own tests. Cover every surface the change can reach (run panel, trainer step rows, global chip).

- **Verify a test can fail.** After writing a test that should catch a bug, revert the fix and confirm *that* test fails. Several tests in this repo were written against behaviour that turned out to differ from the assumption; the revert is what catches it.
- **Never guard an assertion with `if (thing)`** — it passes vacuously the day `thing` stops rendering.
- **Wait for content, not containers.** A view's table renders *before* its query resolves, so `findByRole("table")` succeeds against an empty body and reads as "no data". Wait for rows.
- Mock the `api` module, not the IPC bridge — tests then state intent rather than channel plumbing.

### Environment gotchas (all cost real debugging time)

- **jsdom has no layout engine.** `getBoundingClientRect()` returns zeros, so anything gated on element size behaves as if hidden — this silently turns "assert hidden" tests into tests that prove nothing. `step-replayer.dom.test.ts` installs a nominal box.
- `renderer/__tests__/setup.ts` stubs what jsdom lacks: `matchMedia`, `IntersectionObserver`, `ResizeObserver`, `scrollTo`/`scrollIntoView`. A missing one surfaces as a bare `ReferenceError` from inside the SDK bundle and reads like a component bug.
- **Radix `TabsTrigger` activates on pointer-down/focus, not a bare `click`** — `fireEvent.click` leaves the tab unchanged and assertions silently run against the previous tab.
- **`SidebarListItem` activates on `mouseDown`**, same idiom, same silent failure: `fireEvent.click` doesn't fire its `onClick`, and the assertion then reports "0 calls", which reads as a broken handler rather than the wrong event. Use `fireEvent.mouseDown`.
- **A fresh worktree needs `npm run bootstrap` before anything else.** Without it there is no `node_modules`, and the first `vitest` run CREATES an empty one for its own cache (`node_modules/.vite`) — which then makes `bootstrap` report "already present — nothing to do" and leaves you permanently broken. `vitest.config.ts` then points every React alias into a tree with no React, and every component test fails at import reading like a missing dependency; `type-check` degrades separately, reporting `Property 'children' does not exist` on SDK components across files you never touched. Fix: `rm -rf node_modules && npm run bootstrap`.
- **The SDK's `Select` is native-menu-backed**: its options never enter the DOM, so a selection cannot be driven in jsdom. Assert the displayed value and cover persistence at the IPC layer instead.
- An ambiguous `findBy*` (matching 2+ elements) retries until timeout, which reports as "never rendered" rather than "your query was ambiguous".
- This project targets **ES2020**: no `Array.prototype.at`.

## The capture boundary is a security boundary

The trainer loads **arbitrary untrusted websites**, and the injected capture script hands steps back through a **DOM attribute** (`data-pw-queue`) that the page can write itself. Steps are then compiled into a `.spec.ts` that Playwright **executes in Node**. So: page input → generated code → executed. An unchecked field on that path is remote code execution, and it already was one — a page setting `count` to a string got arbitrary Node code into the spec, because the generator interpolated numerics raw on the strength of their TypeScript type.

- **Everything crossing that boundary goes through `normalizeRawStep` / `normalizeStep` / `normalizePickedElement` in `main/recorder/types.ts`.** There are three page-JSON entry points in `recorder-service.ts` (step drain, refine-mode picked element, right-click pick-at-point) plus two IPC ones (`insertStep`, `tests:updateSteps`). A new one must normalize too.
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

## Hard constraints

- **Never edit or create files in `.glaze/`, `build/`, `node_modules/`, `@glaze/core`, or any `sdk/current/@glaze/core` path** — these are generated or protected; changes there are silently lost or break the build. Everything else in this repo is yours to maintain: application code in `main/`, `renderer/`, `mcp/`; config in `glaze.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts`; and repo-level files (`README.md`, `CLAUDE.md`, `docs/`, `.github/`, `.gitignore`, `.gitattributes`).
- `@glaze/core` resolves through this project's tsconfig path aliases and ESM loader hooks pointing at the Glaze SDK install — never `npm install @glaze/core`, and never run `glaze` as a global CLI install.
- **Forbidden imports** (cause runtime breakage): `backendNativeBridge`, `@glaze/core/backend/internal`, `GlazeIPCServer`, `GlazeLifecycle`, `registerNativeApiHandlers`, `wireProtocolHandlers`. Use the public `@glaze/core/backend` exports instead (`dialog`, `shell`, `clipboard`, `Notification`, `Menu`, `Tray`, …). Don't suppress `no-restricted-imports` for these — if an API genuinely isn't exported, it isn't available here.
- Don't install or configure Xcode, run `xcode-select --install`, or otherwise touch Xcode setup from this project.
- Never touch the Glaze-managed `.npmrc` under `~/Library/Application Support/app.glaze.macos.main*/` or the `NPM_CONFIG_USERCONFIG` env var. Don't set `min-release-age`, `before`, `allow-git`, `registry`, or `ignore-scripts` in a project-level `.npmrc` here. If `npm install` rejects a package version as "too new," pin an older version in `package.json` instead of weakening that policy.
- This folder must stay at its current path under `app.glaze.macos.main/apps/...` — `glaze.ts` and the tsconfig `@glaze/core/*` aliases resolve the SDK via paths relative to this location. Moving or copying it elsewhere breaks the build.

## SDK reference (for exact API signatures — don't guess from Electron docs)

- API reference index: `/Applications/Glaze.app/Contents/Resources/sdk/@glaze/core/GLAZE-SDK-API-REFERENCE/INDEX.md`
- Symbol map (JSON): `/Applications/Glaze.app/Contents/Resources/sdk/@glaze/core/GLAZE-SDK-API-REFERENCE/symbols.json`
- Symbol lines (ndjson, one symbol per line): `/Applications/Glaze.app/Contents/Resources/sdk/@glaze/core/GLAZE-SDK-API-REFERENCE/symbols.ndjson`

These are read-only.

## Making a change

Feature work happens on a branch and lands through a pull request. `main` is the integration branch.

```bash
git switch -c feat/step-reordering
```

Branch names: `feat/…`, `fix/…`, `chore/…`, `docs/…`.

**1. Write the change, and tests with it.** A suite nobody extends decays into one nobody trusts, and most bugs found in this codebase so far were silent — wrong behaviour that threw no error and looked fine on screen. See the Testing section for the conventions that matter, especially *verify a test can fail*.

**2. Run the full gate.** Nothing runs it for you; CI cannot (see below).

```bash
npm run lint && npm run type-check && npm run test:all && npm run build
```

**3. Verify in the Glaze app.** A terminal here cannot launch the native app or inspect the running UI — only the Glaze app can build the native shell, launch it, and preview it live. After any UI-affecting change, rebuild and launch there and confirm the change before calling it done. This is the step most easily skipped and the one that catches what tests cannot.

**4. Update the docs in the same commit.** If the change adds a service, moves a boundary, or invalidates something in `docs/ARCHITECTURE.md`, fix that entry. If it involved a real decision — a trade-off, a rejected alternative, a non-obvious constraint — add an entry to `docs/DECISIONS.md`. These were kept current automatically until 2026-08-06; they now stay accurate only if changes carry them.

**5. Open a pull request.** `.github/pull_request_template.md` carries the checklist, including the two security boundaries below.

### What CI does and does not do

`.github/workflows/repo-hygiene.yml` runs on every push and pull request, but it checks only repo hygiene — no generated files committed, no absolute paths, no secrets, lockfile in sync.

It **cannot** run lint, type-check, the test suite, or the build: `@glaze/core` resolves to the Glaze.app SDK install outside this repo, which does not exist on a hosted runner. That is why step 2 is a local gate rather than something a green checkmark can vouch for. A self-hosted macOS runner with Glaze installed is the only route to the real suite in CI.
