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
import type {
  AssertKind,
  DebugEntry,
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
import { describeStep, generateSpec } from "./script-generator.js";
import { testStore } from "./test-store.js";

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
          { label: "Page URL is…", click: () => ctxAction({ kind: "assertion", assert: "url", picked: null, prefillText: "", prefillValue }) },
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
    const showNow = () => {
      if (shown || !recWindow || recWindow.isDestroyed()) return;
      shown = true;
      recWindow.show();
    };
    recWindow.once("ready-to-show", showNow);
    wc.once("dom-ready", () => setTimeout(showNow, 1500));
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
      // 10s hard timeout: if the window hasn't finished loading, cancel the
      // session, log the failure to run history (so it shows in Stats), and
      // push a loadFailed state so the renderer shows an error dialog.
      setTimeout(() => { finishLoad(); resolve(); }, 10000);
    });

    // If the session was already torn down (user closed early), bail.
    if (!session) return currentState();

    // Check whether the window actually loaded. If the window is destroyed or
    // the load never completed (did-finish-load never fired), treat it as a
    // load failure: cancel the session and log the issue.
    if (!shown || recWindow.isDestroyed()) {
      session.loadFailed = true;
      const message = `Training window failed to open for ${url} within 10 seconds.`;
      logger.error("recorder", "Trainer window load timeout", { url, testId });
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
      const result = (await wc.executeJavaScript(buildReplayScript(step))) as {
        ok: boolean;
        error?: string;
        logs?: { i: number; t: number; level: "info" | "warn" | "error"; m: string }[];
      };
      const ok = !!(result && typeof result.ok === "boolean" && result.ok);
      const error = ok ? undefined : result?.error || "Replay produced no result.";
      const entry: DebugEntry = {
        stepId,
        stepIndex: idx,
        stepLabel: describeStep(step),
        ok,
        error,
        at: Date.now(),
        logs: result?.logs ?? [],
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
        try {
          const result = (await wc.executeJavaScript(buildReplayScript(step))) as {
            ok: boolean;
            error?: string;
            met?: boolean;
            logs?: { i: number; t: number; level: "info" | "warn" | "error"; m: string }[];
          };
          const ok = !!(result && result.ok);
          const entry: DebugEntry = {
            stepId: step.id,
            stepIndex: i,
            stepLabel: describeStep(step),
            ok,
            error: ok ? undefined : result?.error || `Step ${i + 1} failed during replay.`,
            at: Date.now(),
            logs: result?.logs ?? [],
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
        sendToMain("recorder:replayStep", { index: i, status: "begin", ok: true });
        let ok = false;
        let error: string | undefined;
        let met: boolean | undefined;
        let logs: { i: number; t: number; level: "info" | "warn" | "error"; m: string }[] = [];
        try {
          const result = (await wc.executeJavaScript(buildReplayScript(step))) as {
            ok: boolean;
            error?: string;
            met?: boolean;
            logs?: { i: number; t: number; level: "info" | "warn" | "error"; m: string }[];
          };
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

  const source = generateSpec({ name: s.name, url: s.url, steps: s.steps });
  const scriptPath = testStore.writeScript(s.testId, source);
  const record: TestRecord = {
    id: s.testId,
    name: s.name,
    url: s.url,
    createdAt: s.createdAt,
    updatedAt: Date.now(),
    steps: s.steps,
    scriptPath,
    scriptEdited: false,
    // Seed from the persisted default so new recordings inherit the user's
    // last-chosen run speed (slow by default). Existing tests keep their own
    // speed; the sidebar "Adjust Test Speed" menu still overrides per-test.
    speed: recorderSettingsStore.get().defaultRunSpeed,
  };
  testStore.save(record);

  logger.info("recorder", "Recording finalized", { id: s.testId, steps: s.steps.length });
  broadcastState();
  sendToMain("recorder:finished", { testId: s.testId });
}
