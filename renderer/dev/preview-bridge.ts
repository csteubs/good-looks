// A `window.glazeAPI` that needs no backend.
//
// The renderer reaches the backend through exactly one funnel —
// `renderer/lib/api.ts` calls `window.glazeAPI.glaze.ipc.invoke(channel, ...)`
// — plus a handful of direct uses of clipboard, Menu, shell and nativeTheme.
// Standing in for that surface is enough to run the whole UI in an ordinary
// browser tab: no native shell, no Glaze app, no build slot to take turns over.
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
  BatchRecord,
  BatchState,
  CaptureOverheadSummary,
  FlakeReport,
  RecorderState,
  RunLogs,
  RunRecord,
  SecretStatus,
  TestRecord,
} from "../lib/recorder-types";
import type { LlmConfig, LlmModel, LlmProviderStatus } from "../lib/llm-types";
import type { TriageResult } from "../../shared/triage.mjs";
import type { StepDurationRow, StepHealthRow } from "../../shared/metrics-query.mjs";
import type { CostBreakdown, DivergentStep } from "../../shared/step-insights.mjs";

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

  /** One step-health row per fixture test, so the panel has something to sort.
   *  The checkout step is the interesting one: it fails sometimes AND heals. */
  const stepHealthRows = (): StepHealthRow[] => [
    {
      stepId: "s5",
      label: "click Place order",
      type: "click",
      testId: "t-checkout",
      testName: "Checkout — happy path",
      runs: 24,
      failed: 5,
      failRate: 5 / 24,
      heals: 3,
      healFailures: 1,
      visualChanges: 2,
      a11yNew: 0,
      pageErrors: 1,
      timedRuns: 24,
      minMs: 380,
      maxMs: 15_000,
      lastSeenAt: RUNS[0].startedAt,
    },
    {
      stepId: "s4",
      label: "fill Password",
      type: "fill",
      testId: "t-login",
      testName: "Login — wrong password shows an error",
      runs: 18,
      failed: 0,
      failRate: 0,
      heals: 1,
      healFailures: 0,
      visualChanges: 0,
      a11yNew: 1,
      pageErrors: 0,
      timedRuns: 18,
      minMs: 120,
      maxMs: 240,
      lastSeenAt: RUNS[1].startedAt,
    },
  ];

  /** `slowed` is a SUBSET of `rows` in the real query — a step that is slower
   *  than its own previous window. Keeping that relationship here matters:
   *  a fixture where the two lists disagree would make the panel's "N of M
   *  steps slowed" line render an impossible number. */
  const durationRows = (): StepDurationRow[] => [
    {
      stepId: "s5",
      label: "click Place order",
      type: "click",
      testId: "t-checkout",
      testName: "Checkout — happy path",
      recentRuns: 12,
      previousRuns: 12,
      recentP50Ms: 2_400,
      recentP95Ms: 14_800,
      previousP50Ms: 900,
      changeRatio: 2_400 / 900,
    },
    {
      stepId: "s2",
      label: "goto shop.example.com",
      type: "goto",
      testId: "t-checkout",
      testName: "Checkout — happy path",
      recentRuns: 12,
      previousRuns: 12,
      recentP50Ms: 810,
      recentP95Ms: 1_200,
      previousP50Ms: 790,
      changeRatio: 810 / 790,
    },
  ];

  const cost = (): CostBreakdown => {
    const totalMs = 412_000;
    const captureMs = 26_400;
    const a11yMs = 6_300;
    return {
      runs: state.runs.length,
      totalMs,
      captureMs,
      a11yMs,
      shots: 18,
      bySpeed: [
        // `bySpeed.speed` is a bare string in the schema, so the type-checker
        // will not catch a value outside the app's vocabulary. These are real
        // TestSpeed names on purpose — a "normal" bucket would render a speed
        // this app has never had.
        { speed: "medium", runs: 2, totalMs: 280_000 },
        { speed: "slow", runs: 1, totalMs: 132_000 },
      ],
      instrumentedMs: captureMs + a11yMs,
      otherMs: totalMs - (captureMs + a11yMs),
      instrumentedShare: (captureMs + a11yMs) / totalMs,
    };
  };

  return {
    // ── Library ──────────────────────────────────────────────────────────
    // Channel names are not guesses — they are the set `api.ts` actually
    // invokes, and `preview-bridge.test.ts` fails if this map ever names one
    // that does not exist.
    "tests:list": (): TestRecord[] => state.tests,
    /** Not `TestRecord[]` — the flow picker takes a narrowed row. */
    "tests:listFlows": (): { id: string; name: string; flowParams: string[] }[] =>
      state.tests
        .filter((t) => t.isFlow)
        .map((t) => ({ id: t.id, name: t.name, flowParams: t.flowParams ?? [] })),
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
    /** Copies what the test IS, never its history — the same rule the real
     *  service follows, so the preview cannot suggest runs come along. */
    "tests:duplicate": (p): TestRecord | null => {
      const test = findTest(p?.id);
      if (!test) return null;
      const copy: TestRecord = {
        ...structuredClone(test),
        id: `${test.id}-copy-${state.tests.length}`,
        name: `${test.name} [1]`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.tests.push(copy);
      return copy;
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
    /** One row per declared variable, not a single boolean. Empty is honest:
     *  no fixture test declares a secret. */
    "tests:secretStatus": (): SecretStatus[] => [],

    // ── Runs and artifacts ───────────────────────────────────────────────
    "runs:list": (): RunRecord[] => state.runs,
    "runs:getLog": (): string => RUN_LOG,
    "runs:logsDir": (): string => "/preview/runs",
    "runs:searchLogs": () => [],
    /** Site or runner. A real verdict rather than null, because the whole
     *  point of the panel is the evidence list and `null` renders none of it.
     *  `limits` is deliberately non-empty: the real triage never claims to
     *  have seen everything, and a preview that does would misrepresent it. */
    "runs:triage": (): TriageResult => ({
      verdict: "site",
      confidence: 0.72,
      evidence: [
        {
          signal: "same-step-across-browsers",
          direction: "site",
          detail: "The same step failed on chromium and webkit within the hour.",
        },
        {
          signal: "locator-resolved",
          direction: "site",
          detail: "The locator resolved; the element was present and not actionable.",
        },
      ],
      limits: ["No network capture on this run, so a 5xx cannot be ruled in or out."],
      failingStepId: "s4",
      suggestedNext: "Open the failing step's frame in Visual — the button was present but disabled.",
    }),
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

    // ── Metrics ──────────────────────────────────────────────────────────
    // Every one of these carries `available`, and the default-for-unknown rule
    // below would answer `null` — which these three views destructure. They
    // MUST be handled explicitly or the panels crash rather than degrade.
    //
    // `available: true`, because "metrics are off on this runtime" is an empty
    // state and the preview exists to show the populated ones.
    "metrics:stepHealth": (): { available: boolean; rows: StepHealthRow[] } => ({
      available: true,
      rows: stepHealthRows(),
    }),
    "metrics:slowness": (): {
      available: boolean;
      rows: StepDurationRow[];
      slowed: StepDurationRow[];
      cost: CostBreakdown;
    } => {
      const rows = durationRows();
      return { available: true, rows, slowed: rows.filter((r) => (r.changeRatio ?? 1) > 1.5), cost: cost() };
    },
    "metrics:divergence": (): { available: boolean; steps: DivergentStep[] } => ({
      available: true,
      steps: [
        {
          stepId: "s5",
          testId: "t-checkout",
          testName: "Checkout — happy path",
          label: "click Place order",
          browsers: [
            { browser: "chromium", runs: 12, failed: 0 },
            { browser: "webkit", runs: 8, failed: 6 },
          ],
          verdict: "single-engine",
          failingBrowsers: ["webkit"],
          passingBrowsers: ["chromium"],
        },
      ],
    }),

    "artifacts:list": () => [],
    /** `RunLogs`, not a line array: the panel reads `console` and `network`
     *  separately and reports what was dropped. */
    "artifacts:getLogs": (): RunLogs => ({
      console: [
        {
          step: 4,
          ts: RUNS[1].startedAt + 1_200,
          type: "error",
          text: "Failed to load resource: the server responded with a status of 401",
          url: "https://app.example.com/api/session",
          line: 0,
        },
      ],
      network: [
        {
          step: 4,
          ts: RUNS[1].startedAt + 1_180,
          ms: 96,
          method: "POST",
          url: "https://app.example.com/api/session",
          resourceType: "fetch",
          status: 401,
          ok: false,
        },
      ],
      consoleDropped: 0,
      networkDropped: 0,
      // The default: headers are only recorded when recordAllHeaders is on, and
      // the panel says so. Reporting `false` here would claim the preview
      // captured request headers it never had.
      headersFiltered: true,
    }),
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
    "llm:getConfig": (): LlmConfig => state.llmConfig,
    "llm:setConfig": (p): LlmConfig => {
      Object.assign(state.llmConfig, p ?? {});
      return state.llmConfig;
    },
    /** One status per provider — the AI pane renders a row for each. */
    "llm:detect": (): LlmProviderStatus[] => LLM_STATUS,
    /** …but `llm:status` asks about ONE, and is passed which. */
    "llm:status": (p): LlmProviderStatus =>
      LLM_STATUS.find((s) => s.provider === p?.provider) ?? LLM_STATUS[0],
    "llm:listModels": (): LlmModel[] => [],
    "llm:hasApiKey": () => ({ hasKey: false }),
    "llm:isActive": () => ({ active: false }),
    "alerts:status": () => ({ hasUrl: false, host: null }),

    // ── Visual ───────────────────────────────────────────────────────────
    "visual:listBaselines": () => [],
    "visual:getMasks": () => [],
    "visual:getThreshold": () => 0.2,
    "visual:getElementSteps": () => [],

    // ── AI debug and annotations ─────────────────────────────────────────
    "aiDebug:list": () => [],
    /** Fire-and-forget in the app; the backend gates on the setting itself.
     *  Answering `{ ok: true }` keeps the renderer's post-completion path on
     *  its normal branch instead of its error one. */
    "aiDebug:notifyDone": () => ({ ok: true }),
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
      replaying: false,
      pageReady: false,
      loading: false,
      loadFailed: false,
    }),

    // ── Batch ────────────────────────────────────────────────────────────
    "batch:list": (): BatchRecord[] => [],
    /** `BatchState | null`, and idle is `null` — not a half-filled state
     *  object. A `{ running: false }` stand-in is missing every other field the
     *  view reads once it decides a batch exists. */
    "batch:status": (): BatchState | null => null,
  };
}

/** Channels the DESIGN SYSTEM invokes directly, rather than the app.
 *
 *  `@glaze/core/components` talks to the native layer on its own — asking for
 *  system icons, mostly — so these never appear in api.ts and the coverage test
 *  deliberately does not look for them there.
 *
 *  They are handled rather than left to `defaultFor` for one reason: a warning
 *  that fires on every single page load teaches everyone to ignore the miss
 *  list, and the miss list is the whole drift-detection mechanism. Answering a
 *  known, permanent miss explicitly is what keeps a NEW one visible.
 *
 *  `null` is the honest answer — there is no native layer to produce an image,
 *  and every SDK caller already handles not getting one. */
const SDK_CHANNELS: Record<string, Handler> = {
  "nativeImage:createFromNamedImage": () => null,
};

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
  const handlers = { ...buildHandlers(state), ...SDK_CHANNELS };
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

/** Channels this module answers on the APP's behalf. Read by the test that pins
 *  coverage against api.ts, so the two cannot drift apart quietly.
 *
 *  Deliberately excludes `SDK_CHANNELS` — those are not api.ts's and asserting
 *  them against it would fail. */
export function handledChannels(): string[] {
  return Object.keys(buildHandlers(seed()));
}

/** Channels answered on the DESIGN SYSTEM's behalf. Exposed so the test can
 *  assert they are genuinely not api.ts's: if one ever becomes an app channel,
 *  the exemption above would start hiding a real gap. */
export function sdkChannels(): string[] {
  return Object.keys(SDK_CHANNELS);
}
