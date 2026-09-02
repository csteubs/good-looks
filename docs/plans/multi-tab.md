# Multiple tabs — design

**Status:** written 2026-09-02, revised the same day after a spike against
real Playwright (see "What the spike proved"). **Phases 1 and 2 SHIPPED
2026-09-02** — `shared/tabs-fixture-source.mjs`, the per-page fixture halves,
both runners' `GLAZE_FOLLOW_TABS`, the `tab` marker, `runner:tab` and the
Step details row; `e2e/tab-follow.spec.ts` (nine rows) and
`main/services/tabs-fixture.test.ts` are the authority. See DECISIONS
2026-09-02. The deferred design at the end is still deferred.

Companion documents: [../ARCHITECTURE.md](../ARCHITECTURE.md) for what exists,
[../DECISIONS.md](../DECISIONS.md) for why, [../IFRAMES.md](../IFRAMES.md) for
the engine-first precedent.

## The problem

A recorded click on a `target="_blank"` link, or on a control that calls
`window.open`, passes in the trainer and fails on every run.

In the trainer it passes because the capture script rewrites the clicked
anchor's `target` to `_self` before the browser follows it
(`main/recorder/capture-script.ts:579` `keepInWindow`), injects
`<base target="_self">`, and the recorder window denies every `window.open`
through `setWindowOpenHandler` (`main/services/recorder-service.ts:2558`),
re-issuing the URL in the same window. The recording is therefore a LINEAR
journey: a click, then steps captured against the document that click opened,
whichever tab a real browser would have put it in.

On a run none of that exists. Real Playwright honours the `target`, the new
document opens as a second `Page` in the same `BrowserContext`, and the
generated spec's one `page` (`main/services/script-generator.ts:2285`
`async ({ page })`) stays on the opener. Every later locator resolves against
the wrong document and every `toHaveURL` reads the old address. The trainer
showed the journey green.

## The requirement

The run must follow the journey the trainer recorded **without user input**.
Tab management is the runner's business and invisible to the user, with one
exception: while a run is being watched, the Step details list shows a row

```
> New Tab Opened (#N)
```

after the step that opened it, where N is the number of tabs open in the run's
browser at that moment.

That rules out the first draft of this plan, which asked the user to author
`popup` and `switchPage` steps. It is kept at the end as the deferred design
for the one case automatic following cannot express: a test that acts on the
opener while the popup is still open.

## The design: the run follows the newest tab

The recorded journey is linear, so the run is made linear too. A run fixture,
`shared/tabs-fixture-source.mjs`, installed in the capture fixture beside the
overlay rules, keeps a stack of the context's open pages and an ACTIVE page,
which is always the newest open one. Every step in a generated spec resolves
against the active page at the moment the step RUNS, not the page that was
current when the spec was written.

### What the fixture does

- **A `page` that follows.** The `page` fixture handed to the test is a Proxy
  over the original page whose every read delegates to the active page.
  `context.on("page")` pushes the new page, makes it active, and installs the
  per-page fixtures on it (below). `page.on("close")` pops it and falls back to
  the previous open page, which is what a person watching the closed popup
  would look at next.
- **Locators are materialized when they act, not when they are built.** A
  factory call through the proxy (`getByRole`, `locator`, `frameLocator` and
  the rest) returns a RECIPE, a lazy locator that remembers the chain
  (`.filter().nth()` append to it) and builds the real `Locator` on the active
  page when an action or an assertion runs. A generated spec builds each
  step's locator inline, so a recipe is materialized once per step in
  practice; what the laziness buys is a step written just after a popup that
  closes itself, where the page it was built on is gone by the time it runs.
  The materialized locator is a real Playwright `Locator`, so the capture,
  heal and settle wrappers on `Locator.prototype` still apply.
- **`expect` follows too.** The fixture already re-exports `expect`
  (`shared/capture-fixture-source.mjs:52`) and the runner rewrites the spec's
  `@playwright/test` import to the fixture, so `expect(page)` and
  `expect(recipe)` reach a wrapper that resolves the receiver at CALL time,
  after tabs have settled, and dispatches to Playwright's `expect` on the real
  page or locator. `.not` and `.soft` are carried through; every other
  receiver falls straight through to Playwright's `expect`.
- **Settling before every action and assertion.** Two waits, both bounded:
  - **The tab that is coming.** A context init script hooks `window.open` and a
    capture-phase click on `a[target]`, `area[target]` and `form[target]`
    (anything but `_self`, `_parent`, `_top`) and reports through an exposed
    binding, `__glTabIntent`. When intent has been signalled and the page has
    not arrived, the next action or assertion waits for the `page` event (up
    to a few seconds). Without this, `expect(page).toHaveURL` right after an
    anchor click binds the opener: Playwright's page matchers capture the
    receiver once at call time (`page.mainFrame().waitForURL`, `expect.js`
    `toHaveURLWithPredicate`) and never re-resolve it. A `window.open` popup
    exists before the click resolves; an anchor's does not, reliably.
  - **The tab that arrived.** `waitForLoadState("domcontentloaded")` on the
    newest page, so the first step on it does not read `about:blank`.
- **One retry when the page went away underneath.** An action or assertion
  that fails while the page it was bound to is now closed (`isClosed()`, not
  the error text — the spike saw the same close surface as "Target page,
  context or browser has been closed" and as "Protocol error
  (Runtime.callFunctionOn): session closed") and the active page has changed,
  runs once more on the new active page. This is the self-closing popup:
  the run reaches the next step in milliseconds, the popup takes hundreds to
  close itself, and the recorded journey's next step was on the opener.
- **Announcing.** Each new page writes a marker to stdout,
  `__GLAZE_STEP__:{"event":"tab","count":N,"attempt":a}`, on the channel the
  step markers already use (`shared/step-marker.mjs`), and a line
  `[glaze-tabs] New Tab Opened (#N)` to stderr for the Output tab and the
  saved log. `N` is `context.pages().length` at that moment. A close writes
  only the stderr line; the requirement names one row, and a close changes
  nothing the user must act on.

### Where it is on

Set through the environment by both runners, `GLAZE_FOLLOW_TABS=1`, for every
test whose spec the app generated, and NOT for an imported test. An imported
spec that manages its own popups (`const [popup] = await Promise.all([
page.waitForEvent("popup"), …])`) means `page` as the opener from then on,
and following would break it. The runner already decides per test whether a
spec is imported (`playwright-runner.ts:365`, where the signature fixture is
withheld for the same reason: an imported spec may not even import
`@playwright/test`).

No setting. The trainer's journey is linear and the run replays it; there is
nothing a user could choose here that the recording did not already choose.

### Downloads are unaffected

A `target="_blank"` link that serves an attachment fires `download` on the
OPENER and creates no page (`context.pages()` stays 1, measured in the spike),
so the `download` step's arming line (`script-generator.ts:1849`) keeps
working through the proxy, which binds `waitForEvent` to the active page at
arming time.

### The trainer does not change

`keepInWindow`, `<base target="_self">`, the deny handler and
`did-create-window` all stay. They are what makes the recording linear, and a
linear recording is exactly what the run now replays. A tab strip in the
trainer is the deferred design at the end, wanted only for the opener-while-
popup-open case.

## What the spike proved

A throwaway fixture (proxy page, lazy locators, wrapped `expect`, the intent
binding, the closed-page retry) against a local server with an anchor
`_blank`, a `window.open`, a `noopener` `window.open`, a `form target=_blank`,
a popup that closes itself after 300 ms, and a `_blank` download link.
Playwright 1.62, headless Chromium. Seven cases including a twenty-iteration
anchor race; **7/7 across repeated runs** once the retry keyed on `isClosed()`
rather than the error message. Before the intent binding the anchor case
failed every time (expect bound the opener); before the lazy locators and the
retry the self-closing popup failed every time. Both mechanisms are needed;
neither alone is enough. The plan's first task is turning the spike into
`e2e/tab-follow.spec.ts` so those seven rows are the feature's authority.

## Where we are, and what each phase changes

| Layer | File | The single-page assumption | Phase |
|---|---|---|---|
| Capture fixture | `shared/capture-fixture-source.mjs:452-463` `patchOnce` | `PAGE_ACTIONS` wrapped on the fixture page **instance**; `LOCATOR_ACTIONS` on `Locator.prototype` (global, already right for any page) | 1 |
| Capture logs | `capture-fixture-source.mjs:210-278` `installLogCapture(page)` | console, pageerror, request, response on one page | 1 |
| Axe | `capture-fixture-source.mjs:574` `page.addInitScript` | page-level; a second page has no `window.axe` and every per-step audit on it returns null | 1 |
| Heal | `shared/heal-fixture-source.mjs:385-395` factories on the instance; `:495`, `:525`, `:546` probe and rebuild close over the fixture `page` | a second page's locators carry no heal key; even keyed, the probe runs on page 1 | 1 |
| Settle | `shared/settle-fixture-source.mjs:209-219` | same instance/prototype split | 1 |
| User stylesheet | `shared/user-page-fixture-source.mjs:65-66` | `page.on("domcontentloaded")`, page-level (the init script is context-level already) | 1 |
| Overlay counter | `shared/dismiss-fixture-source.mjs:175` `page.exposeBinding` | the watcher runs in every page; its dismissals on a second page go uncounted | 1 |
| Already context-wide | signature `context.route`, `storageState`, both `addInitScript`s | nothing to do | — |
| Marker parser | `shared/step-marker.mjs:45-64` | admits only `begin`/`end` | 2 |
| Runner | `playwright-runner.ts:1020-1036` `processStdout`; `mcp/run-tests.mjs:873` | forwards step markers only | 2 |
| Store and panel | `renderer/main/recorder-store.tsx:558` `runner:step`; `renderer/main/run-output.tsx:514-548` Step details | rows are the test's steps and nothing else | 2 |
| Artifacts | `artifact-store.ts:5` `<stepIndex>.png`, manifest `capture-fixture-source.mjs:403-406` | no page axis; a screenshot is of whichever page acted, unlabelled | 2 |
| Generator, parser, model | — | unchanged: the spec still names one `page` | — |
| Trainer | — | unchanged | — |

### Phase 1 — the fixture follows, and the other fixtures follow the page

After this, a recorded test that opens a tab runs green, with full evidence on
every tab.

1. **`shared/tabs-fixture-source.mjs`** — the mechanism above, as a source
   string in the dismiss-fixture idiom, plus `installTabFollowing(page,
   context, testInfo, perPage)` where `perPage(p)` is the chain of per-page
   installs the capture fixture hands it. Exports `expect`. The capture
   fixture imports it unconditionally (`check:ci-fixtures` derives the written
   set from the fixture's imports) and installs it FIRST in the `page`
   fixture, before the signature, so it owns `context.on("page")`.
2. **Per-page installs.** Each fixture splits its install into a prototype
   half (once per process, the existing `patched` latches) and an instance
   half taking a page: capture (`PAGE_ACTIONS` wrap, `installLogCapture`, axe
   — or move axe to `context().addInitScript`, which is simpler and right),
   heal (factory tagging per page; the probe and the rebuild use `loc.page()`
   instead of the closed-over page; an install guard like settle's, so the
   prototype half cannot double-wrap), settle (instance half), user stylesheet
   (the two listeners), overlay counter (`context().exposeBinding`, which
   installs into every page). `shared/page-actions.mjs` is unchanged.
3. **Manifest and log entries gain `page: n`** (optional; absent reads as 0)
   so a screenshot of tab 2 can be labelled. Nothing is keyed by it.
4. **Both runners set `GLAZE_FOLLOW_TABS`** for non-imported tests
   (`playwright-runner.ts`, `mcp/run-tests.mjs`), and `describeRun` says it
   armed, the way it says which overlay rules were.
5. **Tests.** `e2e/tab-follow.spec.ts` — the spike's seven rows through the
   REAL CLI on a spec `generateSpec` emitted (the `record-then-run` /
   `runtime-boot` pattern): anchor, `window.open`, `noopener`, form,
   self-closing popup then a step on the opener, `_blank` download, the
   twenty-iteration anchor race; plus a capture-run row asserting a screenshot
   with `page: 1`, console entries from tab 2, and a heal on a locator that
   only resolves on tab 2 (written-but-unwired is R49's shape, and a heal map
   that cannot probe the acting page heals nothing while reporting armed).
   `check:ci-fixtures` asserts the new fixture is written and loaded. A
   laptop-speed half executes the fixture string against a fake context that
   emits `page` and `close` (the `check:retry-evidence` shape) for the stack,
   the intent counter and the retry rule. `main/services/assert-emission.test.ts`
   is unchanged: the spec's text does not change.

### Phase 2 — "> New Tab Opened (#N)" in Step details

1. **`shared/step-marker.mjs`**: `parseStepMarker` admits
   `{ event: "tab", count, attempt }` with `count` an integer ≥ 1 and no
   `line`; `splitStepMarkers` is unchanged. A `tab` marker from a writer the
   parser predates is dropped, as unknown markers are today.
2. **Runner**: `processStdout` emits `runner:tab { runId, count, afterIndex }`
   where `afterIndex` is the last step that BEGAN on this attempt (the runner
   already tracks attempt statuses), so the row lands under the step that
   opened the tab. The MCP runner records `tabsOpened` on the run record and
   `triage_run` mentions it.
3. **Store**: `runs[runId].tabEvents: { afterIndex, count }[]` appended on
   `runner:tab`; cleared with the run.
4. **Panel**: `run-output.tsx` Step details renders, after step `afterIndex`'s
   row, a muted mono row `> New Tab Opened (#N)` with `data-gl="tab-event"`.
   The trainer panel's Step details mirror (`renderer/trainer/
   trainer-panel-view.tsx`) gets the same row. The console's `N/M steps` line
   does not count it: it is not a step.
5. **Tests.** `step-marker.test.ts` rows for the new event and for a `tab`
   marker straddling chunks; a `processStdout` test that a tab marker becomes
   `runner:tab` with the right `afterIndex` and never a `runner:step`;
   `recorder-store.test.tsx` for the append and the reset; `run-output.test.tsx`
   for the row's position under the opening step and its absence when no tab
   opened; the same for the trainer panel; `check:step-progress` pins that the
   reporter's category guard still drops nothing it used to report.

## Rejected: a same-tab run policy

An init script that prepends `<base target="_self">`, rewrites every `target`
and replaces `window.open` with `location.assign` makes a run behave like the
trainer and needs none of the above. Rejected because it changes what the
site does — a `noopener` popup that posts a message back to its opener, an
OAuth flow that closes itself, a page that reads `window.opener` — and the
requirement is that the tab opens and the watcher sees it. It stays available
as the user's own "Page init script" (Settings → Recording) for a site that
needs it.

## Deferred: explicit tabs

The one journey following cannot express: act on the opener WHILE the popup is
open, then on the popup, then on the opener. The trainer cannot record it
either (it has one document), so it is a hand-written or imported case today,
and imported specs already run with following off.

The design, should it be needed: a `popup` step (armed before the triggering
step and awaited after, the `download` step's shape, `types.ts:92-98`,
`script-generator.ts:1804-1892`) and a `switchPage` step carrying a numeric
`pageIndex` (never a free-text identifier, so nothing crosses the capture
boundary as one), a current-receiver threaded through `root()`
(`script-generator.ts:180-183`) and the 33 sites that emit the literal `page`,
a receiver capture in the parser's ~25 `page\.`-anchored regexes, entries in
the renderer's step-type tables (`type-chip.tsx:27-73` is exhaustive), refusal
arms in the replayer (`step-replayer.ts:547-605`), and, last, a second
`WebContentsView` and a tab strip in the trainer with the deny handler
unchanged. `describe-step-parity.test.ts:448` is the first test that goes red
when a step type is added. All of it sits on top of Phase 1, not instead of
it: an explicit `switchPage` would set the fixture's active page.

## Appendix: the spike fixture

The throwaway fixture the seven rows ran against, verbatim, for whoever turns it into `shared/tabs-fixture-source.mjs`. It is a spike: `globalThis.__glTabs` and the string-matched close errors are shortcuts the real fixture must not keep.

```js
import { test as base, expect as baseExpect } from "@playwright/test";

const PAGE_ACTIONS = ["goto", "reload", "goBack", "goForward", "setViewportSize", "setContent", "waitForTimeout"];
const FACTORIES = ["getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByTestId", "getByTitle", "getByAltText", "locator", "frameLocator"];
const REFINERS = ["filter", "nth", "first", "last", "and", "or", "getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByTestId", "getByTitle", "getByAltText", "locator"];
const CLOSED = /has been closed|Target closed|Target page, context or browser has been closed/;
export const events = [];

const RECIPE = Symbol("recipe");

export const test = base.extend({
  page: async ({ page, context }, use) => {
    const stack = [page];
    let active = page;
    let intent = 0, seen = 0;   // intent: in-page signals; seen: page events consumed
    let gate = Promise.resolve();
    let pendingPage = null;      // a promise for the next page event when intent > seen

    await context.exposeBinding("__glTabIntent", () => { intent++; if (!pendingPage) pendingPage = context.waitForEvent("page", { timeout: 3000 }).catch(() => null).then(() => { pendingPage = null; }); });
    await context.addInitScript(() => {
      const o = window.open;
      window.open = function (...a) { try { window.__glTabIntent(); } catch {} return o.apply(this, a); };
      document.addEventListener("click", (e) => {
        const el = e.target && e.target.closest ? e.target.closest("a[target],area[target],form[target]") : null;
        const t = el && el.getAttribute("target");
        if (t && t !== "_self" && t !== "_parent" && t !== "_top") { try { window.__glTabIntent(); } catch {} }
      }, true);
    });
    context.on("page", (p) => {
      stack.push(p); active = p; seen++; if (intent < seen) intent = seen;
      const n = context.pages().length;
      events.push(`New Tab Opened (#${n})`);
      process.stdout.write(`__GLAZE_STEP__:{"event":"tab","count":${n}}\n`);
      gate = p.waitForLoadState("domcontentloaded").catch(() => {});
      p.on("close", () => {
        const i = stack.indexOf(p); if (i >= 0) stack.splice(i, 1);
        if (active === p) { active = stack[stack.length - 1]; events.push(`Tab closed -> #${stack.length}`); }
      });
    });
    // Everything an action or assertion does first: if the page signalled a
    // tab is coming and it has not arrived, wait for it; then wait for the
    // newest tab to reach domcontentloaded.
    async function settleTabs() {
      if (intent > seen && pendingPage) { await pendingPage; pendingPage = null; }
      await gate;
    }
    const materialize = (recipe) => recipe.reduce((acc, [m, args]) => acc[m](...args), active);
    function lazy(recipe) {
      const target = () => materialize(recipe);
      return new Proxy({}, {
        get(_t, prop) {
          if (prop === RECIPE) return recipe;
          if (prop === "then") return undefined;
          if (REFINERS.includes(prop)) return (...args) => lazy([...recipe, [prop, args]]);
          return async (...args) => {
            await settleTabs();
            const bound = active;
            try { return await target()[prop](...args); }
            catch (e) { if ((bound.isClosed() || CLOSED.test(String(e))) && active !== bound) { await settleTabs(); return target()[prop](...args); } throw e; }
          };
        },
      });
    }
    const proxy = new Proxy(page, {
      get(_t, prop) {
        if (prop === RECIPE) return [];
        if (FACTORIES.includes(prop)) return (...args) => lazy([[prop, args]]);
        if (PAGE_ACTIONS.includes(prop)) return async (...args) => { await settleTabs(); return active[prop](...args); };
        const v = active[prop];
        return typeof v === "function" ? v.bind(active) : v;
      },
    });
    proxy.__settleTabs = undefined;
    globalThis.__glTabs = { settleTabs, materialize, current: () => active, RECIPE };
    await use(proxy);
    delete globalThis.__glTabs;
  },
});

// expect: a receiver that is the page proxy or a lazy locator is resolved at
// CALL time, after tabs have settled; a closed-target failure on a receiver
// whose page has since changed is retried once on the new page.
function wrapExpectation(recv, mods) {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === "not" || prop === "soft") return wrapExpectation(recv, { ...mods, [prop]: true });
      return async (...args) => {
        const T = globalThis.__glTabs;
        await T.settleTabs();
        const build = () => { let e = baseExpect(recv[T.RECIPE].length ? T.materialize(recv[T.RECIPE]) : T.current()); if (mods.soft) e = e.soft ? baseExpect.soft(recv[T.RECIPE].length ? T.materialize(recv[T.RECIPE]) : T.current()) : e; if (mods.not) e = e.not; return e; };
        const bound = T.current();
        try { return await build()[prop](...args); }
        catch (e) { if ((bound.isClosed() || CLOSED.test(String(e))) && T.current() !== bound) { await T.settleTabs(); return build()[prop](...args); } throw e; }
      };
    },
  });
}
export const expect = new Proxy(baseExpect, {
  apply(target, thisArg, args) {
    const T = globalThis.__glTabs;
    const r = args[0];
    if (T && r && typeof r === "object" && r[T.RECIPE] !== undefined) return wrapExpectation(r, {});
    return Reflect.apply(target, thisArg, args);
  },
});
```
