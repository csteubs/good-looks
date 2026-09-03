# In-app analytics, debug data and feedback filing — strategy

**Status:** research and proposal, written 2026-09-03. Nothing built, no
provider chosen. This document exists to scope the work and to name the
decisions only the product owner can take — they are collected in §12, and the
plan proceeds under the stated default for each until answered.

Companion documents: [../ARCHITECTURE.md](../ARCHITECTURE.md) for what
exists, [../DECISIONS.md](../DECISIONS.md) for why, [../LINEAR.md](../LINEAR.md)
for the issue-tracker research this builds on, and
[testing-pipeline-and-preview-environments.md](testing-pipeline-and-preview-environments.md)
for the CI shape any new gate lands in.

## 1. What this is, and what it is not

Three capabilities, deliberately separated because they have different
consent models, different destinations and different failure modes:

1. **Product analytics** — which surfaces are used, how often, in what order,
   and whether a journey completes. The requirement is that **every in-app
   surface can be reported on**: a route, a dialog, a settings row, a command,
   a menu item, a trainer control, an MCP tool. The candidate providers are
   Amplitude and FullStory; the comparison is in §7.
2. **Debug data** — crashes, unhandled errors, stuck jobs, and the evidence
   needed to act on them: version, platform, the route the user was on, the
   last few things they did, a redacted log tail.
3. **Feedback filing** — a way for a user to say "this is wrong" from inside
   the app, with the evidence attached and the report landing somewhere a
   maintainer reads.

**What it is not.** The app already has analytics — of the user's *tests*.
`metrics.db`, the Stats board, `get_step_health`, `get_flake_report` and the
insights report are all analytics of run history. This plan is analytics of
**app usage**, and the two must never share a store, a vocabulary or a
screen: `metrics.db` is a derived shadow that is dropped and replayed from the
JSON stores (CLAUDE.md, "The metrics DB"), which is exactly the wrong property
for a product-analytics queue, and the Stats board deliberately draws an
"analytics here, operations there" line (`stats-categories.md` §6) that a
"how often is the Stats board opened" tile would erase.

## 2. Where the app stands today

### 2.1 The egress posture

The stated posture is **one opt-in, summary-only webhook** (DECISIONS
2026-08-04, restated in `main/services/alert-service.ts:1-16`), and every
later egress path has been argued against that bar individually:

| Path | Destination chosen by | Default | What leaves | Guard |
|---|---|---|---|---|
| Alert webhook (`alert-service.ts`) | the user (URL) | off | test name, status, failing step LABEL, counts, duration | `check:alerts`, `redact` at the send site |
| Insights → Slack (`insights/insights-slack-url-store.ts`) | the user (URL) | off | the scheduled report, built from indexes and aggregates only | `check:insights-egress` (planted secret) |
| Issue tracker (`issue-tracker/`, Linear or GitHub) | the user (token + project) | off, per-failure explicit send | `buildIssueDraft` output; screenshots only with consent in the compose dialog | `check:issue-payload` |
| Hosted LLM (`llm-service.ts`, Claude provider) | the user (key) | off | prompts, redacted through `secret-redaction.ts` | `check:agent-egress`, `check:editor-egress` |
| `api.github.com` (`github-prs.ts`, the Branches view) | the app, for `origin` only | only from a git checkout | repo name, token if configured | DECISIONS 2026-08-09 ("second outbound host") |
| Mailbox worker (`workers/mailbox`) | the user (deployed by them) | off | the `emailCode` step's mail lookups | `mailbox-worker.test.ts` |
| Site icons (`renderer/theme/primitives/site-icon.tsx`) | the app (`icons.duckduckgo.com`) | off (`siteIconsFromWeb: false`) | every test's hostname | `check:renderer-egress` allowlist entry + the setting's `false` pinned at both ends |
| Playwright browser download (`browser-install.mjs`, the installer child) | the app (Playwright's CDN) | on first run, with a named command | nothing about the library | `check:ci-fixtures` |

Two rules recur in all of them and are the reason this plan is shaped the way
it is:

- **The payload builder is pure, and a check plants a secret and asserts it
  never comes out.** `buildAlertPayload`, `buildIssueDraft`, the insights
  facts builder — none of them can see the run log, the script or a header
  value, because the type has nowhere to put one.
- **Redaction happens at the send site**, "rather than anywhere a later
  refactor could route around" (`alert-service.ts`), from a snapshot of every
  stored secret (`secret-redaction.ts`).

And one check watches the *renderer* rather than a payload:
`check:renderer-egress` exists because the sidebar once fetched a favicon from
Google for every host in the library, sending a QA tool's unreleased staging
hostnames to a third party with no setting, no disclosure and no way to see
it. Its allowlist is of **specific strings with a reason each**, not of hosts.
A product-analytics SDK loaded in the renderer is precisely the thing that
check was written to make somebody write down.

### 2.2 Where sensitive data lives

Everything below is on disk under `userData/recorder/` and is what an
analytics property, a session replay or a crash dump could pick up by
accident. The never-sent list in §5.3 is derived from it.

- **Credentials, encrypted with `safeStorage`:** the Anthropic key, the GitHub
  token, the Linear token, the LM Studio token, the webhook URL, the Slack URL,
  the proxy password, secret test variables, Shopify crawler signatures, the
  mailbox credentials (`*-store.ts` over `encrypted-secret-store.ts`).
- **The library itself:** test names, start URLs and hostnames (routinely
  unreleased or internal), every step's target and typed value, variables and
  datasets, cookies, generated specs, imported project source.
- **Run evidence:** logs (page content, URLs with tokens, typed fixture
  values), console and network captures (`GLAZE_RECORD_ALL_HEADERS=1` records
  real `Authorization` headers), screenshots, traces, a11y and visual reports.
- **AI material:** prompts, answers, standing instructions per host
  (`aiInstructionsByHost`), the AI-debug transcripts.
- **Identity-adjacent:** git branch names and PR titles (Branches view), the
  user's email if configured for the mailbox or an issue tracker, the
  machine's userData path.

### 2.3 Debug data and feedback today

What exists is local, and mostly for **handing to someone** rather than
sending:

- `main/shell/logger.ts` — console plus an append-only `userData/logs/main.log`
  with no rotation. Renderer console output and `render-process-gone` /
  `preload-error` are forwarded into it (`host-handlers.ts:184-203`). Nothing
  reads it back, ships it, or notices an error in it.
- Settings → Diagnostics — debug screenshots of every open app window
  (⌘⌥⇧S, `debug:capture`), meant for an MCP client or a person helping you.
- The AI debug feature and `recorder-debug-store.ts` — per-test replay
  attempts, kept for the user's own inspection.
- The issue tracker — "Send this failure to the issue tracker" on a failed
  run, Linear or GitHub, with `buildIssueDraft`'s four pinned properties and a
  `goodlooks://` deep link back. It is the one flow that already files
  something off the machine on the user's behalf, and the feedback flow in
  §10 is built on it rather than beside it.
- The Help menu (`main/index.ts:432-480`) — documentation topics only. There
  is no "Report a problem", no "Send feedback", and no entry point that is
  not tied to a failed run.

What does not exist: a crash reporter, an `uncaughtException` or
`unhandledRejection` handler in the main process, a renderer error boundary
that reports (the router's error component renders, it does not record),
breadcrumbs, and any notion of an app session.

### 2.4 The renderer's content-security policy

Every app window ships a CSP meta tag (`main-window.html:8`,
`trainer-window.html:8`, `recorder-chrome.html:19`): `script-src 'self'
'unsafe-inline'` plus localhost for the dev server, `connect-src 'self'
https:` plus localhost in the two app windows, and **no `https:` at all** in
the URL strip. Two consequences for any vendor SDK: a script loaded from a
CDN at init is blocked in every window, silently — the SDK must be a bundled
npm module; and while a bundled renderer SDK *could* POST to any `https:`
host from the main and trainer windows, `check:renderer-egress` walks
`renderer/**/*.ts(x)` and not `node_modules`, so a bundled SDK's ingest URL
is exactly the kind of host that check was written to make visible and would
not see. §6 draws the conclusion.

## 3. The bar a new egress path must clear

Derived from §2, and applied to all three capabilities. A phase in §11 is not
done until each of these is pinned by a test or a check.

1. **Off until the user turns it on.** The posture is opt-in per destination,
   and a QA tool's library names unreleased hosts — the default cannot be
   "on" (§12 asks whether a first-run prompt is acceptable, which is still
   opt-in).
2. **Named hosts, written down.** Every host contacted is a line in the
   renderer-egress allowlist (if the renderer contacts it) or the main-process
   equivalent this plan adds, with its reason. An SDK that loads a remote
   script at init is a second host and a second line.
3. **A pure payload builder, and a planted-secret check over it.** Events,
   crash envelopes and feedback drafts are all built by pure functions with
   typed inputs that have nowhere to put a URL, a path or a free-text value,
   and a `check:analytics-egress` plants a secret in every store and asserts
   the emitted bytes never contain it.
4. **Redaction at the send site**, over `allRedactableValues()`, even though
   rule 3 should make it a no-op — a no-op today is the cheap insurance
   against the field added next year.
5. **Never on the run path.** A slow, down or misconfigured collector must
   not delay a recording, a run, a batch or a routine; every send is
   best-effort, time-boxed and swallowed, the way the alert webhook already is.
6. **Through the app's proxy.** `appFetch` (`proxy-service.ts`) is how every
   outbound request honours Settings → Proxy; an SDK that opens its own
   sockets bypasses a setting the user relied on.
7. **Inert where there is no user.** e2e (`e2e/fixtures.ts`), the browser
   preview (`renderer/dev/preview-bridge.ts`), CI, the MCP server and the CLI
   (§4.7) either do not load the layer or load a sink that writes nowhere.
8. **Visible.** Settings shows what is on, where it goes, and a way to see the
   last N events sent (the same "can anyone tell?" principle as the trainer's
   `signedRequests` tally).

## 4. The reportable set — every surface, by the seam that reports it

The inventory below was built by reading the tree on 2026-09-03 and is the
input to the coverage gate in §5.5: **a surface is reportable when it is
either covered by a chokepoint or named in the catalog with an explicit
event**. The last column says which. Counts are what the tree holds today;
the gate re-derives them, so the numbers here are a snapshot, not a contract.

### 4.1 Screens, windows and processes

| Surface | Where | Reported by |
|---|---|---|
| 12 screens on 14 route entries — Home `/`, Test `/test/$id`, Stats `/stats` + `/stats/$category` + `/stats/$category/$facet`, Visual, Accessibility, Routines `/batch`, Heals, Insights, Branches, Settings `/settings` + `/settings/$pane` + `/settings/$pane/$topic` | `renderer/main/router.tsx` | router history subscription (`createMemoryHistory` — never `window.location`) |
| The recording screen — `RootShell` swaps the outlet for `RecordingView` **without navigating** | `renderer/main/root-view.tsx:49` | recorder store `state.recording` — a synthetic screen, or every recording is attributed to the route it started from |
| Route not found; root error boundary (`ErrorBoundaryView`, renders only) | `router.tsx`, `renderer/ui/layout.tsx:645` | explicit — the boundary is also the renderer's crash hook (§9) |
| Boot plate (cold start, skip) | `renderer/theme/shell/boot-plate.tsx` | explicit (`bootDurationMs`) |
| Main window; trainer panel window (`alwaysOnTop`, docks beside the training browser); recorder window holding `pageView` (**untrusted**, `recorder-incognito-<uuid>`, no preload) and `chromeView` (the read-only URL strip) | `main/index.ts:249`, `main/windows/trainer-panel-window.ts:299`, `main/services/recorder-service.ts:2209-2327` | window lifecycle in main; the untrusted view is **never** instrumented |
| Hidden PDF window (insight report export); TypeScript `utilityProcess`; Playwright CLI child per run; batch runner; routine scheduler (unattended, every 60 s); insights ticks; propagation service | `insight-report-pdf.ts`, `ts-service/client.ts:58`, `playwright-runner.ts:1165`, `batch-runner.ts`, `routine-scheduler.ts:100` | lifecycle events in main, tagged by `trigger` (`manual` / `schedule` / `mcp` / `cli`) — "active user" means `manual` |
| Application menu (App, File, Edit, View, Window, Help — 13 Help items, all documentation) | `main/index.ts:383-484` | `openSettingsPane` funnel + explicit per item |
| `goodlooks://` deep links | `main/shell/deep-link.ts` | explicit (`hasRun`, `hasStep` — never the URL) |
| Desktop notifications (run, AI debug, insights) | `run-notifier.ts:141`, `ai-debug-notifier.ts:47`, `insights-notifier.ts` | explicit (kind only) |

### 4.2 Shell chrome and global controls

| Surface | Where | Reported by |
|---|---|---|
| App strip: back / forward, breadcrumb, history keys | `renderer/main/app-strip.tsx` | router subscription |
| Library rail: test rows, groups, tags, Add menu, custom order, the Routines rail, the Branches row + flyout, the Insights row | `library-sidebar.tsx`, `routines-rail.tsx`, `branches-rail-row.tsx`, `insights-rail-row.tsx` | explicit on row activation (test **id**, never name) |
| Command palette ⌘K — every command runs through one `go()` wrapper | `command-palette.tsx:103` | chokepoint (command id + group) |
| Keyboard shortcuts — six separate `keydown` listeners, no registry; ⌘R pause/resume in the trainer | `command-palette.tsx`, `recorder-service.ts:1947` | explicit per listener (a capture-phase listener is the alternative) |
| Toasts — 248 call sites through one re-export | `renderer/ui/overlays.tsx:630` | chokepoint (toast kind; **never the message**, which quotes paths and URLs) |
| Native popup menus — `Select`, `DropdownMenu`, Add-test, Manage-stats, assertion kinds; options **never enter the DOM** | `renderer/ui/native-menu.tsx:253,424`, `preload.ts:113` | chokepoint at `Menu.popup` (menu id + chosen command id) — DOM autocapture cannot see these |
| Job ticker; AI debug chip; pending branch switch (module-level bus, no IPC) | `job-ticker.tsx:100`, `ai-debug-chip.tsx`, `pending-branch-switch.ts:29` | explicit |
| Settings-open push (menu, Help, AI connection footer) | `root-view.tsx:130-143` | explicit (entry source) |

### 4.3 Dialogs and panels

| Surface | Where | Reported by |
|---|---|---|
| New recording; Generate test from prompt; Generate steps with AI; Import from git; Duplicate; Tags; Group name; Create flow; Missed runs; Load failed; Exit/save confirmation; Refine selector; Issue compose; AI debug (dialog + step dialog); Stats log inspector; Proxy validation | `renderer/main/*.tsx`, `renderer/components/issue-compose-dialog.tsx`, `renderer/settings/panes/proxy-pane.tsx` | explicit open / confirm / cancel per dialog, from one `useDialogEvent` hook |
| Test detail tabs — Steps (edit view + insert cursor), Script (CodeMirror + inspections + AI panel), Variables, Heals, Accessibility, run history, run output, run summary, triage, failure reason | `test-detail-view.tsx:1619` (`TabsRoot onValueChange`) and the per-tab mutations | chokepoint on tab change; explicit for edits (count of steps changed, never content) |
| Stats panels — flake, cost, digest, divergence, step health, suite cost, report export | `renderer/main/*-panel.tsx` | route + explicit for actions (export kind) |
| Visual, Accessibility, Heals, Insights, Branches, Routines actions — 8 + 11 `useMutation` hooks and the batch controls | the views' mutation hooks | react-query `MutationCache` observer (mutation key + outcome) |

### 4.4 Settings

| Surface | Where | Reported by |
|---|---|---|
| 18 panes on the board, in the rail, and by search | `renderer/lib/settings-schema.ts` (`PANES`) | router subscription (`$pane`) + explicit for search (query **length** and match count only) |
| ~90 rows in `SETTING_INDEX` — every persisted write goes through **one** optimistic `save(patch)` | `settings-controller.tsx:365` → `recorder:setSettings` | chokepoint: row id + key **names** + boolean/enum values; numbers and free text never (`userStylesheet`, `userInitScript`, `aiInstructions*`, `proxyUrl`, `costHourlyRate`) |
| Credential rows — Anthropic key, LM Studio token, webhook URL, Slack URL, GitHub token, issue-tracker connection, Shopify signatures, mailbox, proxy password; each has its own set / clear / test channel and never travels through `save()` | `settings-controller.tsx:391-885` | chokepoint at the credential channels: outcome only (set / cleared / tested-ok / tested-failed) |
| Egress-enable confirmations (`AlertDialog` on the webhook and Slack switches) | `integrations-pane.tsx:475-494, 571-587` | explicit: shown / confirmed / cancelled — the consent events this plan's own switch will emit too |
| Section reset; Storage prune; Stats reset / delete (no confirmation today) | `settings-view.tsx:274`, `settings-controller.tsx:917-960` | explicit |
| Two rows not in `SETTING_INDEX` (`extra-testid-attributes`, `default-batch-headless`) | `recording-pane.tsx`, `test-defaults-pane.tsx` | **gap** — index them first (the gate in §5.5 fails on them otherwise) |

### 4.5 The trainer

| Surface | Where | Reported by |
|---|---|---|
| Session lifecycle — started (new / editing), load failed, paused, resumed, saved, abandoned (`finalize` vs `discardExit`; an OS close **saves**) | `recorder-service.ts` lifecycle methods, `:2941`, `:4355` | main-process events — the panel and `RecordingView` are two renderings of one session, so renderer emission would double-count |
| Step captured / inserted / edited / reordered / deleted / replayed; verified-step insertion; insert cursor; flow scope | `recordCaptured`, `insertStep`, `updateStep :3676`, `deleteStep :3209`, `reorderStep :3646`, `tryStep` | main-process events: step **kind** and count, never target or value |
| Assert armed, refine started / ended (`countMatches`), element-context picker, add-step kind picks (native menus) | `trainer-actions.ts:141-173`, `recorder-service.ts:3153-3199` | explicit at the pick sites |
| Step composer; step rows; debug panel (Console / Step details / Cookies); cookies tab; variables tab | `step-composer.tsx`, `step-row.tsx`, `recording-view.tsx:160`, `cookies-panel.tsx`, `variables-panel.tsx` | explicit (open / submit counts) — **replay-excluded**: fill values, including password fields, are recorded verbatim and rendered in clear here |
| Trainer agent (goal sent, proposal offered / accepted / rejected, finish reason) and the suggestion strip (offered / accepted / dismissed / refused-by-allowlist) | `trainer-agent-service.ts` emitter, `suggestion-service.ts` | main-process events — the acceptance rate DECISIONS 2026-08-23 says nothing measures today |
| Trainer panel dock / undock (reason: user / no room / full screen / session ended); viewport-narrowed toast | `trainer-panel-window.ts:400-441`, `viewport-narrowed-notice.ts:78` | explicit |
| Page guards on the untrusted view — navigation blocked, permission denied, popup opened, basic-auth prompt, overlay rule saved, signature not sent | `recorder-service.ts:1804, 2370, 2552` | main-process events: **kind only** |
| The URL strip (`chromeView`) — copy, assert menu | `url-bar.tsx:105-125` | explicit through IPC; its own CSP has no `https:` in `connect-src`, so it can send nothing itself |

### 4.6 Backend-only surfaces

| Surface | Where | Reported by |
|---|---|---|
| ~287 `ipcMain.handle` registrations across 35 namespaces, bare, in one `registerHandlers()` — no wrapper, no timing, eight `catch` sites | `main/handlers/index.ts:184` | a registration wrapper: channel, duration bucket, error class — **never arguments or results** (they carry keys, URLs, passwords) |
| ~35 push channels through `sendToMain` (+ three direct `webContents.send`) | `main/services/app-window.ts:58` | the same wrapper on the push side; `check:push-consumers` already requires every push to have a listener |
| Run completion record (status, duration, browser, trigger, retries, heals) | `playwright-runner.ts` | derived event from the record — the one place run outcomes are already summary-only |
| Debug screenshots (⌘⌥⇧S, Capture now, MCP `capture_app`) | `debug-capture.ts:164` | explicit (source; never the images) |

### 4.7 Beyond the main window — thirteen execution surfaces, three with a user

| Surface | Has a user? | Recommendation |
|---|---|---|
| Trainer panel window (`renderer/trainer/index.tsx`) | yes | same `track()` client as the main window; lifecycle events come from main so nothing double-counts |
| URL strip (`renderer/recorder-chrome/index.tsx`) | yes | **no client** — its CSP has no `https:` in `connect-src`, and the two things it does (copy, assert menu) are IPC calls main can report |
| Main process running unattended timers (routine scheduler, insights ticks, propagation) | no, but the app is open | events, tagged `trigger: "schedule"`; excluded from "active user" |
| Untrusted page view (`pageView`) | the user is *on* it, the app is not | **never** — no app code loads there (capture boundary) |
| Hidden PDF window (`insight-report-pdf.ts`) | no | main-side `export_finished` event only |
| TypeScript `utilityProcess` (`ts-service/`) | no | exit / unavailable as `error_seen` from the client side; no SDK in the child (it resolves `typescript` from the runner's tree and must stay that way) |
| Playwright CLI child per run | no | the run record is the event |
| MCP server (`mcp/server.mjs`) | an AI client, often CI | **inert** — no user, no consent surface, plain `.mjs` with no build step; if §12 says otherwise, the opt-in RULE goes in `shared/` and each side reads it |
| `good-looks` CLI (`bin/good-looks.mjs`) | a CI runner | **inert** — and structurally: the CLI never calls `process.exit`, so an SDK with an exit-time flush or a keep-alive timer would hang or truncate piped stdout (`check:cli-exit`) |
| GitHub Action (`action.yml`) | no | inert; always CI |
| Mailbox worker (`workers/mailbox`) | no (user-deployed) | not an app surface; Cloudflare's own observability |
| Browser preview (`npm run dev:web`; **published to public GitHub Pages from `main`** when `ENABLE_PAGES` is set) | a visitor | in-memory sink only, selected by `window.__preview`; the shared renderer entry must refuse any provider client there — a demo on a public URL against fixtures must not phone home |
| Specimen page (`?view=specimen`) | no | inert by construction (no app root) |
| e2e-launched app (`GOOD_LOOKS_E2E=1`, throwaway `--user-data-dir`) | no | null sink; first-run identity logic must tolerate a fresh userData every test |
| Branch builds (`userData/branch-builds/`, **same userData as the checkout**) | the maintainer | events carry the running build's `app.getVersion()` and a `branch` flag; the consent and identity files are read forward-compatibly and never migrated destructively |

Two facts about distribution shape everything above: there is **no signed
build, no updater and no way to change an installed copy** (`PORTING.md`
names signing and notarization as the next step), so a provider key, a
consent version and an endpoint baked into a build are there until the user
installs another one — key rotation is a release, and the consent UI has to
live in the app. And **the dev bundle is not distinguishable by
`app.isPackaged`** (a re-signed Electron clone named "Good Looks!" with bundle id
`com.goodlooks.recorder.dev`, sharing userData with the packaged
`com.goodlooks.recorder`), so `environment` is derived from the env vars and
the git-checkout test, as §5.4 says.

## 5. The event model

### 5.1 One catalog, as data

`shared/analytics-catalog.mjs` (+ a hand-written `.d.mts`, the `shared/`
rule: pure, no `fs`, no IPC — because the main process validates against it
and the renderer emits from it, and neither can import the other's
TypeScript) is the single source of truth: every event the app can emit, with its name, the surface it
belongs to, its allowed properties and their types. Nothing may call
`track()` with a name that is not in it — the call takes the catalog entry,
not a string, so an event that is not declared does not type-check.

```ts
export const EVENTS = {
  screen_viewed:        { surface: "route",   props: { screen: SCREEN_IDS, from: SCREEN_IDS_OR_NONE } },
  command_run:          { surface: "palette", props: { command: COMMAND_IDS, via: ["palette", "shortcut", "menu"] } },
  setting_changed:      { surface: "settings", props: { row: SETTING_ROW_IDS, kind: ["boolean", "enum", "number", "text", "list"], value: BOOL_OR_ENUM_OR_NONE } },
  dialog_opened:        { surface: "dialog",  props: { dialog: DIALOG_IDS, source: ENTRY_SOURCES } },
  recording_started:    { surface: "trainer", props: { mode: ["new", "editing"], viewport: VIEWPORT_PRESETS, handlePopups: BOOL } },
  step_captured:        { surface: "trainer", props: { kind: STEP_KINDS, origin: ["captured", "manual", "verified", "suggested"], count: INT } },
  run_finished:         { surface: "run",     props: { status: ["passed", "failed", "cancelled"], trigger: RUN_TRIGGERS, browser: RUN_BROWSERS, durationBucket: BUCKETS, retried: BOOL, healed: INT } },
  egress_consent:       { surface: "settings", props: { feature: EGRESS_FEATURES, decision: ["shown", "confirmed", "cancelled"] } },
  ai_offered:           { surface: "ai",      props: { feature: AI_FEATURES, provider: LLM_PROVIDERS } },
  ai_resolved:          { surface: "ai",      props: { feature: AI_FEATURES, outcome: ["accepted", "rejected", "edited", "timed_out", "failed"] } },
  heal_proposed:        { surface: "heals",   props: { source: ["run", "ci"], kind: HEAL_KINDS } },
  heal_resolved:        { surface: "heals",   props: { outcome: ["accepted", "reverted", "expired"] } },
  error_seen:           { surface: "any",     props: { where: ["main", "renderer", "utility", "child"], kind: ERROR_KINDS, screen: SCREEN_IDS_OR_NONE } },
  process_gone:         { surface: "any",     props: { process: ["renderer", "utility", "child"], reason: GONE_REASONS, window: WINDOW_IDS_OR_NONE } },
  feedback_opened:      { surface: "feedback", props: { source: ["help", "palette", "diagnostics", "run"] } },
  feedback_sent:        { surface: "feedback", props: { destination: ["app", "own_tracker"], attachments: ATTACHMENT_FLAGS } },
  session_started:      { surface: "app",     props: { coldStartBucket: BUCKETS, firstRun: BOOL } },
  // …
} as const satisfies Catalog;
```

The property vocabularies are **declared as data and asserted equal to the
modules that own them** — `SCREEN_IDS` against the router's route table
(each entry already carries a `staticData.title`), `SETTING_ROW_IDS` against
`SETTING_INDEX`, `COMMAND_IDS` against the palette's command builders,
`STEP_KINDS` against `main/recorder/types.ts`, `AI_FEATURES` against the six
places the app offers a model's output (suggestion strip, trainer agent,
AI-debug fix, ghost text, Generate steps, Generate test). A `.mjs` cannot
import those TypeScript modules, but `analytics-catalog.test.ts` (node
project) can import both sides and assert set equality, which is the
`export-egress` / `push-consumers` discipline: a renamed route or a new step
kind fails the gate naming the stale entry rather than leaving one in the
catalog.

The **outcome pairs** are the part no chokepoint produces and the part the
product questions in §12 are answered from: `recording_started` →
`recording_finished(saved | abandoned)`; `run_finished(passed, trigger:
manual)`; `ai_offered` → `ai_resolved` across all six AI features (the
acceptance rate DECISIONS 2026-08-23 says ghost text has no telemetry on);
`heal_proposed` → `heal_resolved`, fed by the heal journal's
`pending | accepted | reverted` statuses; `feedback_opened` →
`feedback_sent`. The activation funnel is `session_started(firstRun)` →
`recording_finished(saved)` → `run_finished(passed)` per install.

### 5.2 Naming and the property rule

- `object_pastVerb`, lower snake case, one verb per event
  (`recording_started`, `setting_changed`). No `click`/`tap` events: what the
  user did is the verb, where they did it is a property.
- **Every property is an enum, a boolean, a bucketed integer, or an id the
  app minted** (test id, run id, routine id — opaque UUIDs that only mean
  something to the library that minted them). There is **no string type** in
  the catalog. A URL, a hostname, a test name, a step label, a typed value, a
  path, an error message, a prompt, a branch name, a search query, a
  credential host — none of these has a type it could be declared with, which
  is the "the type has nowhere to put them" property `issue-payload.check.ts`
  pins for issue drafts.
- Durations and sizes are **buckets** (`<1s`, `1-5s`, …; `1-10`, `11-50`,
  …), not raw numbers — a raw `durationMs` is harmless, a raw
  `costHourlyRate` is personal, and a rule with exceptions is a rule that
  gets one more exception.
- Counts that reveal library shape (tests in the library, hosts with
  standing instructions, signatures registered) are buckets too, or absent —
  §12 asks.

### 5.3 Never sent — the list, derived from §2.2

Test names; start URLs, hostnames and any URL; step targets and values;
variables and datasets; cookies; generated or imported source; run logs,
console and network captures; screenshots and traces; a11y node targets;
prompts, answers and standing instructions; branch names and PR titles;
e-mail addresses; the userData path or any path; error **messages** (the
error **class** is fine); search queries; free-text settings; credential
hosts; the machine name or username; the IP address (`trackingOptions.ipAddress: false`).
`check:analytics-egress` plants a distinctive marker in every one of these
places and asserts the emitted bytes never contain it — after asserting the
marker **entered** the builder, since absence proves nothing when the input
never carried it (the insights check's rule).

### 5.4 Identity, sessions, context

- **Identity is an install id**: a UUID minted once into
  `userData/recorder/analytics-id.json` **at consent time** (nothing is
  minted for a user who never opts in), rotated by a button in Settings
  ("Reset analytics identity"), deleted with opt-out. Test and run ids are
  the app's own opaque UUIDs; the stricter option — a per-session keyed
  hash, so a journey is analysable within a session and unlinkable across
  sessions — is a §12 question, because it also removes "time to green"
  across days from the answerable set. No user id, no e-mail,
  no machine id; the MCP server and CLI share the store but **do not emit**
  (§4.7), so the id never travels from a context without a user.
- **Session** = one app launch to quit, or 30 minutes idle; the id is minted
  in main and stamped on every event, so both windows and every process agree.
- **Context stamped in main on every event**: app version
  (`app.getVersion()` — the `app:getInfo` handler still answers
  `"My Glaze App" / "1.0.0"` from the SDK scaffold and must be fixed or
  removed first), Electron and Chromium versions, OS and arch, locale,
  `environment` (`packaged` / `dev` / `e2e` / `ci` — **not** from
  `app.isPackaged`, which is true under `npm run dev`'s branded bundle; from
  `GOOD_LOOKS_E2E`, `GOOD_LOOKS_DEV_URL`, `CI` and the git-checkout test the
  Branches view already applies), the current screen, whether a recording is
  live, and the consent version the user accepted.

### 5.5 The coverage gate

`check:analytics-coverage` (pure, `tsx`, source-level like
`check:renderer-egress`) asserts four things, and fails naming the surface:

1. Every route in the router's route table has a `screen_viewed` id in the
   catalog, and vice versa.
2. Every `SETTING_INDEX` row id is a legal `setting_changed.row`, and every
   `RecorderSettings` key in `recorder-settings-store.ts`'s defaults is
   reachable from some row (this is the assertion `settings-schema.test.ts`
   already makes, reused — and the two unindexed rows fail it today).
3. Every command id the palette builds is a legal `command_run.command`;
   every dialog component name (`*-dialog.tsx`, `AlertDialog` users) is a
   legal `dialog_opened.dialog`; every Help-menu label and every MCP tool and
   CLI subcommand is in the catalog's surface list.
4. The catalog has no property whose type is `string`.

And `renderer/dev/preview-bridge.ts` gains an in-memory sink, so the browser
preview can answer "which catalog events fired while I clicked through
`?view=settings`" — the only place an agent can drive the whole UI and read
the events back.

## 6. Architecture

### 6.1 Where things run

```
renderer (main window, trainer panel)          main process
┌──────────────────────────────┐               ┌──────────────────────────────────┐
│ track(EVENTS.x, props)       │  analytics:   │ analytics-service.ts             │
│  ← router subscription      │  track (IPC)  │  ← ipc wrapper (channel, ms, err)│
│  ← command palette go()     │ ───────────▶  │  ← sendToMain wrapper (push)     │
│  ← settings save()          │               │  ← recorder-service lifecycle    │
│  ← Menu.popup wrapper       │               │  ← runner / batch / routine      │
│  ← toast re-export          │               │  ← error hooks (§9)              │
│  ← MutationCache observer   │               │  stamp context · validate against│
│  ← useDialogEvent()         │               │  catalog · ring buffer (N=200)   │
└──────────────────────────────┘               │  → sink (consent-gated)          │
                                               │     ├ null sink (default; e2e,  │
                                               │     │  preview, CI, MCP, CLI)    │
                                               │     ├ local sink (JSONL, Settings│
                                               │     │  "last 200 events" viewer) │
                                               │     └ provider adapter           │
                                               │        (Amplitude | PostHog | …) │
                                               │        via appFetch, time-boxed  │
                                               └──────────────────────────────────┘
```

**Transport is the main process, not a renderer SDK.** Three reasons, each
already a rule in this repo: only main can route through `appFetch` and
honour Settings → Proxy (rule 6); the renderer-egress check exists to keep
third-party hosts out of `renderer/` and a bundled SDK carries its ingest
URL in its own source (the check walks `.ts`/`.tsx`, so a `node_modules`
bundle would pass it silently — which is worse); and one queue in main means
one consent gate, one ring buffer and one redaction pass for two windows and
every backend producer. The renderer's whole analytics surface is
`track()` → `ipc().invoke("analytics:track", …)`, which the preview bridge
stubs like any other channel. Amplitude's HTTP API is a plain JSON POST, so
the adapter is a hundred lines over `appFetch` with no SDK at all — and no
SDK is the right number: the Node SDK's transport bypasses the proxy (§7.1)
and the browser SDK is a renderer SDK.

**Session replay is the exception** — it can only run in a renderer, which
is why it is a separate decision (§8) with its own consent and its own
allowlist line, never bundled into "analytics on".

### 6.2 The service

`main/services/analytics-service.ts`, deps-injected like
`trainer-agent-service.ts` (clock, sink, consent reader, context reader), so
its unit tests state intent. It owns:

- **The consent gate**, re-read at *every* flush — the `aiSuggestionsEnabled`
  precedent: "the flag is re-read at send time AND after the model answers".
  Off means the null sink and an empty queue; opting out deletes the queue
  file and the install id.
- **Validation against the catalog** — an event with a property outside its
  declared vocabulary is dropped and counted (`analytics_dropped` in the
  local sink), never coerced.
- **The ring buffer** (last 200 events, in memory, no disk when consent is
  off) — also the breadcrumb trail §9 and §10 read.
- **The queue** — append-only JSONL under `userData/recorder/analytics/`,
  capped by count and age (Sentry's 30 / 30 days are sane defaults), flushed
  on a timer and at `before-quit`, batch POST through `appFetch` with a hard
  timeout, retries with backoff, every failure logged and swallowed
  (rule 5).
- **Redaction at the send site** over `allRedactableValues()` (rule 4).
- **Environment gating** — the null sink is *selected*, not merely
  configured, when `GOOD_LOOKS_E2E=1`, in the preview, under `CI`, and in
  every process that is not the app; `check:analytics-boot` starts the MCP
  server and the CLI the way `check:mcp-boot` / `check:cli-exit` do and
  asserts no socket is opened — because "inert by configuration" is the
  `trigger: "mcp"` bug in a new coat.

### 6.3 Chokepoints, and what they do not cover

| Chokepoint | Covers | Does not cover |
|---|---|---|
| Router history subscription | every screen view, back/forward, deep-link landings | the recording screen (store-driven), the trainer panel (no router) |
| `ipcMain.handle` registration wrapper | every user command that reaches main: channel, duration bucket, error class | which *control* issued it |
| `sendToMain` wrapper | every backend-announced lifecycle event | renderer-only state (tab changes, dialog opens) |
| `save(patch)` | every persisted setting change by row id | credential rows (own channels), the two unindexed rows |
| `Menu.popup` wrapper (preload) | every native menu pick | nothing — but only if wrapped in the preload, since the wrappers in `native-menu.tsx` are not the only callers |
| Command palette `go()` | every command by id | the same action reached by a button (which is why `via` is a property) |
| `toast` re-export | every user-visible error by kind | the message (deliberately) |
| react-query `MutationCache` | every mutation's outcome | reads |
| `useDialogEvent()` | open / confirm / cancel, once adopted by every dialog | dialogs that do not adopt it — the coverage gate's job |

The rule that follows: **chokepoints give breadth, explicit events give
meaning, the gate proves the union is complete.** Nothing is instrumented
twice: a settings change is one `setting_changed` from `save()`, not also an
`ipc_invoked` — the IPC wrapper records only channels that have no
higher-level event, which is a catalog flag.

### 6.4 Consent surface

A new **Privacy** row group in Settings → Integrations (the pane whose flag
copy is already "leaves this Mac"), not a new pane — `PaneId` is a closed
union with three keyed records and a test that asserts the pane count.
Rows: *Share usage analytics* (off; `AlertDialog` on enable naming the host
and the property rule, exactly as the webhook switch does), *Session replay*
(off, only if §8 says yes, its own dialog), *Crash reports* (off; §9.3),
*Show the last 200 events* (a local viewer, always available — the "can
anyone tell" affordance), *Reset analytics identity*. The consent version is
a constant; changing what is sent bumps it and turns the switch off until
the user reads the new dialog.

A **first-run prompt** is a §12 question; the default is *no prompt* — the
repo's precedent is off-until-found with confirm-on-enable, and a prompt at
first launch is the one place a user cannot yet judge what the app holds.
The middle shape, if one is wanted: a dismissable home-screen card that
**only opens the Privacy rows** and turns nothing on.

## 7. Providers — what was verified

Verified on 2026-09-03 from the vendors' source repositories and README files
(the vendors' documentation sites were unreachable from the session's network
policy — items marked *unverified* are from search-result summaries or prior
knowledge and must be re-checked before a decision).

### 7.1 Amplitude

- **Packages.** `@amplitude/analytics-browser` (renderer) and
  `@amplitude/analytics-node` (main process) — both plain npm modules; the
  browser package works **without loading a remote script** (the CDN loader is
  an alternative install, not a requirement).
- **Endpoints.** `https://api2.amplitude.com/2/httpapi` and `/batch`; EU:
  `https://api.eu.amplitude.com/…` (`serverZone: 'EU'`). One host either way.
- **Browser autocapture defaults are ON** for `attribution`, `pageViews`,
  `sessions`, `formInteractions`, `fileDownloads` and `pageUrlEnrichment`, and
  off for `elementInteractions`, `networkTracking`, `webVitals`,
  `frustrationInteractions`. Under `app://` a page view carries the app's own
  URL, and form-interaction autocapture would fire on the step composer and
  the settings rows — **every autocapture option must be off** and the layer
  must emit its own events (§5). `trackingOptions` defaults send `ipAddress`,
  `language` and `platform`; `ipAddress` off.
- **Identity.** `identityStorage` defaults to `cookie` (fine under `app://`,
  but `localStorage` or `none` with an app-supplied `deviceId` is the
  deterministic choice); `deviceId` is a UUID if not supplied; `optOut: true`
  drops everything client-side.
- **Delivery.** `flushIntervalMillis` 1000 / `flushQueueSize` 30 /
  `flushMaxRetries` 5 in the browser (10000 / 200 / 12 in core); unsent events
  are kept under an `AMP_unsent` storage key; `offline: false` by default.
  **The Node SDK's transport is `http`/`https`.request with a hard-coded
  option set and no agent, proxy or custom-fetch hook** (verified in
  `analytics-node/src/transports/http.ts`), so it cannot honour Settings →
  Proxy; the core config does accept a `transportProvider`, but the HTTP V2
  API is a plain JSON POST and needs no SDK at all (§6.1).
- **Session replay** is a separate plugin, `@amplitude/plugin-session-replay-browser`:
  rrweb DOM snapshots, **no remote script**, `sampleRate` required, all inputs
  masked by default, `.amp-mask` / `.amp-block` classes and a `privacyConfig`
  with `blockSelector` / `maskSelector` / `unmaskSelector` /
  `defaultMaskLevel` (*the last three per search summary — unverified*).
- **Electron.** No official Electron guide; the community answer is "Browser
  SDK in the renderer" (*unverified*). Nothing in the SDK depends on a real
  origin except the cookie default.

### 7.2 FullStory

- **Package.** `@fullstory/browser` 2.1.0 (`fullstorydev/fullstory-browser-sdk`),
  whose one runtime dependency is `@fullstory/snippet` — the README calls it
  "a wrapper around Fullstory's hosted recording script".
  `init({ orgId, host, script, namespace, devMode, recordCrossDomainIFrames,
  recordOnlyThisIFrame, debug, cookieDomain, assetMapId, startCaptureManually,
  appHost })`.
- **It loads a remote script.** `init` injects the recording script `fs.js`
  from `edge.fullstory.com` (the `script` option's default; `host` defaults to
  `fullstory.com`). Self-hosting a copy is supported. Under this repo's
  posture that is an executable fetched from a third party at every launch
  and a second allowlist line — self-hosting turns it into a bundled asset,
  which is the only shape consistent with DECISIONS's "no network fallback in
  the font stack" reasoning.
- **Electron is not a documented platform.** The help-centre index has a
  community thread titled "Electron elements masked" — elements captured as
  masked when the app served local files rather than a dev server — and an
  "Asset Uploading for Web" article whose stated use case includes assets
  "bundled with Electron apps and accessed via the file system" (*both from
  search summaries; the pages themselves were unreachable*). Expect the
  `app://` origin to need the asset uploader for stylesheets and fonts, and
  expect replay fidelity to be the first thing to prove in a spike.
- **Privacy.** Three element rules — `.fs-exclude` (not captured, striped in
  playback, events on it dropped), `.fs-mask` (structure kept, text and images
  omitted), `.fs-unmask` — and an org-level **Private by Default** mode that
  makes mask the default. Without Private by Default, *unmask is the default*.
- **Analytics.** `FS('trackEvent')`, `FS('setProperties')`,
  `FS('setIdentity')`, `FS('getSession')` — an event API exists, but
  FullStory's product is the replay and the autocapture over it; it is not an
  event-catalog analytics tool in the way Amplitude is.

### 7.3 Sentry (debug data — the reference point, whichever analytics vendor wins)

- **Package.** `@sentry/electron`, `electron >= 23`. `init` in the main
  process (`@sentry/electron/main`) **and** in every renderer
  (`@sentry/electron/renderer`; `dsn`/`release`/`environment` there are
  ignored — every renderer event is forwarded through main). Utility
  processes need `@sentry/electron/utility`; a preload under
  `contextIsolation: true` needs `import "@sentry/electron/preload"`, and
  **because this app bundles its main process with esbuild the SDK cannot
  inject its preload automatically** — the import is manual.
- **What it captures.** Node errors in main, JS errors in renderers, native
  crashes as minidumps through Electron's own crash reporter (uploaded on
  restart, or immediately after a renderer crash; main, renderer and utility
  processes on macOS/Windows/Linux; `child_process.fork` on macOS/Windows),
  breadcrumbs and context merged across processes into main. Minidumps are
  memory snapshots — they can contain environment variables, file paths and
  input field contents; Sentry deletes them after processing.
- **IPC.** `ipcMode` `Classic` | `Protocol` | `Both` (default `Both`): Electron
  IPC first, a custom protocol as fallback; `ipcNamespace` to keep its
  channels clear of the app's.
- **Offline.** Envelopes are queued across processes: `maxQueueSize` 30,
  `maxAgeDays` 30, `flushAtStartup` false by default, `shouldSend` /
  `shouldStore` hooks.
- Session Replay and User Feedback integrations exist for the renderer
  (*capability under `app://` unverified*).

### 7.4 PostHog (the alternative worth naming)

An official Electron tutorial exists: `posthog-js` full bundle imported in
the renderer ("because Electron has security restrictions about loading
external code"), session replay "works out of the box", `$pageview` captured
by hand because "Electron apps don't have pages", error tracking in the same
product, self-hosting possible (*all from a search summary of
posthog.com/tutorials/electron-analytics; unreachable directly*). It is the
one candidate that covers analytics, replay, error tracking and surveys in a
single SDK with one host, and the only one that can be self-hosted — which
matters if §12's data-residency answer is "nothing leaves infrastructure we
control".

### 7.5 What the comparison comes down to

| Need | Amplitude | FullStory | Sentry | PostHog |
|---|---|---|---|---|
| Typed event catalog, funnels, retention | strong | basic (`trackEvent`) | no | strong |
| Session replay of the app UI | plugin, rrweb, no remote script | core product; remote script; Electron undocumented | renderer integration (*unverified* under `app://`) | built in |
| Crashes and native minidumps | no | no | yes, including utility processes | JS errors only (*unverified* for native) |
| Feedback intake | no | no | User Feedback widget | Surveys |
| Hosts contacted | 1 | 2 (script CDN + ingest) unless self-hosted script | 1 | 1 (or self-hosted) |
| Fits rule 2 (no remote code at launch) | yes | only self-hosted | yes | yes (full bundle) |

Nothing here forces one vendor, and the architecture in §6 puts a **sink
interface** between the app and the provider, so the decision in §12 changes
an adapter, not the catalog, the consent surface or the gates. The
recommendation this plan proceeds under, until §12 says otherwise, and which
four independently written strategies converged on when scored against this
repo:

- **Analytics: Amplitude, through its HTTP V2 API from the main process**
  over `appFetch` — no `@amplitude/*` package in any window, no Node SDK
  (its transport bypasses the proxy), EU zone as a setting. PostHog is the
  fallback if §12 answers "self-host".
- **Session replay: not in scope** for the first phases; if revisited,
  Amplitude's replay plugin or PostHog's recorder, bundled, mask-everything
  (§8). **FullStory is rejected for this app**: its SDK is a loader for a
  hosted script every window's CSP blocks, self-hosting it means shipping a
  third-party executable, Electron is undocumented, and its strength —
  autocapture of a DOM — is the one thing §2.2 says must not be captured.
- **Debug data: vendor-free first** (§9), `@sentry/electron` only if native
  minidumps are wanted (§12), behind its own switch.
- **Feedback: the issue-tracker seam that exists** (§10), with the app's own
  destination decided in §12.

## 8. Session replay — scope, if at all

Replay is the capability that makes FullStory attractive and the one that
sits worst with §2. It is treated here as **a separate decision with a
separate switch**, and the plan works without it.

### 8.1 What replay would see

The topology decides this. The untrusted page lives in its own
`WebContentsView` with its own partition, no preload and no app code
(`recorder-service.ts:2280`), so **no replay SDK can reach it and none will
be injected** — that is the capture boundary, not a configuration choice.
Replay could run in the main window and the trainer panel, and in those it
would see, by default: the library sidebar (test names, hostnames, favicons),
the step list and composer (`.fill("<typed value>")` — including password
fields, which the capture script records verbatim), the cookies and
variables tabs, run output and the log inspector (page content), the Script
tab (the whole spec), the settings panes (credential rows are password
inputs; URLs and hosts are plain text), the URL strip's live address, the AI
panels (prompts and answers). That is most of §2.2.

### 8.2 The only acceptable shape

- **Mask everything by default, unmask by allowlist.** FullStory's Private
  by Default (`.fs-mask` as the default, `.fs-exclude` on the panels above)
  or Amplitude's `defaultMaskLevel` with `blockSelector` on the same set —
  the unmask allowlist is chrome only: rail row *positions*, tab strips,
  buttons, dialogs' structure, settings row labels. A masked replay still
  shows *where* the user went and *what they pressed*, which is what a
  feedback report needs.
- **Exclude, not mask, the panels that hold page-derived text**: the step
  list, composer, cookies, variables, run output, log inspector, script
  editor, AI panels, the Branches view, every credential row. Excluded means
  not captured, and events on excluded elements are dropped — so a replay
  cannot leak by the width of a rendered word.
- **Its own switch, its own consent dialog, its own allowlist line**, and a
  sample rate the user sees. Never on while a recording is live is a
  defensible default — the trainer is where the most sensitive text is on
  screen.
- **Bundled, never remote.** Every app window's CSP is
  `script-src 'self' 'unsafe-inline' localhost` (`main-window.html:8`,
  `trainer-window.html:8`, `recorder-chrome.html:19`), so FullStory's default
  loader (`fs.js` from `edge.fullstory.com`) is blocked before any policy
  question arises; only a self-hosted copy bundled as an app asset can run,
  and it then needs FullStory's asset uploader for the app's own stylesheets
  and fonts under `app://`. Amplitude's replay plugin and PostHog's recorder
  bundle from npm and need neither.
- **Verified in a spike before it is scoped**: a masked replay of the
  settings board and one recording session, played back, reviewed against
  §2.2 by someone who did not write the mask list. The "Electron elements
  masked" thread in FullStory's help centre says fidelity under a local
  origin is where the first surprise will be.

### 8.3 What replay buys, honestly

A feedback report with the last minutes attached, and rage-click /
dead-click signals on a UI with a lot of native-menu-backed controls that a
DOM recorder cannot see anyway (every `Select`, every popup). If the
feedback flow ships with breadcrumbs (§9.2) and screenshots-with-consent
(§10), the case for replay is weaker than it looks, and the §12 default is
**not in scope for the first three phases**.

## 9. Debug data

The order below is the order of value per unit of risk; each step is a
phase-3 deliverable in §11.

### 9.1 App-level error capture, with no vendor

`process.on("uncaughtException")` and `unhandledRejection` in main (log,
then let Electron's default dialog behaviour stand — today the app has no
handler at all); `window.onerror` / `unhandledrejection` in every app
renderer and a root error boundary that records the route and component
stack through the existing console forwarder — which is attached to the
main window only (`main/index.ts:278`) and must be attached to the trainer
panel and the URL strip too; and `render-process-gone`,
`child-process-gone`, `unresponsive` and the TypeScript utility process's
exit recorded as *events* (`error_seen`, `process_gone`: kind, reason, exit
code, window label) rather than only log lines. This is the data the
feedback flow attaches, and it is useful with no provider at all.

### 9.2 Breadcrumbs are the analytics events, kept locally

The last N catalog events (§5) in a ring buffer in main — route changes,
commands, dialog opens, IPC failures — are the "what were they doing" a
crash report needs. One producer, two consumers; no second instrumentation,
and the buffer exists whether or not analytics is on (it never leaves the
process on its own).

### 9.3 A crash reporter

Electron's `crashReporter` (through `@sentry/electron`, or bare
`crashReporter.start` to a self-hosted minidump endpoint) — opt-in
separately from analytics, because a minidump is memory and §2.2 lists what
is in this app's memory: decrypted credentials, typed values, page content.
Off by default in any case; if on, the `uploadToServer` decision is the
user's, and §12 asks whether "prompt after a crash" is the acceptable
middle. Re-exported from `main/shell/backend.ts` and stubbed in
`shell-backend-stub.ts`, because only `main/shell/` may import `electron`.

### 9.4 Log shipping, never automatic

`main.log` routinely carries page content and hostnames. It is attached to
a *feedback report* after redaction and a preview, and only then (§10).
Rotation is a prerequisite and cheap: `main.log` grows without bound today.

## 10. Feedback filing

Build it on the issue tracker that exists, not beside it.

- **Entry points, each a catalog event:** Help → "Report a problem…"; ⌘K
  "Report a problem"; a "Something wrong here?" affordance in the settings
  Diagnostics pane; and the existing per-failure "Send to the issue tracker"
  action gains a "This is a bug in the app, not the site" checkbox that routes
  to the app's own tracker rather than the user's.
- **Two destinations, one provider interface.** The user's tracker (Linear or
  GitHub, already configured) for their own tests; **the app's own tracker**
  (a GitHub repository the maintainer owns, or a Linear team) for feedback
  about the app. The second needs a credential the *user* does not hold —
  §12 asks whether that is a public-issues repo with a scoped token shipped
  in the build, a relay endpoint the maintainer runs (the mailbox worker is
  the precedent for "a small worker the repo owns"), or e-mail.
- **The draft is pure and pinned** the way `buildIssueDraft` is: title, free
  text the user typed, the current route and test id (id, not name), app
  version, Electron and OS versions, the settings snapshot as **key names and
  booleans only**, the last N breadcrumbs, the error events from §9.1, a
  redacted `main.log` tail — every one shown in the compose dialog before
  send, with the log tail and the screenshots behind their own checkboxes
  (consent per attachment, the mitigation `issue-payload.check.ts` already
  chose for screenshots).
- **Replay link, if replay exists.** FullStory's `getSession()` /
  Amplitude's replay URL / Sentry's replay id is one property on the draft —
  the strongest reason to want replay at all is that a bug report arrives
  with the last five minutes attached.
- **Jam.** A Jam recording is a bug report someone already made
  (`JAM-IMPORT.md`); "attach a Jam link" is a text field, and the reverse
  (Jam → test) is a separate plan. Nothing here depends on it.

## 11. Phasing

Each phase is a PR (or two) that leaves the gate green and the app
shippable, and none of the first three needs a provider decision. Sizes are
relative to this repo's recent PRs (the multi-tab work was an L).

| Phase | Scope | Deliverables | Size |
|---|---|---|---|
| **0 — Decide** | Answer §12. Fix `app:getInfo` (or delete it) so the app reports its real version; index the two settings rows that are outside `SETTING_INDEX`; route `mailbox-service.ts:58` through `appFetch` and `issue-tracker-service.ts:294` through `allRedactableValues()` — two inconsistencies with rules 4 and 6 that the inventory found and that would otherwise be "fixed by analogy" later | three small PRs; a DECISIONS entry recording the answers | S |
| **1 — Catalog and local sink** | `shared/analytics-catalog.mjs` (+ `.d.mts`); `analytics-service.ts` with the null and local sinks; the `track()` renderer API and `analytics:track`; the router, palette, `save()`, `Menu.popup`, toast, `MutationCache` and IPC/push wrappers; `useDialogEvent` adopted by every dialog; the recorder, runner, batch, routine and agent lifecycle events; the Settings *Privacy* rows with the local event viewer; `check:analytics-coverage`, `check:analytics-egress`, `check:analytics-boot`; preview-bridge sink; ARCHITECTURE + DECISIONS. **Nothing leaves the machine.** | the catalog, the service, the gates, the viewer | L |
| **2 — Provider adapter** | One adapter behind the sink interface (Amplitude HTTP API over `appFetch`, or PostHog — §12), the consent dialog and version, the queue with retry and age caps, EU/US zone as a setting, the allowlist entry with its reason, e2e row that an opted-in session sends exactly the catalog and an opted-out one opens no socket (a local HTTP listener as the collector, the way the agent-loop spec scripts an Ollama server) | one vendor, one host, one switch | M |
| **3 — Debug data, vendor-free** | `uncaughtException` / `unhandledRejection` in main; `window.onerror` / `unhandledrejection` in every app renderer; `forwardRendererConsole` on the trainer panel and the URL strip; `render-process-gone`, `child-process-gone`, `unresponsive` and utility-process exits as `error_seen` events; the ring buffer as breadcrumbs; `main.log` rotation | errors become events; the log stops growing forever | M |
| **4 — Feedback filing** | *Report a problem…* in Help, ⌘K and Diagnostics; the `app-feedback` `DefectSource`; a pure `buildFeedbackDraft` pinned by `check:feedback-payload`; the compose dialog reused with per-attachment consent (screenshots, redacted log tail, breadcrumbs); the app's own destination (§12); a deep-link form back to a settings pane, with `check:deep-link` rows | a user can report a bug from anywhere in the app | M |
| **5 — Crash reports** (optional) | `crashReporter` / `@sentry/electron` behind its own switch, minidump upload as prompt-after-crash or never (§12), the `@shell/backend` re-export and stub, `ELECTRON_RUN_AS_NODE` audit for the helper | native crashes reach a tracker | M |
| **6 — Session replay** (optional, after a spike) | the §8.2 shape, mask list reviewed, its own switch and dialog, bundled SDK, e2e row that a replay of the settings board contains no §2.2 marker | replay of the chrome, never of the data | L |
| **7 — Beyond the app** | Whether the MCP server, CLI and Action report anything (§12 default: never — they have no user and no consent surface); if yes, an opt-in flag the runner reads and the same catalog through `shared/` | — | S–M |

Phases 3 and 4 do not depend on 2: a team that never picks a vendor still
gets error capture and a feedback door, which is most of the debugging value.

### 11.1 What the gate gains — each check named for the silent failure it catches

| Check or test | Kind | Catches |
|---|---|---|
| `check:analytics-coverage` | pure `tsx`, source-level | a route, settings row, command, dialog, Help item, MCP tool or CLI subcommand with no catalog entry; a catalog entry with a `string` property |
| `check:analytics-egress` | esbuild + `shell-backend-stub` | a planted marker in a test name, URL, step value, secret, log line, prompt, branch name or search query reaching the emitted bytes — asserting first that the marker **entered** the builder (the insights check's rule: absence proves nothing if the input never carried it) |
| `check:analytics-boot` | boots real processes, like `check:mcp-boot` / `check:cli-exit` | the MCP server, the CLI, the e2e app and the preview opening any socket to a provider host; the CLI hanging on an SDK timer |
| `analytics-service.test.ts` | vitest, node, deps-injected | consent re-read at flush; the null sink selected (not configured) for each environment; queue caps; opt-out deleting the queue and the id; one event per lifecycle transition with two windows open |
| `analytics-catalog.test.ts` | vitest, node | vocabularies equal their owning modules' exports (routes, rows, commands, step kinds) |
| `preview-bridge.test.ts` (extended) | vitest, dom | the new channels stubbed; the preview sink records what the UI fires |
| `settings-schema.test.ts` (extended) | vitest, node | the three new keys default `false` at both ends and are surfaced in exactly one pane |
| `check:push-consumers`, `check:derived-cache` (existing) | — | an `analytics:*` push with no listener; the "last 200 events" query not in `RUN_DERIVED_KEYS` if it depends on runs |
| `e2e/analytics.spec.ts` | Playwright `_electron` against a local HTTP collector | an opted-in session sends exactly the catalog's shape with no §5.3 marker; an opted-out session opens no connection; the trainer panel and main window produce one recording event set |
| `check:repo-hygiene` (existing; extend `SECRET_PATTERNS` if §12 says keys stay out of source) | — | a provider write key committed where the current patterns (Anthropic, GitHub, AWS, PEM) would not see it |

Two conventions the checks inherit: a new `check:*` must be in the
`test:checks` chain in the same commit or `check:repo-hygiene` fails, and a
bundled check does not type-check, so `npm run type-check` is the real gate
for the service.

<!-- WORKFLOW:QUESTIONS -->

## 13. Risks and rejected alternatives

**Risks**

- *The gate proves breadth, not meaning.* A `dialog_opened` on every dialog
  says nothing about whether the user finished the task. The catalog's
  explicit lifecycle events (recording saved vs abandoned, run finished,
  proposal accepted) are where the product questions in §12 are answered,
  and they are hand-written — the gate cannot tell a missing one from an
  intentional absence. The review checklist for a new surface should ask
  "what is the outcome event".
- *A property vocabulary drifts into strings.* The catalog forbids `string`;
  the first PR that needs "just this one" free-text property is the one to
  refuse.
- *Two windows, one session.* Emitting recording events from the renderer
  double-counts (the panel and `RecordingView` render one session); the
  design puts them in main, and a test asserts one event per lifecycle
  transition with both windows open.
- *Unattended activity looks like usage.* Routines fire every minute,
  insights tick, propagation runs; "active user" must key on
  `trigger === "manual"` and renderer interaction, or a dashboard will show
  a user who has not opened the app in weeks.
- *`app.isPackaged` lies in dev.* The branded dev bundle is not named
  Electron, so environment tagging must use the env vars and the checkout
  test, or every developer session lands in the production dashboard.
- *The dev branch switcher runs other versions.* A build under
  `userData/branch-builds/` shares userData; its events must carry *its*
  version (`app.getVersion()` of the running build) and the same install id,
  or version-cohort charts break the day someone tests a PR.
- *Cost.* Every provider bills by event volume; `ipc_invoked` on 287
  channels for every user would dominate. It stays off unless a channel has
  no higher-level event, and the local viewer shows volume before anything
  is sent.

**Rejected**

- *Autocapture.* Amplitude's defaults (page views on `window.location`, form
  interactions, file downloads) and FullStory's DOM capture see the wrong
  things under `app://` (one page forever; the step composer as a "form")
  and cannot see native menus at all. Off, every option, in every vendor.
- *A renderer SDK as the transport.* Bypasses the proxy, puts a third-party
  host in `renderer/` outside the check's sight, needs a second queue and a
  second consent read for the trainer panel. See §6.1.
- *Storing events in `metrics.db`.* It is dropped and replayed; a
  product-analytics queue would be erased on every schema bump and mixed
  into the Stats board's queries. Analytics of the user's tests and
  analytics of the app stay apart.
- *A new Settings pane.* `PaneId` is a closed union with three keyed records
  and a pane-count test; rows in Integrations carry the "leaves this Mac"
  vocabulary already.
- *Filing feedback through the user's own tracker only.* Their Linear team
  is not where app bugs belong, and the app's maintainer has no access to
  it. Both destinations, one provider interface.
- *Shipping a maintainer credential in the build for feedback.* A token in a
  packaged app is a public token. The relay-worker shape (`workers/mailbox`
  is the precedent) or a public-issues repository with a narrowly scoped
  token are the choices §12 puts to the owner; neither is decided here.
