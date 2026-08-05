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

import { BrowserWindow, logger, Menu } from "@glaze/core/backend";
import type { MenuItemConstructorOptions } from "@glaze/core/backend";

import {
  ATTR_ASSERT,
  ATTR_ASSERT_SOFT,
  ATTR_PAUSED,
  ATTR_REFINE,
  CAPTURE_SCRIPT,
  DRAIN_PICKED_SCRIPT,
  DRAIN_SCRIPT,
  PICK_AT_POINT_SCRIPT,
} from "../recorder/capture-script.js";
import { buildReplayScript } from "./step-replayer.js";
import { healStep } from "./auto-heal.js";
import type { CookieSpec } from "../recorder/types.js";
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
import { recorderDebugStore } from "./recorder-debug-store.js";
import { recorderSettingsStore } from "./recorder-settings-store.js";
import { runHistoryStore } from "./run-history-store.js";
import { describeStep } from "./script-generator.js";
import { testStore } from "./test-store.js";

// Pacing for the "Replay from current step" run so the user can watch it step
// through slowly: a short settle after highlighting a row before running it,
// and a longer pause between steps.
const REPLAY_SETTLE_MS = 300;
const REPLAY_STEP_DELAY_MS = 600;
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
    e.includes("did not resolve")
  );
}

/** Run the Auto-Heal engine for a failed step, then (if candidates were found)
 *  re-run the step with the best candidate to see if it succeeds. Pushes a
 *  `recorder:healSuggestion` event to the renderer so the Console can surface
 *  the candidates as a menu. Returns the heal result and whether the re-run
 *  with the applied locator succeeded (so the caller can count it as passed).
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
  // Try the best candidate first; if it succeeds, auto-apply it.
  const best = heal.candidates[0];
  try {
    const rerun = await runWithLocator(best.locator);
    if (rerun.ok) {
      heal.ok = true;
      heal.appliedLocator = best.locator;
      heal.autoApplied = true;
      // Auto-apply the healed locator to the step so future runs use it.
      if (session) {
        const idx = session.steps.findIndex((s) => s.id === step.id);
        if (idx >= 0) {
          session.steps[idx] = { ...session.steps[idx], locator: best.locator };
        }
      }
      sendToMain("recorder:healSuggestion", heal);
      return { heal, okWithHeal: true, healedLogs: rerun.logs };
    }
  } catch (err) {
    logger.info("recorder", "Auto-Heal re-run threw", { stepId: step.id, error: String(err) });
  }
  // Best candidate didn't auto-succeed — surface all candidates for the user.
  sendToMain("recorder:healSuggestion", heal);
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
  const live = recWindow && !recWindow.isDestroyed() ? recWindow.webContents.getURL() : "";
  return live || session?.url || "";
}

/**
 * Run one step during trainer replay.
 *
 * Single dispatch point on purpose: `cookie` steps CANNOT go through the
 * injected-script replayer, because an httpOnly cookie is invisible to
 * document.cookie by definition — they need the session API instead. Routing
 * every path through here means a new step kind can't be handled in some replay
 * paths and silently missed in others.
 */
async function runStep(
  wc: { executeJavaScript: (script: string) => Promise<unknown> },
  step: Step,
): Promise<ReplayStepResult> {
  if (step.type === "cookie") {
    // The trainer window can close mid-replay (the loops elsewhere guard for
    // exactly this), so don't assert it's alive — report a clean failure
    // instead of throwing a TypeError out of the replay loop.
    if (!recWindow || recWindow.isDestroyed()) {
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
    return applyCookieStep(
      recWindow.webContents as unknown as CookieHost,
      step,
      currentPageUrl(),
    );
  }
  return (await execWithTimeout(wc, buildReplayScript(step), REPLAY_STEP_TIMEOUT_MS)) as ReplayStepResult;
}

/** `tryHeal` with the standard in-window re-run wiring — every replay path
 *  re-runs a healed step the same way (substitute the locator, execute the
 *  replay script against the training window under the usual step timeout), so
 *  the four callers share this instead of repeating it. */
async function healAndRetry(
  wc: { executeJavaScript: (script: string) => Promise<unknown> },
  step: Step,
  stepIndex: number,
  error: string | undefined,
): Promise<{ heal: HealResult | null; okWithHeal: boolean; healedLogs?: DebugEntry["logs"] }> {
  return tryHeal(wc, step, stepIndex, error, async (locator) => {
    const healedStep = { ...step, locator: locator! };
    return (await execWithTimeout(wc, buildReplayScript(healedStep), REPLAY_STEP_TIMEOUT_MS)) as {
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
  /** continuing/extending an existing test rather than recording a new one */
  editing: boolean;
  /** preserved from the original record when editing, else the session start time */
  createdAt: number;
  /** snapshot of the global "show URL bar" setting for this session's window title */
  showUrlBar: boolean;
  /** true once the trainer window's first page has finished loading */
  pageReady: boolean;
  /** set when the window failed to open within the load timeout */
  loadFailed: boolean;
}

const POLL_INTERVAL_MS = 250;

let recWindow: BrowserWindow | null = null;
let session: Session | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function currentState(): RecorderState {
  return {
    recording: !!session,
    paused: session?.paused ?? false,
    assertMode: session?.assertMode ?? null,
    stepCount: session?.steps.length ?? 0,
    testId: session?.testId ?? null,
    url: session?.url ?? null,
    name: session?.name ?? null,
    editing: session?.editing ?? false,
    assertSoft: session?.assertSoft ?? false,
    cursor: session?.cursor ?? 0,
    refineMode: session?.refineMode ?? false,
    pageReady: session?.pageReady ?? false,
    loading: !!session && !session.pageReady && !session.loadFailed,
    loadFailed: session?.loadFailed ?? false,
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
  if (!recWindow || recWindow.isDestroyed() || !session) return;
  const wc = recWindow.webContents;
  try {
    await wc.executeJavaScript(CAPTURE_SCRIPT);
    await applyStateAttributes();
  } catch (err) {
    logger.warn("recorder", "Failed to inject capture script", { err: String(err) });
  }
}

async function applyStateAttributes(): Promise<void> {
  if (!recWindow || recWindow.isDestroyed() || !session) return;
  const wc = recWindow.webContents;
  const paused = session.paused ? "1" : "0";
  const assert = session.assertMode ?? "";
  const soft = session.assertSoft ? "1" : "0";
  const refine = session.refineMode ? "1" : "0";
  const crosshair = session.assertMode || session.refineMode;
  await wc.executeJavaScript(
    '(function(){var e=document.documentElement;' +
      'e.setAttribute("' + ATTR_PAUSED + '","' + paused + '");' +
      'e.setAttribute("' + ATTR_ASSERT + '","' + assert + '");' +
      'e.setAttribute("' + ATTR_ASSERT_SOFT + '","' + soft + '");' +
      'e.setAttribute("' + ATTR_REFINE + '","' + refine + '");' +
      'try{if(document.body)document.body.style.cursor=' +
      (crosshair ? '"crosshair"' : '""') +
      ';}catch(_){}' +
      'try{if("' + refine + '"!=="1"){var b=document.querySelector("[data-pw-refine-box]");if(b)b.style.display="none";}}catch(_){}' +
      "})()",
  );
}

/** Read and clear an element picked in refine mode; forward it to the app. */
async function drainPicked(): Promise<void> {
  if (!recWindow || recWindow.isDestroyed() || !session || !session.refineMode) return;
  try {
    const json = (await recWindow.webContents.executeJavaScript(DRAIN_PICKED_SCRIPT)) as string;
    if (!json) return;
    const picked = JSON.parse(json) as PickedElement;
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

async function drain(): Promise<void> {
  if (!recWindow || recWindow.isDestroyed() || !session) return;
  try {
    const json = (await recWindow.webContents.executeJavaScript(DRAIN_SCRIPT)) as string;
    const raw = JSON.parse(json) as RawStep[];
    for (const step of raw) addStep(step);
  } catch {
    // Page may be mid-navigation; the next poll will catch up.
  }
}

function windowLabel(): string {
  return session?.editing ? "Editing" : "Recording";
}

/** Payload pushed to the main window when the user picks an item from the
 *  right-click test-tools menu in the training browser. The renderer opens the
 *  Add-step dialog prefilled with these so the user can tweak before inserting. */
export interface ContextAction {
  kind: "assertion" | "wait" | "goto" | "press" | "viewport" | "find" | "refine";
  /** assert kind when kind === "assertion" */
  assert?: AssertKind;
  /** wait mode when kind === "wait" ("element" resolves the locator, "hidden"
   *  waits for the element to hide, "time" is a fixed duration) */
  waitMode?: "element" | "hidden" | "time";
  /** the element under the right-click, with its locator candidates */
  picked: PickedElement | null;
  /** the element's current text — prefills text/exactText asserts */
  prefillText: string;
  /** the element's current value — prefills value asserts */
  prefillValue: string;
}

/** Push a context-menu action to the main window's Add-step dialog. */
function ctxAction(action: ContextAction): void {
  sendToMain("recorder:contextAction", action);
}

/** Keep the native title bar showing the current page's URL (the trainer's
 *  stand-in for an address bar, since an externally-loaded page can't host an
 *  app-owned toolbar). No-op when the user has turned the setting off. */
function updateTitle(): void {
  if (!recWindow || recWindow.isDestroyed() || !session || !session.showUrlBar) return;
  const current = recWindow.webContents.getURL() || session.url;
  recWindow.setTitle(`${windowLabel()} — ${current}`);
}

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void drain();
    void drainPicked();
  }, POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export const recorderService = {
  getState(): RecorderState {
    return currentState();
  },

  async start(params: { url: string; name?: string; testId?: string }): Promise<RecorderState> {
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
      cursor: existingSteps.length,
      editing,
      createdAt,
      showUrlBar: recorderSettingsStore.get().showUrlBar,
      pageReady: false,
      loadFailed: false,
    };

    // Push the existing steps to the renderer so the trainer's live list shows
    // full context while extending. They're already in session.steps above, so
    // this is a push-only notification, not another addStep.
    broadcastSteps();
    // Broadcast the initial loading state so the renderer shows the loading
    // modal immediately — before the window even appears.
    broadcastState();

    // Initial navigation is the first step; later navigations are consequences of
    // recorded interactions (the window has no address bar). Skip when editing —
    // the existing steps already start with one.
    if (!editing) addStep({ type: "goto", url });

    recWindow = new BrowserWindow({
      windowKey: "recorder",
      width: 1200,
      height: 820,
      title: (editing ? "Editing — " : "Recording — ") + url,
      titleBarStyle: "default", // native draggable frame for an external page
      show: false,
      webPreferences: {
        // No "persist:" prefix: an in-memory session unique to this session,
        // so every training run starts logged out with empty cookies/storage
        // instead of inheriting state from a previous recording.
        partition: `recorder-incognito-${randomUUID()}`,
      },
    });

    const wc = recWindow.webContents;

    // Force navigation into the recorder window. `loadNavInWindow` re-issues the
    // navigation via loadURL; the guard stops that programmatic load from being
    // intercepted again (which would loop).
    let selfLoad: string | null = null;
    const loadNavInWindow = (target: string): void => {
      if (!recWindow || recWindow.isDestroyed()) return;
      selfLoad = target;
      void recWindow.webContents
        .loadURL(target)
        .catch(() => {})
        .finally(() => {
          if (selfLoad === target) selfLoad = null;
        });
    };

    // window.open / target=_blank that reach the native layer: keep in-window.
    wc.setWindowOpenHandler((details) => {
      if (/^https?:/i.test(details?.url ?? "")) loadNavInWindow(details.url);
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

    // Glaze routes cross-origin main-frame link navigations to the system
    // browser by default. Intercept them and load in the recorder window so all
    // navigation stays inside the trainer. Same-document (SPA) navigations are
    // left alone. Drain first so the click that triggered the nav isn't lost.
    wc.on("will-navigate", (details) => {
      void drain();
      const target = details.url;
      if (!details.isMainFrame || details.isSameDocument) return;
      if (!/^https?:/i.test(target)) return;
      if (selfLoad === target) {
        selfLoad = null;
        return;
      }
      details.preventDefault();
      loadNavInWindow(target);
    });

    wc.on("did-navigate", () => {
      void drain();
      updateTitle();
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
        const px = zoom === 1 ? params.x : Math.round(params.x / zoom);
        const py = zoom === 1 ? params.y : Math.round(params.y / zoom);
        let resolved: { picked: PickedElement; text: string; value: string } | null = null;
        try {
          const json = (await wc.executeJavaScript(`(${PICK_AT_POINT_SCRIPT})(${px}, ${py})`)) as string;
          if (json) resolved = JSON.parse(json) as { picked: PickedElement; text: string; value: string };
        } catch {
          // Page may be mid-navigation; show the menu without a target.
        }
        const picked = resolved?.picked ?? null;
        const prefillText = resolved?.text ?? "";
        const prefillValue = resolved?.value ?? "";
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
        ];
        const assertPageItems: MenuItemConstructorOptions[] = [
          { label: "URL contains…", click: () => ctxAction({ kind: "assertion", assert: "url", picked: null, prefillText: "", prefillValue }) },
          { label: "URL ends with…", click: () => ctxAction({ kind: "assertion", assert: "urlEndsWith", picked: null, prefillText: "", prefillValue }) },
          { label: "URL is…", click: () => ctxAction({ kind: "assertion", assert: "urlIs", picked: null, prefillText: "", prefillValue }) },
          { label: "Page title is…", click: () => ctxAction({ kind: "assertion", assert: "title", picked: null, prefillText: "", prefillValue }) },
        ];
        const waitItems: MenuItemConstructorOptions[] = [
          { label: "For element visible", click: () => ctxAction({ kind: "wait", waitMode: "element", picked, prefillText: "", prefillValue: "" }) },
          { label: "For element hidden", click: () => ctxAction({ kind: "wait", waitMode: "hidden", picked, prefillText: "", prefillValue: "" }) },
          { label: "For duration…", click: () => ctxAction({ kind: "wait", waitMode: "time", picked: null, prefillText: "", prefillValue: "" }) },
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
        menu.popup({ window: recWindow, x: params.x, y: params.y });
      })();
    });

    // Show the window as early as possible. `ready-to-show` fires when the
    // first page has enough layout to display without a white flash, but on a
    // slow redirect (e.g. shopify.com → /website/builder) it can lag. Fall back
    // to `dom-ready` (1.5s after creation) so the user sees the window opening
    // promptly instead of a blank background with "Recording" and no window.
    let shown = false;
    let showFallback: ReturnType<typeof setTimeout> | null = null;
    const showNow = () => {
      if (showFallback) {
        clearTimeout(showFallback);
        showFallback = null;
      }
      if (shown || !recWindow || recWindow.isDestroyed()) return;
      shown = true;
      recWindow.show();
    };
    // Prefer the WebView's own readiness signals (no white flash) when they
    // fire, but guarantee the window appears with a creation-relative fallback
    // so a cold-start lag in those events can't leave it hidden.
    recWindow.once("ready-to-show", showNow);
    wc.once("dom-ready", showNow);
    showFallback = setTimeout(showNow, SHOW_FALLBACK_MS);
    recWindow.on("closed", () => void finalize());

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
    if (!shown || recWindow.isDestroyed()) {
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
      if (recWindow && !recWindow.isDestroyed()) recWindow.close();
      recWindow = null;
      stopPolling();
      broadcastState();
      sendToMain("recorder:loadFailed", { testId: failedId, message });
      return currentState();
    }

    session.pageReady = true;
    startPolling();
    broadcastState();
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
      if (mode && recWindow && !recWindow.isDestroyed()) recWindow.focus();
      broadcastState();
    }
    return currentState();
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
      if (recWindow && !recWindow.isDestroyed()) recWindow.focus();
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
      const step: Step = { id: randomUUID(), timestamp: Date.now(), ...raw };
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
          "count",
          "width",
          "height",
          "waitMs",
          "soft",
          "assert",
          "locator",
          "label",
          "continueOnFailure",
          "disabled",
        ];
        const target = step as unknown as Record<string, unknown>;
        const src = patch as Record<string, unknown>;
        for (const key of allowed) {
          if (key in patch) target[key] = src[key];
        }
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
    if (!recWindow || recWindow.isDestroyed()) return [];
    const url = currentPageUrl();
    if (!url) return [];
    return listCookies(recWindow.webContents as unknown as CookieHost, url);
  },

  /** Create or update a cookie in the training browser. */
  async setCookie(spec: CookieSpec): Promise<void> {
    if (!recWindow || recWindow.isDestroyed()) throw new Error("Recorder window is not open.");
    await setCookie(recWindow.webContents as unknown as CookieHost, spec, currentPageUrl());
  },

  /** Delete one cookie from the training browser. */
  async deleteCookie(spec: CookieSpec): Promise<void> {
    if (!recWindow || recWindow.isDestroyed()) throw new Error("Recorder window is not open.");
    await deleteCookie(recWindow.webContents as unknown as CookieHost, spec, currentPageUrl());
  },

  /** Remove every cookie visible to the current page. */
  async clearCookies(): Promise<{ removed: number }> {
    if (!recWindow || recWindow.isDestroyed()) throw new Error("Recorder window is not open.");
    const removed = await clearCookies(recWindow.webContents as unknown as CookieHost, currentPageUrl());
    return { removed };
  },

  /** Apply a user-chosen Auto-Heal candidate locator to a step. Thin wrapper
   *  over `updateStep` so the heal menu has a dedicated IPC channel. */
  applyHeal(stepId: string, locator: Locator): RecorderState {
    logger.info("recorder", "Applying heal candidate", { stepId, locator });
    return this.updateStep(stepId, { locator });
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
   * results can differ from a real run. Capture is paused for the duration so a
   * replayed interaction is not re-recorded. Returns a DebugEntry (with verbose
   * logs) that is also persisted to the per-test debug log store.
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
    if (!recWindow || recWindow.isDestroyed()) return empty("Recorder window is not open.");
    const idx = session.steps.findIndex((s) => s.id === stepId);
    const step = session.steps[idx];
    if (!step) return empty("Step not found.");

    const wc = recWindow.webContents;
    const wasPaused = session.paused;
    try {
      // Suppress capture so the replayed interaction isn't recorded as a step.
      session.paused = true;
      await applyStateAttributes();
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
      return entry;
    } finally {
      if (session) session.paused = wasPaused;
      await applyStateAttributes().catch(() => {});
    }
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
    if (!recWindow || recWindow.isDestroyed()) {
      return { ok: false, stoppedAtIndex: -1, error: "Recorder window is not open." };
    }
    const wc = recWindow.webContents;
    const wasPaused = session.paused;
    try {
      session.paused = true;
      await applyStateAttributes();
      for (let i = 0; i < session.steps.length; i++) {
        const step = session.steps[i];
        // A disabled step is skipped — log why and continue without running it.
        if (step.disabled) {
          logger.info("recorder", "Step skipped — disabled", { stepIndex: i });
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
            continue;
          }
          if (step.type === "endif") continue;
          if (ok) {
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
    } finally {
      if (session) session.paused = wasPaused;
      await applyStateAttributes().catch(() => {});
    }
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
    if (!recWindow || recWindow.isDestroyed()) {
      return { ok: false, failedAtIndex: -1, error: "Recorder window is not open." };
    }
    const wc = recWindow.webContents;
    const wasPaused = session.paused;
    try {
      session.paused = true;
      await applyStateAttributes();
      for (let i = 0; i < session.steps.length; i++) {
        const step = session.steps[i];
        // A disabled step is skipped — log why and move on without running it.
        if (step.disabled) {
          logger.info("recorder", "Step skipped — disabled", { stepIndex: i });
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
          continue;
        }
        // A soft assertion reports failure but doesn't stop the run.
        if (!ok && !step.soft) {
          return { ok: false, failedAtIndex: i, error };
        }
      }
      return { ok: true, failedAtIndex: -1 };
    } catch (err) {
      return { ok: false, failedAtIndex: -1, error: String(err) };
    } finally {
      // The window may have closed (finalize → session = null) while the replay
      // loop was in flight; guard so we don't crash dereferencing a null session.
      if (session) session.paused = wasPaused;
      await applyStateAttributes().catch(() => {});
    }
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
    if (!recWindow || recWindow.isDestroyed()) {
      return { ok: false, ranCount: 0, passedCount: 0, failedAtIndex: -1, error: "Recorder window is not open." };
    }
    const wc = recWindow.webContents;
    const wasPaused = session.paused;
    const from = Math.max(0, Math.min(startIndex, session.steps.length));
    const total = session.steps
      .slice(from)
      .filter((s) => s.type !== "if" && s.type !== "endif").length;
    let ran = 0;
    let passed = 0;
    sendToMain("recorder:replayLog", { phase: "start", startIndex: from, total });
    try {
      session.paused = true;
      await applyStateAttributes();
      for (let i = from; i < session.steps.length; i++) {
        // The window may close (finalize → session = null) mid-run.
        if (!session || !recWindow || recWindow.isDestroyed()) break;
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
          await sleep(REPLAY_STEP_DELAY_MS);
          continue;
        }
        if (step.type === "endif") {
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
        await sleep(REPLAY_STEP_DELAY_MS);
      }
      sendToMain("recorder:replayLog", { phase: "done", ran, passed, failedAtIndex: -1 });
      return { ok: true, ranCount: ran, passedCount: passed, failedAtIndex: -1 };
    } catch (err) {
      sendToMain("recorder:replayLog", { phase: "done", ran, passed, failedAtIndex: -1, error: String(err) });
      return { ok: false, ranCount: ran, passedCount: passed, failedAtIndex: -1, error: String(err) };
    } finally {
      if (session) session.paused = wasPaused;
      await applyStateAttributes().catch(() => {});
    }
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
        recWindow = null;
        broadcastState();
      });
      recWindow.close();
    } else {
      recWindow = null;
      broadcastState();
    }
  },
};

async function finalize(): Promise<void> {
  stopPolling();
  const s = session;
  session = null;
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
