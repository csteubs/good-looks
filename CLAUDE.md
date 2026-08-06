# CLAUDE.md

Handoff doc for working on **Good Looks!** (a Playwright test recorder) outside the Glaze app, e.g. from Claude Code CLI run directly in this folder. This app is also actively developed through the Glaze app itself (a separate agent with its own build/launch/live-preview tooling) — both work against the same git history, so read the "Working alongside the Glaze app" section below before making changes.

## What this app does

Records interactions on any website (clicks, typing, navigation, assertions) and generates runnable `@playwright/test` specs from them. Full feature history and architecture decisions live in `.glaze_memory/PROJECT-CONTEXT.md` (gitignored, but present on disk) — **read it before any non-trivial change**, it's the canonical source of truth for what's already built and why.

## Architecture

- **Frontend** (React 19 + Vite, `renderer/`) renders in a macOS WebView.
- **Backend** (Node.js, `main/`) calls native Swift host APIs through the Glaze SDK.
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
mcp/                 standalone MCP server exposing the test library to external MCP clients
                     (list_tests, get_test, list_runs, get_run_log, run_test, run_batch,
                      capture_app, get_screenshot)
                     — see mcp/README.md
glaze.ts             thin wrapper that resolves the Glaze CLI relative to this folder's SDK install
vitest.config.ts     test runner config (node + jsdom projects, @glaze/core aliasing)
*.test.ts(x)         Vitest tests, colocated with the code they cover
main/services/__tests__/  standalone check:* scripts + the @glaze/core/backend stub
renderer/__tests__/setup.ts  jsdom setup (browser-API stubs, sonner/toast stub)
```

## Commands

- `npm install --include=dev` — install deps (plain `npm install` under `NODE_ENV=production` prunes devDeps)
- `npm run lint` / `npm run type-check` / `npm run test:all` — must pass before considering a change done
- `npm run build` — runs the SDK's build pipeline (Vite + tsc). This only compiles; it does not package or launch the native app shell — that step happens inside the Glaze app itself (see below).
- `npm run dev` / `npm run dev:renderer` — dev servers
- `npm test` (Vitest, one pass) / `npm run test:watch` / `npm run test:coverage`
- `npm run test:checks` — the standalone `check:*` scripts; `npm run test:all` runs those **and** Vitest

## Testing

**Two systems, one command.** `npm run test:all` = the standalone `check:*` scripts, then Vitest. Both must pass. Roughly 330 Vitest tests and 16 checks today.

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

## Hard constraints

- **Edit only** inside `main/`, `renderer/`, `mcp/`, `glaze.ts`, `package.json`, `tsconfig.json`. Never edit or create files in `.glaze/`, `build/`, `node_modules/`, `@glaze/core`, or any `sdk/current/@glaze/core` path — these are generated or protected; changes there are silently lost or break the build.
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

## Working alongside the Glaze app

- After changing code, run `npm run lint && npm run type-check && npm run test:all` (and `npm run build` to confirm the production build compiles). Lint/type-check/build are what the Glaze app's own build step runs; `test:all` is this project's own suite and will NOT be run for you — see the Testing section.
- Adding a feature? Add tests with it. A suite nobody extends decays into one nobody trusts, and most of the bugs found in this codebase so far were silent — wrong behaviour that threw no error and looked fine on screen.
- This CLI can't launch the native app or visually inspect the running UI — only the Glaze app can build the native shell, launch it, and preview it live. After a UI-affecting change, open the Glaze app (or describe the change in its chat) to rebuild, launch, and verify it before treating the change as done.
- Commit your own changes normally (`git add` / `git commit`); the Glaze app commits its own changes the same way, so `git log` will show both interleaved. No remote is configured — this is a local-only repo.
