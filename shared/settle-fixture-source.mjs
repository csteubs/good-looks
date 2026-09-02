// The "Crawl" page-settling fixture, as a raw JS string written next to the
// specs at runtime (like capture-fixture-source.ts and heal-fixture-source.ts).
//
// What it does
// ------------
// After every page-mutating action resolves, it waits for the page to actually
// finish loading before control returns to the spec: `load`, then network
// quiet, then fonts and a painted frame. The next step therefore starts against
// a settled page rather than one that is still fetching, laying out, or
// swapping fonts under it.
//
// Why a fixture and not generated code
// ------------------------------------
// A spec is generated ONCE and then lives on disk; speed is changed afterwards
// from the sidebar slider with no regeneration. Emitting `waitForLoadState`
// calls into the spec would mean the file and the setting silently disagree the
// moment someone moves that slider — and the file is what runs.
//
// Why it is its own module rather than more code in the capture fixture
// --------------------------------------------------------------------
// Settling is where page indexing will hook in: post-settle is the one moment
// the DOM is known to be stable. Keeping it separate makes that a later
// addition instead of a later untangling. `onSettled` below is that seam.
//
// It must NEVER fail a test
// -------------------------
// This is pacing, not assertion. A page with a websocket, a long-poll, or an
// analytics beacon never reaches network idle, and a page that navigates during
// the wait destroys the execution context underneath it. Every wait is
// individually bounded and individually swallowed, and every raced promise gets
// a terminal `.catch` — a dangling rejection here would surface as an unhandled
// rejection and fail a run that was otherwise fine.
//
// Diagnostics go to STDERR, never stdout: stdout carries the StepReporter's
// `__GLAZE_STEP__:` markers, and text interleaved into that stream breaks step
// highlighting for the whole run.
//
// Plain JavaScript (no TypeScript) because Playwright loads it through its own
// Babel transform.

import { actionsLiteral, LOCATOR_ACTIONS, PAGE_ACTIONS } from "./page-actions.mjs";

export const SETTLE_FIXTURE_FILE = "glaze-settle.mjs";

/** Longest wait for the `load` event. Generous: this is the wait the feature is
 *  actually about, and a slow page is precisely the case it exists for. */
export const SETTLE_LOAD_TIMEOUT_MS = 15_000;
/** Longest wait for network quiet. Deliberately much shorter than the load
 *  wait: a page that keeps a connection open never goes idle at all, so this
 *  cap is the normal outcome there, not the exception. */
export const SETTLE_IDLE_TIMEOUT_MS = 5_000;
/** Longest wait for fonts + a painted frame. Cheap on a settled page. */
export const SETTLE_PAINT_TIMEOUT_MS = 2_000;

export const settleFixtureSource = `const ON = process.env.GLAZE_SETTLE === "1";

const LOAD_TIMEOUT_MS = ${SETTLE_LOAD_TIMEOUT_MS};
const IDLE_TIMEOUT_MS = ${SETTLE_IDLE_TIMEOUT_MS};
const PAINT_TIMEOUT_MS = ${SETTLE_PAINT_TIMEOUT_MS};

const PAGE_ACTIONS = ${actionsLiteral(PAGE_ACTIONS)};
const LOCATOR_ACTIONS = ${actionsLiteral(LOCATOR_ACTIONS)};

let patched = false;
// Whether the network-idle cap has already been reported. A page that never
// goes idle hits it on EVERY step, and a line per step would bury the run log
// in the same sentence a hundred times.
let idleCapReported = false;

// Extension seam. Page indexing will register here: by the time these run the
// DOM is as stable as this fixture knows how to make it, which is the whole
// precondition an index needs. Callbacks are awaited in order and, like
// everything else here, can never fail the test.
const afterSettle = [];

/** Register a callback to run once the page has settled, after each action. */
export function onSettled(fn) {
  if (typeof fn === "function") afterSettle.push(fn);
}

function note(msg) {
  try {
    process.stderr.write("[glaze-settle] " + msg + "\\n");
  } catch (e) {
    /* stderr is best-effort too */
  }
}

/**
 * Resolve when \`promise\` settles or \`ms\` elapses, whichever comes first.
 *
 * The terminal \`.catch\` is not optional. On timeout this function returns while
 * the underlying Playwright call is still in flight; when the page then
 * navigates and that call rejects, an uncaught rejection becomes an unhandled
 * rejection, and Playwright fails the test for it. The catch is what makes an
 * abandoned wait harmless.
 */
function withTimeout(promise, ms) {
  let timer = null;
  const guarded = Promise.resolve(promise).catch(() => undefined);
  return Promise.race([
    guarded,
    // Deliberately NOT unref'd. An unref'd timer does not keep the event loop
    // alive, so when this timer is the only thing pending — a page whose paint
    // wait never resolves, with no other work in flight — the process exits
    // instead of the fallback firing, and the run just stops. Holding the loop
    // open for at most PAINT_TIMEOUT_MS is the cheaper of the two.
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).then((v) => {
    if (timer) clearTimeout(timer);
    return v;
  });
}

/**
 * Wait for the page to finish loading, quiet down, and paint.
 *
 * Ordered cheapest-precondition-first: there is no point asking for network
 * quiet before the document has loaded, and no point waiting for a painted
 * frame before either.
 */
export async function settle(page) {
  if (!page) return;
  try {
    if (page.isClosed && page.isClosed()) return;
  } catch (e) {
    return; // a page we can't even interrogate is not one we can wait on
  }

  // 1. The document itself. This is the "waits for the page to load completely"
  //    part; on an already-loaded page it resolves immediately.
  try {
    await page.waitForLoadState("load", { timeout: LOAD_TIMEOUT_MS });
  } catch (e) {
    note("load wait gave up: " + String(e && e.message ? e.message : e));
  }

  // 2. Network quiet. Bounded and expected to time out on some pages — see the
  //    header. Reported once per run, not once per step.
  const idleStart = Date.now();
  try {
    await page.waitForLoadState("networkidle", { timeout: IDLE_TIMEOUT_MS });
  } catch (e) {
    if (!idleCapReported) {
      idleCapReported = true;
      note(
        "this page does not reach network idle (open connection or polling); " +
          "capping the idle wait at " + IDLE_TIMEOUT_MS + "ms per step from here on",
      );
    }
  }
  // Playwright's own timeout is the normal path above, but a page that closes
  // mid-wait can resolve early — check the clock rather than trusting the throw.
  if (!idleCapReported && Date.now() - idleStart >= IDLE_TIMEOUT_MS) idleCapReported = true;

  // 3. Fonts and a painted frame. Without this the next action can resolve
  //    against a layout that is about to shift under it when the webfont swaps
  //    in — which is exactly the class of flake crawl exists to remove.
  await withTimeout(
    page.evaluate(() => {
      const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
      return fonts.then(
        () =>
          new Promise((resolve) => {
            // Two frames, not one: the first is the frame currently being
            // composed, the second is the one that reflects the action.
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
          }),
      );
    }),
    PAINT_TIMEOUT_MS,
  );

  for (const fn of afterSettle) {
    try {
      await fn(page);
    } catch (e) {
      note("an after-settle callback threw: " + String(e && e.message ? e.message : e));
    }
  }
}

function wrap(obj, method, getPage) {
  const orig = obj[method];
  if (typeof orig !== "function") return;
  obj[method] = async function (...args) {
    const result = await orig.apply(this, args);
    // Settle AFTER the action resolves and BEFORE returning: control reaches
    // the next line of the spec only once the page is done reacting.
    try {
      await settle(getPage(this));
    } catch (e) {
      /* never throw into the test */
    }
    return result;
  };
}

/**
 * Patch the action methods so each one settles before returning.
 *
 * Install order matters. This runs BEFORE the capture fixture's own patch, so
 * capture ends up the outer wrapper and the unwind is: action → settle →
 * screenshot. A screenshot taken before the settle would catch the page
 * mid-load, which is both a worse artifact and a source of visual-diff noise.
 */
/** The page-instance half: page-level actions settle THIS page. Called for
 *  every page a run opens (the tabs fixture hands later ones over), because a
 *  page-level action on a second tab that settled nothing would hand control
 *  back to the spec mid-load. */
export function installSettleOnPage(page) {
  if (!ON) return;
  for (const m of PAGE_ACTIONS) wrap(page, m, function () { return page; });
}

export function installSettle(page) {
  if (!ON) return;
  installSettleOnPage(page);
  if (patched) return;
  patched = true;
  try {
    const proto = Object.getPrototypeOf(page.locator("body"));
    for (const m of LOCATOR_ACTIONS) wrap(proto, m, function (self) { return self.page(); });
  } catch (err) {
    note("could not patch the locator prototype: " + String(err));
  }
}
`;
