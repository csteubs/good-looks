// A `window.glazeAPI` that needs no main process.
//
// The renderer reaches the backend through exactly one funnel —
// `renderer/lib/api.ts` calls `window.glazeAPI.glaze.ipc.invoke(channel, ...)`
// — plus a handful of direct uses of clipboard, Menu, shell and nativeTheme.
// Standing in for that surface is enough to run the whole UI in an ordinary
// browser tab: no Electron, no native shell, no build slot to take turns over.
//
// What this is for: reviewing a change in seconds, on a URL anyone can open,
// and letting an agent drive the real UI with ordinary browser tooling.
//
// What this is NOT: a working app. Nothing here records, runs Playwright, or
// talks to a model. `preview-boot.ts` puts a banner on screen saying so,
// because a fake that quietly looks real is worse than no preview at all.
//
// ── On drift ──────────────────────────────────────────────────────────────
// The failure mode for a fake bridge is silent: a channel gets added, the fake
// does not know it, the view renders its empty state, and the preview shows
// "no data" for a feature that works. Two things guard against that:
//
//   1. Unhandled channels are RECORDED, warned about, and exposed on
//      `window.__preview.misses` — not silently resolved.
//   2. `preview-bridge.test.ts` reads the channel list straight out of
//      api.ts and fails when one is neither handled nor covered by a
//      default rule.
//
// Resolving misses to a shaped empty value rather than throwing is deliberate:
// a preview that white-screens on one unknown channel is useless exactly when
// you most want to look at it.

import {
  HEALS,
  LLM_CONFIG,
  LLM_STATUS,
  RUNS,
  RUN_LOG,
  SETTINGS,
  TESTS,
} from "./preview-fixtures";
// Annotating the handlers with the app's own return types is what actually
// prevents shape drift. The runtime coverage test in preview-bridge.test.ts
// pins channel NAMES; only the type-checker can catch a fixture that answers
// the right channel with the wrong object — which crashes a view exactly as
// hard as no answer at all, and is far less obvious in review.
import type {
  ArtifactUsage,
  CaptureOverheadSummary,
  FlakeReport,
  RecorderState,
  RunRecord,
  TestRecord,
} from "../lib/recorder-types";

/** api.ts passes ONE options object per call — `invoke("tests:get", { id })`,
 *  never `invoke("tests:get", id)`. A handler taking positional arguments
 *  reads `undefined` for every field, finds nothing, and returns null; the
 *  view then renders its "no such test" branch, which is a blank pane with no
 *  error and no console output. That cost a real debugging pass here. */
type Payload = Record<string, unknown> | undefined;
type Handler = (payload: Payload) => unknown;

export interface PreviewDiagnostics {
  /** Channels invoked that had no explicit handler, with a call count. */
  misses: Record<string, number>;
  /** Every channel invoked, in order. Useful when driving the UI from a test. */
  calls: string[];
}

/** Mutable copies, so the preview behaves like an app with state: renaming a
 *  test or deleting a tag persists for the session. Reloading resets it, which
 *  is the right amount of persistence for a preview. */
function seed() {
  return {
    tests: structuredClone(TESTS),
    runs: structuredClone(RUNS),
    heals: structuredClone(HEALS),
    settings: structuredClone(SETTINGS),
    llmConfig: structuredClone(LLM_CONFIG),
  };
}

function buildHandlers(state: ReturnType<typeof seed>): Record<string, Handler> {
  const findTest = (id: unknown) => state.tests.find((t) => t.id === id) ?? null;

  return {
    // ── Library ──────────────────────────────────────────────────────────
    // Channel names are not guesses — they are the set `api.ts` actually
    // invokes, and `preview-bridge.test.ts` fails if this map ever names one
    // that does not exist.
    "tests:list": (): TestRecord[] => state.tests,
    "tests:listFlows": (): TestRecord[] => state.tests.filter((t) => t.isFlow),
    "tests:get": (p): TestRecord | null => findTest(p?.id),
    "tests:getScript": (p) => {
      const test = findTest(p?.id);
      if (!test) return "";
      return [
        'import { test, expect } from "@playwright/test";',
        "",
        `test(${JSON.stringify(test.name)}, async ({ page }) => {`,
        `  await page.goto(${JSON.stringify(test.url)});`,
        "  // …generated from the recorded steps",
        "});",
        "",
      ].join("\n");
    },
    "tests:rename": (p) => {
      const test = findTest(p?.id);
      if (test) test.name = String(p?.name ?? test.name);
      return test;
    },
    "tests:delete": (p) => {
      state.tests = state.tests.filter((t) => t.id !== p?.id);
      return true;
    },
    "tests:setHidden": (p) => {
      const test = findTest(p?.id);
      if (test) test.hidden = Boolean(p?.hidden);
      return test;
    },
    "tests:updateSteps": (p) => {
      const test = findTest(p?.id);
      if (test && Array.isArray(p?.steps)) test.steps = p.steps as typeof test.steps;
      return test;
    },
    "tests:setTags": (p) => {
      const test = findTest(p?.id);
      if (test && Array.isArray(p?.tags)) test.tags = p.tags as string[];
      return test;
    },
    "tests:secretStatus": () => ({ hasSecret: false }),

    // ── Runs and artifacts ───────────────────────────────────────────────
    "runs:list": (): RunRecord[] => state.runs,
    "runs:getLog": (): string => RUN_LOG,
    "runs:logsDir": (): string => "/preview/runs",
    "runs:searchLogs": () => [],
    "runs:captureOverhead": (): CaptureOverheadSummary => ({
      capturedRuns: 1,
      uncapturedRuns: 2,
      meanCaptureMs: 840,
      meanMsPerShot: 140,
      meanCapturedDurationMs: 12_400,
      meanUncapturedDurationMs: 10_000,
      captureShareOfRun: 0.068,
      totalShots: 6,
      a11yRuns: 1,
      meanA11yMs: 210,
      meanMsPerA11yCheck: 35,
      a11yShareOfRun: 0.017,
    }),
    "runs:flake": (): FlakeReport => ({
      tests: [],
      clusters: [],
      analysedTests: state.tests.length,
      windowRuns: state.runs.length,
      windowCap: 50,
    }),
    "artifacts:list": () => [],
    "artifacts:getLogs": () => ({ lines: RUN_LOG.split("\n") }),
    "artifacts:hasLogs": () => ({ hasLogs: true }),
    "artifacts:usage": (): ArtifactUsage => ({
      bytes: 18_400_000,
      runs: state.runs.length,
      tests: state.tests.length,
    }),

    // ── Heals ────────────────────────────────────────────────────────────
    "heals:list": () => state.heals,
    "heals:listAll": () => state.heals,
    "heals:pending": () => state.heals.filter((h) => h.status === "pending"),

    // ── Settings and providers ───────────────────────────────────────────
    "recorder:getSettings": () => state.settings,
    "recorder:setSettings": (p) => {
      Object.assign(state.settings, p ?? {});
      return state.settings;
    },
    "llm:getConfig": () => state.llmConfig,
    "llm:setConfig": (p) => {
      Object.assign(state.llmConfig, p ?? {});
      return state.llmConfig;
    },
    "llm:detect": () => LLM_STATUS,
    "llm:status": () => LLM_STATUS,
    "llm:listModels": () => [],
    "llm:hasApiKey": () => false,
    "llm:isActive": () => false,
    "alerts:status": () => ({ webhookUrl: null, configured: false }),

    // ── Visual ───────────────────────────────────────────────────────────
    "visual:listBaselines": () => [],
    "visual:getMasks": () => [],
    "visual:getThreshold": () => 0.2,
    "visual:getElementSteps": () => [],

    // ── AI debug and annotations ─────────────────────────────────────────
    "aiDebug:list": () => [],
    "annotations:list": () => [],

    // ── Recorder ─────────────────────────────────────────────────────────
    // Nothing can actually record here; reporting an idle recorder is honest
    // and keeps the trainer's entry points in their normal state.
    "recorder:getSteps": () => [],
    "recorder:getDebugLogs": () => [],
    "recorder:listCookies": () => [],
    "recorder:getState": (): RecorderState => ({
      recording: false,
      paused: false,
      assertMode: null,
      stepCount: 0,
      testId: null,
      url: null,
      name: null,
      editing: false,
      assertSoft: false,
      cursor: 0,
      refineMode: false,
      pageReady: false,
      loading: false,
      loadFailed: false,
    }),

    // ── Batch ────────────────────────────────────────────────────────────
    "batch:list": () => [],
    "batch:status": () => ({ running: false }),
  };
}

/** Shape an unhandled channel's answer from its name. A view awaiting a list
 *  and getting `undefined` crashes on `.map`; getting `[]` renders an empty
 *  state, which is wrong but legible — and the miss is recorded either way. */
function defaultFor(channel: string): unknown {
  const verb = channel.split(":")[1] ?? "";
  if (/^(list|pending|all|search|history)/i.test(verb)) return [];
  if (/^(has|is|can)/i.test(verb)) return false;
  if (/^(count|usage|overhead)/i.test(verb)) return 0;
  return null;
}

export function installPreviewBridge(): PreviewDiagnostics {
  const state = seed();
  const handlers = buildHandlers(state);
  const diagnostics: PreviewDiagnostics = { misses: {}, calls: [] };

  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    diagnostics.calls.push(channel);
    const handler = handlers[channel];
    if (handler) return handler(args[0] as Payload);

    diagnostics.misses[channel] = (diagnostics.misses[channel] ?? 0) + 1;
    // Once per channel, not once per call — a polling view would otherwise
    // bury every other message in the console.
    if (diagnostics.misses[channel] === 1) {
      console.warn(`[preview] no fixture for IPC channel "${channel}" — returning an empty value`);
    }
    return defaultFor(channel);
  };

  const noopSubscribe = () => () => {};

  const glazeAPI = {
    glaze: {
      ipc: {
        invoke,
        send: () => {},
        on: noopSubscribe,
        once: noopSubscribe,
        onNotification: noopSubscribe,
        stream: async (channel: string) => invoke(channel),
        cancelStream: () => {},
        isConnected: () => true,
        waitForReady: async () => {},
        disconnect: () => {},
      },
    },
    clipboard: {
      writeText: async (text: string) => {
        // The real thing, where the browser allows it. Copy buttons are a
        // common review target and a no-op would read as a bug.
        try {
          await navigator.clipboard?.writeText(text);
        } catch {
          /* clipboard permission is not worth failing a preview over */
        }
      },
      readText: async () => "",
    },
    // Native menus have no browser equivalent. Returning "dismissed" leaves
    // the UI in the state it has when a user presses Escape — a real state,
    // and better than a menu that appears to open and then does nothing.
    Menu: {
      popup: async () => ({ commandId: undefined }),
      setApplicationMenu: async () => {},
    },
    shell: {
      beep: () => {},
      showItemInFolder: () => {},
    },
    nativeTheme: {
      getInfo: async () => ({
        shouldUseDarkColors: window.matchMedia("(prefers-color-scheme: dark)").matches,
        themeSource: "system" as const,
      }),
      setThemeSource: async (source: "system" | "light" | "dark") => {
        document.documentElement.classList.toggle(
          "dark",
          source === "dark" ||
            (source === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches),
        );
        return true;
      },
      getShouldUseDarkColors: async () => window.matchMedia("(prefers-color-scheme: dark)").matches,
      getThemeSource: async () => "system" as const,
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
      showMessageBox: async () => ({ response: 0 }),
      showErrorBox: async () => {},
    },
  };

  (window as unknown as { glazeAPI: unknown }).glazeAPI = glazeAPI;
  (window as unknown as { __preview: PreviewDiagnostics }).__preview = diagnostics;

  return diagnostics;
}

/** Channels this module answers explicitly. Read by the test that pins
 *  coverage against api.ts, so the two cannot drift apart quietly. */
export function handledChannels(): string[] {
  return Object.keys(buildHandlers(seed()));
}
