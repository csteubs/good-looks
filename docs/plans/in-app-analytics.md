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
  mailbox address every `emailCode` step carries and the mailbox endpoint
  and token (`main/recorder/types.ts:517`, `mailbox-store.ts`) — so e-mail
  addresses do live in the library even though no store holds the user's
  own — and the machine's userData path.

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
   renderer-egress allowlist (if the renderer contacts it) or in `check:main-egress`, the
   main-process equivalent this plan adds in Phase 0 — there is none today:
   every existing check pins a payload or the renderer, so `api.anthropic.com`,
   `api.github.com` and Playwright's CDN are reachable from `main/` with
   nothing written down — with its reason. An SDK that loads a remote script
   at init is a second host and a second line.
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
| Application menu (App, File, Edit, View, Window, Help — twelve Help items, all documentation) | `main/index.ts:383-484` | `openSettingsPane` funnel + explicit per item |
| `goodlooks://` deep links | `main/shell/deep-link.ts` | explicit (`hasRun`, `hasStep` — never the URL) |
| Desktop notifications (run, AI debug, insights) | `run-notifier.ts:141`, `ai-debug-notifier.ts:47`, `insights-notifier.ts` | explicit (kind only) |
| Native OS dialogs — the open-file picker behind Import from files (Home, the rail's Add menu, ⌘K `import-files`), the save dialogs behind report export and the PDF, message and error boxes | `preload.ts:69-80`, `renderer/lib/import-from-files.ts:28`, `report-emitter.ts:117`, `insight-report-pdf.ts:33` | explicit at the `dialog:*` host channels (kind and outcome; never a path) — none of them enters any DOM |
| External link opens (documentation links, PR links) and clipboard writes (the MCP install command, which names the Electron binary's path) | `host-handlers.ts` `shell:openExternal`, `documentation-pane.tsx:75,225-254`, `branch-menu.tsx:80` | explicit (link kind; never the URL or the copied text) |
| The training browser's **native HTTP basic-auth prompt** — shown on a 401 when the test has no password variable | `recorder-service.ts:2450-2457` | explicit, kind only: an OS dialog no renderer or replay sees, and a credential typed into it |

### 4.2 Shell chrome and global controls

| Surface | Where | Reported by |
|---|---|---|
| App strip: back / forward, breadcrumb, history keys | `renderer/main/app-strip.tsx` | router subscription |
| Library rail: test rows, groups, tags, Add menu, custom order, the Routines rail, the Branches row + flyout, the Insights row | `library-sidebar.tsx`, `routines-rail.tsx`, `branches-rail-row.tsx`, `insights-rail-row.tsx` | explicit on row activation (test **id**, never name) |
| Command palette ⌘K — every command runs through one `go()` wrapper | `command-palette.tsx:103` | chokepoint (command id + group) |
| Keyboard shortcuts — seven separate `keydown` listeners (two on `document`), no registry, plus CodeMirror's own keymaps, snippets and the play-step chord; ⌘R pause/resume in the trainer | `layout.tsx:1127`, `boot-plate.tsx:122`, `rail-flyout.tsx:227`, `primitives/menu.tsx:116`, `command-palette.tsx`, `use-play-step-shortcut.ts`, `editor-keymaps.ts`; `recorder-service.ts:1947` | explicit per listener — a window-level capture listener would miss the `document` ones and the editor's |
| Toasts — 248 call sites through one re-export | `renderer/ui/overlays.tsx:630` | chokepoint (toast kind; **never the message**, which quotes paths and URLs) |
| Native popup menus — `Select`, `DropdownMenu`, Add-test, Manage-stats, step actions, assertion kinds; options **never enter the DOM** | nine `popup` call sites: `native-menu.tsx:253,424`, `step-row.tsx:428`, `library-sidebar.tsx:583`, `edit-steps-view.tsx:163`, `stats-view.tsx:409`, `trainer-actions.ts:145,169`, `url-bar.tsx:117` — all through `preload.ts:113` | chokepoint at `Menu.popup` with a required `menuId`; the chosen command id only for the fixed menus, "a pick happened" for `Select` rows (whose command ids can be a model name or a host) — DOM autocapture cannot see these |
| Job ticker; AI debug chip; pending branch switch (module-level bus, no IPC) | `job-ticker.tsx:100`, `ai-debug-chip.tsx`, `pending-branch-switch.ts:29` | explicit |
| DOM menus, distinct from the native popups: the rail flyout (portalled, its own `document` keydown), the library's Radix context menus (group Rename / Ungroup; per-test Reveal in Finder / Duplicate / Delete / Tags), the tag-cluster delete dialog | `renderer/theme/shell/rail-flyout.tsx`, `library-sidebar.tsx:367-379,624-648`, `tag-cluster.tsx:115-122` | explicit on item select (item id) — these ARE visible to DOM autocapture, which is one more reason not to rely on it |
| Home: the four primary buttons (Record, Generate, Import folder, Import git) and the stat tiles that navigate (Tests, Green · 7d, Heals to review) — the activation funnel's first clicks | `home-view.tsx:114,206-245` | explicit (button id) |
| Settings-open push (menu, Help, AI connection footer) | `root-view.tsx:130-143` | explicit (entry source) |

### 4.3 Dialogs and panels

| Surface | Where | Reported by |
|---|---|---|
| New recording; Generate test from prompt; Generate steps with AI; Import from git; Duplicate; Tags; Group name; Create flow; Flow arguments (`flow-args-fields.tsx:139`); Missed runs; Load failed; Exit/save confirmation; Refine selector; Issue compose; AI debug (dialog + step dialog); Stats log inspector; Proxy validation; Delete test; Rename test; script-changed-on-disk and diverge confirmations; the Accessibility tab's accept-this-step / accept-every / forget / accept-rule-everywhere dialogs (`a11y-panel.tsx:75,271,285`, `a11y-view.tsx:219`); the Heals view's delete-record dialog (`heals-view.tsx:369`); Visual's Masks & baselines and annotation edit/clear (`visual-view.tsx:1187,1105,1117`); Routines' schedule picker (`schedule-picker.tsx:270`), open-N-windows and delete-routine confirmations (`batch-view.tsx:2179-2208`); Stats' reset / delete-all / delete-AI-history confirmations and Delete logs by date (`stats-view.tsx:443-449,997-1025`) | `renderer/main/*.tsx`, `renderer/components/issue-compose-dialog.tsx`, `renderer/settings/panes/proxy-pane.tsx` | explicit open / confirm / cancel per dialog, from one `useDialogEvent` hook — and a **required `name` prop** on `Dialog` / `AlertDialog` in `renderer/ui/overlays.tsx` (no raw Radix dialog import exists outside `renderer/ui/`), so an anonymous dialog is a type error |
| Test detail tabs — Steps (edit view + insert cursor), Script (CodeMirror + inspections + AI panel), Variables, Heals, Accessibility, run history, run output, run summary, triage, failure reason | `test-detail-view.tsx:1619` (`TabsRoot onValueChange`) and the per-tab mutations | chokepoint on tab change; explicit for edits (count of steps changed, never content) |
| Stats: the category board and six dashboards (outcomes, speed, steps, a11y, visual, AI debug), the weekly digest, the flake / cost / divergence / step-health / suite-cost panels, report export, the Manage menu (reset, delete all, delete by date, delete AI-debug history, reveal logs folder), the pager | `renderer/main/stats/*-dashboard.tsx`, `category-board.tsx`, `digest-panel.tsx`, `renderer/main/*-panel.tsx`, `stats-view.tsx:409-436`, `pager.tsx` | route (`$category`, `$facet`) + explicit for actions (export kind, manage choice, page turned) — the dashboards are what a product manager asks adoption of, so each is a facet id, not "Stats" |
| Test detail below the tab strip: run history, run summary, run triage, failure reason, step health, heals panel, script outline, script AI panel, script change rows, variable picker, diff view | `run-history-panel.tsx`, `run-summary-panel.tsx`, `run-triage.tsx`, `run-failure-reason.tsx`, `step-health-panel.tsx`, `heals-panel.tsx`, `script-outline-panel.tsx`, `script-ai-panel.tsx`, `script-change-row.tsx`, `renderer/components/variable-picker.tsx`, `diff-view.tsx` | explicit for the decisions made there (triage verdict, failure reason chosen, heal accepted, change applied) — where the outcome events of §5.1 are actually clicked |
| Script editor: ghost-text accept (Tab) / dismiss (Escape) — the acceptance rate DECISIONS 2026-08-23 says nothing measures — keymap choice, snippet expansion | `renderer/main/ghost-text.ts:70`, `editor-keymaps.ts`, `editor-snippets.ts` | explicit (`ai_resolved` for ghost text; kind only for the rest) |
| Visual, Accessibility, Heals, Insights, Branches, Routines actions — 8 + 11 `useMutation` hooks and the batch controls | the views' mutation hooks | explicit outcome events at the handlers that matter (accept a heal, apply a propagation, generate a report, switch a branch); a `MutationCache` observer was considered and deferred — it needs a `mutationKey` on some sixty sites for a breadth the outcome events already give |

### 4.4 Settings

| Surface | Where | Reported by |
|---|---|---|
| 18 panes on the board, in the rail, and by search | `renderer/lib/settings-schema.ts` (`PANES`) | router subscription (`$pane`) + explicit for search (query **length** and match count only) |
| 96 rows in `SETTING_INDEX` — every persisted write goes through **one** optimistic `save(patch)` | `settings-controller.tsx:365` → `recorder:setSettings` | chokepoint: row id + key **names** + boolean/enum values; numbers and free text never (`userStylesheet`, `userInitScript`, `aiInstructions*`, `proxyUrl`, `costHourlyRate`) |
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
| The trainer panel's **own** exit dialog and its **own** `Toaster` — the recorder store raises thirteen toasts in both windows | `trainer-panel-view.tsx:836`, `renderer/trainer/index.tsx:52` | main-process events for the lifecycle; the toast seam must dedupe per window or every trainer toast counts twice |
| Drag-and-drop reordering — steps, flow scope, routine order — the gesture before `reorderStep`, which can be abandoned mid-drag | `step-row.tsx`, `edit-steps-view.tsx`, `flow-scope-editor.tsx`, `batch-view.tsx` | explicit (`drop` with a kind; the abandoned drag is the interesting count) |

### 4.6 Backend-only surfaces

| Surface | Where | Reported by |
|---|---|---|
| ~287 `ipcMain.handle` registrations across 35 namespaces, bare, in one `registerHandlers()` — no wrapper, no timing, eight `catch` sites | `main/handlers/index.ts:184` | a registration wrapper: channel, duration bucket, error class — **never arguments or results** (they carry keys, URLs, passwords) |
| ~35 push channels through `sendToMain` (+ three direct `webContents.send`) | `main/services/app-window.ts:58` | the same wrapper on the push side; `check:push-consumers` already requires every push to have a listener |
| Run completion record (status, duration, browser, trigger, retries, heals) | `playwright-runner.ts` | derived event from the record — the one place run outcomes are already summary-only |
| Debug screenshots (⌘⌥⇧S, Capture now, MCP `capture_app`) | `debug-capture.ts:164` | explicit (source; never the images) |

### 4.7 Beyond the main window — fifteen execution surfaces, three with a user

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
| `good-looks` CLI — the subcommands are dispatched in `bin/good-looks.mjs:49-145` (`run`, `install`, `export`, `ingest`, `data-dir`, `help`, `--version`); `cli/args.mjs` parses only `run` and `install` flags, so a harvester reads `bin/`, not `cli/` | a CI runner | **inert** — and structurally: the CLI never calls `process.exit`, so an SDK with an exit-time flush or a keep-alive timer would hang or truncate piped stdout (`check:cli-exit`) |
| GitHub Action (`action.yml` — inputs including `install-deps` and `working-directory`, outputs `exit-code` and `junit`) | no | inert; always CI; an input is attacker-controlled the moment a workflow passes it a PR title, so no analytics flag is ever added there |
| Mailbox worker (`workers/mailbox`) | no (user-deployed) | not an app surface; Cloudflare's own observability |
| Browser preview (`npm run dev:web`; **published to public GitHub Pages from `main`** when `ENABLE_PAGES` is set; its `?view=` set includes `trainer-panel`, `chrome` and `bar-lab` beyond the ones CLAUDE.md lists) | a visitor | in-memory sink only, selected by `window.__preview`; the shared renderer entry must refuse any provider client there — a demo on a public URL against fixtures must not phone home |
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

Every entry also carries a **tier**: `product` (leaves the machine when
consent is on) or `breadcrumb` (ring buffer only, never sent). `ipc_invoked`
and `push_sent` are breadcrumb-tier — which is what keeps 287 channel names
and the vendor's per-event bill out of the product stream — and credential
channels carry a `silent` class in `IPC_CHANNEL_CLASS`, so a channel NAME
cannot say that a credential was set.

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
- **Every `RecorderSettings` key is classified once, as data**: `SAFE_VALUE`
  (booleans, enums — the value travels), `KEY_ONLY` (numbers, lists — the
  change travels, the value does not) or `NEVER` (free text, URLs, hosts —
  not even the key name). `setting_changed` is built from that table, read
  from the module the store reads, so a new key is unreportable until
  somebody classifies it.

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
`check:renderer-egress`) is a **bijection, not an allowlist**. One harvester
per surface kind that already has an owning module — routes from the
router's route table, panes from `PaneId`, rows from `SETTING_INDEX` *and*
keys from `RecorderSettings`' defaults (both, because they already disagree
by two rows), commands from the palette's builders, dialogs from the
required `name` prop's call sites, menus from the nine `popup` sites'
`menuId`, Help labels from the menu template, push channels from
`sendToMain`, IPC channels from `ipcMain.handle`, MCP tools from
`registerTool`, CLI subcommands from `cli/args.mjs` — and it asserts
`harvested == SURFACES ∪ WITHHELD` and `SURFACES ⊆ harvested`, failing with
the name of the surface on either side. `WITHHELD` is a map, not a list:
every entry carries a written reason the check prints (the `push-consumers`
argument against allowlists — a bare exception is the thing nobody
re-reads). Every harvest has a **floor**, so a regex that stops matching
fails as a broken check rather than passing as an empty set.

`check:analytics-schema` walks every `track(` call site and refuses what
the type system cannot: a spread into the properties object, a template
literal, `String(`, and any expression ending in `.message`, `.url`,
`.href`, `.pathname` or `.name`; and it refuses a catalog property whose
type is `string` or bare `number`, or whose name is on the reserved list
(`url`, `host`, `name`, `path`, `message`, `query`, `value`).

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
- **The ledger** — the exact bytes of every batch that left, kept locally
  and capped, and shown by the Settings viewer (rule 8): "what was sent" is
  answerable after the fact, not reconstructed from what should have been.
- **The queue** — append-only JSONL under `userData/recorder/analytics/`,
  capped by count and age (Sentry's 30 / 30 days are sane defaults), flushed
  on a timer and at `before-quit`, batch POST through `appFetch` with a hard
  timeout, retries with backoff, every failure logged and swallowed
  (rule 5). Nothing in the app reads `navigator.onLine` or `net.isOnline`,
  so the queue assumes it may be offline indefinitely and the age cap is
  what bounds it. And **the app takes no single-instance lock**
  (`second-instance` is handled for deep links, `requestSingleInstanceLock`
  is never called), so two instances or a branch relaunch can share
  userData: the queue, the consent file and the install id are written
  atomically (temp file + rename, the credential stores' pattern) and
  re-read rather than cached — §12 asks whether the lock should come first.
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
| explicit outcome events at mutation handlers | the outcomes the product questions need | the long tail of writes — a `MutationCache` observer is the later, breadth-only option |
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
- **Its transport is Electron `net.request` on the SDK's own session
  partition, not `appFetch`** (per the provider-first strategist's reading of
  the SDK source; *re-verify before adopting*) — adopting it is a written
  exception to rule 6. Its default integration set includes screenshots,
  local variables and minidumps; if it ever ships, the integration list is
  curated and **pinned by name in a check**, `beforeSend` runs
  `redactWithSnapshot`, and `release` is `app.getVersion()`.
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
code, window label) rather than only log lines. Two things the inventory
found decide the shape: the renderer contains **no `console.error` at all**
— every handled failure is one of 247 `toast.*` calls, so the toast seam,
not the console forwarder, is where handled errors become `error_seen`
(kind only); and the untrusted `pageView` uses `console-message` as its
**capture channel** (`recorder-service.ts:2637`), so error capture is never
attached there, and the breadcrumb ring is fed by the catalog, never by
`logger` — the page-guard log lines already carry URLs. This is the data
the feedback flow attaches, and it is useful with no provider at all.

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
middle. If it is ever started it starts from `main/shell/` before `ready`,
re-exported through `backend.ts` and stubbed in `shell-backend-stub.ts`,
because only `main/shell/` may import `electron`; and `uploadToServer:
false` still writes minidumps — memory of a process holding decrypted
credentials — to disk beside the encrypted stores, which is why "never
start it" is a real option in §12.

### 9.4 Log shipping, never automatic

`main.log` routinely carries page content and hostnames. It is attached to
a *feedback report* after redaction and a preview, and only then (§10).
Rotation is a prerequisite and cheap: `main.log` grows without bound today.

## 10. Feedback filing

Build it on the issue tracker that exists, not beside it.

- **Entry points, each a catalog event:** Help → "Report a problem…"; ⌘K
  "Report a problem"; a "Something wrong here?" affordance in the settings
  Diagnostics pane; a "Report this" button on the root error boundary, with
  the error event pre-attached; and the existing per-failure "Send to the issue tracker"
  action gains a "This is a bug in the app, not the site" checkbox that routes
  to the app's own tracker rather than the user's.
- **Two destinations, one provider interface.** The user's tracker (Linear or
  GitHub, already configured) for their own tests; **the app's own tracker**
  (a GitHub repository the maintainer owns, or a Linear team) for feedback
  about the app. The second needs a credential the *user* does not hold —
  §12 asks whether that is a public-issues repo with a scoped token shipped
  in the build, a relay endpoint the maintainer runs (the mailbox worker is
  the precedent for "a small worker the repo owns"), or e-mail. One fact
  shapes the answer: the GitHub provider declares `supportsImageUpload:
  false` (`github-provider.ts:73`; Linear's is `true`), so a GitHub-hosted
  inbox never receives a screenshot unless the relay stores it — a retention
  obligation the maintainer would own.
- **The draft is pure and pinned** the way `buildIssueDraft` is: title, free
  text the user typed, the current route and test id (id, not name), app
  version, Electron and OS versions, the settings snapshot as **key names and
  booleans only**, the last N breadcrumbs, the error events from §9.1, a
  redacted `main.log` tail bounded at 200 lines and 32 KB — every one shown in the compose dialog before
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
| **0 — Decide** | Answer §12. Fix `app:getInfo` (or delete it) so the app reports its real version; index the two settings rows that are outside `SETTING_INDEX`; route `mailbox-service.ts:58` through `appFetch` and `issue-tracker-service.ts:294` through `allRedactableValues()` — two inconsistencies with rules 4 and 6 that the inventory found and that would otherwise be "fixed by analogy" later; add `check:main-egress` (an allowlist with reasons over absolute URLs in `main/**`, the renderer check's twin) so the provider host is later a one-line diff; widen `forwardRendererConsole` to take a `WebContents` and attach it to the trainer panel and the URL strip | four small PRs; a DECISIONS entry recording the answers and the vendor facts in §7 | S |
| **1 — Catalog and local sink** | `shared/analytics-catalog.mjs` (+ `.d.mts`); `analytics-service.ts` with the null and local sinks; the `track()` renderer API and `analytics:track`; the router, palette, `save()`, `Menu.popup`, toast, `MutationCache` and IPC/push wrappers; `useDialogEvent` adopted by every dialog; the recorder, runner, batch, routine and agent lifecycle events; the Settings *Privacy* rows with the local event viewer; `check:analytics-coverage`, `check:analytics-schema`, `check:analytics-egress`, `check:analytics-boot`; preview-bridge sink; the new store wired into the existing deletion affordances (Delete stats & logs, Delete logs by date, `runs:deleteAll`) and `retention.ts`, which today sweeps run artifacts only; ARCHITECTURE + DECISIONS. **Nothing leaves the machine.** | the catalog, the service, the gates, the viewer | L |
| **2 — Provider adapter** | One adapter behind the sink interface (Amplitude HTTP API over `appFetch`, or PostHog — §12), the consent dialog and version, the queue with retry and age caps, EU/US zone as a setting, the `check:main-egress` entry with its reason, the write key as a build-time `define` in `scripts/build-main.mjs` (none exists there today; `vite.config.ts:71` has one for the display name) so dev and branch builds are inert by construction, a dashboards-as-data doc mapping each product question to its events and chart, e2e row that an opted-in session sends exactly the catalog and an opted-out one opens no socket (a local HTTP listener as the collector, the way the agent-loop spec scripts an Ollama server) — **after** widening `e2e/app-launch.spec.ts:133-138`, whose clean-console assertion drops any error mentioning `127.0.0.1` or `localhost`, which is exactly where the collector would sit | one vendor, one host, one switch | M |
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
| `check:analytics-schema` | pure `tsx`, source-level | a `track(` call that spreads, templates, stringifies or reads `.message` / `.url` / `.name`; a catalog property typed `string` or named on the reserved list |
| `check:main-egress` | pure `tsx`, source-level | an absolute URL in `main/**` with no allowlist reason — the provider host, the relay host, or the next favicon-shaped surprise |
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

## 12. Open questions — the decisions only the owner can take

Every question below changes the work materially. Each names why it matters
in this repo, the realistic options, and the **default the phases in §11
proceed under until it is answered**. Phase 0 and Phase 1 need none of them
answered; each later phase is blocked by the ones marked for it.

### 12.1 Goals and audience

1. **Which product questions must the first release answer, and who reads
   the answers?** The catalog only earns its egress if each event serves a
   question. Options: a written list of 5–10 questions each mapped to events
   and a chart (a dashboards-as-data doc) / adoption counts only, no funnels /
   everything reportable, decide later. **Default:** the dashboards doc is
   written first with roughly eight questions (activation funnel, adoption per
   surface, AI acceptance per feature, heal acceptance, time-to-green,
   retention, error and crash rates, feedback volume); every product-tier
   event names the question it serves; anything unmapped is breadcrumb-tier.
   Blocks Phase 2.
2. **Is the audience for debug data the maintainer, users diagnosing their own
   installs, or both?** Today the only sink is `main.log` with no reader.
   Options: maintainer-facing (envelopes leave, opt-in) / user-facing only (an
   in-app error inspector and "attach to feedback") / both. **Default:** both —
   a local error ring always; hosted envelopes (class + fingerprint only)
   behind their own switch. Blocks Phase 3 scope and whether an error vendor
   exists at all.
3. **"Every surface CAN be reported on" (a gate proves each surface has an
   event) or "every surface IS reported" (everything emits once opted in)?**
   Options: a bijection with a `WITHHELD` map whose reasons the check prints /
   strict set equality, no exceptions / curated product events, coverage
   measured informally. **Default:** the bijection with written reasons
   (§5.5). Blocks the coverage gate's shape.

### 12.2 Users and identity

4. **What identity is attached to events?** No store holds a user e-mail
   today; the GitHub and Linear tokens are the only identity-adjacent data.
   Options: anonymous install id only / install id plus an optional
   user-supplied handle / a GitHub login derived from the token / session-only
   ids, unlinkable across launches. **Default:** anonymous install id; no
   account identity, ever. Blocks the envelope and the consent copy.
5. **When is the install id minted?** The four strategies split here.
   Options: on opt-in, deleted on opt-out (nothing on disk before consent) /
   at first launch, never sent until consent / at first launch, rotated on
   opt-out. **Default:** on opt-in; deleted on opt-out; re-enabling mints a
   fresh one. Blocks the consent store and the "nothing on disk before
   consent" assertion.
6. **May events carry a stable opaque per-test id?** A stable UUID lets
   recording → run → heal be joined across sessions (time-to-green,
   heal acceptance per test); a per-session keyed handle makes a test
   unlinkable across launches and removes those dashboards. Options: stable
   opaque test id (never the name) / per-session handle / no per-test
   identity. **Default:** stable opaque test id, with test name, start URL and
   hostname on the never-sent list. Blocks the product questions in 1.
7. **Must the MCP server and CLI honour the app's opt-in state, or do they
   emit nothing by design?** They share userData; any shared rule must be a
   pure `.mjs` in `shared/`; the CLI must never keep the event loop alive.
   Options: emit nothing, ever / read a shared consent rule and emit
   `run_finished` under the install id / an explicit `--analytics` flag on the
   CLI and Action (a new flag touches `cli/args.mjs`, the usage text and
   `check:github-action`). **Default:** emit nothing; their runs are visible
   only through the run record's `trigger` and, if 18 allows it, a bucketed
   library snapshot the app emits. Blocks Phase 7.

### 12.3 Consent and privacy posture

8. **Is a first-run consent surface acceptable, or must the switches stay
   off-until-found like every existing egress toggle?** Options:
   off-until-found, no prompt / a non-blocking home card after first launch
   that only opens the Privacy rows / the same card after the first saved
   recording / a modal (still opt-in). **Default:** off-until-found plus a
   dismissable card on packaged builds that only navigates to the rows; no
   modal. Blocks Phase 2 and the e2e clean-console spec if a card renders at
   boot.
9. **How many switches?** Options: one "usage reports" switch / two (usage;
   errors), feedback always explicit per send / three independent switches
   (usage, errors, replay) each with its own confirm-on-enable dialog naming
   host and payload. **Default:** three, each off, each with the
   `AlertDialog` pattern; feedback is additionally explicit per report.
   Blocks the Settings rows.
10. **Where do the rows live?** `PaneId` is a closed union mirrored in three
    records and a test that pins the last ungrouped segment. Options: rows in
    Integrations / rows in Diagnostics / a new Privacy pane / a new pane that
    also absorbs the existing egress switches. **Default:** rows in
    Integrations, with a "What leaves this Mac" summary linking the existing
    switches. Blocks Phase 2.
11. **What does a `consentVersion` bump do?** Options: turns the switch off
    until re-confirmed / only re-shows the notice / maintainer decides per
    release, pinned by a test that the constant changed when the property set
    did. **Default:** a hand-maintained constant; a bump turns the switch off;
    a check fails when the envelope's property set changes without a bump.
    Blocks the consent store.
12. **Is EU data residency required, and is the zone user-selectable?**
    Endpoints are verified (§7.1); the choice is policy. Options: EU only /
    US default / a zone setting / self-hosted only (PostHog). **Default:** EU
    as the only endpoint; no setting. Blocks Phase 2's allowlist line.
13. **Which value classes may ever leave?** Options: enums, booleans,
    bucketed counts and opaque ids only, numbers as "changed" / plus bucketed
    numeric settings / plus raw numbers (never text). **Default:** the first;
    `costHourlyRate` and every library-shape count are "changed: true" only.
    Blocks the catalog's type rule.
14. **Do IPC channel names ever reach the vendor?** They reveal feature use
    (`shopify:*`, `proxy:*`) and credential lifecycle (`llm:setApiKey`).
    Options: breadcrumb-tier, local only / `ipc_failed` with a `silent` class
    for credential channels / failures only, for channels with no product
    event. **Default:** local only. Blocks the IPC wrapper's tier.
15. **Is unattended in-app activity (routines every minute, insights ticks,
    propagation) reported under the install id?** Options: reported with
    `trigger: schedule`, excluded from "active user" / kept local / not
    counted anywhere. **Default:** reported with the trigger; "active user" is
    renderer-originated events or `trigger: manual` only. Blocks the
    engagement definition.
16. **Is the recorded site's hostname ever a property?** Options: never;
    scheme and `isLocalhost` booleans only / eTLD+1 hashed with the install
    id / full hostname. **Default:** never.
17. **Is the Settings search query reportable in any form?** It is free text
    and host-bearing. Options: length bucket plus a zero-result boolean /
    zero-result boolean only / not reported. **Default:** length bucket and
    zero-result boolean; never the text.
18. **May a bucketed daily library snapshot leave (tests, hosts with
    standing instructions, signatures, runs by trigger, which integrations
    are configured)?** It is a configuration fingerprint, and the only way to
    see MCP/CLI adoption without those processes emitting. Options: bucketed
    snapshot / counts on the never-sent list / integration booleans only.
    **Default:** absent; revisit after Phase 2 with real volumes.

### 12.4 Providers, transport and budget

19. **Which analytics provider and transport?** The CSP blocks any CDN
    snippet in every window; `connect-src https:` would let a bundled
    renderer SDK POST from the two app windows where the renderer-egress
    check cannot see it. Options: Amplitude HTTP API from main over
    `appFetch`, no SDK anywhere / a bundled browser SDK in the renderer with
    an allowlist entry / PostHog self-hosted behind the same sink interface /
    FullStory self-hosted script (only if replay is wanted). **Default:**
    Amplitude's HTTP API from main; the renderer emits over one IPC channel.
    Blocks Phase 2.
20. **Is honouring Settings → Proxy a hard requirement for every sink, or may
    a vendor SDK own its transport "with disclosure"?** This decides whether
    `@sentry/electron` (its transport is Electron `net`) is eligible at all.
    Options: hard requirement / an exception for the error vendor, disclosed
    in the row's risk copy / no requirement. **Default:** hard requirement;
    a sink that cannot use `appFetch` gets a custom transport or is out.
21. **Where does the write key live?** `check:repo-hygiene` would not see an
    Amplitude key in source. Options: a build-time `define` in both
    `vite.config.ts` and `scripts/build-main.mjs`, absent in every
    non-package build / a named constant in source plus a hygiene pattern /
    an environment variable read at runtime. **Default:** the `define`;
    absence makes every sink a no-op, which is what keeps dev, e2e, CI, the
    preview and branch builds inert by construction. Blocks Phase 2.
22. **What is the budget and expected volume?** Pricing is unverified for
    every vendor. Options: free tier, catalog sized to fit / a paid plan up to
    a stated cap / self-hosted to avoid per-event cost. **Default:** free
    tier; only product-tier events leave; queue capped at 500 events / 7 days.
23. **Is an error vendor wanted at all, or do error envelopes (class +
    fingerprint + surface) go through the analytics sink?** Options: no
    vendor / Sentry with a curated integration list pinned by name and
    `beforeSend` over the redaction snapshot / a self-hosted collector later.
    **Default:** no error vendor in the first release. Blocks Phase 5.

### 12.5 Session replay

24. **Is replay of the app UI wanted at all?** Options: no (drops FullStory
    from consideration) / deferred behind a masked-playback spike with a
    block-everything default / yes, mask-by-default with an unmask allowlist /
    yes, with the trainer surfaces excluded entirely. **Default:** not in
    scope; §8 stays a spike gated on a later yes. Blocks Phase 6.
25. **If enabled, are `RecordingView` and the trainer panel excluded entirely
    or masked element by element, and does replay run in both windows (two
    streams for one session)?** **Default:** both trainer surfaces and the
    URL strip excluded; text masked everywhere else; one instance, in the
    main window.

### 12.6 Debug and crash data

26. **Which crash surfaces are in scope?** Options: every app-owned process
    and window, never `pageView` / the main window and main process only /
    everything including child exit codes as health events. **Default:** all
    app-owned surfaces: widen `forwardRendererConsole` to a `WebContents`,
    attach it to the trainer panel and the URL strip, add the main-process
    handlers and a child-exit event; `pageView` excluded by name. Blocks
    Phase 3.
27. **Native crash dumps: never start `crashReporter`, start it with
    `uploadToServer: false` and offer dumps as a consented attachment, or
    prompt-after-crash upload?** A minidump is process memory holding
    decrypted credentials and typed values; even local-only dumps land on
    disk beside the encrypted stores. **Default:** never start it; JS-level
    envelopes only. Blocks Phase 5.
28. **What error content may leave?** The redaction snapshot knows secrets,
    not hostnames or the URLs a load-failed message quotes. Options: class +
    in-bundle fingerprint + surface / plus a redacted message with a length
    cap / plus in-bundle stack frames. **Default:** class + fingerprint +
    surface; the message stays in the local ring for feedback attachment.
29. **Does `uncaughtException` in main keep Electron's default dialog after
    logging, or degrade silently like every other unattended path?**
    **Default:** log and emit, then let Electron's default proceed; a
    "Report this" surface appears on the next launch from the persisted
    envelope.
30. **Do analytics events double as the breadcrumb ring, and how many are kept
    when the usage switch is off?** **Default:** one catalog, two consumers;
    a bounded local ring of 200 in its own JSON store, present regardless of
    consent, never sent unless attached to a report.
31. **Does `main.log` gain rotation in this work?** A bounded, redacted tail
    is a prerequisite for any log attachment. Options: rotation and a cap in
    Phase 0 / a bounded tail read only / never attach logs. **Default:** a
    bounded tail (200 lines / 32 KB) read backend-side and redacted; rotation
    lands in Phase 3.

### 12.7 Feedback filing

32. **Where does app feedback land?** The user does not hold a maintainer
    credential; the GitHub provider cannot carry images. Options: a relay
    Worker the repo owns posting to a maintainer GitHub repository (images
    stored by the Worker or dropped) / the same relay to a Linear team (images
    travel) / a scoped token in the build posting to GitHub directly / e-mail
    through the mailbox Worker. **Default:** a relay Worker under `workers/`
    to a maintainer GitHub repository, text-only; attachments only if the
    owner accepts Worker-side storage with a stated retention. Blocks
    Phase 4.
33. **May an app-bug report also go to the user's own tracker, and does the
    per-failure dialog gain a "this is a bug in the app" switch?**
    **Default:** a separate "Report a problem" dialog to the app's tracker;
    the per-failure dialog untouched.
34. **What does a report contain by default and what only behind a
    checkbox?** Screenshots cannot be redacted and the debug captures include
    the untrusted training page; step lists and replay logs carry typed
    values. **Default:** versions, surface, settings snapshot (key names and
    booleans/enums), the breadcrumb ring by default; log tail and screenshots
    behind checkboxes with a backend-built preview; never the step list,
    cookies or replay logs.
35. **Which entry points?** **Default:** Help menu, ⌘K, and a "Report this"
    on the error boundary with the error pre-attached; no entry in the
    trainer panel (the main window's `RecordingView` shares the dialog).
36. **Should a report link back into the app beyond `test/<id>`, and should an
    About or version row exist?** The deep-link parser refuses every other
    form by design; nothing exposes the app version to the renderer today.
    **Default:** fix `app:getInfo` to return the real version and environment
    flags (used by both the event context and the dialog); no new deep-link
    forms.
37. **Do CLI and Action users get a feedback path?** Today: exit code and the
    JUnit report. Options: none / a `good-looks doctor`-style local bundle the
    user files by hand / a flag that emits an envelope to stdout.
    **Default:** none; documentation points at the app.

### 12.8 Coverage and the catalog

38. **What counts as a surface for the gate, and from which owning module is
    each harvested?** **Default:** every kind with an owning module (§5.5);
    keyboard chords and toasts withheld with a written reason; the two
    unindexed settings rows indexed in Phase 0.
39. **The required identity prop on primitives: `name` on
    `Dialog`/`AlertDialog` and `menuId` on every popup, typed from the
    catalog?** It touches every dialog file and the nine popup sites in one
    PR. **Default:** yes, `name` and `menuId`, instrumented at the
    `overlays.tsx` and `native-menu.tsx` seams rather than per component.
    Blocks Phase 1's wide PR.
40. **Where does the catalog live?** **Default:** `shared/` for the envelope,
    the type rule, the tier and the never-sent list; per-kind vocabularies
    asserted equal to their owners by a unit test rather than copied (§5.1).
41. **Which product events are mandatory in the first catalog?** **Default:**
    the full set in §5.1, each emitted at its backend seam so the trainer
    panel's second rendering never double-counts.
42. **Is `setting_changed` emitted from the renderer's optimistic `save()` or
    from the backend handler, where values are normalised and where writes
    from other views also land?** **Default:** the backend handler, with the
    per-key classification (§5.2); credential channels emit outcome-only
    events; `proxyUrl` removed from the store's local "Saved trainer
    settings" log line while there.
43. **Native-menu choices: the chosen command for fixed menus and only
    "picked" for `Select` rows over user data?** **Default:** yes; the
    catalog marks each `menuId` static or dynamic.

### 12.9 Non-app surfaces, rollout and distribution

44. **Do dev checkouts and branch builds ever emit?** Options: never, inert by
    key absence / a maintainers-only "send from dev builds" row / an
    environment-variable override. **Default:** never; `environment` remains
    a context property when a packaged build sends.
45. **Must the public GitHub Pages preview and the specimen page be proven
    inert by a boot check with a socket spy, or is the preview bridge
    answering "disabled" enough?** **Default:** both.
46. **Must code signing, notarisation and an update channel land before a
    write key ships?** The mac build is unsigned with target `dir`; a leaked
    key cannot be rotated in installed copies. Options: yes, prerequisite /
    no, a re-package is acceptable and the key is a public write key /
    analytics ships behind the `define` only after the first signed release.
    **Default:** not a prerequisite; the key is treated as
    public-but-rotatable by re-packaging, and the risk is written into
    DECISIONS. Blocks the ordering of Phase 2 against a distribution project.
47. **What is the first shippable increment?** Options: local-first (catalog,
    ring and gate with nothing leaving; sink later) / consent and sink first /
    feedback first (highest user value, reuses the issue-tracker pipeline).
    **Default:** local-first, as §11 orders it.

### 12.10 Ownership, operations and gates

48. **Who owns the vendor account, the relay Worker (deployment, its token,
    screenshot retention) and the dashboards, and are dashboards kept as data
    in the repo?** **Default:** the maintainer owns all three; dashboards are
    documented event → properties → chart so a vendor swap re-creates them.
49. **Does the "last N events sent" ledger live beside the switch or in
    Diagnostics?** **Default:** beside the switch, readable and exportable.
50. **Does a user-facing privacy document join the in-app manual?** Only
    three docs are parsed today; slugs must be unique across all of them.
    **Default:** a fourth shipped doc with its own slugs, linked from the
    consent rows.
51. **Which checks are required, and in what shape?** **Default:** all five
    in §11.1 (`main-egress`, `analytics-egress`, `analytics-schema`,
    `analytics-coverage`, `analytics-boot`), each wired into `test:checks` in
    the same commit; plus one e2e row against a local collector, because
    only a real window can show whether a socket opens.
52. **Is instrumentation confined to the seams (components untouched), or
    are auto-instrumenting hooks acceptable given the React compiler runs
    only in the Vite build?** **Default:** seams only.

### 12.11 Prerequisites and state on disk

53. **Are the two observed inconsistencies in scope for Phase 0** — the
    mailbox probe's raw `fetch` and the issue tracker redacting over
    `testSecretsStore.allValues()` — **or filed separately?** The second is
    on the feedback path. **Default:** both in Phase 0, each with a
    planted-secret row (suggested as separate tasks alongside this plan).
54. **Should the capture script's verbatim recording of password-field values
    be changed first (recorded as secret variables) before any attachment
    or replay could include a step list?** It is a product behaviour change
    with its own plan. **Default:** not a prerequisite; step lists, replay
    logs and cookies are never attachable.
55. **Are the stale `app:getInfo` scaffold, the two unindexed rows, the
    main-window-only console forwarding and `proxyUrl` in the local settings
    log all fixed in Phase 0 regardless of provider?** **Default:** all four,
    each with a test that can fail.
56. **Should the app take `requestSingleInstanceLock()` before it writes any
    per-install file?** Two instances, or a branch relaunch, share userData
    with no locking today; the stores are read-modify-write JSON.
    Options: take the lock in `main/shell/` (a second launch focuses the
    first — a behaviour change users will notice) / atomic writes and
    re-reads only / leave it. **Default:** atomic writes and re-reads; the
    lock is a separate decision because it changes what a second click on
    the dock icon does.
57. **Do the analytics queue, ledger, breadcrumb ring and install id join the
    existing deletion affordances (Delete stats & logs, Delete logs by date,
    the retention sweep), and what is their retention?** A user who asks
    "what does this app hold about me" should get one answer. **Default:**
    yes to all three affordances; queue 7 days, ledger and ring 200 entries,
    the id until opt-out.
58. **May the Privacy rows (the ledger, the install id) appear in debug
    screenshots?** `capture_app` hands PNGs of every app window to whichever
    MCP client asks while debug screenshots are on. **Default:** yes — the
    ledger holds nothing the never-sent list forbids, by construction; the
    install id is shown truncated.

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
- *A gate that goes red for non-bugs.* Twelve regex harvesters over TSX is
  twelve places a legitimate refactor fails the build. The mitigations are
  structural: one harvester per surface kind that has an owning module (no
  harvester for keyboard chords or mutation keys in the first landing), a
  `WITHHELD` map with reasons instead of set equality with no exceptions,
  and floors that distinguish "nothing found" from "regex broke".
- *Two writers, one userData.* No single-instance lock, and a branch relaunch
  shares the checkout's userData; the identity and consent files are the
  first per-install state this app has written that must survive that.
- *A pull request runs on the maintainer's library.* The branch switcher
  builds and relaunches any PR's head against the real userData; a
  telemetry change in a PR runs there. The write key being a package-time
  `define`, absent from every checkout build, is what keeps that from being
  an exfiltration path.
- *The key leaks into children.* Playwright children inherit the app's
  environment (`playwright-runner.ts:1165-1167`), and the Action maps inputs
  to env; a key or a sink selector carried as an environment variable would
  reach every spec process and every CI job. Hence the `define`, never env.
- *Local time versus UTC.* Routines fire on local-time cadences
  (`shared/routine-schedule.mjs:25`) and events are stamped in UTC; DST and
  travelling laptops shift `schedule` runs relative to event time, and
  clocks can simply be wrong. Timestamps are stamped in main from one
  clock, and a test of any bucketing `delete`s `TZ` rather than assigning
  it (CLAUDE.md's gotcha).
- *Cost.* Every provider bills by event volume; `recorder:state` is pushed on
  every transition and `runner:output` per stdout chunk, so a generic
  wrapper produces hundreds of breadcrumbs per run; `ipc_invoked` on 287
  channels for every user would dominate. Breadcrumb tier never leaves, and
  the local viewer shows volume before anything is sent.

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
