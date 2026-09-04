// The artifact-capture fixture as a raw JS string, written next to the specs at
// runtime (like step-reporter-source.ts). When a run has the Phase 0 capture
// toggle enabled, the runner runs a temp copy of the spec whose
// `@playwright/test` import is redirected to this module; it re-exports `expect`
// unchanged and an extended `test` whose `page` fixture screenshots after every
// page-mutating action into GLAZE_ARTIFACT_DIR.
//
// Contract (Phase 1 of the visual-testing roadmap):
//   • Files:    <artifact dir>/<stepIndex>.png  (stepIndex = 0-based ACTION order)
//   • Manifest: <artifact dir>/manifest.json     (per-step artifact + outcome model)
// The check is env-gated so an off run pays nothing (falls back to base `test`,
// no prototype patching, no fixture wrapping). Every capture is wrapped so a
// failure (detached frame, navigation mid-shot, timeout) is logged and skipped
// and can NEVER fail or alter the underlying test's pass/fail result.
//
// The artifact dir is GLAZE_ARTIFACT_DIR on a first attempt and
// `<GLAZE_ARTIFACT_DIR>/attempt-<n>/` on a retry. This is a `page` fixture, so
// Playwright re-enters it for every attempt with the step counter back at 0 —
// and before R24a that meant attempt 2 wrote its screenshots, manifest and logs
// straight over attempt 1's. Since a retry only follows a failure, the attempt
// being destroyed was always the one worth looking at. The spelling is
// `shared/attempt-artifacts.mjs`, interpolated below rather than copied: this
// file WRITES those directories and the app READS them.
//
// Plain JavaScript (no TypeScript) because Playwright loads it via its own
// Babel transform, which does not understand `import type`.

import {
  LOG_CAPTURE_HELPERS,
  MAX_CONSOLE_HEAD,
  MAX_CONSOLE_TAIL,
  MAX_NETWORK_HEAD,
  MAX_NETWORK_TAIL,
} from "./log-capture-source.mjs";
import { actionsLiteral, LOCATOR_ACTIONS, PAGE_ACTIONS } from "./page-actions.mjs";
import { SETTLE_FIXTURE_FILE } from "./settle-fixture-source.mjs";
import { DISMISS_COUNT_ENV, DISMISS_FIXTURE_FILE } from "./dismiss-fixture-names.mjs";
import { USER_CSS_ENV, USER_INIT_ENV, USER_PAGE_FIXTURE_FILE } from "./user-page-fixture-source.mjs";
import { SIGNATURE_COUNT_ENV, SIGNATURE_FIXTURE_FILE } from "./signature-fixture-source.mjs";
import { STEP_MARKER } from "./step-marker.mjs";
import { ATTEMPT_HELPERS } from "./attempt-artifacts.mjs";
import { FOLLOW_TABS_ENV, TABS_FIXTURE_FILE } from "./tabs-fixture-source.mjs";

export const captureFixtureSource = `import { test as base, expect as baseExpect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { installHealing, tagHealFactories } from "./glaze-heal.mjs";
import { installSettle, installSettleOnPage } from "./${SETTLE_FIXTURE_FILE}";
import { installSignatureHeaders, reportSignedRequests } from "./${SIGNATURE_FIXTURE_FILE}";
import { dismissalsSoFar, installOverlayDismissal } from "./${DISMISS_FIXTURE_FILE}";
import { installUserPage, installUserPageOn } from "./${USER_PAGE_FIXTURE_FILE}";
import { followingExpect, installTabFollowing } from "./${TABS_FIXTURE_FILE}";

// Tab following (tabs-fixture-source.mjs). On for every app-generated spec:
// the trainer records a linear journey, and a run that did not follow the
// newest tab would strand every step after a \`_blank\` click on the opener.
const TABS_ON = process.env.${FOLLOW_TABS_ENV} === "1";

// The \`expect\` a redirected spec imports. When tabs are followed it resolves
// the page and locator proxies at CALL time — Playwright's page matchers bind
// their receiver once, so an \`expect(page)\` that started against the opener
// would poll the opener for its whole timeout. Off, it is Playwright's own.
export const expect = TABS_ON ? followingExpect(baseExpect) : baseExpect;

const ON = process.env.GLAZE_CAPTURE_ARTIFACTS === "1";
// Run-time Auto-Heal is gated independently of capture, but installed from
// HERE rather than from its own fixture. A spec imports exactly one module for
// \`test\`, and two fixtures each patching the Locator prototype would double-wrap
// every action — each one's retry would run inside the other's.
const HEAL_ON = process.env.GLAZE_HEAL === "1";
// Standing overlay rules. Gated on there being any, not on a toggle: a run
// with no rules for its host loads the fixture and installs nothing.
const DISMISS_ON = (Number(process.env.${DISMISS_COUNT_ENV}) || 0) > 0;
// Settings → Recording → page stylesheet / init script, base64 in the env.
const USER_PAGE_ON = Boolean(process.env.${USER_CSS_ENV} || process.env.${USER_INIT_ENV});
// Accessibility checks, gated separately from screenshots: a11y is useful
// without them, and it costs far more, so nobody should pay for one by asking
// for the other.
const A11Y_ON = process.env.GLAZE_A11Y === "1";
// "Crawl" speed's page-settling, gated independently again and installed from
// here for the same reason healing is: a spec imports exactly ONE module for
// \`test\`, so every run-time patch has to be installed through this fixture or
// it does not run at all.
const SETTLE_ON = process.env.GLAZE_SETTLE === "1";
// Console + network recording, gated independently again: it is far cheaper
// than either screenshots or axe, but it writes page-controlled text and
// request URLs to disk, so nobody should get it by asking for something else.
const LOGS_ON = process.env.GLAZE_RECORD_LOGS === "1";
// Shopify crawler signatures, gated independently again. Unlike every other
// flag here this one is a COUNT rather than a "1": the runner passes one env
// var per value, so the count is what says whether there is anything to send.
const SIG_ON = Number(process.env.${SIGNATURE_COUNT_ENV} || 0) > 0;
// The user's explicit "record all headers (may include credentials)" opt-out
// from the allowlist.
const ALL_HEADERS = process.env.GLAZE_RECORD_ALL_HEADERS === "1";
const MAX_CONSOLE_HEAD = ${MAX_CONSOLE_HEAD};
const MAX_CONSOLE_TAIL = ${MAX_CONSOLE_TAIL};
const MAX_NETWORK_HEAD = ${MAX_NETWORK_HEAD};
const MAX_NETWORK_TAIL = ${MAX_NETWORK_TAIL};
const AXE_PATH = process.env.GLAZE_AXE_PATH || "";
// Caps on what a single step may record. A page with a systemic problem can
// produce hundreds of nodes for one rule; storing them all would bloat every
// manifest for information that adds nothing after the first few examples.
const MAX_VIOLATIONS = 25;
const MAX_NODES = 5;
const DIR = process.env.GLAZE_ARTIFACT_DIR || "";
// The ONE spelling of what an attempt IS and where its evidence goes,
// interpolated from shared/attempt-artifacts.mjs. Not imported: this file is
// written next to the specs and loaded by Playwright's own transform, and a
// hand-copied branch here is the drift the shared module exists to stop.
${ATTEMPT_HELPERS}
// This attempt's directory. Attempt 0 keeps DIR, so every existing reader — the
// replay, the visual diff, readManifest, readShot — is untouched.
function attemptArtifactDir(attempt) {
  return path.join(DIR, attemptDirName(attempt));
}
const TEST_ID = process.env.GLAZE_TEST_ID || "";
const RUN_ID = process.env.GLAZE_RUN_ID || "";
// Where to save this run's signed-in storage state (login-session tests).
// Empty means the test doesn't save one.
const SAVE_STATE = process.env.GLAZE_SAVE_STATE || "";
const SHOT_TIMEOUT_MS = 5000;

// page/locator methods that mutate or navigate the page — the meaningful set for
// visual diffing. Pure queries and assertions are intentionally NOT captured.
// Interpolated from page-actions.ts, which the settle fixture reads too: the
// two must patch the same set, and two copies would drift.
const PAGE_ACTIONS = ${actionsLiteral(PAGE_ACTIONS)};
const LOCATOR_ACTIONS = ${actionsLiteral(LOCATOR_ACTIONS)};

// Module-level context for the active test. workers=1 + one spec per run means a
// single test owns this at a time, so the locator-prototype patch (which is
// global) reads the current run's context safely.
let ctx = null; // { dir, index, manifest, startedAt, captureMs, a11yMs, a11yChecks }
let patched = false;

// ── Per-step progress ────────────────────────────────────────────────────────
//
// The step markers the runner strips out of stdout and forwards to the renderer
// as \`runner:step\`, so the step list can highlight the step that is running and
// the step that failed.
//
// The Playwright reporter cannot emit these for the actions patched below, and
// this is not a limitation that can be worked around on its side. Playwright
// takes a step's location from the first stack frame outside its own library —
// which, once THIS file (or the heal fixture, or the settle fixture) has wrapped
// the method, is the wrapper. The reporter's file guard then drops the step,
// correctly: line 366 of this file must never be read as line 366 of the spec.
//
// So the wrapper announces the step itself. It is the only place that can: the
// spec's own frame is still on ITS stack, a level or two up. The two emitters
// cannot collide, because installing this wrapper is exactly what takes the
// step's location off the spec and out of the reporter's reach.
const STEP_MARKER = ${JSON.stringify(STEP_MARKER)};
// The spec file for the test currently running, set per test by the page fixture
// from \`testInfo.file\` — the path PLAYWRIGHT resolved, so a capture run's
// redirected temp copy is matched without any guessing about where it lives.
let specFile = "";
// Which attempt is running, set per test from \`testInfo.retry\`. Every marker
// carries it so the backend can keep one attempt's outcomes apart from
// another's; without it the last attempt's verdict is the only one that
// survives, and a test that failed and then passed reports no failure at all.
let attemptNo = 0;

function emitStepMarker(payload) {
  try {
    // Stamped HERE rather than at each call site: three of them, and a fourth
    // that forgot would report its step under attempt 0 no matter which
    // attempt ran it.
    payload.attempt = attemptNo;
    process.stdout.write(STEP_MARKER + JSON.stringify(payload) + "\\n");
  } catch (err) {
    // Progress reporting must never fail a run. A step that goes unhighlighted
    // is a worse run to watch; a step that throws here is a broken test.
  }
}

/**
 * The line in the SPEC that called us, or null when no frame in this call chain
 * came from it.
 *
 * Null is a real answer, not a degraded one: an action this fixture drives for
 * its own purposes is not a step the user recorded, and reporting one would move
 * the highlight to a line nobody executed.
 */
function specCallerLine() {
  if (!specFile) return null;
  const limit = Error.stackTraceLimit;
  try {
    // Deep enough to see past every wrapper that can nest here (capture over
    // settle over heal), and short enough that building it costs nothing next
    // to the action it precedes.
    Error.stackTraceLimit = 30;
    const stack = new Error().stack || "";
    for (const frame of stack.split("\\n")) {
      if (frame.indexOf(specFile) === -1) continue;
      const m = /:(\\d+):\\d+\\)?\\s*$/.exec(frame);
      if (m) return Number(m[1]);
    }
  } catch (err) {
    /* a stack we cannot read is the same as no step */
  } finally {
    Error.stackTraceLimit = limit;
  }
  return null;
}

${LOG_CAPTURE_HELPERS}

/**
 * Subscribe to console + network events for this page.
 *
 * Every entry records the step index that was current when it happened, so a
 * failure can be correlated with what the page was doing at the time — the
 * whole point of offering these to the model.
 *
 * Listeners are best-effort and must never fail the test: a handler that throws
 * inside Playwright's event emitter would surface as an unhandled rejection and
 * fail a run that was otherwise fine.
 */
/** Which tab a page is, 0 for the one the test started on. Stamped by the
 *  tabs fixture; a page nothing stamped is the first. Only a later tab is
 *  written into an entry, so a manifest predating tabs reads exactly as it
 *  did. */
function tabIndexOf(page) {
  try {
    const n = page && page.__glTabIndex;
    return typeof n === "number" && n > 0 ? n : 0;
  } catch (e) {
    return 0;
  }
}

/** Add the tab to an entry when it is not the first one. */
function onTab(entry, page) {
  const tab = tabIndexOf(page);
  if (tab > 0) entry.page = tab;
  return entry;
}

/**
 * Everything a run records about what the page said and did — console, uncaught
 * page errors, network — subscribed ONCE on the CONTEXT.
 *
 * NOT per page, and the difference is a whole tab's evidence. A page-level
 * subscription is not in force when \`page.on("console")\` RETURNS: the client
 * sends an asynchronous \`updateSubscription\` for it, and until the server has
 * recorded that, the server's own dispatch check drops that page's console
 * messages on the floor. A tab the site opened only reaches us through the
 * context's \`page\` event, so the earliest a per-page listener can exist is
 * AFTER the tab's document does — and a document that logs while it parses
 * wins that race often enough to have flaked CI.
 *
 * Worse for anything logged before that: Playwright buffers a page's console
 * messages until it marks the page initialized, then emits the \`page\` event
 * and REPLAYS the buffer immediately after it in the same synchronous stack.
 * The page's subscription set cannot be anything but empty at that moment, so
 * every one of those was lost every time — a popup logged into while it was
 * still on about:blank said nothing at all.
 *
 * A context subscription is in force before any second page can exist and
 * covers every page in the context, the first one included, so there is no
 * per-page attach left to lose.
 *
 * Exactly one registration, for the same reason: two would record every line
 * twice. NOT latched, though, and that is the deliberate half: Playwright
 * gives every test — and every retry — its own context, so this runs once per
 * context as it stands. A latch keyed on the context would not make that
 * safer; it would make a REUSED context record nothing for the second test
 * rather than twice for the first, which is the worse of the two failures.
 *
 * \`weberror\` is the context-level \`pageerror\`. That one was NOT losing to
 * any of the above — a page error is dispatched unconditionally, subscription
 * or not — and moves so that a tab nothing attached to still reports one, and
 * so that "what the page said" has one mechanism rather than two. The entry
 * keeps the type string "pageerror": that is what a reader of console.json
 * matches on, and the channel it arrived by is not a reader's business.
 */
function installLogCapture(context, logs) {
  context.on("console", (msg) => {
    try {
      glazePush(logs.console, onTab({
        step: ctx ? ctx.index : 0,
        ts: Date.now(),
        type: String(msg.type()),
        text: glazeTruncate(msg.text()),
        url: glazeScrubUrl((msg.location && msg.location().url) || ""),
        line: (msg.location && msg.location().lineNumber) || 0,
      }, msg.page()), MAX_CONSOLE_HEAD, MAX_CONSOLE_TAIL);
    } catch (e) { /* never throw into the run */ }
  });

  // An uncaught page exception is not a console message, and it is usually the
  // most diagnostic single line available when a click "did nothing".
  context.on("weberror", (webError) => {
    try {
      const err = webError.error();
      glazePush(logs.console, onTab({
        step: ctx ? ctx.index : 0,
        ts: Date.now(),
        type: "pageerror",
        text: glazeTruncate(String((err && err.stack) || err)),
        url: "",
        line: 0,
      }, webError.page()), MAX_CONSOLE_HEAD, MAX_CONSOLE_TAIL);
    } catch (e) { /* ignore */ }
  });

  // Network, on the same subscription and for the same reason: a request is
  // gated exactly like a console message, so a per-page listener lost a tab's
  // subresources under load (measured 3 in 8 with a busy client event loop, 0
  // in 8 from the context).
  //
  // The page an entry belongs to comes from the request's own frame rather
  // than from a closure, and an entry whose page cannot be resolved is NOT
  // RECORDED. That is not a new gap: a tab's own navigation request has no
  // frame yet (\`request.frame()\` throws "Frame for this navigation request is
  // not available"), and a per-page listener never saw it either, because the
  // page it belongs to does not exist when it is issued. What changes is that
  // the reason is now stated instead of implied — and the alternative, filing
  // the second tab's document under the first, is the kind of plausible-and-
  // wrong this repo refuses elsewhere. Service-worker requests are skipped by
  // the same rule, as they were before.
  const started = new Map();

  const pageOf = (req) => {
    try {
      const frame = req.frame();
      return frame ? frame.page() : null;
    } catch (e) {
      return null;
    }
  };

  context.on("request", (req) => {
    try { started.set(req, Date.now()); } catch (e) { /* ignore */ }
  });

  const record = (req, fields) => {
    try {
      const t0 = started.get(req) || Date.now();
      started.delete(req);
      const owner = pageOf(req);
      if (!owner) return;
      glazePush(logs.network, onTab(Object.assign({
        step: ctx ? ctx.index : 0,
        ts: Date.now(),
        ms: Date.now() - t0,
        method: String(req.method()),
        url: glazeScrubUrl(req.url()),
        resourceType: String(req.resourceType()),
        requestHeaders: glazeFilterHeaders(req.headers(), ALL_HEADERS),
      }, fields), owner), MAX_NETWORK_HEAD, MAX_NETWORK_TAIL);
    } catch (e) { /* ignore */ }
  };

  context.on("response", (res) => {
    let headers = {};
    try { headers = res.headers(); } catch (e) { headers = {}; }
    record(res.request(), {
      status: res.status(),
      ok: res.ok(),
      responseHeaders: glazeFilterHeaders(headers, ALL_HEADERS),
    });
  });

  // A request that never got a response — blocked, DNS failure, CORS refusal —
  // has no status at all, and is exactly the case a failing test needs.
  context.on("requestfailed", (req) => {
    let failure = "";
    try { failure = (req.failure() && req.failure().errorText) || ""; } catch (e) { failure = ""; }
    record(req, { status: 0, ok: false, failure: glazeTruncate(failure) });
  });
}

function describe(target, method, args) {
  let loc = "";
  try { loc = String(target); } catch (e) { loc = ""; }
  // Page-level actions (goto/reload/...) stringify to a bare object; the
  // meaningful detail lives in the value (e.g. the URL), so label them 'page'.
  if (!loc || loc.indexOf("[object") === 0) loc = "page";
  let value;
  try { if (typeof (args && args[0]) === "string") value = args[0]; } catch (e) { /* ignore */ }
  return { action: method, target: loc, value: value };
}

// The element's on-page rectangle, NORMALIZED against the viewport, recorded at
// capture time. Component-level diffing crops to this instead of re-resolving a
// selector later — the roadmap's "stable selector-to-region mapping" hazard is
// avoided by never doing the mapping twice.
async function elementRect(page, target) {
  try {
    if (!target || typeof target.boundingBox !== "function") return undefined;
    const box = await target.boundingBox({ timeout: 1000 });
    if (!box || !box.width || !box.height) return undefined;
    const vp = page.viewportSize && page.viewportSize();
    if (!vp || !vp.width || !vp.height) return undefined;
    return {
      x: box.x / vp.width,
      y: box.y / vp.height,
      w: box.width / vp.width,
      h: box.height / vp.height,
    };
  } catch (e) {
    return undefined; // geometry is best-effort; never fail the test for it
  }
}

/**
 * Run axe against the current page and return a COMPACT violation list.
 *
 * Compact matters: axe's own result objects carry the full rule metadata, help
 * URLs and an HTML snippet per node. Storing those verbatim for every step of
 * every run would put megabytes into manifest.json for information the UI never
 * shows. What's kept is what identifies a violation and lets the user find it:
 * the rule id, its impact, the short help text, and the node targets.
 *
 * Never throws. An a11y check that fails must not fail the test — this is
 * reporting, not a gate.
 *
 * The caps are PASSED IN rather than closed over. The callback is serialized to
 * source and re-evaluated inside the page, so it keeps no scope from this file:
 * naming MAX_VIOLATIONS directly threw \`ReferenceError: MAX_VIOLATIONS is not
 * defined\` in the page, AFTER axe had finished — every check paid its full cost,
 * returned null, and the feature reported nothing at all while looking enabled.
 */
async function runAxe(page) {
  try {
    if (page.isClosed && page.isClosed()) return null;
    const raw = await page.evaluate(async (caps) => {
      if (!window.axe) return null;
      // resultTypes trims what axe assembles: we only ever read violations, and
      // asking for passes/incomplete on a large page is most of the cost.
      const res = await window.axe.run(document, {
        resultTypes: ["violations"],
        reporter: "v2",
      });
      return (res.violations || []).slice(0, caps.maxViolations).map((v) => ({
        id: v.id,
        impact: v.impact || "minor",
        help: v.help,
        nodes: (v.nodes || []).slice(0, caps.maxNodes).map((n) => (n.target || []).join(" ")),
      }));
    }, { maxViolations: MAX_VIOLATIONS, maxNodes: MAX_NODES });
    return raw;
  } catch (err) {
    process.stderr.write("[glaze-a11y] check failed: " + String(err) + "\\n");
    return null;
  }
}

/**
 * Post-action hook: screenshot and/or accessibility check.
 *
 * The two are gated independently — a11y is useful without screenshots, and
 * screenshots are much cheaper than a11y — but they share this one hook and one
 * step index, so a step's shot and its violations always describe the same
 * moment.
 */
async function capture(page, method, target, args, stepMs) {
  if (!ctx) return;
  const index = ctx.index++;
  const info = describe(target, method, args);
  let ok = false;
  // Time the screenshot itself so the runner can report what capture actually
  // costs, rather than leaving the toggle's overhead to guesswork.
  // Measured BEFORE the screenshot so it reflects the element the action ran
  // against, and excluded from captureMs so overhead stays screenshot-only.
  const rect = ON ? await elementRect(page, target) : undefined;
  const tShot = Date.now();
  if (ON) {
    try {
      if (page && (!page.isClosed || !page.isClosed())) {
        await page.screenshot({ path: path.join(ctx.dir, index + ".png"), timeout: SHOT_TIMEOUT_MS });
        ok = true;
      }
    } catch (err) {
      // Capture must never fail or alter the test. Log to stderr for diagnosis.
      process.stderr.write("[glaze-capture] step " + index + " (" + method + ") screenshot failed: " + String(err) + "\\n");
    }
  }
  const ms = Date.now() - tShot;
  ctx.captureMs += ms;

  // Accessibility, timed separately. axe is by far the more expensive of the
  // two — often more than the rest of the step — so its cost is measured and
  // reported rather than quietly folded into the capture number.
  let violations = null;
  if (A11Y_ON) {
    const tAxe = Date.now();
    violations = await runAxe(page);
    ctx.a11yMs += Date.now() - tAxe;
    if (violations) ctx.a11yChecks++;
  }

  // \`ms\` is the SCREENSHOT's cost (and is summed into captureMs); \`stepMs\` is
  // how long the action itself took. Two different questions — what capture
  // costs, and why the suite is slow — and a single field cannot answer both.
  const entry = onTab({ index: index, action: info.action, target: info.target, value: info.value, ok: ok, ts: Date.now(), ms: ms, stepMs: stepMs }, page);
  if (rect) entry.rect = rect;
  if (violations) entry.a11y = violations;
  ctx.manifest.push(entry);
}

function wrap(obj, method, getPage) {
  const orig = obj[method];
  if (typeof orig !== "function") return;
  obj[method] = async function (...args) {
    // Announced before the call and closed after it, so the step list shows
    // "running" for exactly as long as the action takes.
    const line = specCallerLine();
    if (line !== null) emitStepMarker({ event: "begin", line: line, title: method });
    // How long the STEP took — the action itself, from call to resolve.
    //
    // Distinct from \`entry.ms\`, which times the screenshot and is summed into
    // captureMs. Conflating the two is an easy mistake to make and a bad one:
    // "this step went from 1.2s to 4.8s" is the answer to "why is the suite
    // slow?", and the screenshot's duration answers a completely different
    // question (what capture costs) that this fixture already reports
    // separately.
    //
    // Measured HERE rather than around the whole wrapper so it excludes the
    // screenshot and the axe run. On a crawl run it DOES include the settling
    // waits, which is correct: those are time the step really took, and a
    // number that hid them would make crawl runs look as fast as fast ones.
    const tStep = Date.now();
    let result;
    try {
      result = await orig.apply(this, args);
    } catch (err) {
      // The step that threw IS the step that failed, and it is the one the user
      // needs highlighted. Reported before rethrowing — after the rethrow this
      // frame is gone and nothing downstream knows which line it was.
      if (line !== null) emitStepMarker({ event: "end", line: line, title: method, ok: false, duration: Date.now() - tStep });
      throw err;
    }
    const stepMs = Date.now() - tStep;
    // Closed BEFORE the screenshot: the step is over when the action resolves,
    // and folding capture's cost into it would make every step look slower than
    // the same step on a run that captured nothing.
    if (line !== null) emitStepMarker({ event: "end", line: line, title: method, ok: true, duration: stepMs });
    // Screenshot AFTER the action resolves, so the frame reflects its effect.
    try { await capture(getPage(this), method, this, args, stepMs); } catch (e) { /* never throw into the test */ }
    return result;
  };
}

/** The page-instance half of the patch: page-level actions on THIS page.
 *  Locator actions live on the prototype and cover every page at once; these
 *  do not, so a page the context opens later (a tab) gets its own call — or
 *  its \`goto\` reports no step and takes no screenshot. */
function patchPageActions(page) {
  for (const m of PAGE_ACTIONS) wrap(page, m, function () { return page; });
}

function patchOnce(page) {
  patchPageActions(page);
  if (patched) return;
  patched = true;
  // Reach the Locator prototype from a throwaway locator and patch it once.
  try {
    const proto = Object.getPrototypeOf(page.locator("body"));
    for (const m of LOCATOR_ACTIONS) wrap(proto, m, function (self) { return self.page(); });
  } catch (err) {
    process.stderr.write("[glaze-capture] could not patch locator prototype: " + String(err) + "\\n");
  }
}


/**
 * Save the run's signed-in storage state for other tests to start from.
 * Only a PASSING run saves — a failed login would write a half-signed-in
 * state that poisons every test starting from it. Never fails the run.
 */
async function saveSessionState(page, testInfo) {
  if (!SAVE_STATE) return;
  if (testInfo.status !== "passed") {
    process.stdout.write("[glaze-session] run did not pass - signed-in state NOT saved\\n");
    return;
  }
  try {
    await page.context().storageState({ path: SAVE_STATE });
    process.stdout.write("[glaze-session] signed-in state saved for reuse\\n");
  } catch (err) {
    process.stderr.write("[glaze-session] state save failed: " + String(err) + "\\n");
  }
}

/** Say what the overlay rules actually did. Silence here would leave a run that
 *  clicked things on the page with no record of having done so — and the whole
 *  argument for arming a rule is that the run stays explainable afterwards. */
function reportDismissals() {
  if (!DISMISS_ON) return;
  try {
    const fired = dismissalsSoFar();
    if (fired.length) {
      process.stderr.write("[glaze-dismiss] dismissed: " + fired.join(", ") + "\\n");
    } else {
      process.stderr.write("[glaze-dismiss] no overlay matched a rule this run\\n");
    }
  } catch (e) { /* reporting is best-effort */ }
}

export const test = (((ON || A11Y_ON || LOGS_ON) && DIR) || HEAL_ON || SETTLE_ON || SIG_ON || DISMISS_ON || USER_PAGE_ON || SAVE_STATE || TABS_ON) ? base.extend({
  page: async ({ page }, use, testInfo) => {
    // Per-test state, read together: the spec Playwright resolved, and which
    // attempt at it this is. Playwright numbers a retry from 1 and re-enters a
    // \`page\` fixture for every attempt, so this is the one place that knows.
    // Set FIRST, ahead of every install below, because the tabs fixture's
    // markers and the assertion wrapper's announcements carry the attempt.
    specFile = testInfo.file || "";
    attemptNo = normalizeAttempt(testInfo.retry);
    // Console + network, decided up front so every listener below closes over
    // it — a tab opened later records into the same two stores.
    const logs = LOGS_ON && DIR ? { console: glazeMakeStore(), network: glazeMakeStore() } : null;
    // Recording goes on the CONTEXT, once, and BEFORE anything else — ahead of
    // tab following, ahead of the spec, ahead of any page a site can open.
    // That is the whole point: a subscription made after a tab exists is a
    // subscription that missed whatever its document said while it parsed, and
    // one made after the tab was ANNOUNCED missed everything it said before
    // that. See installLogCapture.
    if (logs) {
      try { installLogCapture(page.context(), logs); } catch (e) { /* best effort */ }
    }
    // What a LATER page gets: the instance half of every install the first
    // page gets below, in the same order. The prototype halves are already in
    // place and cover every page; these are the ones that are not.
    const installOnPage = (p) => {
      if (USER_PAGE_ON) {
        try { installUserPageOn(p); } catch (e) { /* best effort */ }
      }
      if (HEAL_ON) {
        try { tagHealFactories(p); } catch (e) { /* best effort */ }
      }
      if (SETTLE_ON) {
        try { installSettleOnPage(p); } catch (e) { /* best effort */ }
      }
      patchPageActions(p);
    };
    // Tab following goes on FIRST: it owns the context's page event, and the
    // installs that follow need to have happened on the first page before a
    // second can exist. The spec receives the proxy it hands back; every
    // install below still targets the REAL first page.
    let specPage = page;
    if (TABS_ON) {
      try {
        specPage = await installTabFollowing(page, {
          perPage: installOnPage,
          attempt: attemptNo,
          // The assertion wrapper announces its own step, the way \`wrap\` below
          // announces an action: once \`expect\` goes through the tabs fixture
          // the reporter files the step under that file and drops it.
          announce: {
            begin: (title) => {
              const line = specCallerLine();
              if (line !== null) emitStepMarker({ event: "begin", line: line, title: title });
              return { line: line, title: title };
            },
            end: (a, ok, duration) => {
              if (a && a.line !== null) emitStepMarker({ event: "end", line: a.line, title: a.title, ok: ok, duration: duration });
            },
          },
        });
      } catch (e) {
        process.stderr.write("[glaze-tabs] install failed: " + String(e) + "\\n");
      }
    }
    // The signature goes on FIRST, and is the only one of these that is not an
    // action patch — it routes the network. Installed ahead of the three
    // wrappers so it can never end up inside one of them, where a heal retry
    // would re-enter it.
    if (SIG_ON) {
      try { installSignatureHeaders(page); } catch (e) {
        process.stderr.write("[glaze-signature] install failed: " + String(e) + "\\n");
      }
    }
    // Overlay rules go on beside the signature, ahead of every action patch:
    // this registers an init script on the CONTEXT and wraps nothing, so it has
    // no business inside a wrapper's unwind. Announcing what was armed is part
    // of the install — a run that clicks things on a page without saying which
    // rules were active is a run whose surprises point nowhere.
    // The user's own stylesheet and init script, ahead of the overlay rules
    // for the same reason: a context init script and page listeners, no
    // action wrapped.
    if (USER_PAGE_ON) {
      try {
        await installUserPage(page);
      } catch (e) {
        process.stderr.write("[glaze-user-page] install failed: " + String(e) + "\\n");
      }
    }
    if (DISMISS_ON) {
      try {
        const armed = await installOverlayDismissal(page);
        if (armed.length) {
          process.stderr.write("[glaze-dismiss] armed: " + armed.join(", ") + "\\n");
        }
      } catch (e) {
        process.stderr.write("[glaze-dismiss] install failed: " + String(e) + "\\n");
      }
    }
    // Healing is installed next so its retry sits inside the capture wrapper:
    // a healed action should produce one screenshot of the successful result,
    // not one per failed attempt.
    if (HEAL_ON) {
      try { installHealing(page); } catch (e) {
        process.stderr.write("[glaze-heal] install failed: " + String(e) + "\\n");
      }
    }
    // Settling goes on NEXT — outside healing, inside capture. Each patch wraps
    // the previous one, so this install order is what produces the unwind
    // "action → heal retry → settle → screenshot". Move it after patchOnce and
    // every screenshot is taken of a page that hasn't finished loading yet.
    if (SETTLE_ON) {
      try { installSettle(page); } catch (e) {
        process.stderr.write("[glaze-settle] install failed: " + String(e) + "\\n");
      }
    }
    // Per-step progress, and the hook screenshots and a11y hang off. Installed
    // for EVERY run that loads this fixture, not just capturing ones: heal and
    // settle wrap the same methods, so any of them being on is already enough to
    // move the step's location off the spec and out of the reporter's reach. The
    // wrapper no-ops on the capture side when there is nothing to capture, and
    // announcing the step is the part every run needs.
    //
    // Installed AFTER heal and settle so it is the outermost of the three — but
    // \`specCallerLine\` searches the whole stack rather than one frame, so a
    // future patch landing on either side of it does not silently stop progress.
    patchOnce(page);
    // Inject axe into every document, once, rather than evaluating its ~570KB
    // source per check. addInitScript survives navigation, which a per-check
    // injection would not. On the CONTEXT, so a tab the run opens has it too
    // — a page-level script left every audit on a second tab returning null.
    if (A11Y_ON && AXE_PATH) {
      try {
        await page.context().addInitScript({ path: AXE_PATH });
      } catch (e) {
        process.stderr.write("[glaze-a11y] could not inject axe: " + String(e) + "\\n");
      }
    }
    // The manifest is what carries BOTH screenshots and violations, so it is
    // written whenever either is on — an a11y-only run still needs one.
    if ((!ON && !A11Y_ON && !LOGS_ON) || !DIR) {
      // A signing-only run lands here — no artifact dir, no manifest — so the
      // signed-request count has to be reported from this path too, or the one
      // run that is ONLY about signatures is the one that says nothing.
      try {
        await use(specPage);
      } finally {
        await saveSessionState(page, testInfo);
        reportSignedRequests();
        reportDismissals();
      }
      return;
    }
    const attemptDir = attemptArtifactDir(attemptNo);
    try { fs.mkdirSync(attemptDir, { recursive: true }); } catch (e) { /* ignore */ }
    ctx = { dir: attemptDir, index: 0, manifest: [], startedAt: Date.now(), captureMs: 0, a11yMs: 0, a11yChecks: 0 };
    // The action patch itself is already installed above — every run that loads
    // this fixture needs it for per-step progress, so it is no longer gated on
    // screenshots or a11y being on.
    try {
      await use(specPage);
    } finally {
      await saveSessionState(page, testInfo);
      reportSignedRequests();
      reportDismissals();
      // Persist the manifest: the per-step artifact + outcome model for this run.
      try {
        const manifest = {
          testId: TEST_ID,
          runId: RUN_ID,
          title: testInfo.title,
          status: testInfo.status,
          // Which attempt produced this evidence. The directory already says
          // so, but a manifest is also read on its own — and "which attempt is
          // this" has no answer from inside one that does not carry it.
          attempt: attemptNo,
          startedAt: ctx.startedAt,
          finishedAt: Date.now(),
          // Total wall-clock ms spent taking screenshots this run, and how many
          // were attempted — the raw inputs for the overhead readout in Stats.
          captureMs: ctx.captureMs,
          shotCount: ctx.manifest.length,
          // Reported separately from captureMs so "screenshots are slow" and
          // "the a11y check is slow" can't be mistaken for each other.
          a11yMs: ctx.a11yMs,
          a11yChecks: ctx.a11yChecks,
          steps: ctx.manifest,
        };
        fs.writeFileSync(path.join(ctx.dir, "manifest.json"), JSON.stringify(manifest, null, 2));
      } catch (err) {
        process.stderr.write("[glaze-capture] manifest write failed: " + String(err) + "\\n");
      }
      // Console + network go in their own files rather than the manifest: they
      // are unbounded in a way per-step entries are not, and every existing
      // manifest reader would have to parse past them.
      if (logs) {
        try {
          const c = glazeDrain(logs.console);
          const n = glazeDrain(logs.network);
          fs.writeFileSync(path.join(ctx.dir, "console.json"), JSON.stringify({
            testId: TEST_ID, runId: RUN_ID, dropped: c.dropped, entries: c.entries,
          }, null, 2));
          fs.writeFileSync(path.join(ctx.dir, "network.json"), JSON.stringify({
            testId: TEST_ID, runId: RUN_ID, dropped: n.dropped, headersFiltered: !ALL_HEADERS, entries: n.entries,
          }, null, 2));
        } catch (err) {
          process.stderr.write("[glaze-capture] log write failed: " + String(err) + "\\n");
        }
      }
      ctx = null;
    }
  },
}) : base;
`;
