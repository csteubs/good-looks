# Good Looks!

A macOS desktop app that records interactions on any website — clicks, typing,
navigation, assertions — and generates runnable `@playwright/test` specs from
them. Point it at a URL, drive the site in the recorder window, and it produces
a spec you can run, edit, batch, and re-run against future builds.

Those tests do not need the app to run them. A `good-looks` command line ships
inside the app, and a GitHub Action wraps it, so the same recorded tests run on
a build server and report on the CLI's exit code — see [Running tests without
the app](#running-tests-without-the-app).

A standalone **Electron** app: a React 19 renderer served over a custom `app://`
scheme, a Node.js main process, and Electron IPC between them. It builds, runs,
tests and packages entirely from this folder with `npm` — no external SDK, and
no requirement that the folder live at a particular path.

> **This app was ported off the Glaze SDK.** It used to compile against
> `@glaze/core`, resolved through relative paths into a Glaze.app install
> outside the repo; that is gone, and every dependency now comes from
> `npm install`. Two Glaze names survive deliberately and are not leftovers to
> clean up: the preload global is `window.glazeAPI` (every view, page-world
> helper and test stub addresses it), and the AI debug panel's log-request
> fence is tagged `glaze-request` (a wire format the model emits).
> [`PORTING.md`](PORTING.md) records what the migration changed and why — read
> it before assuming anything about the shell layer, the component library, or
> the build.

---

## Setup

```bash
npm install --include=dev
```

Node 20 or newer. `--include=dev` matters: a plain `npm install` under
`NODE_ENV=production` prunes the devDependencies that the lint, test and build
pipeline needs.

**In a git worktree, run `npm run bootstrap` before anything else.** It
symlinks the main checkout's `node_modules` when the lockfiles match, which
takes a second instead of a multi-minute install. Run it *first*: the first
`vitest` run in a worktree creates an empty `node_modules` for its own cache,
after which `bootstrap` reports "already present — nothing to do" and leaves
every React alias pointing into a tree with no React. If that has happened,
`rm -rf node_modules && npm run bootstrap`.

**`npm run package` needs a real install, not the symlink.** electron-builder
reads `node_modules` itself and through a symlink finds the direct dependencies
and nothing below them — then exits 0 with an incomplete bundle. `npm run
package` refuses up front and re-checks the finished bundle, but the fix is
`rm node_modules && npm install --include=dev`.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server + Electron, renderer hot-reloads |
| `npm run dev:web` | **The browser preview** — the whole renderer in an ordinary tab at `http://localhost:5199`, against fixtures, with no native shell |
| `npm start` | Launches the already-built app (`electron .`) |
| `npm run build` | Vite (renderer) then esbuild (main + preload) |
| `npm run build:preview` | Static preview bundle → `build-preview/` |
| `npm run package` | Build, then electron-builder → `dist/mac-arm64/Good Looks!.app` |
| `npm run lint` | ESLint, including the `electron`-import boundary rule |
| `npm run type-check` | `tsc --noEmit` — the real gate for the bundled `check:*` scripts |
| `npm test` | Vitest, single pass |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Vitest with V8 coverage |
| `npm run test:checks` | The standalone `check:*` scripts |
| `npm run test:all` | `test:checks` **and** Vitest — the full suite |
| `npm run test:e2e` | Playwright driving the real app through `_electron` |
| `npm run check:repo-hygiene` | Repo-level checks (see [CI](#ci)) |

`npm run dev:web` is the fastest way to see a UI change and the only one an
agent can drive. Open a view directly with `?view=stats|visual|batch|heals`,
`?test=<id>`, `?view=settings` (add `&pane=cost` for one section),
`?view=recorder`, or `?view=specimen` (every redesign primitive in every state).
It does not replace running the real app: a preview has no backend, so it cannot
catch a broken IPC handler, a window that fails to open, or native menu
behaviour.

## Running tests without the app

The app records tests; it is not the only thing that can run them. Three entry
points read the same library:

| Entry point | What it is for |
| --- | --- |
| The app | Recording, watching a run, accepting baselines, everything that edits |
| `good-looks` (CLI) | Build servers and terminals. Exits 0/1/2/3 on the result |
| The MCP server | Driving the library from an AI assistant |

The CLI lives at `bin/good-looks.mjs`, decides nothing itself (`cli/` holds the
rules so they can be tested), and ships inside the packaged app alongside the
MCP server:

```bash
good-looks run --tag smoke --browser firefox --parallel 2 --junit results.xml
```

Exactly one selector — `--id`, `--tag`, `--group` or `--all` — and no default,
because a command that runs the whole library when a flag is misspelt is worse
than one that refuses. Exit code 2 means the selector matched nothing, which is
otherwise indistinguishable from a clean pass.

[`action.yml`](action.yml) wraps the same CLI as a composite GitHub Action, and
`good-looks ingest` carries a CI job's runs back into the local library so
Stability, the flake verdict and step health count them.

Unattended runs are not lesser runs: screenshots, accessibility checks, console
and network recording, Auto-Heal, page-settling and standing overlay rules all
apply, each following the setting the test already carries. What cannot cross
the boundary is anything encrypted to the app — secret variables, the Shopify
crawler signature, a proxy password — and a run says which of those it went
without.

Full detail: [`docs/CI-GUIDE.md`](docs/CI-GUIDE.md) (also the app's in-app
manual) and [`docs/GITHUB-ACTION.md`](docs/GITHUB-ACTION.md).

## Repo layout

```
main/shell/          the Electron seam: backend adapter, logger, host IPC, the app://
                     protocol. THE ONLY PLACE THAT IMPORTS `electron`
main/handlers/       IPC handler registration
main/services/       business logic (recorder, playwright-runner, spec-parser,
                     visual-pipeline, metrics-store, issue-tracker)
main/services/insights/    the scheduled AI report — the app's only unattended LLM egress
main/services/ts-service/  the Script IDE's TypeScript language service, in a utilityProcess
main/services/llm/   local + hosted LLM chat (Ollama, LM Studio, Claude), and the
                     two halves of standing overlay rules
main/recorder/       recording-session logic (script injection, step capture)
main/windows/        BrowserWindow creation/config
renderer/main/       primary views (home, recording/trainer, script view, ai-debug-panel, stats)
renderer/settings/   the Settings SCREENS (panes/, one per rail row). Routes in the main
                     window, not a separate window — it stopped being one on 2026-08-24
renderer/trainer/    the trainer window's own panel
renderer/recorder-chrome/  the training browser's read-only URL bar
renderer/ui/         the app's component library (Radix + Tailwind + cva)
renderer/components/ reusable UI composed from renderer/ui
renderer/theme/      the indie redesign's token and treatment layer (--gl-* tokens,
                     primitives/, shell/, screens.css)
renderer/lib/        shared frontend utilities
renderer/dev/        the browser preview's fake backend — never shipped
shared/              the one pure core the app, the MCP server and the CLI all import
                     (.mjs + hand-written .d.mts). No fs, no IPC, no process. The run
                     fixtures live here, which is what lets a CI runner heal and settle
bin/                 the `good-looks` CLI entry point — argv in, exit code out
cli/                 what the CLI decides, kept out of bin/ so it can be tested
mcp/                 standalone MCP server exposing the test library (see mcp/README.md)
workers/mailbox/     the catch-all inbox behind the `emailCode` step (Cloudflare)
e2e/                 Playwright specs driving the real app through `_electron`
scripts/             build-main, dev harness, package verification, branch switcher
docs/                ARCHITECTURE.md, DECISIONS.md, the two in-app manuals, and the notes below
.github/             PR template, workflows, and the scripts they run
action.yml           the `good-looks` GitHub Action — a composite action over the CLI
vite.config.ts       renderer build (two windows + the training browser's URL strip);
                     `--mode preview` builds the browser preview instead
vitest.config.ts     test runner config (node + jsdom projects)
```

Tests are colocated with the code they cover. `main/services/__tests__/` holds
the standalone `check:*` scripts and `shell-backend-stub.ts`, the stub that
`@shell/backend` resolves to under test. The CLI's own unit tests live there
too, because a test file under `cli/` would match neither Vitest project.

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the per-file map;
[`CLAUDE.md`](CLAUDE.md) carries the fuller annotated version of the tree above.

## Documentation

| Doc | What it is for |
| --- | --- |
| `README.md` | This file — setup, commands, workflow |
| [`CLAUDE.md`](CLAUDE.md) | Working rules: security boundaries, testing conventions, environment gotchas, hard constraints |
| [`PORTING.md`](PORTING.md) | What the migration off the Glaze SDK changed, and why |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Per-file map of what exists and why — read before any non-trivial change |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Dated record of *why* each feature landed the way it did |
| [`docs/MCP-GUIDE.md`](docs/MCP-GUIDE.md) | Driving the app from an AI assistant, and where the Linear/GitHub/Slack integrations fit |
| [`docs/CI-GUIDE.md`](docs/CI-GUIDE.md) | Running recorded tests from the CLI and from GitHub Actions |
| [`docs/GITHUB-ACTION.md`](docs/GITHUB-ACTION.md) | The Action's full input/output reference |

All are hand-maintained. `ARCHITECTURE.md` and `DECISIONS.md` were kept current
automatically until 2026-08-06; they stay accurate now only if changes carry
them, so update the relevant entry in the same commit.

**Two of these are also the app's in-app manual.** Settings → Documentation
renders `docs/MCP-GUIDE.md` and `docs/CI-GUIDE.md`, and the Help menu deep-links
their sections. `renderer/lib/doc-blocks.ts` parses a subset of markdown and
throws on the rest; `check:docs-blocks` runs it in the gate, so a construct the
pane cannot draw is a red build rather than a section that renders as nothing.
Edit them as prose, but expect the gate to refuse an ordered list or a nested
bullet — and note that topic slugs must stay unique **across** both files, since
a slug names a topic rather than a document plus a topic.

Two subdirectories differ in kind. [`docs/plans/`](docs/plans/) is a historical
record of intent — design documents written before larger features, kept for
what was scoped and deliberately left out, not as a description of the code.
[`docs/issue-audit/`](docs/issue-audit/) is **generated**, rewritten by the
`issue-audit` skill; the newest `AUDIT-<date>.md` there is meant to be current.

### Design, research and status notes

Each opens with a banner saying what has shipped since, re-verified on the day
it landed — read that first.

| Doc | What it is for | State |
| --- | --- | --- |
| [`docs/REDESIGN.md`](docs/REDESIGN.md) | The indie redesign's implementation plan | **Phases A, B and C complete** — B8, the last one open, landed 2026-08-17 |
| [`docs/ROUTINES.md`](docs/ROUTINES.md) | Batch v2: Routines as a first-class entity | Capabilities 1 and 2 **built** (2026-08-13); the rest is still design |
| [`docs/QA-KNOWN-GAPS.md`](docs/QA-KNOWN-GAPS.md) | What was already known going into the 2026-08-12 QA pass | Reference — do not file these as bugs |
| [`docs/IFRAMES.md`](docs/IFRAMES.md) | Interacting with iframes in the engine, ignoring them in the trainer | **Engine shipped 2026-08-22** — a framed step is writable and runnable. Trainer capture inside a frame is still unbuilt |
| [`docs/JAM-IMPORT.md`](docs/JAM-IMPORT.md) | Turning a jam.dev recording into a runnable test | Unbuilt, accurate |
| [`docs/LINEAR.md`](docs/LINEAR.md) | "Send to Linear" on an a11y violation, and what leaves the Mac | **Shipped** — and since 2026-08-14 the tracker is selectable (Linear or GitHub) in Settings → Integrations; see `main/services/issue-tracker/` |
| [`docs/TRAINING-CONTEXT.md`](docs/TRAINING-CONTEXT.md) | Explaining a failure to the model: user prose, screenshots, HTML state | **Half shipped** — user prose and `capture_app`/`get_screenshot` exist; screenshot annotation and preserved HTML state do not |
| [`docs/VISUAL-TUNING.md`](docs/VISUAL-TUNING.md) | Why visual diffs feel flaky, and why tuning is not the fix | **Open** — its main recommendation (disable animations at capture) is still unbuilt |

## Branch workflow

`main` is the integration branch. Feature work happens on a branch and lands
through a pull request.

```bash
git switch -c feat/step-reordering
```

Branch naming: `feat/…`, `fix/…`, `chore/…`, `docs/…`.

Run the full local gate before you push. CI runs it too now, but this is the
fast feedback loop:

```bash
npm run lint && npm run type-check && npm run test:all && npm run build
```

Then push and open a PR:

```bash
git push -u origin feat/step-reordering
gh pr create --fill
```

`.github/pull_request_template.md` carries the checklist, including the two
security boundaries documented in `CLAUDE.md`. Keep branches short-lived and
rebase on `main` rather than merging it back in, so history stays linear and
easy to bisect.

### Verifying in the app

After any UI-affecting change, look at it before calling it done — this is the
step most easily skipped and the one that catches what tests cannot.

- `npm run dev:web` for the renderer alone, in a browser tab, on fixtures.
- `npm run dev` for the real app with a hot-reloading renderer.
- `npm run package` for the real bundle.

A renderer that throws during mount shows a blank window and a *clean* main
log, so check the log too: renderer errors and warnings are forwarded there by
`forwardRendererConsole`.

## Testing

**Two systems, one command.** `npm run test:all` runs the `check:*` scripts and
then Vitest. Both must pass. 6067 Vitest tests across 334 files and 93 checks in
the chain as of 2026-08-26 (95 are defined — `check:repo-hygiene` and
`check:shell-drift` are deliberately outside it).

Vitest has two projects. **`node`** covers `main/**/*.test.ts`,
`mcp/**/*.test.ts` and `renderer/lib/**/*.test.ts`. **`dom`** (jsdom) covers
`renderer/**/*.test.tsx`, `renderer/dev/**/*.test.ts` and
`main/**/*.dom.test.ts` — that suffix is for *backend* code that genuinely
needs a document, such as the injected replayer and the Auto-Heal probe. A
`.ts` test under `renderer/` outside `lib/` or `dev/` matches neither project
and is silently never run.

The `check:*` scripts predate Vitest and are deliberately kept: plain
assertions and a non-zero exit, no runner. Six are *source-level*
(`check:ai-debug-scroll`, `check:scroll-layout`, `check:narrow-layout`,
`check:clickable-chrome`, `check:dialog-footer`, `check:drift-gap`) because
they guard layout contracts jsdom cannot observe — occlusion, which it cannot
see at all, and overflow, which it renders as zeros in both the fixed and the
broken case. Two others **boot what they test** rather than reading it:
`check:mcp-boot` speaks stdio JSON-RPC to a real server process, and
`check:cli-exit` spawns the CLI and reads its exit code through a pipe. Both
exist because every other `check:mcp-*` read source and stayed green for the six
months the MCP server threw at module load.

**A third system the local gate does not run: `e2e/`.** Twenty-five Playwright
specs driving the real app through `_electron` (`npm run test:e2e`, and CI's
`gate.yml`). It is where anything about real windows gets checked — a click
that changes route, a second window actually opening, occlusion, where the
trainer panel physically lands, dialog footer layout, window titles, UI scale,
the forked TypeScript service. jsdom has no second window and no layout engine,
so these are not slow duplicates of unit tests; they are the only place their
subject exists.

Six specs there are not about windows at all, and each answers a question only
real Playwright can settle:

| Spec | The question |
| --- | --- |
| `assert-parity.spec.ts` | What a step *means* — the injected replayer and the generated source must agree |
| `context-parity.spec.ts` | Which element a step points *at* |
| `shadow-parity.spec.ts` | The same, one level down, inside a web component |
| `frame-parity.spec.ts` | Whether an emitted `frameLocator` chain resolves what the recorder meant |
| `step-progress.spec.ts` | Which steps a run *reports*, which decides what the app can highlight |
| `retry-evidence.spec.ts` | Whether a retry re-enters the `page` fixture, and what Playwright names a retried attempt's scratch directory |

Changing what an assertion, a context clause, a shadow-DOM walk, a frame
reference or the step reporter emits, or where an attempt's artifacts go? Add a
row.

New features ship with tests. Most bugs found in this codebase so far have been
silent — wrong behaviour that threw no error and looked correct on screen.
[`CLAUDE.md`](CLAUDE.md) documents the security boundaries (untrusted page
input on the path to generated-and-executed code; imported projects and branch
names as untrusted input) and the environment gotchas that have each cost real
debugging time. Read it before any non-trivial change.

## CI

Two workflows on every pull request and on pushes to `main`, plus a self-test
for the Action.

**`.github/workflows/gate.yml`** runs the real gate on hosted runners — `lint`,
`type-check`, `test:all` and `build`, plus the Playwright e2e suite under
`xvfb`, the browser-preview build, an `electron-builder` package with
`verify:package` over the result, and the shell-drift check. That last one is
dormant by design: it guarded the Glaze tree and the Electron tree against
drifting apart, and with no counterpart branch left it prints `nothing to
compare` and exits 0 rather than going red because its problem was solved.

The gate could not run at all before the port: `@glaze/core` resolved to an SDK
install outside the repo that no hosted runner has, so every one of these
commands failed there for reasons unrelated to the change under review, and the
merge gate was a checkbox in the pull request template instead.

Every job runs on `ubuntu-latest` — macOS runner minutes bill at roughly ten
times the Linux rate, and nothing in the suite is platform-specific. So CI
packages `--linux dir` where `npm run package` builds the `.app`. **What CI
therefore does not prove: that the app packages as a mac app, and that `npm run
build` works on macOS.** Both are on you locally, and so is looking at the app:
CI cannot tell you a UI change came out wrong.

**`.github/workflows/repo-hygiene.yml`** is the cheap one — no install, node
builtins and git only:

- no generated or scratch output committed (`coverage/`, `test-results/`, `.glaze-tool-output/`, `node_modules/`)
- no absolute `/Users/...` paths in tracked files
- no obvious secret material
- `package.json` and `package-lock.json` in sync

**`.github/workflows/action-selftest.yml`** drives `action.yml` the way a
stranger would (`uses: ./`) against a library built from nothing — the one
configuration no local check can stand up.
