# Multiple tabs — design

**Status:** design, written 2026-09-02. Nothing below is built.

Companion documents: [../ARCHITECTURE.md](../ARCHITECTURE.md) for what exists,
[../DECISIONS.md](../DECISIONS.md) for why, [../IFRAMES.md](../IFRAMES.md) for
the engine-first precedent this plan follows.

## The problem

A recorded click on a `target="_blank"` link, or on a control that calls
`window.open`, passes in the trainer and fails on every run.

In the trainer it passes because the capture script rewrites the clicked
anchor's `target` to `_self` before the browser follows it
(`main/recorder/capture-script.ts:579` `keepInWindow`), injects
`<base target="_self">`, and the recorder window denies every `window.open`
through `setWindowOpenHandler` (`main/services/recorder-service.ts:2558`),
re-issuing the URL in the same window. The recording therefore looks like a
click followed by a same-tab navigation, and the steps after it are captured
against the new document.

On a run none of that exists. Real Playwright honours the `target`, the new
document opens as a second `Page` in the same `BrowserContext`, and the
generated spec's one `page` (`main/services/script-generator.ts:2285`
`async ({ page })`) stays on the opener. Every later locator resolves against
the wrong document and every `toHaveURL` reads the old address. The failure is
silent in the sense that matters: the trainer showed the journey green.

Nothing in the model can express a second tab. `StepType`
(`main/recorder/types.ts:44-180`) has no page concept, `root()` seeds every
locator with the literal `"page"` (`script-generator.ts:180-183`), and the
run fixtures patch the one fixture `page` instance (see "Where we are").

## Two features, and the order

*Same-tab policy* and *multi-tab support* are different features, and both are
needed:

- **Same-tab policy** — a run option that makes a run behave the way the
  trainer already does: every `_blank` target and `window.open` stays in the
  one page. Small, and it is the **migration path**: every test recorded so far
  that clicks a `_blank` link was recorded under exactly this policy, and
  re-recording them is not an answer. It is also the right behaviour for a test
  whose subject is what is *behind* the link, not the tab.
- **Multi-tab support** — a `popup` step that expects the previous step to open
  a page and a `switchPage` step that moves later steps onto one, so a test
  whose subject IS the second tab (an OAuth popup, a "preview in new tab", a
  help centre) is writable, runnable and eventually recordable.

Engine first, trainer last, as `docs/IFRAMES.md` argued and as landed: a
multi-tab test is **writable and runnable** (hand-written, AI-written,
imported) before it is **recordable**. The trainer half is where the cost is
(a second `WebContentsView`, a tab strip, replay across tabs) and every one of
the engine phases is useful without it.

## Where we are

| Layer | File | The single-page assumption |
|---|---|---|
| Model | `main/recorder/types.ts:44-180`, `:1245` `STEP_TYPES` | no page concept anywhere |
| Generator | `script-generator.ts:180-183` `root()`, plus 33 sites emitting the literal receiver `page` (list in Phase 1) | one receiver, `page`, seeded in `root()` and hard-coded everywhere else |
| Parser | `spec-parser.ts` — ~25 regexes anchored on `page\.`; `:1977` `expect(page)`; `:2333` the variable-action guard | a `pageN` receiver falls through to `parseLocator("pageN")` and counts as `skipped`, or is mistaken for a locator variable |
| Capture fixture | `shared/capture-fixture-source.mjs:452-463` `patchOnce` | `PAGE_ACTIONS` are wrapped on the fixture page **instance**; `LOCATOR_ACTIONS` on `Locator.prototype` (global, so a second page's locators ARE wrapped and screenshot `self.page()`) |
| Capture logs | `capture-fixture-source.mjs:210-278` `installLogCapture(page)` | console, pageerror, request, response on the one page only |
| Axe | `capture-fixture-source.mjs:574` `page.addInitScript` | page-level, so a second page has no `window.axe` and every per-step audit on it returns null |
| Heal | `shared/heal-fixture-source.mjs:385-395` factories on the page instance; `:495`, `:525`, `:546` probe and rebuild close over the fixture `page` | a second page's locators carry no heal key; even keyed, the probe would run on page 1 |
| Settle | `shared/settle-fixture-source.mjs:209-219` | same instance/prototype split as capture |
| User stylesheet | `shared/user-page-fixture-source.mjs:65-66` | `page.on("domcontentloaded")`, page-level (the init script at `:54` is context-level and already reaches every page) |
| Overlay counter | `shared/dismiss-fixture-source.mjs:175` `page.exposeBinding` | the watcher runs in every page (context init script); its dismissals on a second page go uncounted |
| Already context-wide | signature `context.route` (`signature-fixture-source.mjs:105`), `storageState`, both `addInitScript`s | nothing to do |
| Reporter | `shared/step-reporter-source.mjs:33-37`, `shared/step-marker.mjs` | keyed by spec line only; page-agnostic, which is fine |
| Artifacts | `artifact-store.ts:5` `<testId>/<runId>/<stepIndex>.png`, manifest entries `capture-fixture-source.mjs:403-406` | no page axis; a step's screenshot is of whichever page acted, unlabelled |
| Trainer | `recorder-service.ts:830` one `pageView`; `:2558` deny; `:2566` `did-create-window` closes strays; `capture-script.ts:579` `keepInWindow` | a popup cannot happen, by three layers of design |
| Trainer replay | `step-replayer.ts` resolves against `document` of the one page; every replay entry goes through `pageWc()` | a `switchPage` the replayer does not refuse previews later steps against the wrong document |

## The model

Two step types. Neither carries a locator; neither carries page-controlled
text that reaches generated source as anything but a number.

### `popup` — "expect the PREVIOUS step to open a page"

The `download` step's shape exactly (`types.ts:92-98`): the promise is armed
BEFORE the triggering step's line and awaited after, because a listener
attached after the click races the event it exists to catch. The generator
already has the pre-line hook for this (`script-generator.ts:1889-1892`) and
the backward walk that finds the trigger (`:1818-1842`).

```ts
// Step
| "popup"
// fields
timeoutMs?: number;   // existing field; the waitForEvent timeout
```

Emission, with `n` the popup's emission-order number (a fixed point on
regeneration, the same rule `download${n}` follows):

```ts
const popup1 = page.context().waitForEvent("page", { timeout: 30000 });   // armed before the trigger
let page1;
await page.getByRole("link", { name: "Open help" }).click();            // the trigger
await test.step("expect a new page", async () => {
  page1 = await popup1;
  await page1.waitForLoadState();
});
```

`page1` is declared at test scope beside the arming line, not inside the
wrapper: `stepOpen`/`stepClose` never wrap an arming line
(`script-generator.ts:1771-1780`) precisely so the awaited value lives in the
scope later lines read from. The `let` is one extra pre-line, attributed to
the trigger by the same `record1` call as the arming line.

**Why `context().waitForEvent("page")` and not `page.waitForEvent("popup")`.**
The `popup` event fires on the OPENER for pages it opened. The context event
fires for any new page, including one a form submit or a script on another tab
opened, and it fires on the receiver's context wherever the current receiver
is. One spelling for every case; the name `popup` is the user's word for it.

**`waitForLoadState()` is part of the step.** A new page begins at
`about:blank` and Playwright's own docs pair the two calls. Without it the
first assertion on `page1` reads the blank document.

**The popup step switches the current receiver.** After it, steps emit
against `page1` until a `switchPage` says otherwise. This matches what the
trainer will do when it opens a tab (focus follows) and what a hand-written
test means nine times in ten.

### `switchPage` — "later steps act on this tab"

```ts
| "switchPage"
// fields
pageIndex?: number;   // 0 = the original page; n = the nth popup, in step order
```

Emits nothing of its own. It changes the generator's current receiver, which
`root()` seeds and which the six emission helpers read. A `pageIndex` that
names a popup not yet declared at that point in the step list is
`UNGENERATABLE` with the reason, the existing shape for a step the generator
refuses.

**An index, not a name.** A page-variable name chosen by the user would be an
identifier landing in executed source and would need `isValidVariableName` at
the boundary AND at emission (`repeatVar`'s double guard, `types.ts:1863`).
An index goes through `num()` and derives `page${n}` on emission; the parser
reads it back from the receiver. Nothing free-text crosses.

**Inside `if`/`loop` it is refused.** The receiver is tracked statically in
emission order, the way `loopNames` and `blockKinds` are
(`script-generator.ts:1785-1802`). A `switchPage` inside a conditional would
change the receiver for every step after the block whether or not the branch
ran, which is a spec that lies. `UNGENERATABLE`, same as a `download` whose
trigger would be a structural step.

### Where the two are refused on purpose

- **Page path.** Both are added to `IPC_ONLY_STEP_TYPES` (`types.ts:1253`)
  until the trainer records them (Phase 3 lifts `popup` out, as the download
  recorder inserts through `insertStep`, which re-normalizes). A page that
  could author a `switchPage` could point the rest of the test at a page it
  opened.
- **The injected replayer** (`step-replayer.ts:547-605`): both get the
  honest-refusal arm the run-only steps have, and for `switchPage` this is
  stronger than a courtesy — until Phase 4 the trainer has one document, and a
  replay past a `switchPage` would resolve every later locator against it.
- **The AI-steps subset** (`renderer/lib/parse-llm-response.ts:95-106`) does
  NOT gain them in Phase 1; the trainer agent proposes steps it can try on the
  live page, and it cannot try these until Phase 4.

### Same-tab policy

A run option beside `handlePopups` (`shared/popup-presets.mjs`
`resolveHandlePopups`): per-test field, global default, shipped default. Named
`newTabs: "same-tab" | "new-tab"`.

- `same-tab` installs a context init script that prepends
  `<base target="_self">`, rewrites `target` on every anchor and form present
  and added (a `MutationObserver`, attribute filter `target`), and replaces
  `window.open` with `location.assign`. It is the trainer's `keepInWindow`
  moved to the run, which is the parity the trainer's whole navigation
  containment was built for.
- `new-tab` installs nothing.
- **Shipped default: `same-tab`.** Every existing test was recorded under it
  and a default of `new-tab` breaks them all on the day it ships. A test that
  carries a `popup` step is generated with `new-tab` regardless of the
  setting, because the step cannot succeed otherwise; the generator emits the
  override into `test.use` the way `httpCredentials` is emitted, and
  `describeRun` says which policy was armed, as it says which overlay rules
  were.

## Phases

### Phase 0 — same-tab policy (its own PR, lands first)

The fix for the reported failure, and the smallest change here.

1. `shared/same-tab-fixture-source.mjs` in the dismiss-fixture idiom: the
   init script as a string, `installSameTab(page)` calling
   `page.context().addInitScript`, a `note()` to stderr saying it armed.
2. `shared/run-fixtures.mjs` gains the file; the capture fixture imports it
   unconditionally and installs it when the env says so (`check:ci-fixtures`
   derives the written set from the fixture's own imports, so the unattended
   runner needs no second list).
3. `shared/popup-presets.mjs` (or a sibling `shared/new-tabs.mjs`) holds
   `resolveNewTabs(test, settings)` — THE one function the app's runner, the
   MCP/CLI runner and `describeRun` call, the `armedPopupRulesFor` rule.
4. Settings → Recording: the global default. Test detail: the per-test
   override. `TestRecord` gains a field, so `shared/export-bundle.mjs` must
   list it (`check:export-egress` refuses a field in neither list — it is a
   run-read field, so it exports).
5. Docs: `docs/POPUPS-GUIDE.md` gains a section — a third meaning of "pop-up"
   beside the two it already separates (a browser dialog, a page overlay), and
   the guide is the in-app manual, so `check:docs-blocks` rules apply: no
   ordered lists, no nested bullets, a slug unique across all three docs.
6. Tests: a DOM test of the init script against `target=_blank`, a
   `MutationObserver`-added anchor and a `window.open` call; a row in the
   real-CLI e2e (`e2e/record-then-run` or `runtime-boot` style) that clicks a
   `_blank` link under each policy and asserts the page count.

### Phase 1 — the engine: model, generator, parser, renderer

After this a multi-tab test is writable in the Script tab or the step list and
runs correctly through the real CLI. Run evidence (screenshots, logs, heal) on
the second page is partial until Phase 2.

**Model** — `main/recorder/types.ts`: the two union members with their
doc-comments, `STEP_TYPES` (`:1245`), `IPC_ONLY_STEP_TYPES`, `pageIndex` on
`Step` and `RawStep` (`:699-754`) via `int()` in `normalizeRawStep` (`:1727+`,
rebuilt, never spread). Mirror in `renderer/lib/recorder-types.ts:74`.

**Generator** — `main/services/script-generator.ts`:

- A `currentReceiver` in the emission loop's per-run state beside `loopNames`
  / `blockKinds` / `downloadNum` (`:1785-1817`), set by `popup` and
  `switchPage`, reset per test body.
- `root()` (`:180-183`) takes the receiver as its seed. `stepLine` (`:865`)
  and the six helpers that take `(step, target, vars)` — `assertLine :308`,
  `captureLine :407`, `stateLine :435`, `conditionExpr :584`, `waitLine :655`,
  `cookieLine :769` — gain the receiver. Every one of the 33 sites below
  reads it instead of the literal, EXCEPT the four marked structural:

  | Lines | What |
  |---|---|
  | :182 | `root()` seed — fixes every locator-bearing step and `.and()` at :281 |
  | :331, :337, :348, :349 | `expect(page).toHaveURL/Title` |
  | :411 | capture subject for url/title |
  | :440, :442 | `page.mouse.down/up` |
  | :586, :602, :604 | condition fallback target, `urlContains`, `titleContains` |
  | :682, :690, :731 | wait on URL/title, `waitForTimeout` |
  | :772, :775, :783 | cookies — `page.context()` is the same context from any page; emit through the receiver anyway so the parser has one shape |
  | :874, :933, :965, :970 | `goto`, keyboard press, `reload`, `setViewportSize` |
  | :1028, :1048, :1062, :1074, :1082, :2036 (:2026 comment) | runtime helpers taking `page` as first argument — they work on any Page (`glaze-runtime-source.mjs`) |
  | :1125 | the viewport log line's `page.viewportSize()` |
  | :2149, :2157 | `page.setDefaultTimeout` bracket — **structural, stays `page`** (a per-page default timeout would differ per receiver; the bracket is about the test) |
  | :1849 | download arming — reads the receiver (a download from the popup tab is a real case) |
  | :2285 | `test(…, async ({ page })` — **structural** |
  | the new popup arming | `page.context()` from the receiver — the context is shared, so either spelling is correct; emit through the receiver for one parser shape |

- The `popup` arming pre-pass and awaiting arm, modelled line for line on the
  download's (`:1804-1850`, `:1889-1892`, `:2056-2092`) including the
  `inPlace` fallback and the structural-trigger refusal.
- `describeStep` (`:1194`) phrases: "expect a new page (tab 2)", "switch to
  tab 2" / "switch to the first tab". `stepTitle` (`:1182`) admits
  `\bpage\d*\.` in its own-code regex. Byte-identical mirror in
  `renderer/lib/describe-step.ts` — `describe-step-parity.test.ts:448` derives
  its coverage from `STEP_TYPES` and is the first test to go red.
- `needsVarObject` unaffected; the page variables are `let`s, not `V` fields.

**Parser** — `main/services/spec-parser.ts`:

- A `pageVars: Map<string, number>` threaded like `pendingDownloads`
  (`:1120`), because a wrapped statement must resolve the same way a bare one
  does.
- A receiver capture `(page\d*)` replacing the `page\.` anchor at each of the
  sites the report lists (`:474/:483/:501` builder prefix, `:978/:981`
  conditions, `:1510`, `:1549-1554`, `:1609`, `:1628-:1721` helpers, `:1760-
  :1872` page methods, `:1977` `expect(page)`, `:2265`, `:2333`, `:2359`),
  emitting a `switchPage` step when the receiver changes between consecutive
  statements. A receiver the map has never seen counts as `skipped`, the
  download-unarmed rule (`:1351-1355`).
- Arming/awaiting branches beside the download's (`:1306-1389`): the arming
  line records `popupN → n`; the awaiting block pushes a `popup` step and sets
  the current receiver to `pageN`. The `let pageN;` declaration is consumed
  with the arming line.
- An explicit test that the pair is NOT swallowed into a `code` step by the
  `:1230-1240` fallback (`code-step-roundtrip.test.ts` is the precedent).

**Renderer** — entries in every table the report enumerates:
`type-chip.tsx:27-73` (compile error without), `step-composer.tsx`
(`AddStepKind`, `ADD_STEP_LABEL`, build switch, dialog body: "Expect a new
tab" with a timeout; "Switch tab" with a picker over the popups declared
above the cursor), `trainer-actions.ts:77-108` (append — index is the native
menu's commandId), `step-row.tsx` inline field, replay-button and
continue-on-failure exclusion lists (`:773`, `:824`), `edit-steps-view.tsx`'s
offerable kinds, `carried-frame.ts:78`. Specimen and preview fixtures gain a
row so the chips can be seen.

**Replayer** — `step-replayer.ts:547-605`: refusal arms for both.

**Tests, Phase 1**

- `main/services/popup-emission.test.ts` mirroring `download-emission.test.ts`
  one for one: arming before the trigger, awaiting after, `inPlace`, disabled,
  continue-on-failure, regeneration fixed point, foreign awaiting block counts
  as skipped, `switchPage` inside `if` is `UNGENERATABLE`, `switchPage` to an
  undeclared index is `UNGENERATABLE`, receiver threading through every
  helper (one row per site group in the table above).
- `check:spec-parser` sections: a seven-step multi-tab journey round-trips;
  the type sequence assertion at `:902`.
- `check:step-ingest`: `pageIndex` rejected as a string, negative, non-integer
  (the `downloadMatch` pair at `:312-320` is the template); both types
  refused on the page path.
- `describe-step-parity`: fixture cases for both.
- `renderer/main/step-composer-popup.test.tsx` beside the download one.
- `assert-emission.test.ts:42` `matcherArg` widened to a `page\d*` receiver.
- `e2e/tab-parity.spec.ts`: a real popup, real Playwright. The fixture
  server (`assert-parity.spec.ts:43` is the pattern) serves a page with a
  `_blank` link and a `window.open` button; a generated spec — click, popup,
  `toHaveURL` on the new page, a locator click on it, `switchPage 0`, an
  assertion on the opener — is run through the real CLI (`check:runtime-boot`
  and `record-then-run` are the patterns). `specVerdict`'s `new Function`
  scope binds one `page`, so this is its own spec rather than a row in
  assert-parity. **Changing what a receiver switch emits or resolves to? Add a
  row.**

### Phase 2 — run fixtures follow the page

After this a run's evidence on the second tab is as complete as on the first.

- **Capture** (`capture-fixture-source.mjs`): split `patchOnce` into a
  prototype half (once per process, the current `patched` latch) and
  `installPageInstance(p)` (per page: `PAGE_ACTIONS` wrap, `installLogCapture`,
  axe init script — or move axe to `context().addInitScript`, which is
  correct and simpler). Subscribe `page.context().on("page", installPageInstance)`
  in the fixture. Manifest entries and log entries gain `page: n` (optional,
  so a manifest predating the field reads as page 0). Screenshots are already
  of `getPage(this)`, which is the acting page once the instance wrap exists.
- **Heal** (`heal-fixture-source.mjs`): the factory tagging (`:385-395`) runs
  per page through the same `on("page")`; the probe (`:525`) and rebuild
  (`:495`, `:546`) use `loc.page()` rather than the closed-over `page`.
  `installHealing` gains the install guard settle and signature have, because
  the prototype half must not double-wrap.
- **Settle**: same split.
- **User stylesheet**: `context().on("page")` attaches the two listeners per
  page. **Overlay counter**: `context().exposeBinding`, which Playwright
  offers and which installs into every page.
- `shared/page-actions.mjs`: no change — the sets are the same per page.
- The runner (`playwright-runner.ts`) and the artifact readers
  (`artifact-store.ts`) read the new `page` field into the step timeline so
  the run panel can label a screenshot "tab 2". Nothing is keyed by it.
- `describeRun` / the MCP `triage_run` say how many pages a run opened.

**Tests, Phase 2**

- `check:retry-evidence` / `check:step-progress` style: execute the shipped
  fixture strings without a browser against a fake context that emits `page`.
- `e2e/tab-evidence.spec.ts` (or rows in `tab-parity.spec.ts`): a capture run
  of the Phase 1 journey yields a screenshot for the step on tab 2 with
  `page: 1` in the manifest, console entries from tab 2, and a heal on a
  locator that only resolves on tab 2. **The one that matters most is the
  heal row**: written-but-unwired is R49's shape, and a heal map that cannot
  probe the acting page heals nothing while reporting armed.

### Phase 3 — the trainer opens a tab

After this the click that opens a tab is recorded as it happened, with a
`popup` step, and the user can switch tabs and have it recorded.

**Views.** `pageView` becomes `tabs: TabView[]` plus `activeTab`; `pageWc()`
returns the active tab's webContents, so the thirty call sites do not change.
A `createPageView()` helper holds the one set of `webPreferences` — same
`partition` string per session (shared cookies and storage; a popup that
lands in a fresh partition is logged out), no preload, nothing else — and
`layoutViews()` sets the active tab's bounds and hides the others.
`destroyViews()` closes them all; the four `recWindow = null` sites are
unchanged. Every `wc.on(…)` attached inside `start()` moves into
`attachPageListeners(wc)` and is called per tab: the capture console channel
(`:2637`), the navigation guards, `dom-ready` inject, `context-menu`, the URL
broadcasts. The `will-download` listener already filters by `contents`.

**Policy.** `setWindowOpenHandler` keeps returning `{ action: "deny" }` — the
check pins it, and it stays right: the app creates the view, Electron never
does. On `load-in-window` under `newTabs: "new-tab"` the handler creates a
tab, loads the URL there, activates it, and inserts a `popup` step through
`insertStep` the way `will-download` does. Under `same-tab` the current
`loadNavInWindow` path stays. **`keepInWindow` and the `<base target=_self>`
injection become conditional on the policy** — the DECISIONS entry that added
them cites WKWebView routing `_blank` past the handler, which is a Glaze fact,
and the Electron handler does receive anchor-opened windows; this is verified
first, in the e2e below, before the rewrite is removed on the new-tab path.
`did-create-window` keeps closing strays.

**Ordering.** The click that opened the tab reaches the backend on the
console channel; `setWindowOpenHandler` fires during the same dispatch. The
`popup` step must land AFTER the click, or the generator arms on the wrong
trigger. The download recorder has the same race, and Phase 3 starts by
writing the e2e row that measures it for downloads and popups both. If the
order is not already guaranteed by the ledger, the `popup` insert is deferred
until the next capture flush, which the ledger can hand it.

**Tab strip.** `renderer/recorder-chrome/` grows a tab row above the URL bar:
title or host per tab, the active one marked, click to activate (records a
`switchPage` through `insertStep`), a close control (records nothing in this
phase; a `closePage` step is a follow-up). `URL_STRIP_HEIGHT` gains the row
only while more than one tab exists, through the existing `stripHeight()`
funnel so the viewport arithmetic the check pins stays the three lines it is.
`recorder:tabs` push and `recorder:activateTab` invoke; the preload has no
channel allowlist. `chrome-clickable.spec.ts` is the pattern for proving the
row is hit-testable under the page.

**Checks to renegotiate, by name.** `check:recorder-navigation` (the deny
assertion stays satisfied; the `webPreferences` audit anchors on `pageView`
by identifier and the preload count must stay 1, so the helper keeps that
identifier or the check is updated with it); `check:recorder-views` (the
partition slice is bounded by `pageView = new WebContentsView(` and
`layoutViews();`, which the helper moves; the check is updated to audit the
helper); `check:replay-suspend` (unchanged, no new replay path).

**Tests, Phase 3**

- `e2e/recorder-tabs.spec.ts` on the `click-navigation.spec.ts` server
  pattern: a `_blank` click opens a second WebContentsView in the SAME
  `BrowserWindow` (`windows.spec.ts` asserts the window count stays), the
  step list reads click → popup in that order, the active target's URL is the
  new page, a click on the tab row records `switchPage 0`, the recording
  finalizes to a spec that runs green under the real CLI against the same
  server. A `window.open` row beside the anchor row. A row under
  `same-tab` asserting one view and no popup step.
- `recorder-navigation.test.ts`: the decision function is unchanged; a unit
  test that the tab-open path is only reached on `load-in-window`.
- Dev preview: `?view=recorder-tabs` reports a session with two tabs so the
  strip can be seen in a browser.

### Phase 4 — replay, verify and the agent across tabs

- `runStep` gains native branches beside `viewport`/`reload`/`cookie`
  (`recorder-service.ts:528-591`): `switchPage` activates the tab,
  `popup` waits for the next tab to be created (bounded by the step's
  timeout). The replayer refusals from Phase 1 are lifted for both.
- `verifyAndInsertSteps` / `tryStep` run against the active tab already; an
  AI-proposed `switchPage` becomes tryable, so the LLM subset in
  `parse-llm-response.ts` gains both types and `agent-prompts.ts` learns the
  vocabulary. `page-summary.ts` reports the tab list so the model can say
  which page it is looking at.
- `e2e/verified-steps.spec.ts` and `agent-loop.spec.ts` gain a row each.

## What is deliberately left out

- **A `closePage` step.** Playwright needs no explicit close; a popup that
  closes itself (OAuth) is followed by `switchPage 0`, which is enough. Add
  it when a test needs to assert the close.
- **Tabs the test did not open** — a page opened by the site on load, or a
  service worker. `context.waitForEvent("page")` catches them if a `popup`
  step is armed; nothing else looks.
- **Cross-context pages** (a new incognito window). Out of scope; one context
  per test stays the rule.
- **A per-tab viewport.** A new page takes the context's viewport; a
  `viewport` step after `switchPage` sizes the receiver.

## Open questions to settle during Phase 1

1. Whether `popup` should also accept an optional URL expectation
   (`value` + the URL match semantics from `shared/step-semantics.mjs`) so a
   single step says "a page opened AND it is the checkout". Cheap, but it is
   a second assertion in one step, which the step list has avoided.
2. Whether `switchPage` to the index of a popup whose page has closed should
   fail (Playwright's `page.isClosed()`) or be `UNGENERATABLE`. Run-time
   failure is more honest: the spec does not know.
