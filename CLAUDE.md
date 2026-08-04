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
                     (list_tests, get_test, list_runs, get_run_log, run_test) — see mcp/README.md
glaze.ts             thin wrapper that resolves the Glaze CLI relative to this folder's SDK install
```

## Commands

- `npm install --include=dev` — install deps (plain `npm install` under `NODE_ENV=production` prunes devDeps)
- `npm run lint` / `npm run type-check` — must pass before considering a change done
- `npm run build` — runs the SDK's build pipeline (Vite + tsc). This only compiles; it does not package or launch the native app shell — that step happens inside the Glaze app itself (see below).
- `npm run dev` / `npm run dev:renderer` — dev servers
- App-specific checks: `npm run check:spec-parser`, `npm run check:visual-pipeline`, `npm run check:ai-debug-scroll`

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

- After changing code, run `npm run lint && npm run type-check` (and `npm run build` to confirm the production build compiles) — same checks the Glaze app's own build step runs.
- This CLI can't launch the native app or visually inspect the running UI — only the Glaze app can build the native shell, launch it, and preview it live. After a UI-affecting change, open the Glaze app (or describe the change in its chat) to rebuild, launch, and verify it before treating the change as done.
- Commit your own changes normally (`git add` / `git commit`); the Glaze app commits its own changes the same way, so `git log` will show both interleaved. No remote is configured — this is a local-only repo.
