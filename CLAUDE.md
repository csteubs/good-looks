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

## Directory map

```
main/shell/         the Electron seam: backend adapter, logger, host IPC handlers,
                    the app:// protocol. THE ONLY PLACE THAT IMPORTS `electron`.
main/handlers/      IPC handler registration
main/services/      business logic (recorder, playwright-runner, llm, spec-parser, visual-pipeline)
main/services/llm/  local + hosted LLM chat integration (Ollama, LM Studio, Claude)
main/recorder/       recording-session logic (script injection, step capture)
main/windows/        BrowserWindow creation/config
renderer/main/       primary views (home, recording/trainer, script view, ai-debug-panel, stats)
renderer/settings/   settings window UI
renderer/ui/         the app's component library (Radix + Tailwind + cva). Replaces the
                     former SDK design system; same symbol names and prop contracts, so
                     consuming views were not rewritten. Select/DropdownMenu are still
                     backed by real macOS menus via Menu.popup.
renderer/components/ reusable UI composed from renderer/ui
renderer/lib/        shared frontend utilities (llm-prompts, host bridge types, etc.)
mcp/                 standalone MCP server exposing the test library to external MCP clients
                     (list_tests, get_test, list_runs, get_run_log, run_test, run_batch,
                      capture_app, get_screenshot)
                     — see mcp/README.md
docs/                ARCHITECTURE.md (per-file map) + DECISIONS.md (dated rationale)
.github/             PR template, hygiene workflow, and the script it runs
vite.config.ts       renderer build (three windows)
scripts/build-main.mjs   esbuild bundling for the main process + preload
eslint.config.js     lint config, incl. the `electron`-import boundary rule
vitest.config.ts     test runner config (node + jsdom projects)
*.test.ts(x)         Vitest tests, colocated with the code they cover
main/services/__tests__/  standalone check:* scripts + the @shell/backend stub
renderer/__tests__/setup.ts  jsdom setup (browser-API stubs, sonner/toast stub)
```

## Commands

- `npm install --include=dev` — install deps (plain `npm install` under `NODE_ENV=production` prunes devDeps)
- `npm run lint` / `npm run type-check` / `npm run test:all` — must pass before considering a change done
- `npm run build` — Vite (renderer) then esbuild (main + preload)
- `npm run package` — build, then electron-builder → `dist/mac-arm64/Good Looks!.app`
- `npm run dev` — Vite dev server + Electron, renderer hot-reloads
- `npm test` (Vitest, one pass) / `npm run test:watch` / `npm run test:coverage`
- `npm run test:checks` — the standalone `check:*` scripts; `npm run test:all` runs those **and** Vitest
- `npm run check:repo-hygiene` — repo-level checks (no generated files committed, no absolute paths, no secrets, lockfile in sync). This is the only part of the gate CI can run.

## Testing

**Two systems, one command.** `npm run test:all` = the standalone `check:*` scripts, then Vitest. Both must pass. 1029 Vitest tests and 27 checks as of 2026-08-06.

- **Vitest** (`vitest.config.ts`) has two projects. **`node`**: `main/**/*.test.ts`, `mcp/**/*.test.ts`, `renderer/lib/**/*.test.ts`. **`dom`** (jsdom): `renderer/**/*.test.tsx` plus `main/**/*.dom.test.ts` — that suffix is for BACKEND code needing a document (the injected replayer and Auto-Heal probe are evaluated for real). The node project explicitly excludes `*.dom.test.ts`; without that they match both globs and run again with no DOM, failing for unrelated reasons.
- **`check:*` scripts** predate Vitest and are kept, not migrated — they catch real bugs and a rewrite would risk that for tooling neatness. Plain assertions + a non-zero exit; no runner. Two are deliberately *source-level* (`check:ai-debug-scroll`, `check:scroll-layout`) because they guard layout contracts that jsdom cannot observe.
- **Adding a check?** Anything importing `@shell/backend` must be bundled with esbuild + `--alias:@shell/backend=./main/services/__tests__/glaze-backend-stub.ts --external:electron`; pure logic can run under `tsx`. **Bundled checks do NOT type-check — `npm run type-check` is the real gate for them.**

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

## An imported project is untrusted input too

Importing clones or reads a folder of someone else's Playwright code and copies the files an imported spec relative-imports, so it still runs once the checkout is gone. A relative specifier is text in a file the *importer* wrote, and `path.resolve` walks `..` as far as it's told — so the copy destination used to escape the scripts dir entirely, reaching an arbitrary absolute path. That fires on **import**, before any test is run, which is exactly when the user believes they're only looking.

- **Each imported test owns `scripts/imported/<id>/`.** Its spec and siblings keep their positions *relative to the project root*, so `../helpers/x.ts` resolves as it did in the original project without anything leaving that directory. Do not flatten an imported spec into the scripts dir — the old layout made escaping load-bearing, because a sibling one level up had to be written one level above the scripts dir for the spec's own `../` to find it.
- **Two boundaries in `copyRelativeImports`, both required:** `projectRoot` bounds what may be read, `destRoot` bounds what may be written. Keep the destination assert even when the paths are derived and "can't" escape.
- **Judge containment on real paths, both sides.** `statSync`/`copyFileSync` follow symlinks, so a repo shipping `helpers.js -> ~/.ssh/id_rsa` would copy that file's contents in. And realpath the ROOT too: on macOS `/var` is a link to `/private/var`, so comparing a resolved path against an unresolved root rejects every legitimate sibling.
- `testStore.writeScript` writes to the record's existing path when it's inside the scripts dir, so editing an imported spec doesn't move it away from its siblings; `remove` deletes the whole sandbox.
- Guarded by `check:import-sandbox`.

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

**The rest of the gate is now CI-able and wasn't before.** Removing the SDK removed the reason: `@glaze/core` used to resolve to a Glaze.app install outside the repo, which no hosted runner has. Every dependency now comes from `npm install`, so `lint`, `type-check`, `test:all` and `build` all run on a stock `macos-latest` runner. Wiring that up is a worthwhile follow-up; until it exists, step 2 is still a local gate.
