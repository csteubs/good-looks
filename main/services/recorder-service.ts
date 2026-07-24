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
  ATTR_PAUSED,
  CAPTURE_SCRIPT,
  DRAIN_SCRIPT,
} from "../recorder/capture-script.js";
import type { AssertKind, RawStep, RecorderState, Step, TestRecord } from "../recorder/types.js";
import { sendToMain } from "./app-window.js";
import { generateSpec } from "./script-generator.js";
import { testStore } from "./test-store.js";

interface Session {
  testId: string;
  url: string;
  name: string;
  steps: Step[];
  paused: boolean;
  assertMode: AssertKind | null;
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
  };
}

function broadcastState(): void {
  sendToMain("recorder:state", currentState());
}

function addStep(raw: RawStep): void {
  if (!session) return;
  const step: Step = { id: randomUUID(), timestamp: Date.now(), ...raw };
  session.steps.push(step);
  sendToMain("recorder:step", step);

  // The capture script self-clears assert mode after capturing an assertion;
  // keep backend + UI in sync.
  if (raw.type === "assert" && session.assertMode) {
    session.assertMode = null;
  }
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
  await wc.executeJavaScript(
    '(function(){var e=document.documentElement;' +
      'e.setAttribute("' + ATTR_PAUSED + '","' + paused + '");' +
      'e.setAttribute("' + ATTR_ASSERT + '","' + assert + '");' +
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

  async start(params: { url: string; name?: string }): Promise<RecorderState> {
    if (session) {
      recWindow?.focus();
      return currentState();
    }

    const url = normalizeUrl(params.url);
    const testId = randomUUID();
    session = {
      testId,
      url,
      name: params.name?.trim() || "Recorded test",
      steps: [],
      paused: false,
      assertMode: null,
    };

    // Initial navigation is the first step; later navigations are consequences of
    // recorded interactions (the window has no address bar).
    addStep({ type: "goto", url });

    recWindow = new BrowserWindow({
      windowKey: "recorder",
      width: 1200,
      height: 820,
      title: "Recording — " + url,
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

    wc.on("did-navigate", () => void drain());

    recWindow.once("ready-to-show", () => recWindow?.show());
    recWindow.on("closed", () => void finalize());

    await recWindow.loadURL(url);
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

  async setAssertMode(mode: AssertKind | null): Promise<RecorderState> {
    if (session) {
      session.assertMode = mode;
      await applyStateAttributes();
      if (mode && recWindow && !recWindow.isDestroyed()) recWindow.focus();
      broadcastState();
    }
    return currentState();
  },

  deleteStep(stepId: string): RecorderState {
    if (session) {
      session.steps = session.steps.filter((s) => s.id !== stepId);
      broadcastState();
    }
    return currentState();
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

  const now = Date.now();
  const source = generateSpec({ name: s.name, url: s.url, steps: s.steps });
  const scriptPath = testStore.writeScript(s.testId, source);
  const record: TestRecord = {
    id: s.testId,
    name: s.name,
    url: s.url,
    createdAt: now,
    updatedAt: now,
    steps: s.steps,
    scriptPath,
  };
  testStore.save(record);

  logger.info("recorder", "Recording finalized", { id: s.testId, steps: s.steps.length });
  broadcastState();
  sendToMain("recorder:finished", { testId: s.testId });
}
