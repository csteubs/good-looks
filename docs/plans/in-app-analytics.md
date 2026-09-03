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
   (§4.4) either do not load the layer or load a sink that writes nowhere.
8. **Visible.** Settings shows what is on, where it goes, and a way to see the
   last N events sent (the same "can anyone tell?" principle as the trainer's
   `signedRequests` tally).

<!-- WORKFLOW:INVENTORY -->

<!-- WORKFLOW:EVENT-MODEL -->

<!-- WORKFLOW:ARCHITECTURE -->

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
  The node package uses its own HTTP client (proxy support *unverified*).
- **Session replay** is a separate plugin, `@amplitude/plugin-session-replay-browser`:
  rrweb DOM snapshots, **no remote script**, `sampleRate` required, all inputs
  masked by default, `.amp-mask` / `.amp-block` classes and a `privacyConfig`
  with `blockSelector` / `maskSelector` / `unmaskSelector` /
  `defaultMaskLevel` (*the last three per search summary — unverified*).
- **Electron.** No official Electron guide; the community answer is "Browser
  SDK in the renderer" (*unverified*). Nothing in the SDK depends on a real
  origin except the cookie default.

### 7.2 FullStory

- **Package.** `@fullstory/browser` (`fullstorydev/fullstory-browser-sdk`).
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

Nothing here forces one vendor. The architecture in §6 puts a **sink
interface** between the app and the provider, so the decision in §12 changes
an adapter, not the catalog, the consent surface or the gates.

<!-- WORKFLOW:REPLAY -->

## 9. Debug data

The order below is the order of value per unit of risk; each step is a
phase-3 deliverable in §11.

1. **App-level error capture with no vendor.** `process.on("uncaughtException")`
   and `unhandledRejection` in main (log, then let Electron's default dialog
   behaviour stand — today the app has no handler at all), a renderer error
   boundary that records the route and component stack to `main.log` through
   the existing console forwarder, and `render-process-gone` /
   `child-process-gone` / `unresponsive` recorded as *events* (kind, reason,
   exit code, window label) rather than only log lines. This is the data the
   feedback flow attaches, and it is useful with no provider at all.
2. **Breadcrumbs = the analytics events, kept locally.** The last N catalog
   events (§5) in a ring buffer in main — route changes, commands, dialog
   opens, IPC failures — are the "what were they doing" a crash report needs.
   One producer, two consumers; no second instrumentation.
3. **A crash reporter.** Electron's `crashReporter` (through `@sentry/electron`
   or bare `crashReporter.start` to a self-hosted minidump endpoint) — opt-in
   separately from analytics, because a minidump is memory and §2.2 lists
   what is in this app's memory. Off by default in any case; if on, the
   `uploadToServer` decision is the user's, and the plan asks in §12 whether
   "prompt after a crash" is the acceptable middle.
4. **Log shipping — never automatic.** `main.log` routinely carries page
   content and hostnames. It is attached to a *feedback report* after
   redaction and a preview, and only then (§10).

Rotation is a prerequisite for 4 and cheap: `main.log` grows without bound
today.

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

<!-- WORKFLOW:PHASES -->

<!-- WORKFLOW:QUESTIONS -->

<!-- WORKFLOW:RISKS -->
