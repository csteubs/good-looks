# Good Looks!

A macOS desktop app that records interactions on any website — clicks, typing,
navigation, assertions — and generates runnable `@playwright/test` specs from
them. Point it at a URL, drive the site in the recorder window, and it produces
a spec you can run, edit, batch, and re-run against future builds.

Built on the **Glaze SDK**: a React 19 renderer in a macOS WebView, a Node
backend that reaches native host APIs, and a JSON-RPC bridge between them.

---

## ⚠️ This repo does not build from a bare clone

The app compiles against `@glaze/core`, which is **not an npm dependency**. It
resolves through relative paths to the Glaze SDK that ships inside the Glaze
desktop app:

```
apps/<app-name>/.glaze-sources/   ← this repo
                ../../../sdk/current/@glaze/core
```

Both `glaze.ts` and the `tsconfig.json` path aliases walk up three levels to
find it. Clone this repo somewhere else and `npm run build`, `lint`, and
`type-check` all fail with "CLI not found" — nothing is wrong with the code, the
SDK simply is not there.

**To work on this app you need it checked out at its Glaze-managed path:**

```
~/Library/Application Support/app.glaze.macos.main/apps/<app-id>/.glaze-sources
```

The practical consequence is that GitHub is used here for **history, branches,
and review** — not as a way to bootstrap the project on a machine that has no
Glaze install. See [CI](#ci) below.

---

## Setup

```bash
npm install --include=dev
```

`--include=dev` matters: a plain `npm install` under `NODE_ENV=production`
prunes the devDependencies that the test and lint pipeline needs.

Never run `npm install @glaze/core`, and never install the `glaze` CLI globally
— both shadow the SDK resolution described above.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server (backend + renderer) |
| `npm run dev:renderer` | Renderer dev server only |
| `npm run build` | Compiles via the SDK pipeline (Vite + tsc). Does **not** package or launch the native shell. |
| `npm run lint` | ESLint |
| `npm run type-check` | `tsc --noEmit` — the real gate for the bundled `check:*` scripts |
| `npm test` | Vitest, single pass |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Vitest with V8 coverage |
| `npm run test:checks` | The standalone `check:*` scripts |
| `npm run test:all` | `test:checks` **and** Vitest — the full suite |
| `npm run check:repo-hygiene` | Repo-level checks that CI also runs (see [CI](#ci)) |

Building the native shell, launching the app, and inspecting the running UI can
only be done from **the Glaze app itself**, not from a terminal here.

## Repo layout

```
main/handlers/       IPC handler registration
main/services/       business logic (recorder, playwright-runner, llm, spec-parser, visual-pipeline)
main/services/llm/   local + hosted LLM chat (Ollama, LM Studio, Claude)
main/recorder/       recording-session logic (script injection, step capture)
main/windows/        BrowserWindow creation/config
renderer/main/       primary views (home, recording/trainer, script view, ai-debug-panel, stats)
renderer/settings/   settings window UI
renderer/components/ reusable UI over the @glaze/core design system
renderer/lib/        shared frontend utilities
mcp/                 standalone MCP server exposing the test library (see mcp/README.md)
docs/                ARCHITECTURE.md (per-file map) + DECISIONS.md (dated rationale)
docs/plans/          historical design docs for larger features
.github/             PR template, hygiene workflow, and the script it runs
glaze.ts             resolves the Glaze CLI relative to this folder's SDK install
vitest.config.ts     test runner config (node + jsdom projects, @glaze/core aliasing)
```

Tests are colocated with the code they cover. `main/services/__tests__/` holds
the standalone `check:*` scripts and the `@glaze/core/backend` stub.

## Documentation

Five docs, each with a distinct job:

| Doc | What it is for |
| --- | --- |
| `README.md` | This file — setup, commands, workflow |
| [`CLAUDE.md`](CLAUDE.md) | Working rules: security boundaries, testing conventions, environment gotchas, hard constraints |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Per-file map of what exists and why — read before any non-trivial change |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Dated record of *why* each feature landed the way it did |
| [`docs/MCP-GUIDE.md`](docs/MCP-GUIDE.md) | User guide to driving the app from an AI assistant, and where the Linear/Slack/GitHub integrations fit |

All five are hand-maintained. `ARCHITECTURE.md` and `DECISIONS.md` were kept
current automatically until 2026-08-06; they stay accurate now only if changes
carry them, so update the relevant entry in the same commit.

### Design and research notes

Written 2026-08-08 from working notes, carried onto `main` 2026-08-14 from a
branch that never merged. Each one opens with a banner saying what has shipped
since, re-verified on the day it landed — read that first, because three of the
five have been overtaken to some degree.

| Doc | What it is for | State |
| --- | --- | --- |
| [`docs/IFRAMES.md`](docs/IFRAMES.md) | Interacting with iframes in the engine, ignoring them in the trainer | Unbuilt, accurate |
| [`docs/JAM-IMPORT.md`](docs/JAM-IMPORT.md) | Turning a jam.dev recording into a runnable test | Unbuilt, accurate |
| [`docs/LINEAR.md`](docs/LINEAR.md) | "Send to Linear" on an a11y violation, and what leaves the Mac | **Shipped** — see `main/services/issue-tracker/` |
| [`docs/TRAINING-CONTEXT.md`](docs/TRAINING-CONTEXT.md) | Explaining a failure to the model: user prose, screenshots, HTML state | Half shipped |
| [`docs/VISUAL-TUNING.md`](docs/VISUAL-TUNING.md) | Why visual diffs feel flaky, and why tuning is not the fix | **Open** — its main recommendation is still unbuilt |

## Branch workflow

`main` is the integration branch. Feature work happens on a branch and lands
through a pull request.

```bash
git switch -c feat/step-reordering
```

Branch naming: `feat/…`, `fix/…`, `chore/…`, `docs/…`.

Before you push, run the full local gate — CI cannot run it for you:

```bash
npm run lint && npm run type-check && npm run test:all && npm run build
```

Then push and open a PR:

```bash
git push -u origin feat/step-reordering
gh pr create --fill
```

Keep branches short-lived and rebase on `main` rather than merging it back in,
so history stays linear and easy to bisect.

### Verifying in the Glaze app

The Glaze app is the **build and launch host**. A terminal here compiles the
code, but only the Glaze app can package the native shell, run it, and show you
the UI — so after any UI-affecting change, rebuild and launch there and confirm
the change before calling it done.

Whatever branch is checked out in this folder is the branch the Glaze app builds,
so check out your feature branch before verifying it.

## Testing

Two systems, one command: `npm run test:all` runs the `check:*` scripts and then
Vitest. Both must pass. Currently 26 checks and 737 Vitest tests.

Vitest has two projects. **`node`** covers `main/**/*.test.ts`,
`mcp/**/*.test.ts`, and `renderer/lib/**/*.test.ts`. **`dom`** (jsdom) covers
`renderer/**/*.test.tsx` plus `main/**/*.dom.test.ts` — that suffix is for
*backend* code that genuinely needs a document, such as the injected replayer
and the Auto-Heal probe.

The `check:*` scripts predate Vitest and are deliberately kept: plain assertions
and a non-zero exit, no runner. Several of them are source-level
(`check:ai-debug-scroll`, `check:scroll-layout`, `check:narrow-layout`,
`check:clickable-chrome`, `check:dialog-footer`) because they guard layout
contracts that jsdom cannot observe at all — occlusion and overflow both render
as zeros there, so the test that looks like the right one passes either way.
The real measurements live in `e2e/`, against the running app.

New features ship with tests. Most bugs found in this codebase so far have been
silent — wrong behaviour that threw no error and looked correct on screen.

`CLAUDE.md` documents the security boundaries (untrusted page input on the path
to generated-and-executed code; imported projects as untrusted input) and the
environment gotchas that have each cost real debugging time. Read it before any
non-trivial change.

## CI

`.github/workflows/repo-hygiene.yml` runs on every push and pull request. It
checks only what is verifiable **without** the Glaze SDK:

- no generated or scratch output committed (`coverage/`, `test-results/`, `.glaze-tool-output/`, `node_modules/`)
- no absolute `/Users/...` paths in tracked files
- no obvious secret material
- `package.json` and `package-lock.json` in sync

Lint, type-check, build, and the test suite **cannot** run on a hosted GitHub
runner, because `@glaze/core` lives outside the repo in the Glaze.app install.
Those remain a local pre-push gate — the pull request template repeats the
command.

If you later want the real suite in CI, the only route is a self-hosted macOS
runner with Glaze installed.
