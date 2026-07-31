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

import { BrowserWindow, logger } from "@glaze/core/backend";

import {
  ATTR_ASSERT,
  ATTR_ASSERT_SOFT,
  ATTR_PAUSED,
  CAPTURE_SCRIPT,
  DRAIN_SCRIPT,
} from "../recorder/capture-script.js";
import { buildReplayScript } from "./step-replayer.js";
import type { AssertKind, RawStep, RecorderState, Step, TestRecord } from "../recorder/types.js";
import { sendToMain } from "./app-window.js";
import { recorderSettingsStore } from "./recorder-settings-store.js";
import { generateSpec } from "./script-generator.js";
import { testStore } from "./test-store.js";

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
  /** continuing/extending an existing test rather than recording a new one */
  editing: boolean;
  /** preserved from the original record when editing, else the session start time */
  createdAt: number;
  /** snapshot of the global "show URL bar" setting for this session's window title */
  showUrlBar: boolean;
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
  await wc.executeJavaScript(
    '(function(){var e=document.documentElement;' +
      'e.setAttribute("' + ATTR_PAUSED + '","' + paused + '");' +
      'e.setAttribute("' + ATTR_ASSERT + '","' + assert + '");' +
      'e.setAttribute("' + ATTR_ASSERT_SOFT + '","' + soft + '");' +
      'try{if(document.body)document.body.style.cursor=' +
      (session.assertMode ? '"crosshair"' : '""') +
      ";}catch(_){}})()",
  );
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
  pollTimer = setInterval(() => void drain(), POLL_INTERVAL_MS);
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
      cursor: existingSteps.length,
      editing,
      createdAt,
      showUrlBar: recorderSettingsStore.get().showUrlBar,
    };

    // Push the existing steps to the renderer so the trainer's live list shows
    // full context while extending. They're already in session.steps above, so
    // this is a push-only notification, not another addStep.
    broadcastSteps();

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

    recWindow.once("ready-to-show", () => recWindow?.show());
    recWindow.on("closed", () => void finalize());

    // A same-origin redirect on load (e.g. adding a trailing slash) can retrigger
    // the will-navigate interceptor above, which re-issues its own loadURL and
    // interrupts this one — the window still ends up on the right page via that
    // second load, so the interruption itself is not a real failure.
    await recWindow.loadURL(url).catch(() => {});
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

  deleteStep(stepId: string): RecorderState {
    if (session) {
      const idx = session.steps.findIndex((s) => s.id === stepId);
      session.steps = session.steps.filter((s) => s.id !== stepId);
      // Keep the insert cursor stable relative to the removed step.
      if (idx >= 0 && idx < session.cursor) session.cursor -= 1;
      session.cursor = clampCursor(session.cursor);
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
   * replayed interaction is not re-recorded.
   */
  async replayStep(stepId: string): Promise<{ ok: boolean; error?: string }> {
    if (!session) return { ok: false, error: "No active recording session." };
    if (!recWindow || recWindow.isDestroyed()) {
      return { ok: false, error: "Recorder window is not open." };
    }
    const step = session.steps.find((s) => s.id === stepId);
    if (!step) return { ok: false, error: "Step not found." };

    const wc = recWindow.webContents;
    const wasPaused = session.paused;
    try {
      // Suppress capture so the replayed interaction isn't recorded as a step.
      session.paused = true;
      await applyStateAttributes();
      const result = (await wc.executeJavaScript(buildReplayScript(step))) as {
        ok: boolean;
        error?: string;
      };
      return result && typeof result.ok === "boolean"
        ? result
        : { ok: false, error: "Replay produced no result." };
    } catch (err) {
      return { ok: false, error: String(err) };
    } finally {
      session.paused = wasPaused;
      await applyStateAttributes().catch(() => {});
    }
  },

  stop(): void {
    if (recWindow && !recWindow.isDestroyed()) {
      recWindow.close();
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
  };
  testStore.save(record);

  logger.info("recorder", "Recording finalized", { id: s.testId, steps: s.steps.length });
  broadcastState();
  sendToMain("recorder:finished", { testId: s.testId });
}
