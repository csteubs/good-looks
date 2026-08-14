// Manages a live recording session: opens the target site in a browser window,
// injects the capture script on every page load, drains captured interaction
// steps from a shared DOM queue on a poll, and streams them to the app's main
// window. On close it generates a Playwright spec and persists the test.
//
// Glaze's executeJavaScript runs each call in an ephemeral content world, so the
// capture script cannot rely on JS globals or the console bridge. Instead it
// stores state and queued steps on <html> attributes (see capture-script.ts),
// which this service reads/writes across calls.

import { randomUUID } from "crypto";

import { BrowserWindow, logger, Menu, WebContentsView } from "@shell/backend";
import type { MenuItemConstructorOptions, WebContentsNavigationEvent } from "@shell/backend";

import { urlAssertPrefill } from "../../shared/url-assert.mjs";

import {
  ATTR_ASSERT,
  ATTR_ASSERT_SOFT,
  ATTR_PAUSED,
  ATTR_REFINE,
  buildCaptureScript,
  DRAIN_PICKED_SCRIPT,
  DRAIN_SCRIPT,
  PICK_AT_POINT_SCRIPT,
} from "../recorder/capture-script.js";
import {
  CaptureLedger,
  parseCaptureMessage,
  parseDrainPayload,
  type CaptureEntry,
} from "../recorder/capture-channel.js";
import { buildReplayScript } from "./step-replayer.js";
import {
  applyStateStep,
  isMouseHeld,
  releaseHeldMouse,
  resetInputState,
  type InputHost,
} from "./input-service.js";
import { applyViewportStep, type ResizeHost } from "./resize-service.js";
import { healStep } from "./auto-heal.js";
import { healJournalStore } from "./heal-journal-store.js";
import { createTrainerWindowGate } from "./trainer-window-gate.js";
import {
  GUARDED_NAVIGATION_EVENTS,
  decideNavigation,
  isDuplicateContainment,
  permissionAllowed,
  DENIED_RECORDER_PERMISSIONS,
} from "./recorder-navigation.js";
import type { CookieSpec } from "../recorder/types.js";
import {
  initialCursor,
  MAX_DRAIN_BYTES,
  MAX_STEP_STRING_LENGTH,
  normalizePickedElement,
  normalizeRawStep,
  normalizeRawSteps,
} from "../recorder/types.js";
import { normalizeViewport, recordedViewport, type Viewport } from "../recorder/window-size.js";
import {
  applyCookieStep,
  clearCookies,
  deleteCookie,
  listCookies,
  setCookie,
  type CookieHost,
} from "./cookie-service.js";
import type {
  AssertKind,
  DebugEntry,
  HealResult,
  Locator,
  PickedElement,
  RawStep,
  RecorderState,
  Step,
  TestRecord,
} from "../recorder/types.js";
import { sendToMain } from "./app-window.js";
import {
  closeTrainerPanel,
  isTrainerPanelOpen,
  openTrainerPanel,
} from "../windows/trainer-panel-window.js";
import { recorderDebugStore } from "./recorder-debug-store.js";
import { recorderSettingsStore } from "./recorder-settings-store.js";
import { scaled, uiScale } from "./ui-scale.js";
import { getWindowUrl, getPreloadPath } from "../windows/window-paths.js";
import { runHistoryStore } from "./run-history-store.js";
import { describeStep } from "./script-generator.js";
import { testStore } from "./test-store.js";

/** Isolated world the recorder's scripts run in. Any id above 0 is isolated
 *  from the page's main world (0); the exact number only has to be stable so
 *  capture state injected by one call is visible to the next. */
const RECORDER_WORLD_ID = 1999;

/** The raw webContents surface the executor adapter needs. */
interface IsolatedHost {
  executeJavaScriptInIsolatedWorld(
    worldId: number,
    scripts: { code: string }[],
  ): Promise<unknown>;
}

/**
 * Adapt a webContents to the `{ executeJavaScript }` shape every helper and
 * test in this codebase types against, routing execution into the recorder's
 * isolated world. The adapter is the ONE place the world id appears; everything
 * downstream stays byte-compatible with the original service (and with the
 * tests' fake webContents, which implement plain executeJavaScript).
 */
function pageExecutor(wc: IsolatedHost): { executeJavaScript: (script: string) => Promise<unknown> } {
  return {
    executeJavaScript: (script: string) =>
      wc.executeJavaScriptInIsolatedWorld(RECORDER_WORLD_ID, [{ code: script }]),
  };
}

// Pacing for the "Replay from current step" run so the user can watch it step
// through slowly: a short settle after highlighting a row before running it,
// and a longer pause between steps.
const REPLAY_SETTLE_MS = 300;
const REPLAY_STEP_DELAY_MS = 600;
// How long to wait after focusing the training window before running the first
// step of a replay. Covers two things at once: the OS actually moving key focus
// to that window (a `press` step types into whatever is focused, and typing
// into the trainer panel is both wrong and invisible), and the page seeing the
// `data-pw-paused` attribute we just wrote. Both are fast, neither is
// synchronous, and getting either wrong is silent.
const REPLAY_FOCUS_SETTLE_MS = 300;
// A single step's injected script must resolve within this window. A step that
// triggers a page navigation (or otherwise hangs) would leave executeJavaScript
// pending forever and wedge the whole run with controls disabled; the timeout
// turns that into a clean per-step failure instead.
const REPLAY_STEP_TIMEOUT_MS = 8000;
// How long after creating the recorder window to force it visible if the
// WebView's own readiness events (`ready-to-show`/`dom-ready`) haven't fired
// yet. On a cold start (the first recorder window in the app's lifetime) those
// events can lag many seconds while the WebView subsystem initializes, which
// left the window hidden behind the main window — the "first click does
// nothing" bug. A creation-relative timer doesn't depend on those events.
const SHOW_FALLBACK_MS = 1500;
// Hard cap on how long we wait for the first page to finish loading before we
// let the trainer proceed (controls enable). The window itself is shown far
// earlier (see SHOW_FALLBACK_MS); this only bounds `pageReady`.
const LOAD_TIMEOUT_MS = 15000;
// Frame size of a trainer window opened with no size preset. Deliberately the
// FRAME rather than the page: with no preset there is no size to honour, so the
// window is sized to sit comfortably on a laptop display, and whatever page
// area that leaves is what the user records at.
const DEFAULT_WINDOW_WIDTH = 1200;
const DEFAULT_WINDOW_HEIGHT = 820;
/**
 * Height of the app-owned URL strip above the training page, in points at UI
 * scale 1. `stripHeight()` is what everything reads — it applies the user's UI
 * scale, because the strip is app chrome and scales with the rest of the app
 * while the page below it deliberately does not.
 *
 * This is the ONLY definition. The renderer is told nothing about it: the strip
 * fills the bounds it is given (`height: 100%`), so a change here moves the
 * layout with no second number to keep in sync.
 */
const URL_STRIP_HEIGHT = 36;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Race a page `executeJavaScript` against a timeout so one hanging/navigating
 *  step can't freeze a replay run. Rejects with a descriptive error on timeout. */
function execWithTimeout(
  wc: { executeJavaScript: (script: string) => Promise<unknown> },
  script: string,
  ms: number,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Step timed out after ${Math.round(ms / 1000)}s — it may have triggered a page navigation or the page stopped responding.`,
          ),
        ),
      ms,
    );
  });
  return Promise.race([wc.executeJavaScript(script), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Build a verbose, ordered set of debug log lines from a replay error so the
 * trainer's step debug panel surfaces real diagnostics (error name, message,
 * stack, step context) instead of a single vague `String(err)` line. Used by
 * every replay path when `webContents.executeJavaScript` throws or rejects.
 */
function verboseErrorLogs(err: unknown, step: Step): DebugEntry["logs"] {
  const t = Date.now();
  const lines: DebugEntry["logs"] = [];
  let i = 0;
  const push = (level: "info" | "warn" | "error", m: string) =>
    lines.push({ i: i++, t, level, m: String(m == null ? "" : m) });
  const e = err as { name?: string; message?: string; stack?: string } | string | undefined;
  const name = (e && typeof e === "object" && e.name) || "Error";
  const msg = (e && typeof e === "object" && e.message) || String(e ?? "");
  push("error", `Replay threw: ${name}: ${msg}`);
  push("info", `Step: ${step.type}${step.assert ? ` (${step.assert})` : ""}${step.cond ? ` cond=${step.cond}` : ""}`);
  if (step.locator) {
    const loc = step.locator;
    push("info", `Locator: ${loc.k}${loc.v ? `=${loc.v}` : ""}${loc.role ? ` role=${loc.role}` : ""}${loc.name ? ` name=${loc.name}` : ""}`);
  }
  if (step.value) push("info", `Value: ${step.value}`);
  if (step.text) push("info", `Text: ${step.text}`);
  if (e && typeof e === "object" && e.stack) {
    // First few stack frames are the useful part — cap to keep the panel readable.
    const stack = String(e.stack).split("\n").slice(0, 6).join("\n");
    push("warn", stack);
  }
  push("error", "Replay did not complete. The step was not executed in the browser.");
  return lines;
}

/** Determine whether a step's failure is a "locator didn't resolve" failure
 *  (element not found) — the only kind Auto-Heal can address. Healing a locator
 *  won't fix a value-mismatch assertion or a click that threw. */
export function isLocatorFailure(error: string | undefined, step: Step): boolean {
  if (!step.locator) return false;
  if (!error) return false;
  const e = error.toLowerCase();
  return (
    e.includes("element not found") ||
    e.includes("no element") ||
    e.includes("not found") ||
    e.includes("0 match") ||
    e.includes("couldn't resolve") ||
    // An AMBIGUOUS locator is a locator problem, and healing is the right
    // answer to it: `identifiesOnly` only ever proposes a candidate that
    // resolves to exactly one element, so a heal here replaces "matched 2" with
    // a locator that matches the element the user meant. The run-time fixture's
    // `isResolveFailure` has always listed this; the trainer's classifier had
    // not, so the same failure was healable in a run and not in the trainer —
    // the wrong way round, since the trainer is where someone is watching.
    e.includes("strict mode violation") ||
    e.includes("did not resolve")
  );
}

/** Write a trainer heal to the journal. Never throws: a journal write failing
 *  must not turn a step that just healed successfully into a failed one. */
function recordHeal(
  step: Step,
  stepIndex: number,
  heal: HealResult,
  best: HealResult["candidates"][number],
  applied: boolean,
): void {
  if (!session) return;
  try {
    healJournalStore.record({
      testId: session.testId,
      stepId: step.id,
      stepIndex,
      stepLabel: describeStep(step),
      source: "trainer",
      originalLocator: heal.originalLocator ?? step.locator,
      appliedLocator: best.locator,
      candidates: heal.candidates,
      applied,
    });
  } catch (err) {
    logger.warn("recorder", "Could not journal a heal", { stepId: step.id, error: String(err) });
  }
}

/** Run the Auto-Heal engine for a failed step, then (if candidates were found)
 *  re-run the step with the best candidate to see if it succeeds. Returns the
 *  heal result and whether the re-run with the applied locator succeeded (so the
 *  caller can count it as passed).
 *
 *  HOW THE HEAL REACHES THE USER. Through the RETURN VALUE, and only there.
 *  This used to also push a `recorder:healSuggestion` event "so the Console can
 *  surface the candidates as a menu"; nothing ever subscribed to it, and it was
 *  removed on 2026-08-09. Of the four callers only `replayFromCurrent` streams
 *  its `heal` onward (on the `recorder:replayLog` step event, which is what the
 *  Console actually renders) — the other three keep `okWithHeal` and drop the
 *  candidates. So for a single-step preview, `replayAll` and `replayFromStart`
 *  the candidates live in the JOURNAL (`recordHeal` → the Heals view) and
 *  nowhere on screen at the moment they are found. That is a missing feature,
 *  not a missing push: reviving a channel no window listens on would not have
 *  put them anywhere either.
 *
 *  Whether success also rewrites the STORED step is governed by the
 *  `autoHealApply` setting; either way the heal is written to the journal.
 *
 *  `runWithLocator` re-runs the step with a substituted locator and returns
 *  `{ ok, error?, logs? }` — supplied by the caller since each replay path has
 *  its own `execWithTimeout` + `buildReplayScript` wiring. */
async function tryHeal(
  wc: { executeJavaScript: (script: string) => Promise<unknown> },
  step: Step,
  stepIndex: number,
  error: string | undefined,
  runWithLocator: (locator: Step["locator"]) => Promise<{
    ok: boolean;
    error?: string;
    logs?: DebugEntry["logs"];
  }>,
): Promise<{ heal: HealResult | null; okWithHeal: boolean; healedLogs?: DebugEntry["logs"] }> {
  const settings = recorderSettingsStore.get();
  if (!settings.autoHealEnabled || !isLocatorFailure(error, step)) {
    return { heal: null, okWithHeal: false };
  }
  const pastEntries = session ? recorderDebugStore.get(session.testId) : [];
  let heal: HealResult;
  try {
    heal = await healStep(wc, step, stepIndex, pastEntries, settings);
  } catch (err) {
    logger.warn("recorder", "Auto-Heal threw", { stepId: step.id, error: String(err) });
    return { heal: null, okWithHeal: false };
  }
  if (heal.candidates.length === 0) {
    // No candidates — still surface the (empty) attempt so the UI can show a
    // "heal tried, found nothing" state if desired. We keep it quiet here.
    return { heal, okWithHeal: false };
  }
  // Try the best candidate first. Whether success also REWRITES the stored step
  // depends on the apply mode — see below.
  const best = heal.candidates[0];
  try {
    const rerun = await runWithLocator(best.locator);
    if (rerun.ok) {
      heal.ok = true;
      heal.appliedLocator = best.locator;
      // Under "suggest" (the default), the candidate got the step past its
      // failure but the step keeps its original locator. This used to apply
      // unconditionally, and the reason that was dangerous is that a mis-heal
      // usually SUCCEEDS: clicking the wrong button rarely throws, so the step
      // was marked passed and the test quietly stopped testing what it was
      // written to test — with nothing recorded to notice it by.
      const apply = settings.autoHealApply === "apply";
      heal.autoApplied = apply;
      if (apply && session) {
        const idx = session.steps.findIndex((s) => s.id === step.id);
        if (idx >= 0) {
          session.steps[idx] = { ...session.steps[idx], locator: best.locator };
        }
      }
      // Journaled either way — the whole point is that a heal leaves a trace,
      // and under "suggest" the entry is also how the user applies it later.
      recordHeal(step, stepIndex, heal, best, apply);
      return { heal, okWithHeal: true, healedLogs: rerun.logs };
    }
  } catch (err) {
    logger.info("recorder", "Auto-Heal re-run threw", { stepId: step.id, error: String(err) });
  }
  // Best candidate didn't auto-succeed — hand the candidates back for the
  // caller to surface. See the note on this function for where they end up.
  return { heal, okWithHeal: false };
}

/** Shape every replay path expects back from a step, whichever mechanism ran it. */
interface ReplayStepResult {
  ok: boolean;
  error?: string;
  met?: boolean;
  logs?: DebugEntry["logs"];
}

/** The training page's current URL, falling back to the session's start URL
 *  (the window may not have navigated yet). */
function currentPageUrl(): string {
  return pageWc()?.getURL() || session?.liveUrl || session?.url || "";
}

/** The training page's current title, for the title assertions' prefill.
 *
 *  They used to prefill from `prefillValue` — the right-clicked element's
 *  `.value` — which is a form field's contents and has nothing to do with the
 *  document title. Right-clicking a filled-in email box and choosing "Page
 *  title is…" opened the dialog suggesting the email address. That exact bug
 *  was found and fixed for the three URL items directly below; the title item
 *  was left on the old argument and kept it. */
function currentPageTitle(): string {
  return pageWc()?.getTitle() || "";
}

/**
 * Run one step during trainer replay.
 *
 * Single dispatch point on purpose: three step kinds CANNOT go through the
 * injected-script replayer alone. A `cookie` step needs the session API,
 * because an httpOnly cookie is invisible to document.cookie by definition; a
 * `viewport` step needs the window API, because a page cannot resize the window
 * it is loaded in; a `state` step needs the input API, because `:hover` follows
 * the OS pointer and no event a page dispatches at itself can move it. Routing
 * every path through here means a new step kind can't be handled in some replay
 * paths and silently missed in others.
 */
async function runStep(
  wc: { executeJavaScript: (script: string) => Promise<unknown> },
  step: Step,
): Promise<ReplayStepResult> {
  if (step.type === "viewport") {
    // `pageResizeHost()` — NOT the window — because the recorded number is the
    // page's size and the window's content box also holds the URL strip.
    return applyViewportStep(pageResizeHost(), step, (script) => wc.executeJavaScript(script));
  }
  if (step.type === "cookie") {
    // The trainer window can close mid-replay (the loops elsewhere guard for
    // exactly this), so don't assert it's alive — report a clean failure
    // instead of throwing a TypeError out of the replay loop.
    const cookieWc = pageWc();
    if (!cookieWc) {
      return {
        ok: false,
        error: "Recorder window is not open.",
        logs: [
          {
            i: 0,
            t: Date.now(),
            level: "error",
            m: "Cookie step skipped — the recorder window is not open.",
          },
        ],
      };
    }
    // The PAGE's webContents, because the private incognito partition is the
    // page view's. The window's own session is the app's ordinary one, so
    // reading cookies from it would return the app's, not the site's.
    return applyCookieStep(cookieWc as unknown as CookieHost, step, currentPageUrl());
  }
  const result = (await execWithTimeout(
    wc,
    buildReplayScript(step),
    REPLAY_STEP_TIMEOUT_MS,
  )) as ReplayStepResult & { point?: { x: number; y: number } };

  // A `state` step is a two-part move: the PAGE resolves the locator and
  // measures the element (only it can), then the WINDOW drives the real
  // pointer (only it can). Both halves' logs are kept, in order — the page's
  // half says which element was found, and losing that would make a failed
  // hover indistinguishable from a hover onto the wrong thing.
  if (step.type === "state" && step.elementState !== "focus") {
    if (!result?.ok) return result;
    const native = applyStateStep(pageInputHost(), step, result.point ?? null);
    const offset = result.logs?.length ?? 0;
    return {
      ok: native.ok,
      ...(native.error ? { error: native.error } : {}),
      logs: [
        ...(result.logs ?? []),
        ...native.logs.map((l) => ({ ...l, i: l.i + offset })),
      ],
    };
  }
  return result;
}

/** `tryHeal` with the standard in-window re-run wiring — every replay path
 *  re-runs a healed step the same way (substitute the locator, re-run it under
 *  the usual step timeout), so the four callers share this instead of repeating
 *  it.
 *
 *  The retry goes through `runStep`, NOT straight to `buildReplayScript`. Those
 *  were the same thing until a step kind needed a native half: a healed
 *  `state: "hover"` run through the injected script alone reports `ok` because
 *  the page found the element, while the pointer never moves — a heal that
 *  says it worked and didn't. Only steps WITH a locator are ever healed, so the
 *  locator-less branches of `runStep` are unreachable from here. */
async function healAndRetry(
  wc: { executeJavaScript: (script: string) => Promise<unknown> },
  step: Step,
  stepIndex: number,
  error: string | undefined,
): Promise<{ heal: HealResult | null; okWithHeal: boolean; healedLogs?: DebugEntry["logs"] }> {
  return tryHeal(wc, step, stepIndex, error, async (locator) => {
    const healedStep = { ...step, locator: locator! };
    return (await runStep(wc, healedStep)) as {
      ok: boolean;
      error?: string;
      logs?: DebugEntry["logs"];
    };
  });
}

interface Session {
  testId: string;
  url: string;
  name: string;
  steps: Step[];
  paused: boolean;
  assertMode: AssertKind | null;
  /** the pending assertion is soft (expect.soft) */
  assertSoft: boolean;
  /** index at which newly captured/inserted steps land (defaults to the end) */
  cursor: number;
  /** the "Refine Selector" element picker is active in the training window */
  refineMode: boolean;
  /** a replay is running steps against the training window (see
   *  `withCaptureSuspended`) */
  replaying: boolean;
  /** continuing/extending an existing test rather than recording a new one */
  editing: boolean;
  /** preserved from the original record when editing, else the session start time */
  createdAt: number;
  /** snapshot of the global "show URL bar" setting — whether this session's
   *  window gets the app-owned URL strip above the page */
  showUrlBar: boolean;
  /**
   * Where the page is NOW, as opposed to `url` above, which is where the
   * recording STARTS and is what gets saved as the test's URL. Kept apart
   * deliberately: see `broadcastTrainingUrl`.
   */
  liveUrl: string;
  /** true once the trainer window's first page has finished loading */
  pageReady: boolean;
  /** set when the window failed to open within the load timeout */
  loadFailed: boolean;
  /**
   * Authenticates steps arriving over the console channel (see
   * capture-channel.ts). Generated once per session and interpolated into every
   * injection of the capture script, which runs in an isolated world — so the
   * page cannot read it and cannot forge a step through that channel.
   */
  captureNonce: string;
}

const POLL_INTERVAL_MS = 250;

let recWindow: BrowserWindow | null = null;
/**
 * The untrusted page. It used to be `recWindow.webContents` itself; it moved
 * into a child view so the URL strip could have somewhere to live.
 *
 * WHY THIS MATTERS MORE THAN A NORMAL REFACTOR. Every guard in this file — the
 * navigation interception, the denied `openExternal` permission, the private
 * partition, the capture-script injection, the drain — is attached to whichever
 * webContents holds the page. Attaching one of them to the WINDOW instead is
 * not a crash; it is a guard that silently protects nothing, or a drain that
 * silently returns no steps. So `recWindow.webContents` must never appear in
 * this file again: `pageWc()` below is the only way to reach the page, and
 * `check:recorder-views` fails the build if the direct form comes back.
 */
let pageView: InstanceType<typeof WebContentsView> | null = null;
/** The app-owned URL strip above the page. Null when the user has turned the
 *  URL bar off, in which case the page fills the window as it always did. */
let chromeView: InstanceType<typeof WebContentsView> | null = null;
let session: Session | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Which captured steps have already been recorded, and in what order.
 *
 * Every step arrives twice — once over the console channel the instant it is
 * captured, once in the queue the poll drains — and this is what makes that
 * safe. Module-level rather than per-session because it must outlive the moment
 * a session ends: a console message emitted by a page that is still unloading
 * can arrive after `session` is null, and there is no answer to that but to
 * drop it. Reset by `stopPolling`, which every teardown path goes through.
 */
const captureLedger = new CaptureLedger();
/** Per-session tally of where steps actually came from. The console channel is
 *  the one that fixes the navigation bug, so "how many arrived that way" is the
 *  number that says whether it is working — logged when the session ends,
 *  because a channel that silently stopped working would otherwise look exactly
 *  like a channel that was never needed. */
let captureStats = { console: 0, drain: 0, late: 0 };

/** The training PAGE's webContents, or null if the session is gone. Every
 *  page-directed call in this file goes through here — see `pageView`. */
function pageWc() {
  const wc = pageView?.webContents;
  return wc && !wc.isDestroyed() ? wc : null;
}

/** True while there is a live window with a live page in it. Replaces the
 *  `!recWindow || recWindow.isDestroyed()` idiom at every site that was really
 *  asking "can I talk to the page?", which is not the same question. */
function pageAlive(): boolean {
  return !!recWindow && !recWindow.isDestroyed() && pageWc() !== null;
}

/**
 * Drop both child views.
 *
 * Closing a BrowserWindow destroys the webContents it OWNS; a WebContentsView's
 * does not belong to the window, so without this each recording session leaks a
 * live renderer process — the page's, still holding the site, its timers and
 * its private partition. Called from every path that nulls `recWindow`, which
 * is why it is idempotent rather than guarded at the call sites.
 */
function destroyViews(): void {
  for (const view of [chromeView, pageView]) {
    const wc = view?.webContents;
    if (!wc || wc.isDestroyed()) continue;
    try {
      // `close()` rather than `destroy()`: it lets the page run its unload
      // handlers, and a training session's page is arbitrary third-party code
      // that may be mid-write to its own storage.
      wc.close();
    } catch {
      /* already gone — nothing to release */
    }
  }
  chromeView = null;
  pageView = null;
}

/** The strip's height in physical points for THIS session, or 0 when the user
 *  has the URL bar turned off. Read it rather than `URL_STRIP_HEIGHT`: the
 *  setting is snapshotted per session, so a mid-session toggle cannot leave the
 *  page's bounds and the window's size disagreeing about how tall the strip is. */
function stripHeight(): number {
  return session?.showUrlBar ? scaled(URL_STRIP_HEIGHT) : 0;
}

/**
 * `recWindow` as a resize host whose "content size" is the PAGE's size, not the
 * window's.
 *
 * This adapter is the entire reason the strip did not silently corrupt every
 * recording. A `viewport` step's numbers are what the generated spec hands to
 * `page.setViewportSize`, so the trainer has to make the PAGE that size — but
 * the window's content box now holds the strip as well. Without the offset,
 * `setContentSize(1280, 800)` leaves the page 800 − stripHeight tall while the
 * step, the spec and the run all say 800, and nothing anywhere reports a
 * mismatch. The correction lives here, in one named place, rather than in
 * `resize-service.ts`, which has no business knowing the training browser grew
 * a toolbar.
 */
function pageResizeHost(): ResizeHost | null {
  const win = recWindow;
  if (!win || win.isDestroyed()) return null;
  return {
    isDestroyed: () => win.isDestroyed(),
    setContentSize: (width: number, height: number, animate?: boolean) => {
      win.setContentSize(width, height + stripHeight(), animate);
      // The views are laid out from the window's content size, so they have to
      // be re-laid after it changes. `resized` fires for user drags; a
      // programmatic setContentSize does not reliably produce one.
      layoutViews();
    },
    getContentSize: () => {
      const [width, height] = win.getContentSize();
      return [width, Math.max(0, height - stripHeight())];
    },
  };
}

/**
 * Give keyboard focus to the training PAGE.
 *
 * TWO CALLS, BOTH REQUIRED, and the second one is new with the strip. The
 * window focus is what the OS acts on — a `press` step types into whatever the
 * OS considers focused, so replaying from the trainer panel without this sends
 * the keystroke to the panel. The view focus is what Chromium acts on WITHIN
 * the window: the window now has two focusable webContents, and the strip is a
 * real one with a real button in it. Focusing only the window would leave key
 * events going to whichever view held them last — including, after the user has
 * clicked "Assert URL", the URL bar. A `press` step typing into the URL bar is
 * silent: the bar is read-only, so nothing appears anywhere and the step simply
 * has no effect on the page.
 *
 * Pinned by check:replay-suspend, which asserts every replay path focuses the
 * page through this function.
 */
function focusTrainingPage(): void {
  if (recWindow && !recWindow.isDestroyed()) recWindow.focus();
  pageWc()?.focus();
}

/** The page's webContents as an input host. No coordinate offset: input goes to
 *  the page's OWN webContents, so the points are already relative to the page's
 *  top-left rather than the window's. Sending to the window instead would land
 *  every hover and press `stripHeight()` pixels too high — and, near the top of
 *  the page, in the URL bar. */
function pageInputHost(): InputHost | null {
  const wc = pageWc();
  if (!wc) return null;
  return {
    isDestroyed: () => wc.isDestroyed(),
    webContents: {
      sendInputEvent: (event) => wc.sendInputEvent(event),
      getZoomFactor: () => wc.getZoomFactor(),
    },
  };
}

function currentState(): RecorderState {
  return {
    recording: !!session,
    paused: session?.paused ?? false,
    assertMode: session?.assertMode ?? null,
    stepCount: session?.steps.length ?? 0,
    testId: session?.testId ?? null,
    url: session?.url ?? null,
    // Where the page is now. Separate from `url` above, which is where the
    // recording starts and what gets saved — see `broadcastTrainingUrl`.
    liveUrl: session?.liveUrl ?? null,
    name: session?.name ?? null,
    editing: session?.editing ?? false,
    assertSoft: session?.assertSoft ?? false,
    cursor: session?.cursor ?? 0,
    refineMode: session?.refineMode ?? false,
    replaying: session?.replaying ?? false,
    pageReady: session?.pageReady ?? false,
    loading: !!session && !session.pageReady && !session.loadFailed,
    // No `loadFailed` here. `Session.loadFailed` above is real and gates
    // `loading`, but it could never be OBSERVED through this snapshot: the one
    // path that sets it nulls the session before the next broadcast, so the
    // field went out as false every time, and the dialog gated on it never
    // opened. Removed 2026-08-09 rather than left as a field that reads like a
    // usable signal. A failed load is announced by `recorder:loadFailed`, which
    // now has a listener — see `renderer/main/load-failed-dialog.tsx`.
  };
}

function broadcastState(): void {
  sendToMain("recorder:state", currentState());
}

// The step list is now fully mutable (insert / reorder / update / delete), so
// rather than streaming individual appends we broadcast the whole list after
// every change and let the renderer replace its copy.
function broadcastSteps(): void {
  sendToMain("recorder:steps", session?.steps ?? []);
}

function clampCursor(index: number): number {
  const n = session?.steps.length ?? 0;
  return Math.max(0, Math.min(n, index));
}

/**
 * Move the insert cursor past a step a replay just got through.
 *
 * THE RULE, and it is the same one `initialCursor` encodes: the cursor marks
 * WHERE THE BROWSER IS. Opening a session executes the initial navigation, so
 * the cursor opens just past the `goto`. A replay executes more than that, and
 * until now nothing said so — the cursor stayed pinned at the front for the
 * whole session.
 *
 * That is what made continuing an existing test produce a wrong test rather
 * than merely a surprising one. The user's flow is "replay to reach the state I
 * want to extend, then act": with the cursor frozen at 1, a step recorded in
 * the END state was spliced in BEFORE the steps that reach that state. Nothing
 * errors, every step is present, and the order is wrong until the test runs —
 * the same failure mode, and the same silence, as the end-of-list cursor this
 * replaced.
 *
 * ONLY ON THE WAY THROUGH. A step that failed does not advance the cursor: the
 * page state after a failure is unknown, and leaving the cursor at the failed
 * index puts the next recorded step exactly where the flow broke, which is
 * where the user is about to work. Skipped steps (disabled, or a conditional
 * block whose condition was false) DO advance it — the replay is past them, and
 * "how far the replay got" is the whole question this answers.
 *
 * Broadcast on change so both trainers' cursor rules move as the run proceeds;
 * silent when nothing moved, so a replay of already-passed steps is not a
 * stream of identical pushes.
 */
function cursorPastReplayed(index: number): void {
  if (!session) return;
  const next = clampCursor(index + 1);
  if (next === session.cursor) return;
  session.cursor = next;
  broadcastState();
}

/**
 * Given the index of an `if`/`endif` step, return its matching partner index
 * (respecting nested blocks), or -1 if the step isn't a block delimiter or the
 * block is unbalanced.
 */
function matchingBlockIndex(steps: Step[], index: number): number {
  const s = steps[index];
  if (!s) return -1;
  if (s.type === "if") {
    let depth = 0;
    for (let i = index + 1; i < steps.length; i++) {
      if (steps[i].type === "if") depth++;
      else if (steps[i].type === "endif") {
        if (depth === 0) return i;
        depth--;
      }
    }
  } else if (s.type === "endif") {
    let depth = 0;
    for (let i = index - 1; i >= 0; i--) {
      if (steps[i].type === "endif") depth++;
      else if (steps[i].type === "if") {
        if (depth === 0) return i;
        depth--;
      }
    }
  }
  return -1;
}

function addStep(raw: RawStep): void {
  if (!session) return;
  const step: Step = { id: randomUUID(), timestamp: Date.now(), ...raw };
  const at = clampCursor(session.cursor);
  session.steps.splice(at, 0, step);
  session.cursor = at + 1;

  // The capture script self-clears assert mode after capturing an assertion;
  // keep backend + UI in sync.
  if (raw.type === "assert" && session.assertMode) {
    session.assertMode = null;
    session.assertSoft = false;
  }
  broadcastSteps();
  broadcastState();
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return "https://" + trimmed;
}

async function injectCapture(): Promise<void> {
  const page = pageWc();
  if (!page || !session) return;
  const wc = pageExecutor(page);
  try {
    await wc.executeJavaScript(buildCaptureScript(session.captureNonce));
    await applyStateAttributes();
  } catch (err) {
    logger.warn("recorder", "Failed to inject capture script", { err: String(err) });
  }
}

async function applyStateAttributes(): Promise<void> {
  const page = pageWc();
  if (!page || !session) return;
  const wc = pageExecutor(page);
  const paused = session.paused ? "1" : "0";
  const assert = session.assertMode ?? "";
  const soft = session.assertSoft ? "1" : "0";
  const refine = session.refineMode ? "1" : "0";
  const crosshair = session.assertMode || session.refineMode;
  // Every interpolated value goes in as a JSON literal rather than being pasted
  // between hand-written quotes. `assert` is an AssertKind off an IPC param, so
  // a quote in it would close the string early and the rest would be evaluated
  // as code — in the page that is currently loaded, i.e. whatever site the user
  // is recording against. Nothing reaching here is page-controlled today; this
  // is so that stays a property of the code rather than of the caller.
  await wc.executeJavaScript(
    "(function(){var e=document.documentElement;" +
      "e.setAttribute(" + JSON.stringify(ATTR_PAUSED) + "," + JSON.stringify(paused) + ");" +
      "e.setAttribute(" + JSON.stringify(ATTR_ASSERT) + "," + JSON.stringify(assert) + ");" +
      "e.setAttribute(" + JSON.stringify(ATTR_ASSERT_SOFT) + "," + JSON.stringify(soft) + ");" +
      "e.setAttribute(" + JSON.stringify(ATTR_REFINE) + "," + JSON.stringify(refine) + ");" +
      "try{if(document.body)document.body.style.cursor=" +
      JSON.stringify(crosshair ? "crosshair" : "") +
      ";}catch(_){}" +
      "try{if(" + JSON.stringify(refine) + '!=="1"){var b=document.querySelector("[data-pw-refine-box]");if(b)b.style.display="none";}}catch(_){}' +
      "})()",
  );
}

/**
 * Run a replay with capture suspended, the training window focused, and both
 * trainers told what is happening.
 *
 * THE POINT. A replayed click is a real click in a live recording session. With
 * capture on, the trainer records the step it was asked to replay — so replaying
 * step 3 appends a fourth step identical to it, and doing it twice appends two.
 * The steps are indistinguishable from ones the user performed, which is why
 * this was never noticed as a crash: it just quietly grew the test.
 *
 * FOUR THINGS, IN THIS ORDER, and each is load-bearing:
 *
 *  1. `paused` + `applyStateAttributes()` — the page's capture script gates
 *     every handler on `data-pw-paused`, and that attribute is the ONLY thing
 *     that actually stops capture. Setting the field without pushing it is a
 *     no-op with a reassuring name.
 *  2. `broadcastState()` — see the note on RecorderState.replaying. Without it
 *     the OTHER trainer window is still live and can act into the run.
 *  3. `focus()` — the replayer dispatches synthetic events, but a `press` step
 *     targets whatever the OS considers focused. Replaying from the panel with
 *     the panel focused sends the keystroke to the panel.
 *  4. A settle wait — neither the focus change nor the attribute write lands
 *     synchronously, and the first step is the one that would run too early.
 *
 * RESTORE IS IN `finally` AND MUST STAY THERE. Every early return in the replay
 * paths (a failed step stops the run, a soft assertion doesn't) has to leave
 * capture in the state it found it in, and a throw has to as well — capture
 * silently never coming back is a worse bug than any replay failure.
 *
 * `paused` is restored to what it WAS, not to false: replaying while the user
 * had deliberately paused recording must not resume it behind their back.
 *
 * Guarded by check:replay-suspend, which pins that every replay path goes
 * through here and that none of them touches `session.paused` directly.
 */
async function withCaptureSuspended<T>(body: () => Promise<T>): Promise<T> {
  // Captured before the flag flips, and re-read rather than closed over in the
  // finally: `session` can become null mid-replay when the training window is
  // closed, which the replay loops already guard for.
  const wasPaused = session?.paused ?? false;
  try {
    if (session) {
      session.paused = true;
      session.replaying = true;
    }
    await applyStateAttributes();
    broadcastState();
    focusTrainingPage();
    await sleep(REPLAY_FOCUS_SETTLE_MS);
    return await body();
  } finally {
    if (session) {
      session.paused = wasPaused;
      session.replaying = false;
    }
    // A `press` step holds the left mouse button down so the assertion after it
    // can measure `:active`. If that assertion FAILS the replay stops there —
    // and unlike a real run, which tears the browser down, the training window
    // stays open with the button still held: every later click in it would be a
    // drag. Released here, in the same `finally` and for the same reason
    // capture is restored here — every early return and every throw in every
    // replay path passes through this one place.
    if (isMouseHeld()) {
      const released = releaseHeldMouse(pageInputHost());
      for (const line of released) logger.warn("recorder", line.m);
    }
    await applyStateAttributes().catch(() => {});
    broadcastState();
  }
}

/** Read and clear an element picked in refine mode; forward it to the app. */
async function drainPicked(): Promise<void> {
  const page = pageWc();
  if (!page || !session || !session.refineMode) return;
  try {
    const json = (await pageExecutor(page).executeJavaScript(DRAIN_PICKED_SCRIPT)) as string;
    if (typeof json !== "string" || !json) return;
    if (json.length > MAX_DRAIN_BYTES) {
      logger.warn("recorder", "Discarded an oversized picked element", { bytes: json.length });
      return;
    }
    const picked = normalizePickedElement(JSON.parse(json));
    if (!picked) return;
    // The page already left refine mode on click; mirror it in the session and
    // drop the overlay. Stay paused until the review dialog resolves (endRefine).
    session.refineMode = false;
    await applyStateAttributes();
    sendToMain("recorder:picked", picked);
    broadcastState();
  } catch {
    // Page may be mid-navigation; the next poll retries.
  }
}

/**
 * Record steps the ledger has released.
 *
 * THE ONE PLACE page-captured steps enter the session, whichever channel
 * carried them. The page is an arbitrary website and a step compiles into a
 * spec that is later executed in Node, so what arrives is treated as hostile
 * input and REBUILT by `normalizeRawSteps` — an unchecked field here is remote
 * code execution later. Both channels land here for exactly that reason: a
 * second entry point is a second boundary to forget.
 */
function recordCaptured(steps: unknown[]): void {
  if (steps.length === 0 || !session) return;
  for (const step of normalizeRawSteps(steps)) addStep(step);
}

/** Take one arrival from either channel. */
function ingestCapture(entry: CaptureEntry, source: "console" | "drain"): void {
  if (!session) return;
  const ready = captureLedger.admit(entry, Date.now());
  if (ready.length > 0) captureStats[source] += ready.length;
  recordCaptured(ready);
}

/**
 * Poll the capture queue — the BACKUP channel — and keep capture installed.
 *
 * Two jobs, and the second is the one that is easy to miss. Draining picks up
 * anything the console channel dropped. Re-injecting covers a document that
 * never got the capture script: `dom-ready` is a single shot, so a load that
 * misses it — a `document.write`, an injection that threw, a navigation that
 * raced it — would otherwise record nothing for the rest of the session, with
 * no error anywhere and a training browser that looks perfectly normal. The
 * drain answers with whether capture is installed precisely so this can notice,
 * and that answer comes from the same isolated-world object the script's own
 * install guard checks — which is what makes re-injecting safe rather than a
 * way to record every later step twice.
 */
async function drain(): Promise<void> {
  const page = pageWc();
  if (!page || !session) return;
  let json: unknown;
  try {
    json = await pageExecutor(page).executeJavaScript(DRAIN_SCRIPT);
  } catch {
    // Page is mid-navigation. Anything it captured has already left over the
    // console channel; the next poll re-reads the queue for the rest.
    return;
  }
  if (typeof json !== "string") return;
  if (json.length > MAX_DRAIN_BYTES) {
    logger.warn("recorder", "Discarded an oversized capture queue", { bytes: json.length });
    return;
  }
  const payload = parseDrainPayload(json);
  if (!payload) return;
  for (const entry of payload.entries) ingestCapture(entry, "drain");
  if (!payload.installed) {
    logger.info("recorder", "Capture script was missing from the page — reinstalling");
    void injectCapture();
  }
}

/** Release steps stuck behind a gap no channel is going to fill. Runs on the
 *  poll, i.e. after the drain has had its chance to supply the missing one. */
function sweepCapture(): void {
  if (!session) return;
  const late = captureLedger.sweep(Date.now());
  if (late.length === 0) return;
  captureStats.late += late.length;
  logger.warn("recorder", "Recorded steps that arrived out of order", { count: late.length });
  recordCaptured(late);
}

function windowLabel(): string {
  return session?.editing ? "Editing" : "Recording";
}

/** Payload pushed to the main window when the user picks an item from the
 *  right-click test-tools menu in the training browser. The renderer opens the
 *  Add-step dialog prefilled with these so the user can tweak before inserting. */
export interface ContextAction {
  kind: "assertion" | "wait" | "goto" | "press" | "viewport" | "find" | "refine" | "elementState";
  /** assert kind when kind === "assertion" */
  assert?: AssertKind;
  /** which pseudo-state to preselect when kind === "elementState". Only the
   *  one-step states are offered from the right-click menu — the composite
   *  picks (:active, :focus-visible) add several rows and belong in the dialog,
   *  where the row count can be stated before the user commits. */
  elementState?: "hover" | "focus";
  /** wait mode when kind === "wait": "element" resolves the locator, "hidden"
   *  opens a Wait Until on the `hidden` predicate, "until" opens Wait Until
   *  with nothing preselected, "time" is a fixed duration. */
  waitMode?: "element" | "hidden" | "time" | "until";
  /** the element under the right-click, with its locator candidates */
  picked: PickedElement | null;
  /** the element's current text — prefills text/exactText asserts */
  prefillText: string;
  /** the element's current value — prefills value asserts */
  prefillValue: string;
  /**
   * Which trainer should act on this.
   *
   * The event is BROADCAST — both the main window and the docked panel receive
   * every push — and without an address both would open a prefilled Add-step
   * dialog for one right-click. Addressed rather than point-to-point so the
   * single `sendToMain` fan-out stays the only delivery path; each view ignores
   * what is not for it. Absent means "main", for records predating the panel.
   */
  target?: TrainerTarget;
}

/** The two windows that can host a trainer. */
export type TrainerTarget = "main" | "panel";

/**
 * Push a context-menu action to whichever trainer should handle it.
 *
 * The docked panel wins when it is open: the user just right-clicked in the
 * training browser, and the panel is the trainer sitting against it. Opening
 * the dialog in the main window instead would put it behind the browser — the
 * exact window hunt this feature removes.
 */
function ctxAction(action: ContextAction): void {
  sendToMain("recorder:contextAction", {
    ...action,
    target: isTrainerPanelOpen() ? "panel" : "main",
  } satisfies ContextAction);
}

/**
 * Lay the strip and the page out down the window's content box.
 *
 * Called on every resize and after every programmatic content-size change.
 * WebContentsView bounds are absolute, not a layout — nothing re-flows them for
 * us, so a window that resizes without this leaves the page at its old size
 * with a band of window showing through beside it.
 */
function layoutViews(): void {
  if (!recWindow || recWindow.isDestroyed()) return;
  const [width, height] = recWindow.getContentSize();
  const strip = stripHeight();
  chromeView?.setBounds({ x: 0, y: 0, width, height: strip });
  pageView?.setBounds({ x: 0, y: strip, width, height: Math.max(0, height - strip) });
}

/**
 * Tell the URL strip — and both trainers — where the page actually is.
 *
 * This replaced `updateTitle()`, which wrote the URL into the native window
 * title as a stand-in address bar. That stand-in did not work, and its failure
 * is why the strip exists: Electron's default handling of `page-title-updated`
 * copies `document.title` onto the window, so every load overwrote the URL with
 * the site's own title. The window said "Ritual" where it was meant to say
 * where you were.
 *
 * The live URL is a SEPARATE field from `session.url`, which must keep meaning
 * "the URL this recording starts at": it is what `finalize()` writes to
 * `TestRecord.url` and what the opening `goto` step replays. Tracking the live
 * location in it would rewrite every saved test's starting point to wherever
 * the user happened to stop. That is also why the trainer panel's header has
 * been stale since it was written — it renders `state.url`, which is correct
 * for what that field means and simply is not the live location.
 */
function broadcastTrainingUrl(): void {
  if (!session) return;
  const live = pageWc()?.getURL() ?? "";
  if (live) session.liveUrl = live;
  const payload = { url: live || session.liveUrl, loading: !session.pageReady };
  // Straight to the strip's own webContents rather than through `sendToMain`:
  // that fan-out is for windows that mirror SESSION state, and the strip is one
  // string inside the training browser. Registering it there would deliver it
  // the step list, the console stream and every replay push, inside the window
  // whose responsiveness the user is judging the page by.
  const chromeWc = chromeView?.webContents;
  if (chromeWc && !chromeWc.isDestroyed()) chromeWc.send("recorder:trainingUrl", payload);
  broadcastState();
}

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void drain();
    void drainPicked();
    sweepCapture();
  }, POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  // Anything still held behind a gap belongs to a session that is ending, and
  // there is no list left to append it to — but a step that was captured and
  // never recorded is the whole bug this machinery exists for, so it is logged
  // rather than dropped in silence.
  const stranded = captureLedger.pendingCount();
  if (captureStats.console || captureStats.drain || captureStats.late || stranded) {
    logger.info("recorder", "Capture channels for this session", { ...captureStats, stranded });
  }
  captureLedger.reset();
  captureStats = { console: 0, drain: 0, late: 0 };
}

export const recorderService = {
  getState(): RecorderState {
    return currentState();
  },

  /**
   * The session's current steps, for a window that opened after they were
   * broadcast.
   *
   * `recorder:steps` is a PUSH, and the initial one fires inside `start()` —
   * before the training browser has even loaded. Any window created later in
   * the session (the docked trainer panel is created once the page is ready)
   * misses it completely and would show an empty step list until the user
   * happened to mutate something. A push is not a substitute for being able to
   * ask.
   */
  getSteps(): Step[] {
    return session ? [...session.steps] : [];
  },

  async start(params: {
    url: string;
    name?: string;
    testId?: string;
    /** page size to record at, from the New Recording dialog's preset picker.
     *  Omitted (or null) keeps the trainer's default window size. */
    viewport?: { width: number; height: number } | null;
  }): Promise<RecorderState> {
    if (session) {
      recWindow?.focus();
      return currentState();
    }

    let testId: string = randomUUID();
    let url = normalizeUrl(params.url);
    let name = params.name?.trim() || "Recorded test";
    let existingSteps: Step[] = [];
    let editing = false;
    let createdAt = Date.now();

    if (params.testId) {
      const rec = testStore.get(params.testId);
      if (rec) {
        editing = true;
        testId = rec.id;
        url = rec.url;
        name = rec.name;
        existingSteps = rec.steps;
        createdAt = rec.createdAt;
      }
    }

    session = {
      testId,
      url,
      name,
      steps: [...existingSteps],
      paused: false,
      assertMode: null,
      assertSoft: false,
      refineMode: false,
      replaying: false,
      cursor: initialCursor(editing, existingSteps),
      editing,
      createdAt,
      showUrlBar: recorderSettingsStore.get().showUrlBar,
      // Starts at the session's start URL so the strip has something true to
      // show during the first load, rather than a blank bar that fills in.
      liveUrl: url,
      pageReady: false,
      loadFailed: false,
      captureNonce: randomUUID(),
    };

    // The pointer position remembered from the previous session was measured
    // against a page that is no longer loaded. Carrying it over would let the
    // first `press` of a new session click a coordinate chosen for a different
    // document — a real click, on whatever happens to be there now.
    resetInputState();

    // Push the existing steps to the renderer so the trainer's live list shows
    // full context while extending. They're already in session.steps above, so
    // this is a push-only notification, not another addStep.
    broadcastSteps();
    // Broadcast the initial loading state so the renderer shows the loading
    // modal immediately — before the window even appears.
    broadcastState();

    // The size this session runs at. A new recording takes the dialog's preset;
    // an existing one takes the size it was already recorded at, so re-opening
    // a mobile test doesn't drop it into a desktop-width window and capture
    // steps against a layout the test will never see.
    const viewport: Viewport | null = editing
      ? recordedViewport(existingSteps)
      : normalizeViewport(params.viewport);

    // Initial navigation is the first step; later navigations are consequences
    // of recorded interactions. The window HAS a URL bar as of the strip below,
    // but deliberately a read-only one — a navigation the recorder did not
    // cause is a navigation it does not record, so letting the user type into
    // it would produce a spec that replays a different journey than the one
    // they performed. Skip when editing — the existing steps already start with
    // a goto.
    if (!editing) {
      // Viewport BEFORE goto: the generated spec has to size the page before it
      // navigates, or the first paint (and anything the site decides from it,
      // like a mobile layout) happens at the runner's default size.
      if (viewport) addStep({ type: "viewport", width: viewport.width, height: viewport.height });
      addStep({ type: "goto", url });
    }

    // The strip's height for this session, needed before the window exists
    // because the window is sized around it. `stripHeight()` reads the same
    // number off the session, which is already assigned above.
    const strip = stripHeight();

    recWindow = new BrowserWindow({
      windowKey: "recorder",
      // With a preset, the numbers are the PAGE size, because that's what the
      // recorded viewport step replays at — sizing the frame instead would
      // leave the page short by the title bar's height.
      //
      // THE STRIP IS ADDED BACK HERE, and this is the load-bearing line. The
      // content box now holds the URL strip AND the page, so a content height
      // of exactly `viewport.height` would give the page `height - strip` and
      // leave the recorded step, the generated spec and the real run all
      // claiming a number the trainer never actually showed. Nothing downstream
      // would report it: the step is written from the preset, not measured.
      width: viewport?.width ?? DEFAULT_WINDOW_WIDTH,
      height: viewport ? viewport.height + strip : DEFAULT_WINDOW_HEIGHT,
      useContentSize: !!viewport,
      // Set once and then defended: `page-title-updated` is prevented below, so
      // the site cannot rename the window out from under the user.
      title: `${windowLabel()} — ${url}`,
      titleBarStyle: "default", // native draggable frame for an external page
      show: false,
      // THE CLICK THAT COMES BACK FROM THE PANEL.
      //
      // macOS spends a click on an inactive window activating it, and does not
      // pass it to the content unless this is set ("Whether clicking an inactive
      // window will also click through to the web contents. Default is false").
      // The trainer panel is `alwaysOnTop` and is where the user arms an
      // assertion, adds a step, or scrolls the list — so the training browser is
      // INACTIVE every single time they turn back to the page. Without this,
      // the first click after every panel interaction is eaten.
      //
      // In an ordinary window that costs a button press. Here it costs a
      // RECORDED STEP: the capture script's listener never fires, so the click
      // is absent from the step list while the page has visibly responded to
      // nothing. That reads as the recorder dropping interactions at random,
      // which is exactly how it was reported.
      //
      // trainer-panel-window.ts already sets this, for the mirror image of the
      // same problem, and its comment says the same thing ("the first click on
      // the panel is spent activating the window"). Only one side of the pair
      // ever got it.
      //
      // The trade, stated: this window hosts an arbitrary third-party page, and
      // click-through means a click that activates the window also reaches that
      // page. It is a window the user opened to click on, the page is already
      // driving the capture boundary under `normalizeRawStep`, and the
      // alternative is a recorder that silently omits steps.
      acceptFirstMouse: true,
    });

    // Worth a line in the log: the OS clamps a window that doesn't fit the
    // display, so a preset larger than the screen records steps at one size and
    // replays them at another. The recorded viewport is the authoritative one.
    logger.info("recorder", "Opened the training window", {
      testId,
      editing,
      pageSize: viewport ? `${viewport.width}x${viewport.height}` : "default",
      urlStrip: strip,
    });

    // ── The page, in a child view ────────────────────────────────────────
    //
    // The partition moved here WITH the page. It is the whole isolation story —
    // an in-memory session unique to this recording, so every training run
    // starts logged out instead of inheriting a previous one's cookies — and
    // it has to sit on whatever webContents actually loads the site. Left on
    // the window (which no longer loads anything) it would still be a valid
    // option, would still create a partition, and would isolate nothing.
    //
    // No preload and no node integration: this view holds an arbitrary
    // untrusted site, and the capture script reaches it through
    // `executeJavaScriptInIsolatedWorld`, which needs neither.
    pageView = new WebContentsView({
      webPreferences: {
        partition: `recorder-incognito-${randomUUID()}`,
      },
    });
    recWindow.contentView.addChildView(pageView);

    // ── The URL strip, above it ──────────────────────────────────────────
    if (session.showUrlBar) {
      chromeView = new WebContentsView({
        webPreferences: {
          preload: getPreloadPath(),
          // NO `partition`, deliberately, and this cost a debugging session.
          // `protocol.handle` in shell/app-protocol.ts registers `app://` on
          // the DEFAULT session; a named partition gets its own session, which
          // has no handler for the scheme. The load then fails with no
          // exception, no `did-fail-load` worth reading and an empty
          // `getURL()` — the strip renders as a blank band above the page and
          // everything else works perfectly.
          //
          // The default session is also the right answer on its own terms: the
          // strip is app chrome in the same trust domain as the main window.
          // What must NOT be shared is the PAGE's partition, and that is a
          // separate in-memory one created above.
        },
      });
      // The strip is app chrome, so it honours the app's UI scale — the page
      // below it deliberately does not (see ui-scale.ts). `stripHeight()`
      // applies the same factor to its bounds, so the two stay in proportion.
      chromeView.webContents.setZoomFactor(uiScale());
      recWindow.contentView.addChildView(chromeView);
      // Logged rather than swallowed. A strip that fails to load is invisible —
      // it renders as a blank band and the recording works — so the log line is
      // the only trace anyone would have. (Ask how that is known.)
      const stripUrl = await getWindowUrl("recorder-chrome.html");
      void chromeView.webContents.loadURL(stripUrl).catch((err) => {
        logger.error("recorder", "The training browser's URL strip failed to load", {
          stripUrl,
          err: String(err),
        });
      });
    }

    layoutViews();

    const wc = pageWc();
    if (!wc) throw new Error("The training browser's page view failed to start.");

    // Force navigation into the recorder window. `loadNavInWindow` re-issues the
    // navigation via loadURL; the guard stops that programmatic load from being
    // intercepted again (which would loop).
    let selfLoad: string | null = null;
    const loadNavInWindow = (target: string): void => {
      const page = pageWc();
      if (!page) return;
      selfLoad = target;
      void page
        .loadURL(target)
        .catch(() => {})
        .finally(() => {
          if (selfLoad === target) selfLoad = null;
        });
    };

    // ── Kill the escape at its source, not just at the events ────────
    //
    // Intercepting navigation events assumes the escape travels through an
    // event we know to listen for. That assumption was already wrong once
    // (will-redirect), and an event-by-event defence can only ever be as
    // complete as the last incident. Handing a URL to the OS is a PERMISSION in
    // this SDK — "openExternal", carrying the target in details.externalURL —
    // so denying it on this window's session refuses the capability itself,
    // whatever path asks for it.
    //
    // Scoped to the recorder's own private partition, so nothing else in the
    // app is affected. Only openExternal is denied; every other permission is
    // left as it was, because a training browser legitimately needs media,
    // geolocation and the rest to reproduce a user's session.
    try {
      const recSession = wc.session;
      recSession.setPermissionRequestHandler((_target, permission, callback, details) => {
        if (!permissionAllowed(permission)) {
          logContained(
            String((details as { externalURL?: unknown })?.externalURL ?? ""),
            "openExternal permission denied",
            "permission-request",
          );
          callback(false);
          return;
        }
        callback(true);
      });
      recSession.setPermissionCheckHandler((_target, permission) => permissionAllowed(permission));
      logger.info("recorder", "Training window containment armed", {
        deniedPermissions: [...DENIED_RECORDER_PERMISSIONS],
        guardedEvents: [...GUARDED_NAVIGATION_EVENTS],
      });
    } catch (err) {
      // If the SDK ever drops these, the event guards below are still in place
      // — but this is the stronger of the two, so its absence is worth shouting
      // about rather than degrading quietly.
      logger.error("recorder", "Could not deny the openExternal permission for the training window", {
        err: String(err),
      });
    }

    // A navigation we refused to let out. Logged loudly AND surfaced in the
    // trainer's Console, because the failure mode this guards against is
    // invisible from inside the app — the damage happens in another program.
    const logContained = (url: string, reason: string, event: string): void => {
      logger.warn("recorder", "Blocked a navigation from leaving the training window", {
        event,
        reason,
        url,
      });
      sendToMain("recorder:navigationBlocked", { url, reason, event });
    };

    // window.open / target=_blank that reach the native layer: keep in-window.
    // Always denied — an http(s) target is re-issued inside this window, and
    // anything else is dropped rather than handed to the OS.
    wc.setWindowOpenHandler((details) => {
      const decision = decideNavigation({ url: details?.url, isMainFrame: true }, null);
      if (decision.action === "load-in-window") loadNavInWindow(decision.url);
      else logContained(details?.url ?? "", decision.reason, "window-open");
      return { action: "deny" };
    });

    // Backstop: if a child window is ever created despite the deny above, close it.
    wc.on("did-create-window", (child) => {
      try {
        (child as BrowserWindow).close();
      } catch {
        /* ignore */
      }
    });

    wc.on("dom-ready", () => void injectCapture());

    // ── The capture channel ──────────────────────────────────────────────
    //
    // THE FIX FOR THE CLICK THAT NAVIGATES. The page emits each captured step
    // as a console message inside the click's own dispatch, so it reaches this
    // process before the navigation that click started can destroy the document
    // the step was sitting in. Everything else about capture — the queue, the
    // poll, `will-navigate`'s best-effort drain — is now the backup path.
    //
    // Every console message an arbitrary website prints arrives here, so the
    // prefix test comes first and the nonce decides trust: it lives only in the
    // capture script's isolated-world closure, which the page cannot read.
    // What survives both is still page-authored, and still rebuilt by
    // `normalizeRawSteps` in `recordCaptured`.
    wc.on("console-message", (details) => {
      if (!session) return;
      const entry = parseCaptureMessage(details.message, session.captureNonce);
      if (entry) ingestCapture(entry, "console");
    });

    // Glaze routes cross-origin main-frame navigations to the SYSTEM BROWSER by
    // default, so every event that can carry one has to be intercepted — not
    // just `will-navigate`. `will-redirect` is the gap that actually escaped: a
    // server 302 to another origin fires that instead, so a click that started
    // same-origin left the trainer the moment the site redirected, which a
    // Shopify checkout does as a matter of course.
    //
    // decideNavigation decides; this only carries the decision out. It fails
    // CLOSED — anything not provably safe is contained or blocked.
    let lastContained: { url: string; at: number } | null = null;
    const guardNavigation = (event: string) => (details: WebContentsNavigationEvent) => {
      void drain();
      const decision = decideNavigation(details, selfLoad);

      if (decision.action === "allow") {
        if (selfLoad !== null && details?.url === selfLoad) selfLoad = null;
        return;
      }

      // Cancel FIRST. Everything after this point is best-effort; the one thing
      // that must happen on every path is that the default never runs.
      try {
        details.preventDefault();
      } catch (err) {
        logger.error("recorder", "Could not cancel a navigation — it may reach the system browser", {
          event,
          url: String(details?.url ?? ""),
          err: String(err),
        });
      }

      if (decision.action === "block") {
        logContained(String(details?.url ?? ""), decision.reason, event);
        return;
      }

      const now = Date.now();
      if (isDuplicateContainment(lastContained, decision.url, now)) return;
      lastContained = { url: decision.url, at: now };
      loadNavInWindow(decision.url);
    };

    for (const event of GUARDED_NAVIGATION_EVENTS) {
      // Electron types `on` as an overload set keyed by literal event name, so
      // iterating a union of names doesn't resolve to a single overload. The
      // handler shape is identical for all three (they share
      // WebContentsNavigationEvent), so the cast is on the dispatch, not the
      // contract — and the list stays the single source of truth for which
      // events are guarded.
      (wc.on as (e: string, fn: (details: WebContentsNavigationEvent) => void) => void)(
        event,
        guardNavigation(event),
      );
    }

    wc.on("did-navigate", () => {
      void drain();
      broadcastTrainingUrl();
    });

    // `did-navigate` alone misses the URL changes that matter most on a modern
    // site. A single-page app moves between routes with `history.pushState`,
    // which fires ONLY `did-navigate-in-page` — so on any SPA the bar would
    // have shown the entry URL for the whole session, which is precisely the
    // stale reading the strip exists to fix. `did-redirect-navigation` catches
    // the intermediate hop of a login round-trip.
    wc.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame) broadcastTrainingUrl();
    });
    wc.on("did-redirect-navigation", () => broadcastTrainingUrl());
    wc.on("did-start-loading", () => broadcastTrainingUrl());
    wc.on("did-stop-loading", () => broadcastTrainingUrl());

    // THE BUG THE STRIP WAS BUILT AGAINST. Electron's default handling of
    // `page-title-updated` copies `document.title` onto the window, and the old
    // URL bar WAS the window title — so every load overwrote the URL with the
    // site's own title and the trainer showed "Ritual" instead of where you
    // were. The strip is now the URL bar, but the title is still the window's
    // accessible name and still says which recording this is, so the page is
    // refused it here rather than being allowed to win a race nobody sees.
    wc.on("page-title-updated", (event) => {
      event.preventDefault();
    });

    // Right-click test-tools menu: resolve the element under the cursor, then
    // pop a native macOS menu whose assertion/wait/refine items are pre-targeted
    // at that element. Picking an item pushes a `recorder:contextAction` event
    // to the main window, which opens the Add-step dialog prefilled so the user
    // can tweak before inserting. The menu belongs to the recorder window (an
    // external page we don't own), so it must be a native backend menu, not
    // in-page React.
    wc.on("context-menu", (_event, params) => {
      void (async () => {
        if (!recWindow || recWindow.isDestroyed() || !session) return;
        const zoom = wc.getZoomFactor?.() ?? 1;
        // `params.x/y` are relative to the webContents that fired the event —
        // the PAGE's, so they need no strip correction here. The popup below
        // does: it positions against the WINDOW.
        // Rounded on both branches so what lands in the script template below is
        // always a numeral, whatever the native layer hands us.
        const px = Math.round(zoom === 1 ? params.x : params.x / zoom);
        const py = Math.round(zoom === 1 ? params.y : params.y / zoom);
        let picked: PickedElement | null = null;
        let prefillText = "";
        let prefillValue = "";
        try {
          const json = (await pageExecutor(wc).executeJavaScript(`(${PICK_AT_POINT_SCRIPT})(${px}, ${py})`)) as string;
          // The third route out of the page, and normalized like the other two.
          // Nothing here reaches a raw sink today — the locators are quoted by
          // the generator and the label only renders in a native menu — but the
          // page chooses every byte of it, including how many.
          if (typeof json === "string" && json && json.length <= MAX_DRAIN_BYTES) {
            const parsed = JSON.parse(json) as Record<string, unknown>;
            picked = normalizePickedElement(parsed?.picked);
            prefillText = typeof parsed?.text === "string" ? parsed.text.slice(0, MAX_STEP_STRING_LENGTH) : "";
            prefillValue = typeof parsed?.value === "string" ? parsed.value.slice(0, MAX_STEP_STRING_LENGTH) : "";
          }
        } catch {
          // Page may be mid-navigation; show the menu without a target.
        }
        const targetLabel = picked ? picked.description || picked.tag : "No element here";

        // Assert element submenu (element-aware). Text/value kinds prefill the
        // element's current text so the dialog opens with a sensible default.
        const assertElItems: MenuItemConstructorOptions[] = [
          { label: "Is visible", click: () => ctxAction({ kind: "assertion", assert: "visible", picked, prefillText, prefillValue }) },
          { label: "Is hidden", click: () => ctxAction({ kind: "assertion", assert: "hidden", picked, prefillText, prefillValue }) },
          { label: "Contains text", click: () => ctxAction({ kind: "assertion", assert: "text", picked, prefillText, prefillValue }) },
          { label: "Has exact text", click: () => ctxAction({ kind: "assertion", assert: "exactText", picked, prefillText, prefillValue }) },
          { label: "Is enabled", click: () => ctxAction({ kind: "assertion", assert: "enabled", picked, prefillText, prefillValue }) },
          { label: "Is disabled", click: () => ctxAction({ kind: "assertion", assert: "disabled", picked, prefillText, prefillValue }) },
          { label: "Is checked", click: () => ctxAction({ kind: "assertion", assert: "checked", picked, prefillText, prefillValue }) },
          { label: "Is unchecked", click: () => ctxAction({ kind: "assertion", assert: "unchecked", picked, prefillText, prefillValue }) },
          { label: "Has value", click: () => ctxAction({ kind: "assertion", assert: "value", picked, prefillText, prefillValue }) },
          { label: "Has attribute", click: () => ctxAction({ kind: "assertion", assert: "attribute", picked, prefillText, prefillValue }) },
          { label: "Has count", click: () => ctxAction({ kind: "assertion", assert: "count", picked, prefillText, prefillValue }) },
          // The one item here worth right-clicking for: `picked.css` carries the
          // element's computed values, read with the cursor over it, so the
          // dialog opens with the HOVERED values already listed.
          { label: "Has CSS property…", click: () => ctxAction({ kind: "assertion", assert: "css", picked, prefillText, prefillValue }) },
        ];
        const stateItems: MenuItemConstructorOptions[] = [
          { label: "Hover (:hover)", click: () => ctxAction({ kind: "elementState", elementState: "hover", picked, prefillText: "", prefillValue: "" }) },
          { label: "Focus (:focus)", click: () => ctxAction({ kind: "elementState", elementState: "focus", picked, prefillText: "", prefillValue: "" }) },
        ];
        // The URL asserts prefill from the PAGE'S URL, not from `prefillValue`.
        // They used to carry `prefillValue` — the clicked element's `.value` —
        // which is a form field's contents and has nothing to do with the
        // location. Right-clicking a filled-in email box and choosing "URL
        // contains…" opened the dialog suggesting the email address.
        const assertPageItems: MenuItemConstructorOptions[] = [
          { label: "URL contains…", click: () => ctxAction({ kind: "assertion", assert: "url", picked: null, prefillText: "", prefillValue: urlAssertPrefill("url", currentPageUrl()) }) },
          { label: "URL ends with…", click: () => ctxAction({ kind: "assertion", assert: "urlEndsWith", picked: null, prefillText: "", prefillValue: urlAssertPrefill("urlEndsWith", currentPageUrl()) }) },
          { label: "URL is…", click: () => ctxAction({ kind: "assertion", assert: "urlIs", picked: null, prefillText: "", prefillValue: urlAssertPrefill("urlIs", currentPageUrl()) }) },
          { label: "Page title is…", click: () => ctxAction({ kind: "assertion", assert: "title", picked: null, prefillText: "", prefillValue: currentPageTitle() }) },
          { label: "Page title contains…", click: () => ctxAction({ kind: "assertion", assert: "titleContains", picked: null, prefillText: "", prefillValue: currentPageTitle() }) },
        ];
        const waitItems: MenuItemConstructorOptions[] = [
          { label: "For element visible", click: () => ctxAction({ kind: "wait", waitMode: "element", picked, prefillText: "", prefillValue: "" }) },
          { label: "For element hidden", click: () => ctxAction({ kind: "wait", waitMode: "hidden", picked, prefillText: "", prefillValue: "" }) },
          { label: "For duration…", click: () => ctxAction({ kind: "wait", waitMode: "time", picked: null, prefillText: "", prefillValue: "" }) },
          { label: "Until…", click: () => ctxAction({ kind: "wait", waitMode: "until", picked, prefillText: "", prefillValue: "" }) },
        ];
        const addStepItems: MenuItemConstructorOptions[] = [
          { label: "Go to URL", click: () => ctxAction({ kind: "goto", picked: null, prefillText: "", prefillValue: "" }) },
          { label: "Press key", click: () => ctxAction({ kind: "press", picked: null, prefillText: "", prefillValue: "" }) },
          { label: "Set viewport", click: () => ctxAction({ kind: "viewport", picked: null, prefillText: "", prefillValue: "" }) },
          { label: "Find element", click: () => ctxAction({ kind: "find", picked, prefillText: "", prefillValue: "" }) },
        ];

        const template: MenuItemConstructorOptions[] = [
          { label: targetLabel, enabled: false },
          { type: "separator" },
          { label: "Assert element", submenu: assertElItems },
          { label: "Assert page", submenu: assertPageItems },
          { label: "Set element state", submenu: stateItems },
          { label: "Wait", submenu: waitItems },
          {
            label: "Refine selector for this element",
            enabled: !!picked,
            click: () => ctxAction({ kind: "refine", picked, prefillText: "", prefillValue: "" }),
          },
          { type: "separator" },
          { label: "Add step", submenu: addStepItems },
        ];
        const menu = Menu.buildFromTemplate(template);
        // Offset by the strip: `params` are page-relative but `popup` places
        // against the window's content box, so without this the menu opens
        // `stripHeight()` pixels above the cursor.
        menu.popup({ window: recWindow, x: params.x, y: params.y + stripHeight() });
      })();
    });

    // Show the window as early as possible. `ready-to-show` fires when the
    // first page has enough layout to display without a white flash, but on a
    // slow redirect (e.g. shopify.com → /website/builder) it can lag. Fall back
    // to `dom-ready` (1.5s after creation) so the user sees the window opening
    // promptly instead of a blank background with "Recording" and no window.
    let showFallback: ReturnType<typeof setTimeout> | null = null;
    // See trainer-window-gate.ts: any of four signals shows the window, and
    // "never shown" is the only thing that counts as a failure to open.
    const gate = createTrainerWindowGate(
      () => {
        if (showFallback) {
          clearTimeout(showFallback);
          showFallback = null;
        }
        recWindow?.show();
      },
      () => !!recWindow && !recWindow.isDestroyed(),
    );
    // Prefer the WebView's own readiness signals (no white flash) when they
    // fire, but guarantee the window appears with a creation-relative fallback
    // so a cold-start lag in those events can't leave it hidden.
    recWindow.once("ready-to-show", () => gate.signal("ready-to-show"));
    wc.once("dom-ready", () => gate.signal("dom-ready"));
    showFallback = setTimeout(() => gate.signal("fallback"), SHOW_FALLBACK_MS);
    recWindow.on("closed", () => void finalize());

    // Log the size the training window settles at after a manual resize.
    //
    // The window's page area is what every step from here on is recorded
    // against — a locator captured at 1280 wide may not exist at 390 — and
    // dragging the window edge leaves no other trace. "This test only fails on
    // one machine" is usually this, and the log is the only place the size at
    // capture time can be recovered from afterwards.
    //
    // `resized` (end of gesture) rather than `resize` (every frame of the drag):
    // one line per deliberate change, not hundreds per drag.
    recWindow.on("resized", () => {
      if (!recWindow || recWindow.isDestroyed()) return;
      // Unconditionally, and BEFORE the replay bail-out below: the views are
      // positioned in absolute bounds, so a window the user drags wider leaves
      // the page at its old width with a band of empty window beside it until
      // something re-lays them.
      layoutViews();
      // A replayed `viewport` step resizes this window through the same host
      // API, and macOS emits `resized` for that too. Logging it here would put
      // a line claiming a manual resize into the log whose entire purpose is to
      // record the manual resizes that leave no other trace — the replay writes
      // its own, more detailed line (see resize-service.ts).
      if (session?.replaying) return;
      // The PAGE's size, which is what steps are captured against — the
      // window's content box also holds the URL strip, and logging that number
      // would overstate the recording viewport by the strip's height.
      const [width, height] = recWindow.getContentSize();
      logger.info("recorder", "The training window was resized", {
        testId,
        pageSize: `${width}x${Math.max(0, height - stripHeight())}`,
      });
    });

    // A same-origin redirect on load (e.g. adding a trailing slash) can retrigger
    // the will-navigate interceptor above. Route the initial load through
    // loadNavInWindow so `selfLoad` is set — the will-navigate guard then
    // recognizes our own programmatic load and lets it through instead of
    // preventDefault()-ing it (which cancelled the first load with
    // NSURLErrorCancelled -999 and left the window blank).
    let loadDone = false;
    const finishLoad = () => {
      if (loadDone) return;
      loadDone = true;
      // A completed load is itself a reason to show. Without this, a page that
      // loaded FASTER than SHOW_FALLBACK_MS raced the failure check below and a
      // working window was closed as "failed to open".
      gate.signal("load-finished");
    };
    await new Promise<void>((resolve) => {
      loadNavInWindow(url);
      wc.once("did-finish-load", () => { finishLoad(); resolve(); });
      wc.once("did-fail-load", () => { finishLoad(); resolve(); });
      // Bound how long controls stay disabled waiting for the first page. The
      // window itself is already shown far earlier (SHOW_FALLBACK_MS), so this
      // only gates `pageReady`, not the window opening.
      setTimeout(() => { finishLoad(); resolve(); }, LOAD_TIMEOUT_MS);
    });

    // If the session was already torn down (user closed early), bail.
    if (!session) return currentState();

    // Only a genuine failure now: the window was never shown (couldn't open) or
    // was destroyed. A slow-but-fine cold-start load no longer trips this — the
    // window is force-shown within SHOW_FALLBACK_MS regardless of load timing.
    if (gate.failed(recWindow.isDestroyed())) {
      session.loadFailed = true;
      const message = `The training window couldn't open for ${url}.`;
      logger.error("recorder", "Trainer window failed to open", { url, testId });
      // Log to run history so the failure is visible in Stats.
      try {
        const logText = `${message}\n\nThe training browser window did not open. This can happen on a slow network, a redirect loop, or if the site is unreachable.\n\nTry again, or check Stats → Run history for more details.`;
        runHistoryStore.append(
          {
            testId,
            testName: name,
            url,
            status: "failed",
            exitCode: -1,
            startedAt: createdAt,
            finishedAt: Date.now(),
          },
          logText,
        );
      } catch {
        /* non-fatal — the error dialog is the primary feedback */
      }
      // Tear down the session without finalizing (no steps to save).
      const failedId = session.testId;
      session = null;
      closeTrainerPanel();
      if (recWindow && !recWindow.isDestroyed()) recWindow.close();
      destroyViews();
      recWindow = null;
      stopPolling();
      broadcastState();
      sendToMain("recorder:loadFailed", { testId: failedId, message });
      return currentState();
    }

    session.pageReady = true;
    startPolling();
    broadcastState();

    // Opened only once the browser is genuinely up: docking resizes that window,
    // and a panel that appeared next to a window which then failed to open would
    // be a floating orphan with nothing to control.
    //
    // `fixedBrowserWidth` when this session has a size: docking normally takes
    // its width out of the training browser, which would leave the page
    // rendering at one width while the recorded `viewport` step promises
    // another — the two features would quietly cancel out.
    if (recorderSettingsStore.get().trainerPanelEnabled && recWindow && !recWindow.isDestroyed()) {
      await openTrainerPanel(recWindow, { fixedBrowserWidth: viewport !== null }).catch((err) => {
        // The panel is an accelerator, not the trainer — the main window still
        // has the full one. Failing to open it must not fail the session.
        logger.warn("recorder", "Could not open the trainer panel", { err: String(err) });
      });
    }

    return currentState();
  },

  async pause(): Promise<RecorderState> {
    if (session) {
      session.paused = true;
      await applyStateAttributes();
      broadcastState();
    }
    return currentState();
  },

  async resume(): Promise<RecorderState> {
    if (session) {
      session.paused = false;
      await applyStateAttributes();
      broadcastState();
    }
    return currentState();
  },

  async setAssertMode(mode: AssertKind | null, soft = false): Promise<RecorderState> {
    if (session) {
      session.assertMode = mode;
      session.assertSoft = mode ? soft : false;
      await applyStateAttributes();
      // `focusTrainingPage()`, not a bare `recWindow.focus()`. Arming an
      // assertion is a request to go and click something in the PAGE, and the
      // window has two focusable webContents — so focusing only the window
      // leaves key events wherever they were, which after "Assert URL" is the
      // read-only URL strip. That is the exact case the function's docstring
      // names, and `assertUrl` above routes through here from that very bar.
      // `startRefine` (the other armed picker) has always used it.
      if (mode) focusTrainingPage();
      broadcastState();
    }
    return currentState();
  },

  /**
   * Open a URL assertion prefilled with where the page actually is.
   *
   * Called from the training browser's own URL strip — the surface the user is
   * already looking at when they decide to assert on the location. Before this
   * existed the value had to be typed from memory, because the only place the
   * full URL was legible was outside the app: the trainer panel showed the
   * session's START url, and the window title showed the site's `document.title`.
   *
   * Routes through `ctxAction`, the same push the right-click menu uses, so the
   * dialog opens in whichever trainer is in front and there is one code path
   * that decides what a prefilled assertion looks like.
   */
  assertUrl(kind: AssertKind): RecorderState {
    if (session) {
      ctxAction({
        kind: "assertion",
        assert: kind,
        picked: null,
        prefillText: "",
        prefillValue: urlAssertPrefill(kind, currentPageUrl()),
      });
    }
    return currentState();
  },

  /** Where the training page is right now, for the URL strip's initial read.
   *  The strip subscribes to `recorder:trainingUrl` for everything after that;
   *  this answers the gap between its bundle loading and the next navigation. */
  getTrainingUrl(): { url: string; loading: boolean } {
    return {
      url: currentPageUrl(),
      loading: !!session && !session.pageReady,
    };
  },

  /** Enter "Refine Selector" mode: pause capture and let the user pick an
   *  element in the training window without interacting with the page. */
  async startRefine(): Promise<RecorderState> {
    if (session) {
      session.refineMode = true;
      session.paused = true;
      session.assertMode = null;
      session.assertSoft = false;
      await applyStateAttributes();
      focusTrainingPage();
      broadcastState();
    }
    return currentState();
  },

  /** Leave refine mode and resume the recording session (after the review
   *  dialog resolves, or when the user cancels the picker). */
  async endRefine(): Promise<RecorderState> {
    if (session) {
      session.refineMode = false;
      session.paused = false;
      await applyStateAttributes();
      broadcastState();
    }
    return currentState();
  },

  deleteStep(stepId: string): RecorderState {
    if (session) {
      const idx = session.steps.findIndex((s) => s.id === stepId);
      if (idx < 0) return currentState();
      // Deleting one delimiter of a conditional block removes both, so blocks
      // stay balanced — the enclosed steps simply become un-wrapped.
      const remove = new Set<number>([idx]);
      const partner = matchingBlockIndex(session.steps, idx);
      if (partner >= 0) remove.add(partner);
      const cursor = session.cursor;
      const removedBeforeCursor = [...remove].filter((i) => i < cursor).length;
      session.steps = session.steps.filter((_, i) => !remove.has(i));
      session.cursor = clampCursor(session.cursor - removedBeforeCursor);
      broadcastSteps();
      broadcastState();
    }
    return currentState();
  },

  /** Insert a manually-added or AI-generated step at `index` (default: cursor). */
  insertStep(raw: RawStep, index?: number): RecorderState {
    if (session) {
      // Normalized for the same reason the drain is: this arrives over IPC, and
      // its fields reach the generator through the identical path. A step the
      // page couldn't sneak in the front door shouldn't get in the side one.
      const clean = normalizeRawStep(raw);
      if (!clean) return currentState();
      const step: Step = { id: randomUUID(), timestamp: Date.now(), ...clean };
      const at = index == null ? clampCursor(session.cursor) : clampCursor(index);
      session.steps.splice(at, 0, step);
      session.cursor = at + 1;
      broadcastSteps();
      broadcastState();
    }
    return currentState();
  },

  /** Move a step to a new index (drag-to-reorder). */
  reorderStep(stepId: string, toIndex: number): RecorderState {
    if (session) {
      const from = session.steps.findIndex((s) => s.id === stepId);
      if (from >= 0) {
        const [moved] = session.steps.splice(from, 1);
        const to = Math.max(0, Math.min(session.steps.length, toIndex));
        session.steps.splice(to, 0, moved);
        broadcastSteps();
        broadcastState();
      }
    }
    return currentState();
  },

  /** Shallow-merge editable fields of a step (inline editing). */
  updateStep(stepId: string, patch: Partial<Step>): RecorderState {
    if (session) {
      const step = session.steps.find((s) => s.id === stepId);
      if (step) {
        const allowed: (keyof Step)[] = [
          "value",
          "text",
          "url",
          "attr",
          // Copied WITHOUT re-normalizing, like every other key here — which is
          // exactly why `script-generator` re-checks `cssProp` and
          // `elementState` on its own rather than trusting the step model.
          "cssProp",
          "cssMatch",
          "elementState",
          "count",
          "width",
          "height",
          "waitMs",
          "waitUntil",
          "timeoutMs",
          "soft",
          "assert",
          "locator",
          "label",
          "continueOnFailure",
          "disabled",
          "fingerprint",
        ];
        const target = step as unknown as Record<string, unknown>;
        const src = patch as Record<string, unknown>;
        for (const key of allowed) {
          if (key in patch) target[key] = src[key];
        }
        // Retargeting a step (Refine Selector) may point it at a DIFFERENT
        // element, which makes the recorded fingerprint a description of
        // something else — and Auto-Heal scoring against it would then confidently
        // propose the old element. Dropping it falls back to locator-only
        // scoring, which is merely weaker rather than wrong. Applying a heal
        // candidate is the exception: same intended element, new locator, so
        // that path preserves the fingerprint (see applyHeal).
        if ("locator" in patch && !patch.fingerprint) delete target.fingerprint;
        broadcastSteps();
        broadcastState();
      }
    }
    return currentState();
  },

  // ── Live cookies in the training browser ──────────────────────────
  // These act on the session immediately; recording them as a test step is a
  // separate, explicit choice in the panel (insertStep with a cookie step).

  /** Cookies visible to the page currently open in the trainer. */
  async listCookies(): Promise<(CookieSpec & { hostOnly?: boolean; session?: boolean })[]> {
    if (!pageAlive()) return [];
    const url = currentPageUrl();
    if (!url) return [];
    return listCookies(pageWc() as unknown as CookieHost, url);
  },

  /** Create or update a cookie in the training browser. */
  async setCookie(spec: CookieSpec): Promise<void> {
    if (!pageAlive()) throw new Error("Recorder window is not open.");
    await setCookie(pageWc() as unknown as CookieHost, spec, currentPageUrl());
  },

  /** Delete one cookie from the training browser. */
  async deleteCookie(spec: CookieSpec): Promise<void> {
    if (!pageAlive()) throw new Error("Recorder window is not open.");
    await deleteCookie(pageWc() as unknown as CookieHost, spec, currentPageUrl());
  },

  /** Remove every cookie visible to the current page. */
  async clearCookies(): Promise<{ removed: number }> {
    if (!pageAlive()) throw new Error("Recorder window is not open.");
    const removed = await clearCookies(pageWc() as unknown as CookieHost, currentPageUrl());
    return { removed };
  },

  /** Apply a user-chosen Auto-Heal candidate locator to a step. Thin wrapper
   *  over `updateStep` so the heal menu has a dedicated IPC channel. */
  applyHeal(stepId: string, locator: Locator): RecorderState {
    logger.info("recorder", "Applying heal candidate", { stepId, locator });
    // Pass the existing fingerprint back through so updateStep's
    // retarget-clears-fingerprint rule doesn't fire: a heal points the SAME
    // intended element at a new locator, and losing the fingerprint here would
    // make every subsequent heal of this step weaker than the first.
    const existing = session?.steps.find((s) => s.id === stepId)?.fingerprint;
    return this.updateStep(stepId, { locator, ...(existing ? { fingerprint: existing } : {}) });
  },

  /** Set the index at which the next captured/inserted step will land. */
  setCursor(index: number): RecorderState {
    if (session) {
      session.cursor = clampCursor(index);
      broadcastState();
    }
    return currentState();
  },

  /**
   * Best-effort in-window preview of a single step: resolve its locator in the
   * live page and perform the action / evaluate the assertion via injected JS.
   * This is a synthetic-event preview, NOT Playwright's actionability engine, so
   * results can differ from a real run. Capture is suspended for the duration
   * (see `withCaptureSuspended`) so a replayed interaction is not re-recorded.
   * Returns a DebugEntry (with verbose logs) that is also persisted to the
   * per-test debug log store.
   *
   * Emits the same `recorder:replayStep` begin/end pair the multi-step paths do.
   * That is what gives a single-step replay the identical row treatment — the
   * spinner, then the ephemeral pass/fail outline — instead of a second,
   * near-identical feedback path that drifts from the first.
   */
  async replayStep(stepId: string): Promise<DebugEntry> {
    const empty = (error: string): DebugEntry => ({
      stepId,
      stepIndex: -1,
      stepLabel: "",
      ok: false,
      error,
      at: Date.now(),
      logs: [{ i: 0, t: Date.now(), level: "error", m: error }],
    });
    if (!session) return empty("No active recording session.");
    const page = pageWc();
    if (!page) return empty("Recorder window is not open.");
    const idx = session.steps.findIndex((s) => s.id === stepId);
    const step = session.steps[idx];
    if (!step) return empty("Step not found.");

    const wc = pageExecutor(page);
    sendToMain("recorder:replayStep", { index: idx, status: "begin", ok: true });
    return withCaptureSuspended(async () => {
      try {
        const result = await runStep(wc, step);
        let ok = !!(result && typeof result.ok === "boolean" && result.ok);
        let error = ok ? undefined : result?.error || "Replay produced no result.";
        let logs: DebugEntry["logs"] = result?.logs ?? [];
        // Auto-Heal: a single-step preview that failed on an unresolved locator
        // gets the same healing pass as a full replay run.
        if (!ok && step.locator) {
          const healed = await healAndRetry(wc, step, idx, error);
          if (healed.okWithHeal) {
            ok = true;
            error = undefined;
            if (healed.healedLogs) logs = healed.healedLogs;
          }
        }
        const entry: DebugEntry = {
          stepId,
          stepIndex: idx,
          stepLabel: describeStep(step),
          ok,
          error,
          at: Date.now(),
          logs,
        };
        if (!ok) logger.info("recorder", "replayStep failed", { stepId, error });
        this.persistDebug(entry);
        // One rule for every replay, single step included: the browser is now
        // past this step, so the insert cursor is too.
        if (ok) cursorPastReplayed(idx);
        sendToMain("recorder:replayStep", { index: idx, status: "end", ok });
        return entry;
      } catch (err) {
        const entry: DebugEntry = {
          stepId,
          stepIndex: idx,
          stepLabel: describeStep(step),
          ok: false,
          error: String(err),
          at: Date.now(),
          logs: verboseErrorLogs(err, step),
        };
        logger.info("recorder", "replayStep threw", { stepId, error: String(err) });
        this.persistDebug(entry);
        // A throw is a failed step, not an absent one: without this the row
        // keeps the "begin" spinner forever.
        sendToMain("recorder:replayStep", { index: idx, status: "end", ok: false });
        return entry;
      }
    });
  },

  /**
   * Replay recorded steps from the beginning, stopping after the first step
   * that completes successfully — so the user can continue iterating manually
   * from that point. Like replayStep, capture is suppressed during the run.
   * Returns the index of the step it stopped after (or -1 if all failed / none).
   * Each replayed step's DebugEntry is persisted along the way.
   */
  async replayFromStart(): Promise<{
    ok: boolean;
    stoppedAtIndex: number;
    error?: string;
  }> {
    if (!session) return { ok: false, stoppedAtIndex: -1, error: "No active recording session." };
    const page = pageWc();
    if (!page) {
      return { ok: false, stoppedAtIndex: -1, error: "Recorder window is not open." };
    }
    const wc = pageExecutor(page);
    return withCaptureSuspended(async () => {
      try {
        for (let i = 0; i < (session?.steps.length ?? 0); i++) {
          // The window may close (finalize → session = null) mid-run.
          if (!session || !pageAlive()) break;
          const step = session.steps[i];
          // A disabled step is skipped — log why and continue without running it.
          if (step.disabled) {
            logger.info("recorder", "Step skipped — disabled", { stepIndex: i });
            cursorPastReplayed(i);
            continue;
          }
          try {
            const result = await runStep(wc, step);
            let ok = !!(result && result.ok);
            let error = ok ? undefined : result?.error || `Step ${i + 1} failed during replay.`;
            let logs: DebugEntry["logs"] = result?.logs ?? [];
            // Auto-Heal before treating an unresolved locator as the stopping
            // point — a healed step counts as the success this path looks for.
            if (!ok && step.locator && step.type !== "if") {
              const healed = await healAndRetry(wc, step, i, error);
              if (healed.okWithHeal) {
                ok = true;
                error = undefined;
                if (healed.healedLogs) logs = healed.healedLogs;
              }
            }
            const entry: DebugEntry = {
              stepId: step.id,
              stepIndex: i,
              stepLabel: describeStep(step),
              ok,
              error,
              at: Date.now(),
              logs,
            };
            this.persistDebug(entry);
            // Structural logic steps never stop the run; a false condition skips
            // its whole block so downstream steps aren't previewed on a page that
            // never showed the conditional content.
            if (step.type === "if") {
              if (result?.met === false) {
                const end = matchingBlockIndex(session.steps, i);
                if (end > i) i = end;
              }
              cursorPastReplayed(i);
              continue;
            }
            if (step.type === "endif") {
              cursorPastReplayed(i);
              continue;
            }
            if (ok) {
              cursorPastReplayed(i);
              return { ok: true, stoppedAtIndex: i };
            }
            // Step failed — stop here so the user can iterate.
            return {
              ok: false,
              stoppedAtIndex: i,
              error: entry.error,
            };
          } catch (err) {
            const entry: DebugEntry = {
              stepId: step.id,
              stepIndex: i,
              stepLabel: describeStep(step),
              ok: false,
              error: String(err),
              at: Date.now(),
              logs: verboseErrorLogs(err, step),
            };
            this.persistDebug(entry);
            return { ok: false, stoppedAtIndex: i, error: String(err) };
          }
        }
        // No steps to replay.
        return { ok: true, stoppedAtIndex: -1 };
      } catch (err) {
        return { ok: false, stoppedAtIndex: -1, error: String(err) };
      }
    });
  },

  /**
   * Replay every recorded step in order (unlike replayFromStart, which stops
   * after the first success), emitting a `recorder:replayStep` event before and
   * after each step so the renderer can highlight progress. Used by the
   * "Edit in Trainer" auto-run. A soft assertion failure does not stop the run.
   * Returns the index of the first hard failure (or -1 if all passed).
   */
  async replayAll(): Promise<{ ok: boolean; failedAtIndex: number; error?: string }> {
    if (!session) return { ok: false, failedAtIndex: -1, error: "No active recording session." };
    const page = pageWc();
    if (!page) {
      return { ok: false, failedAtIndex: -1, error: "Recorder window is not open." };
    }
    const wc = pageExecutor(page);
    return withCaptureSuspended(async () => {
      try {
        for (let i = 0; i < (session?.steps.length ?? 0); i++) {
          // The window may close (finalize → session = null) mid-run.
          if (!session || !pageAlive()) break;
          const step = session.steps[i];
          // A disabled step is skipped — log why and move on without running it.
          if (step.disabled) {
            logger.info("recorder", "Step skipped — disabled", { stepIndex: i });
            cursorPastReplayed(i);
            continue;
          }
          sendToMain("recorder:replayStep", { index: i, status: "begin", ok: true });
          let ok = false;
          let error: string | undefined;
          let met: boolean | undefined;
          let logs: { i: number; t: number; level: "info" | "warn" | "error"; m: string }[] = [];
          try {
            const result = await runStep(wc, step);
            ok = !!(result && result.ok);
            met = result?.met;
            error = ok ? undefined : result?.error || `Step ${i + 1} failed during replay.`;
            logs = result?.logs ?? [];
          } catch (err) {
            error = String(err);
            logs = verboseErrorLogs(err, step);
          }
          // Auto-Heal: heal an unresolved locator before the failure stops the
          // run. Candidates are surfaced to the Console either way.
          if (!ok && step.locator && step.type !== "if") {
            const healed = await healAndRetry(wc, step, i, error);
            if (healed.okWithHeal) {
              ok = true;
              error = undefined;
              if (healed.healedLogs) logs = healed.healedLogs;
            }
          }
          const entry: DebugEntry = {
            stepId: step.id,
            stepIndex: i,
            stepLabel: describeStep(step),
            ok,
            error,
            at: Date.now(),
            logs,
          };
          this.persistDebug(entry);
          sendToMain("recorder:replayStep", { index: i, status: "end", ok });
          // Skip the body of a conditional block whose condition didn't hold —
          // the skipped steps are left un-highlighted (never begun), matching a
          // real run that branches past them.
          if (step.type === "if" && met === false) {
            const end = matchingBlockIndex(session.steps, i);
            if (end > i) i = end;
            cursorPastReplayed(i);
            continue;
          }
          // A soft assertion reports failure but doesn't stop the run.
          if (!ok && !step.soft) {
            return { ok: false, failedAtIndex: i, error };
          }
          cursorPastReplayed(i);
        }
        return { ok: true, failedAtIndex: -1 };
      } catch (err) {
        return { ok: false, failedAtIndex: -1, error: String(err) };
      }
    });
  },

  /**
   * Replay steps from `startIndex` through the end of the list, SLOWLY — a
   * settle before each step and a pause between them — so the user can watch
   * the test progress. Streams each step's result + verbose logs live to the
   * renderer via `recorder:replayLog` (a console/debug panel), and highlights
   * rows via `recorder:replayStep`. Unlike replayFromStart (which stops after
   * the first success), this runs the whole remainder; a hard failure stops it.
   * Capture is suppressed during the run. Structural if/endif steps are honored
   * (a false condition skips its block) but never counted or streamed.
   */
  async replayFromCurrent(startIndex: number): Promise<{
    ok: boolean;
    ranCount: number;
    passedCount: number;
    failedAtIndex: number;
    error?: string;
  }> {
    if (!session) {
      return { ok: false, ranCount: 0, passedCount: 0, failedAtIndex: -1, error: "No active recording session." };
    }
    const page = pageWc();
    if (!page) {
      return { ok: false, ranCount: 0, passedCount: 0, failedAtIndex: -1, error: "Recorder window is not open." };
    }
    const wc = pageExecutor(page);
    const from = Math.max(0, Math.min(startIndex, session.steps.length));
    const total = session.steps
      .slice(from)
      .filter((s) => s.type !== "if" && s.type !== "endif").length;
    let ran = 0;
    let passed = 0;
    sendToMain("recorder:replayLog", { phase: "start", startIndex: from, total });
    return withCaptureSuspended(async () => {
      try {
        for (let i = from; i < (session?.steps.length ?? 0); i++) {
          // The window may close (finalize → session = null) mid-run.
          if (!session || !pageAlive()) break;
          const step = session.steps[i];
          // A disabled step is skipped — log why, stream it as skipped, and move
          // on without running it (not counted in ran/passed totals).
          if (step.disabled) {
            logger.info("recorder", "Step skipped — disabled", { stepIndex: i });
            sendToMain("recorder:replayLog", {
              phase: "step",
              index: i,
              stepLabel: describeStep(step),
              ok: true,
              error: "Skipped — disabled",
              logs: [{ i: 0, t: Date.now(), level: "info", m: "Step skipped — disabled" }],
            });
            cursorPastReplayed(i);
            await sleep(REPLAY_STEP_DELAY_MS);
            continue;
          }
          sendToMain("recorder:replayStep", { index: i, status: "begin", ok: true });
          await sleep(REPLAY_SETTLE_MS);
          let ok = false;
          let error: string | undefined;
          let met: boolean | undefined;
          let logs: DebugEntry["logs"] = [];
          try {
            const result = await runStep(wc, step);
            ok = !!(result && result.ok);
            met = result?.met;
            error = ok ? undefined : result?.error || `Step ${i + 1} failed during replay.`;
            logs = result?.logs ?? [];
          } catch (err) {
            error = String(err);
            logs = verboseErrorLogs(err, step);
          }
          const entry: DebugEntry = {
            stepId: step.id,
            stepIndex: i,
            stepLabel: describeStep(step),
            ok,
            error,
            at: Date.now(),
            logs,
          };
          this.persistDebug(entry);
          sendToMain("recorder:replayStep", { index: i, status: "end", ok });
          // Structural steps: never counted or streamed; a false `if` skips its
          // whole block (leaving those steps un-highlighted, like a real run).
          if (step.type === "if") {
            if (met === false) {
              const end = matchingBlockIndex(session.steps, i);
              if (end > i) i = end;
            }
            cursorPastReplayed(i);
            await sleep(REPLAY_STEP_DELAY_MS);
            continue;
          }
          if (step.type === "endif") {
            cursorPastReplayed(i);
            await sleep(REPLAY_STEP_DELAY_MS);
            continue;
          }
          ran++;
          if (ok) passed++;
          let heal: HealResult | null = null;
          // Auto-Heal: if the step failed because its locator didn't resolve, try
          // to heal it before reporting the failure. If a candidate auto-succeeds,
          // count the step as passed and stream the healed result.
          if (!ok && step.locator) {
            const healed = await healAndRetry(wc, step, i, error);
            heal = healed.heal;
            if (healed.okWithHeal) {
              ok = true;
              passed++;
              error = undefined;
              if (healed.healedLogs) logs = healed.healedLogs;
              // Persist the healed outcome as the step's debug entry.
              const healedEntry: DebugEntry = {
                stepId: step.id,
                stepIndex: i,
                stepLabel: describeStep(step),
                ok: true,
                error: undefined,
                at: Date.now(),
                logs,
              };
              this.persistDebug(healedEntry);
              sendToMain("recorder:replayStep", { index: i, status: "end", ok: true });
            }
          }
          sendToMain("recorder:replayLog", {
            phase: "step",
            index: i,
            stepLabel: describeStep(step),
            ok,
            error,
            logs,
            heal: heal ?? undefined,
          });
          // A soft assertion reports failure but doesn't stop the run.
          if (!ok && !step.soft) {
            sendToMain("recorder:replayLog", { phase: "done", ran, passed, failedAtIndex: i });
            return { ok: false, ranCount: ran, passedCount: passed, failedAtIndex: i, error };
          }
          cursorPastReplayed(i);
          await sleep(REPLAY_STEP_DELAY_MS);
        }
        sendToMain("recorder:replayLog", { phase: "done", ran, passed, failedAtIndex: -1 });
        return { ok: true, ranCount: ran, passedCount: passed, failedAtIndex: -1 };
      } catch (err) {
        sendToMain("recorder:replayLog", { phase: "done", ran, passed, failedAtIndex: -1, error: String(err) });
        return { ok: false, ranCount: ran, passedCount: passed, failedAtIndex: -1, error: String(err) };
      }
    });
  },

  /** Persist a debug entry for the current session's test and push to the renderer. */
  persistDebug(entry: DebugEntry): void {
    if (!session) return;
    const all = recorderDebugStore.append(session.testId, entry);
    sendToMain("recorder:debugLogs", { testId: session.testId, entries: all });
  },

  /** All persisted debug entries for a test (for the panel on session open). */
  getDebugLogs(testId: string): DebugEntry[] {
    return recorderDebugStore.get(testId);
  },

  /** Remove one step's debug entry for the current session's test. */
  clearDebugLog(stepId: string): DebugEntry[] {
    if (!session) return [];
    const all = recorderDebugStore.remove(session.testId, stepId);
    sendToMain("recorder:debugLogs", { testId: session.testId, entries: all });
    return all;
  },

  stop(): void {
    if (recWindow && !recWindow.isDestroyed()) {
      recWindow.close();
    }
  },

  /** Close the training window WITHOUT finalizing — discards any steps
   *  captured this session. Used by the exit confirmation's "Don't Save and
   *  Exit" action. Tears down the session directly (no spec generation, no
   *  test record save) and closes the window. */
  discardExit(): void {
    // Before the window closes: closing the panel undocks it first, which gives
    // the training browser back the width docking took. Once the window is gone
    // there is nothing left to restore.
    closeTrainerPanel();
    if (session) {
      const s = session;
      session = null;
      stopPolling();
      logger.info("recorder", "Discarded recording (no save)", { id: s.testId, steps: s.steps.length });
    }
    if (recWindow && !recWindow.isDestroyed()) {
      // Prevent the `closed` → finalize() handler from running on a null session.
      recWindow.removeAllListeners("closed");
      recWindow.on("closed", () => {
        destroyViews();
        recWindow = null;
        broadcastState();
      });
      recWindow.close();
    } else {
      destroyViews();
      recWindow = null;
      broadcastState();
    }
  },
};

async function finalize(): Promise<void> {
  stopPolling();
  closeTrainerPanel();
  const s = session;
  session = null;
  destroyViews();
  recWindow = null;
  if (!s) {
    broadcastState();
    return;
  }

  // "Edit in Trainer" re-enters this path with an existing test's id, so the
  // record being written may already exist. Spread it FIRST and let this
  // session's results win, rather than building a fresh record: everything the
  // trainer doesn't know about — tags, variables, datasets, browser/headless
  // preferences, visual threshold and masks, the hidden flag — lives only on
  // the stored record, and a from-scratch rebuild silently discards all of it.
  const existing = testStore.get(s.testId);
  const record: TestRecord = {
    // Seed from the persisted defaults so NEW recordings inherit the user's
    // last-chosen run speed and capture preference. Placed before the spread so
    // an existing test keeps its own choices; the sidebar "Adjust Test Speed"
    // menu and the per-test toggle still override per test.
    speed: recorderSettingsStore.get().defaultRunSpeed,
    captureArtifacts: recorderSettingsStore.get().defaultCaptureArtifacts,
    ...(existing ?? {}),
    id: s.testId,
    name: s.name,
    url: s.url,
    createdAt: s.createdAt,
    updatedAt: Date.now(),
    steps: s.steps,
    scriptPath: existing?.scriptPath ?? testStore.scriptPathFor(s.testId),
    // Continuing in the trainer always regenerates from steps, so a previously
    // hand-edited script is replaced and the flag no longer holds.
    scriptEdited: false,
  };
  // Written after the record is assembled so the generator sees this session's
  // steps alongside the variables carried over from the existing record.
  record.scriptPath = testStore.regenerateScript(record);
  testStore.save(record);

  logger.info("recorder", "Recording finalized", { id: s.testId, steps: s.steps.length });
  broadcastState();
  sendToMain("recorder:finished", { testId: s.testId });
}
