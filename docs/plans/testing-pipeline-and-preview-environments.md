# Testing pipeline, preview environments, and the Electron convergence

Written 2026-08-07, against `main` at `014c226`.

Goal: make a change testable in seconds rather than minutes, let an agent
exercise the real app before a merge, and stop serialising every branch behind
one native build slot.

---

## 1. What was measured, not assumed

The full local gate, run on this machine against `main`:

| Step | Time |
|---|---|
| `npm run lint` | 3.6s |
| `npm run type-check` | 4.0s |
| `npm run test:checks` (28 checks) | 7.6s |
| `npm test` (1105 tests, 57 files) | 15.8s |
| `npm run build` | 4.9s |
| **Total** | **~36s** |

**The automated gate is not the expensive part.** Thirty-six seconds is fine.
Whatever makes this process onerous is somewhere else, and it is worth being
precise about where, because optimising the test suite would buy nothing.

(Aside: `CLAUDE.md` says "1029 Vitest tests and 27 checks as of 2026-08-06".
Actual today is 1105 tests and 28 checks in the `test:checks` chain, 29 defined.
Worth correcting when this lands.)

## 2. The four real bottlenecks

### 2.1 The build target is one global slot — this is the big one

`npm run build` ends with:

```
[glaze] Publishing staged build: .build -> ../.glaze/build
[glaze] Synced runtime manifest: ../.glaze/package.json
```

`../.glaze/build` is **outside the repo**, one directory up from
`.glaze-sources`. Every branch, every worktree, and `main` all publish into the
same slot. Only one branch can be "the app" at any moment.

The git history already shows the cost. Two commits exist whose entire purpose
is to claim that slot:

- `014c226` — *"Build this branch: claude/browser-icon-display-bugs-987f45"*
- `ff2efa0` — *"I made some changes behind the scenes with another AI agent. Build the latest version of the app."*

**Git history is being used as a build-slot mutex.** That is the tell. Two
agents on two branches cannot both have a testable app; a build commit has to
land to hand the slot over, which pollutes history and serialises everything
behind a resource there is exactly one of. Every other symptom in this document
descends from this one.

### 2.2 Worktrees cannot run the gate at all

Confirmed directly: this worktree
(`.claude/worktrees/testing-pipeline-optimization-0dfc4b`) has **no
`node_modules`**. Every measurement above had to be run from the main sources
directory instead.

So a parallel agent working in a worktree either burns minutes on a full
`npm install`, or ships without running lint, type-check, or a single test. In
practice that means the branches most likely to need the gate are the ones least
likely to have run it.

### 2.3 CI runs almost nothing

`.github/workflows/repo-hygiene.yml` checks tracked-file hygiene and stops —
correctly, because `@glaze/core` resolves to `/Applications/Glaze.app/...`,
which does not exist on a hosted runner. Lint, type-check, tests, and build
cannot run there.

The merge gate is therefore **a checkbox in a PR template on the honour
system**. Nothing mechanical stops a red branch from merging.

### 2.4 Seeing the UI needs a human at the Glaze app

The PR template says it plainly: *"The Glaze app is the only thing that can build
the native shell and show the UI, so this cannot be delegated to a test or a CI
run."* Every UI-affecting change costs a context switch, a native rebuild, a
launch, and a manual click-through — by a person, one branch at a time.

---

## 3. Two findings that make this tractable

### 3.1 The renderer is one shim away from running in a plain browser

I served the renderer over HTTP (`npm run dev:renderer`, port 4143) and loaded
`main-window.html` in a real browser. Results:

- The HTML and `__APP_DISPLAY_NAME__` define work — the tab titled itself
  "Good Looks!".
- **40+ renderer modules served 200 OK** — `root-view`, `library-sidebar`,
  `recording-view`, `ai-debug-panel`, `edit-steps-view`, `stats-view`,
  `batch-view`, the whole graph.
- React did not mount, for exactly two reasons:
  1. `window.glazeAPI` is `undefined` — no preload runs in a browser.
  2. The SDK's `components.js` returns **500**: it imports `sonner`, which is
     not installed in this tree. (The Electron tree already carries `sonner` as
     a direct dependency; the Glaze tree relies on the SDK having it, and it
     doesn't resolve.)

Neither is architectural. And the surface to fake is small and already mapped:

- **15 files, 36 references** to `glazeAPI` in the entire renderer.
- Nearly all data flow funnels through **one chokepoint** —
  `renderer/lib/api.ts` → `ipc()` → `window.glazeAPI.glaze.ipc`, with just
  `invoke(channel, ...args)` and `on(channel, cb)`.
- The rest is `clipboard.writeText`, `Menu.popup`, `shell.showItemInFolder`,
  and `nativeTheme` — a handful of call sites.
- `renderer/__tests__/setup.ts` **already implements a working stub of this
  shape** for jsdom. The browser bridge is that stub with real fixtures behind
  it.

### 3.2 The Electron port is the CI substrate, and the drift is tiny

`/Users/chris/Code/good-looks-electron` is a complete de-Glazed tree: stock
Electron + Vite + esbuild, no SDK outside `node_modules`, no path requirement,
`npm run package` → a runnable `.app`. Per `PORTING.md`, lint, type-check,
`test:all` (890 tests, 26 checks) and build all pass on it.

**It runs on a hosted runner. The Glaze tree cannot.** That is the whole game.

Comparing the two trees file by file:

| | Count |
|---|---|
| Shared paths | 206 |
| Byte-identical | 101 |
| Differ **only** by import specifier (`@glaze/core/backend`→`@shell/backend`, `@glaze/core/components`→`@ui`) | 47 |
| Real content difference | 58 |

**148 of 206 shared files (72%) are already identical or a one-line rename.**
The "port" is mostly an import swap plus a `main/shell/` directory.

And the 58 real differences are dominated by known, enumerable feature drift.

**The port was cut from `a61598c` (PR #4, 2026-08-06 15:55)** — established by
replaying every candidate commit and comparing all 199 shared source files
against the Electron tree, modulo the import-specifier rename:

| Candidate | Files matching |
|---|---|
| `main` (`014c226`) | 135 / 199 |
| `e6e59cc` (PR #9) | 160 / 199 |
| **`a61598c` (PR #4)** | **181 / 199** |
| `a650d70` (PR #5) | 168 / 194 |

A first pass at this guessed `e6e59cc` from file timestamps and the DECISIONS
entry. That was wrong by about two hours of work, and it matters: branching
from the wrong base makes `git diff main..shell/electron` show the port *plus*
whatever landed in between, and turns cherry-picks into conflicts.

Missing since `a61598c`:

| Commit | Feature |
|---|---|
| `8ab934d` | Glow the steps an AI change added |
| `e73e0a2` | Delete a tag library-wide (`test-store.removeTag`) |
| `0ec4efe` | `.claude/launch.json` for the renderer dev server |
| `577258c` | Real design-system tokens for invented Tailwind names |
| `ff2efa0` | ESLint config additions |
| `7ef708e` | Window resize as a real test step |
| `43e366b` | Conditional waits ("Wait until") |
| `596f388` | Never let a trainer replay record itself |
| `47905d5` | Per-test timeout setting |
| `0c86651` | Model selector on generate |
| `004cfed` | Browser engine as an icon |
| `014c226` | Browser-icon display fixes |

**Twelve commits.** Note that the two whose messages read as build publishes
(`ff2efa0`, `014c226`) carry real source changes — they are not skippable.

**The Electron tree is not a git repository.** It is loose files on disk. It
cannot receive a PR, cannot be diffed against `main`, and has no history. This
is the highest-risk item in this document and the cheapest to fix.

---

## 4. Strategy: one source tree, two shells

The Electron port already found the right seam — app code imports
`@shell/backend`, never `electron`, enforced by an ESLint rule. The same seam
works for Glaze: `@shell/backend` can re-export from `@glaze/core/backend`
instead, chosen at build time.

**End state: one repo, one source tree, two shell adapters.**

```
main/shell/
  backend.ts          re-exports from the active shell
  electron/           app, BrowserWindow, Menu, dialog, logger, app-protocol…
  glaze/              same surface, backed by @glaze/core/backend
renderer/ui/          the component library (already shell-agnostic)
renderer/dev/
  fake-bridge.ts      window.glazeAPI over fixtures, for browser mode
```

Consequences that matter here:

- Every feature is written **once**. The sync problem stops existing rather than
  getting a process wrapped around it.
- CI runs the **full** gate on the Electron shell, on a hosted runner.
- Preview environments become possible, because the Electron build has no global
  slot and no Glaze dependency.
- Glaze stays a first-class shell for anyone who wants the native app — nothing
  is thrown away.

The 72% figure above is what makes this a merge rather than a rewrite.

---

## 5. Phased implementation

Ordered so each phase is independently useful and the riskiest work comes last.

### Phase 0 — Stop the bleeding (half a day)

1. **`git init` the Electron tree and push it as a branch of `csteubs/good-looks`.**
   Not a subdirectory — a **branch**, `shell/electron`. Because it shares file
   paths with `main`, git's own tooling then does the sync work:
   `git diff main..shell/electron` *is* the port, and catching up is
   `git cherry-pick`. As a directory it would be a second copy to hand-maintain,
   which is the problem, not the fix.
2. **Give worktrees a `node_modules`.** Either a shared store symlinked on
   creation, or a documented bootstrap step. Right now a worktree is a place
   where the gate cannot run.
3. **Add `sonner` as a direct dependency** of the Glaze tree, so
   `dev:renderer` stops 500ing. One line; the Electron tree already has it.

### Phase 1 — Real CI (1–2 days)

On the `shell/electron` branch, a workflow on `macos-latest`:

```yaml
npm ci
npm run lint && npm run type-check && npm run test:all && npm run build
```

Expect 2–4 minutes with a warm npm cache. Make it a **required check**.

Then upload `npm run package` output as a per-PR artifact — a downloadable
`.app` for any reviewer, no Glaze app involved.

This is the first point at which a PR's green tick means something.

### Phase 2 — Let agents drive the real app (2–3 days)

`@playwright/test` 1.53 is **already a dependency**, and it ships Electron
support (`_electron.launch()`). So the packaged app can be driven
programmatically: real windows, real IPC, real spec generation, screenshots on
failure.

Add `e2e/` with a first pass over the flows that currently only a human can
check — launch, record a short session against a local fixture site, generate a
spec, run it, assert the output.

This closes the gap `PORTING.md` flags as its top open risk: *"No end-to-end
recording session was driven."* It is also the honest answer to "let agents
identify issues before merge" — an agent gets the real app, not an approximation.

### Phase 3 — Browser preview and per-PR URLs (2–3 days)

1. **`renderer/dev/fake-bridge.ts`** — implement `window.glazeAPI` over seeded
   fixtures (a sample test library, run history, heal journal). Start from the
   shape in `renderer/__tests__/setup.ts`. Gate it behind a build-time define so
   it can never ship in the real app; add a check that pins that.
2. **`npm run dev:web`** — the full UI in any browser, no Electron, no Glaze.
3. **Deploy it per PR.** The renderer is a static bundle, so any static host
   works (GitHub Pages, Cloudflare Pages, Netlify). Post the URL as a PR
   comment.

This is the fastest loop in the plan — seconds, shareable, and directly drivable
by an agent's browser tools. It is a UI preview, not a functional app: the
backend is fixtures. That is the right trade for reviewing layout, states, and
flows, and Phase 2 covers what it cannot.

### Phase 4 — Converge the trees (3–5 days)

1. Cherry-pick the seven missing commits onto `shell/electron`.
2. Introduce `main/shell/glaze/` alongside `main/shell/electron/`, and switch
   the Glaze tree's imports from `@glaze/core/backend` to `@shell/backend` —
   the 47 import-only files are mechanical.
3. Point `@ui` at `renderer/ui/` in both, or keep `@glaze/core/components`
   behind the `@ui` alias for the Glaze shell.
4. Merge `shell/electron` into `main`. The remaining diff should be only
   `main/shell/*`, build config, and `renderer/ui/`.

### Phase 5 — Keep it converged

- A CI check that fails if source outside `main/shell/` and build config differs
  between shell targets.
- Both shells build in CI on every PR.
- A `docs/DECISIONS.md` entry for the two-shell architecture.

---

## 6. Git workflow changes

| Change | Why |
|---|---|
| **Electron tree into git, as branch `shell/electron`** | It is currently untracked loose files — one `rm -rf` from gone, and undiffable. |
| **Required CI check on PRs** | Replaces an honour-system checkbox with a gate. |
| **No more "Build this branch" commits** | These exist only to claim the global build slot. Previews remove the need; the commits pollute history and serialise work. |
| **Worktree bootstrap** | A worktree that cannot run the gate is a trap. |
| **Keep the PR template's boundary checklist** | The capture-boundary and import-sandbox sections encode real security review that CI cannot do. Move the *mechanical* boxes (lint/type-check/test) to CI; keep the judgement ones. |
| **Short-lived branches off `main`** | Already the practice — worth stating now that merges will be gated. |

---

## 7. Ephemeral preview environments — three tiers

Cheapest first. They are complementary, not alternatives.

| Tier | What | Build | Fidelity | Who it serves |
|---|---|---|---|---|
| **1. Web preview** | Renderer + fake bridge on a static URL per PR | seconds | UI only, fixture data | Agents (browser tools), reviewers, anyone with a link |
| **2. App artifact** | `npm run package` on CI, zipped `.app` per PR | 2–4 min | Full app | Reviewers wanting the real thing; no Glaze needed |
| **3. Local slot** | Electron shell run straight from a worktree (`npm run dev`) | seconds | Full app | The developer or agent on that branch |

Tier 3 is what actually dissolves the global-slot problem: the Electron shell
runs from its own directory with its own `userData`, so **N branches can be live
at once**. No publish step, no `../.glaze/build`, no mutex commit.

If the Glaze shell should keep working the same way, the smaller fix is to make
its publish target branch-scoped rather than a single `../.glaze/build`.

---

## 8. Keeping Glaze and Electron in sync

Short term (Phase 0 + 4): the `shell/electron` branch plus seven cherry-picks.

Long term: **do not keep them in sync — make them the same tree.** Any
process-based answer (a checklist, a periodic port, a reminder) loses to the
same drift that produced this gap in the first place; the tree drifted seven
commits in under a day of active work. The 72%-identical measurement is the
argument that convergence is cheaper than perpetual porting.

---

## 9. What I would cut, and the risks

**Cut if time is short:** Phase 3's per-PR *deploys* (keep `dev:web` local —
most of the value, none of the hosting). Phase 5's drift check, if Phase 4
lands fully.

**Do not cut:** Phase 0. The Electron tree being untracked is an unbacked
single point of failure, and it is an hour of work.

**Risks:**

- *The fake bridge drifts from real IPC.* Mitigate by generating both from
  `renderer/lib/api.ts`'s channel list and failing on an unhandled channel,
  rather than silently returning null the way the jsdom stub does.
- *E2E tests are flaky and get ignored.* Keep Phase 2 to a handful of
  high-value flows. The existing `check:flake-analysis` machinery is relevant.
- *Convergence stalls half-done*, leaving two trees plus a shell abstraction —
  worse than either. Phase 4 should land as one merge, not incrementally.
- *macOS CI minutes cost ~10× Linux.* Most of the gate (lint, type-check,
  Vitest, checks) is platform-independent and can run on Linux; reserve macOS
  for `package` and the Electron E2E run.
- *Visual fidelity.* `PORTING.md` is explicit that `renderer/ui/` is an
  approximation, not a pixel match. Converging makes that approximation the
  default look unless the Glaze shell keeps `@glaze/core/components` behind
  `@ui`. Worth an explicit decision.

---

## 10. Sequenced summary

| Phase | Status | Unlocks |
|---|---|---|
| 0 — Electron into git, worktree deps, `sonner` | **built** | Nothing is lost; worktrees work |
| 1 — Real CI on Electron | **built** | A green tick that means something |
| 2 — Playwright-driven Electron E2E | **built** | Agents exercise the real app pre-merge |
| 3 — Browser preview + per-PR artifacts | **built** | Seconds-long loop, shareable previews |
| 4a — Close the drift | **built, then reopened** | Levelled the trees on 2026-08-07; 40 commits behind again by 2026-08-08 — see §11 |
| 4b — Converge on `@shell/backend` | blocked on a decision | One tree; drift stops existing |
| 5 — Drift guard | not started (0.5d) | It stays converged |

---

## 11. What was built, and what is verified

Phases 0–3 landed. Phase 0's Glaze-side work is on `claude/testing-pipeline-optimization-0dfc4b`;
everything else is on **`shell/electron`**, branched from `a61598c`:

| Commit | What |
|---|---|
| `3c72c05` | The port itself, imported from the untracked tree |
| `c49e9c2` | Install fixes — `install-electron` postinstall, `allowScripts`, `build/` ignored |
| `928b467` | `.github/workflows/gate.yml` + `e2e/` driving the real app |
| `f11a42d` | `renderer/dev/` — the whole UI in a browser tab, on fixtures |
| `b86c61f` | Preview published from CI |

**Verified by running it, not by reading it:**

- Full gate on a clean checkout of `shell/electron`: lint 4.5s, type-check 5.0s,
  `test:all` 897 tests + 26 checks in 26.3s, build 3.8s,
  `package` → `dist/mac-arm64/Good Looks!.app`.
- 6/6 end-to-end tests pass in 7.0s against the built app. This also closes
  `PORTING.md`'s open item that the packaged app's UI had never been looked at —
  it was launched, screenshotted, and driven.
- The browser preview renders all six views with zero unhandled channels,
  including the test detail view with steps, tabs, browser picker and the
  capture-overhead estimate.
- The drift guard fails on a simulated channel rename, in both directions.
- The Glaze worktree this plan was written in now runs the full gate
  (1105 tests + 28 checks) via `npm run bootstrap`.

**Three bugs the work surfaced**, each of which would have reached CI:

1. Electron 43 has no postinstall — a clean `npm install` produced no runnable
   binary at all.
2. npm 12 blocks dependency install scripts by default; esbuild and fsevents
   were silently skipped.
3. `build/` was not gitignored — every build left the bundle one `git add -A`
   from being committed, which `check-repo-hygiene` bans.

**Phase 4a — the drift was closed, and has since reopened.**

> **Measured 2026-08-08:** `shell/electron` is **10 ahead, 40 behind `main`**,
> with **243 files differing** (108 under `renderer/`, 80 under `main/`).
> Eighteen of those 40 commits touch `renderer/`.
>
> The convergence below held for about a day. That is the finding, not a
> footnote: **4a closes the gap, it does not keep it closed** — Phase 5, the
> drift guard, is what does that, and it has never been built. Any future
> catch-up merge should land the guard in the same push, or this paragraph
> needs rewriting again.
>
> Commit counts are not conflict counts. 4a resolved 4 conflicts across 164
> changed files because the trees share a real merge base and most edits sit on
> different lines; expect the next catch-up to be worse than that and nowhere
> near 40 files of manual work.

On 2026-08-07 it was **0 commits behind `main`**, done as one `git merge`
rather than 13 cherry-picks: both trees
descend from `a61598c`, so git's three-way handles the mechanical part — a file
where `main` changed logic and the port changed only its import line
auto-merges, because those are different lines. **4 conflicts out of 164
changed files.** Establishing the real merge base is what made that possible.

The suite on `shell/electron` went from 897 tests / 51 files / 26 checks to
**1115 / 59 / 29**. `test:checks` is now generated from the defined `check:*`
scripts rather than hand-listed — `main` and the branch had already drifted on
ordering alone, and a hand-maintained chain that silently omits a check is a
test that passes by never running.

Two of the merge's type errors were the guards working. `RecorderState` gained
a `replaying` field on `main`; the preview bridge did not have it, and the
type-checker said so — which is exactly why the handlers carry the app's own
return types.

**Not done, and deliberately so:**

- **Phase 4b, the convergence itself.** `main` and `shell/electron` are still
  two trees. Finishing means adding `main/shell/glaze/` beside
  `main/shell/electron/`, switching `main`'s 47 import-only files to
  `@shell/backend`, and merging.

  **This is blocked on a product decision, not on effort.** Merging makes the
  Electron shell the thing `main` builds, and `PORTING.md` is explicit that
  `renderer/ui/` is *an approximation of the original design system, not a
  pixel match*. So the question — does the Glaze shell keep
  `@glaze/core/components` behind the `@ui` alias, or does everything move to
  the rebuilt library and accept its look? — changes what the app looks like,
  and it is not one to answer by inference. It also cannot be verified from a
  terminal: only the Glaze app can build the native shell and show the UI.
- **`npm run build` on the Glaze branch was not run as verification.** It
  publishes into `../.glaze/build` and would replace whatever build is
  currently installed in the Glaze app — the exact behaviour this plan exists
  to remove. Nothing in that change touches build inputs.
- ~~**Neither branch has been pushed.**~~ Both are on `origin` as of 2026-08-08
  (`shell/electron` and `claude/testing-pipeline-optimization-0dfc4b`).
- **A per-pull-request preview URL** needs a `gh-pages` branch with a
  `pr-<number>/` prefix; the official Pages actions deploy one site per
  repository. The artifact ships today and the Pages job is behind an
  `ENABLE_PAGES` variable so turning Pages on is never discovered through a red
  pipeline.
