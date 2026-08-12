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
  BATCHES,
  HEALS,
  LLM_CONFIG,
  LLM_STATUS,
  REPLAY,
  REPLAY_HISTORY,
  REPLAY_SUMMARIES,
  RUNS,
  RUN_LOG,
  VISUAL_FRAMES,
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
  BaselineEntry,
  BatchRecord,
  BatchState,
  CaptureOverheadSummary,
  FlakeReport,
  RecorderState,
  RunLogs,
  StepStructure,
  RunRecord,
  RunNoticeKind,
  RunReplay,
  RunReplaySummary,
  SecretStatus,
  TestRecord,
  VisualMask,
} from "../lib/recorder-types";
import type { LlmConfig, LlmModel, LlmProviderStatus } from "../lib/llm-types";
import type { BranchStatus } from "../lib/branch-types";
import type {
  ConnectionStatus,
  CreatedIssue,
  IssueContainer,
  IssueDefaults,
  IssueDraft,
  IssueLabel,
  IssueLink,
  IssueSubContainer,
  ProviderVocabulary,
} from "../lib/issue-types";
import type { TriageResult } from "../../shared/triage.mjs";
import type {
  StepDurationRow,
  StepHealthRow,
  TestDurationTrend,
} from "../../shared/metrics-query.mjs";
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

/** Is the preview being asked to show the TRAINER?
 *
 *  Read from the URL each time rather than captured once, so the same bridge
 *  answers correctly no matter when a view asks. Dev-only by construction —
 *  this module is never bundled into the app (see the header, and the
 *  deliberate `preview.html` filename). */
function recorderPreview(): boolean {
  const view = new URLSearchParams(window.location.search).get("view");
  return view === "recorder" || view === "recorder-editing";
}

/** `?view=recorder-editing` — a session CONTINUING an existing test.
 *
 *  Its own address because it is a different screen in the ways that matter,
 *  and none of them are reachable from `?view=recorder`: the insert cursor
 *  opens just past the navigation rather than at the end, so the step list
 *  carries the labelled cursor mid-list and the footer offers "Save Test"
 *  instead of "Generate Test". That is the state the trainer is in whenever
 *  anyone re-trains a test, and it had no address at all. */
function editingPreview(): boolean {
  return new URLSearchParams(window.location.search).get("view") === "recorder-editing";
}

/** Where the insert cursor sits in the preview's session — mirroring
 *  `initialCursor`: the end of the list for a new recording, just past the
 *  `goto` for one continuing an existing test. */
function previewCursor(): number {
  const steps = TESTS[0].steps;
  if (!editingPreview()) return steps.length;
  const nav = steps.findIndex((s) => s.type === "goto");
  return nav === -1 ? Math.min(1, steps.length) : Math.min(nav + 1, steps.length);
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
    // Starts DISCONNECTED, so the preview opens on the state that actually
    // needs looking at: the empty pane someone sees before they have a key.
    // Connecting works and persists for the session, so both halves of the
    // Integrations pane are reachable in a tab.
    issues: {
      connected: false,
      error: null as string | null,
      defaults: { containerId: null as string | null, subContainerId: null as string | null },
      // Grows as issues are filed, so the recurrence branch is reachable in a tab:
      // send the same defect twice and the second opens on "already filed".
      links: [] as IssueLink[],
    },
  };
}

function buildHandlers(state: ReturnType<typeof seed>): Record<string, Handler> {
  const findTest = (id: unknown) => state.tests.find((t) => t.id === id) ?? null;

  /** One place the connection state is shaped, since four handlers return it. */
  const issuesStatus = (): ConnectionStatus => ({
    provider: "linear",
    hasKey: state.issues.connected,
    account: state.issues.connected
      ? { accountName: "Sam Rivera", workspaceName: "Northwind" }
      : null,
    error: state.issues.error,
  });

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
    // Filler, so the preview shows the panel at the size it actually reaches on
    // a real history — past one page. A two-row fixture renders the pager not at
    // all, which is the state the panel is least likely to be broken in.
    ...Array.from({ length: 58 }, (_, i): StepHealthRow => {
      const runs = 24 - (i % 7);
      return {
        stepId: `s-fill-${i}`,
        label: `${["click", "fill", "expect", "goto"][i % 4]} step ${i + 1}`,
        type: (["click", "fill", "expect", "goto"] as const)[i % 4],
        testId: i % 2 ? "t-checkout" : "t-login",
        testName: i % 2 ? "Checkout — happy path" : "Login — wrong password shows an error",
        runs,
        failed: i % 5 === 0 ? 1 : 0,
        failRate: i % 5 === 0 ? 1 / runs : 0,
        heals: i % 3 === 0 ? 1 : 0,
        healFailures: 0,
        visualChanges: i % 4 === 0 ? 1 : 0,
        a11yNew: 0,
        pageErrors: 0,
        // Every seventh row is unmeasured, so the dash-not-zero rendering is
        // visible in the preview too.
        timedRuns: i % 7 === 0 ? 0 : runs,
        minMs: i % 7 === 0 ? null : 90 + i * 5,
        maxMs: i % 7 === 0 ? null : 400 + i * 40,
        lastSeenAt: RUNS[1].startedAt,
      };
    }),
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
      label: "click Add to cart",
      type: "click",
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
    /** The divergence banner's dismiss control. Mutates the fixture in place so
     *  the preview shows what the app does — the banner goes and stays gone —
     *  rather than a click that appears to do nothing. */
    "tests:dismissDiverged": (p) => {
      const test = findTest(p?.id);
      if (test) test.stepsDivergedDismissed = p?.dismissed === false ? undefined : true;
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
    // THE VERDICTS ARE POPULATED ON PURPOSE, and this used to answer `tests: []`.
    //
    // An empty list is a legitimate shape — it is what a healthy suite returns —
    // but it is the one shape that makes the Stability panel, the Stability
    // dashboard and its per-verdict drill ALL render their empty states. The
    // preview is the only place any of them can be looked at (jsdom has no
    // layout engine and the dom suite runs with `css: false`), so an empty
    // fixture here meant the populated design had never been seen by anyone.
    //
    // Three verdicts rather than one, because they are the vocabulary: `flaky`
    // and `changed-since` sit at the SAME pass rate and need opposite responses,
    // which is the whole reason the panel reports transitions instead of a rate.
    "runs:flake": (): FlakeReport => ({
      tests: [
        {
          testId: "t-checkout",
          testName: "Checkout — happy path",
          runs: 12,
          passed: 6,
          failed: 6,
          transitions: 5,
          flakeRate: 0.45,
          verdict: "flaky",
          failingDatasets: [],
          steps: [
            { stepId: "s-pay", label: "click Place order", failures: 4, heals: 1, failureRate: 0.33 },
          ],
          healedRuns: 1,
        },
        {
          testId: "t-login",
          testName: "Login — wrong password shows an error",
          runs: 9,
          passed: 5,
          failed: 4,
          transitions: 1,
          flakeRate: 0.12,
          verdict: "changed-since",
          failingDatasets: [],
          steps: [
            { stepId: "s-pw", label: "fill Password", failures: 4, heals: 0, failureRate: 0.44 },
          ],
          healedRuns: 0,
        },
        {
          testId: "t-search",
          testName: "Search returns results",
          runs: 11,
          passed: 11,
          failed: 0,
          transitions: 0,
          flakeRate: 0,
          verdict: "stable",
          failingDatasets: [],
          steps: [],
          healedRuns: 0,
        },
      ],
      clusters: [
        {
          signature: "timeout waiting for locator",
          example: 'Timeout 30000ms exceeded waiting for getByTestId("pay")',
          stepId: "s-pay",
          stepLabel: "click Place order",
          count: 4,
          lastSeenAt: Date.now() - 3_600_000,
          runIds: ["r-1", "r-2", "r-3", "r-4"],
        },
      ],
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
    "metrics:slowness": (params?: {
      testId?: string;
    }): {
      available: boolean;
      rows: StepDurationRow[];
      slowed: StepDurationRow[];
      cost: CostBreakdown;
      testTrend: TestDurationTrend | null;
    } => {
      const rows = durationRows();
      return {
        available: true,
        rows,
        slowed: rows.filter((r) => (r.changeRatio ?? 1) > 1.5),
        cost: cost(),
        // Only when a test was named, exactly as the handler does (C §6.3).
        // A fixture that answered for the suite-wide call too would let the
        // run summary read a median that the real app never gives it.
        testTrend: params?.testId
          ? {
              testId: params.testId,
              window: 10,
              recentRuns: 8,
              previousRuns: 6,
              // Slightly above the run summary's own history median (11,900),
              // so the preview shows the two sources being different and the
              // metrics one winning.
              recentP50Ms: 11_400,
              previousP50Ms: 10_800,
              changeRatio: 11_400 / 10_800,
            }
          : null,
      };
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

    // The Visual screen's entire subject. Returning `[]` here is honest for a
    // preview that cannot run Playwright, and it also meant the largest file in
    // the renderer only ever rendered its empty state — see REPLAY.
    "artifacts:list": (): RunReplaySummary[] => REPLAY_SUMMARIES,
    // The history matters as much as the current run: the drift strip (§6.6) is
    // a statement about a SERIES, and a bridge that answers for one run leaves
    // it rendering nothing.
    "artifacts:getReplay": (p): RunReplay | null =>
      [REPLAY, ...REPLAY_HISTORY].find((r) => r.testId === p?.testId && r.runId === p?.runId) ??
      null,
    /** The frames. `readShot` is asked for the CURRENT or the DIFF image and
     *  told which by filename, so the two are told apart on `.diff.` rather
     *  than by guessing from the step — a viewer showing the current frame in
     *  diff mode is exactly the bug a preview should make visible. */
    "artifacts:readShot": (p): string =>
      typeof p?.file === "string" && p.file.includes(".diff.")
        ? VISUAL_FRAMES.diff
        : VISUAL_FRAMES.current,
    /** Accepting, as opposed to dismissing. Patching the replay the way the
     *  backend does is what makes the two visibly different in the preview: an
     *  accept clears the FINDINGS (the diffs become matches, the violations
     *  become accepted) and the banner goes because there is nothing left to
     *  report; a dismiss leaves every finding on the steps. */
    "visual:acceptRun": (): RunReplay => {
      for (const step of REPLAY.steps) {
        if (!step.screenshot) continue;
        step.diff = { state: "match", ratio: 0, threshold: REPLAY.visualThreshold };
      }
      return REPLAY;
    },
    "visual:acceptStep": (p): RunReplay => {
      const step = REPLAY.steps.find((s) => s.stepId === p?.stepId);
      if (step?.screenshot) {
        step.diff = { state: "match", ratio: 0, threshold: REPLAY.visualThreshold };
      }
      return REPLAY;
    },
    "a11y:acceptRun": (): RunReplay => {
      for (const step of REPLAY.steps) {
        if (!step.a11y) continue;
        step.a11y = {
          violations: step.a11y.violations,
          newKeys: [],
          acceptedCount: step.a11y.newKeys.length + step.a11y.acceptedCount,
        };
      }
      return REPLAY;
    },
    "a11y:acceptStep": (p): RunReplay => {
      const step = REPLAY.steps.find((s) => s.stepId === p?.stepId);
      if (step?.a11y) {
        step.a11y = {
          violations: step.a11y.violations,
          newKeys: [],
          acceptedCount: step.a11y.newKeys.length + step.a11y.acceptedCount,
        };
      }
      return REPLAY;
    },
    /** Dismissing a findings banner. Mutates REPLAY so the banner stays gone
     *  across run selection — which is the whole difference between this and a
     *  local flag, and therefore the thing the preview has to reproduce. */
    "artifacts:dismissNotice": (p): RunReplay => {
      const kind: RunNoticeKind | null =
        p?.kind === "visual" || p?.kind === "a11y" ? p.kind : null;
      if (kind) {
        REPLAY.dismissedNotices = [...new Set<RunNoticeKind>([...(REPLAY.dismissedNotices ?? []), kind])];
      }
      return REPLAY;
    },
    "artifacts:restoreNotice": (p): RunReplay => {
      REPLAY.dismissedNotices = (REPLAY.dismissedNotices ?? []).filter((k) => k !== p?.kind);
      return REPLAY;
    },
    "visual:baselineShot": (): string => VISUAL_FRAMES.baseline,
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
    /** The ambiguous-locator case the structure request exists for: one failed
     *  step whose locator matched several buttons — the elements it LITERALLY
     *  matched, and the ones Auto-Heal ranked as alternatives. Three of ten are
     *  listed so the preview shows the "further matches not listed" line too. */
    "artifacts:getStructure": (): StepStructure[] => [
      {
        stepIndex: 4,
        stepLabel: "Click button “Pause”",
        outcome: "exhausted",
        method: "click",
        originalLocator: { k: "role", role: "button", name: "Pause" },
        matchCount: 10,
        matches: [
          {
            index: 0,
            tag: "button",
            classes: ["player-control", "player-control--pause"],
            ancestors: ["div[data-testid=video-player]", "main"],
            ariaLabel: "Pause",
            testid: "video-pause",
            visible: true,
            enabled: true,
            rect: { x: 412, y: 388, w: 32, h: 32 },
          },
          {
            index: 1,
            tag: "button",
            classes: ["controls__btn"],
            ancestors: ["section#playlist"],
            text: "Pause",
            visible: true,
            enabled: false,
            rect: { x: 96, y: 640, w: 64, h: 24 },
          },
          {
            index: 2,
            tag: "button",
            classes: ["sr-only"],
            ancestors: ["nav"],
            ariaLabel: "Pause",
            visible: false,
            enabled: true,
            rect: { x: 0, y: 0, w: 0, h: 0 },
          },
        ],
        candidates: [
          {
            locator: { k: "testid", v: "video-pause" },
            description: "button.player-control inside [data-testid=video-player]",
            score: 0.92,
            matchedPastRun: true,
          },
          {
            locator: { k: "css", v: "header .controls button:nth-child(2)" },
            description: "button.controls__btn inside header",
            score: 0.41,
            matchedPastRun: false,
          },
        ],
      },
    ],
    "artifacts:hasStructure": () => ({ hasStructure: true }),
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
    "llm:hasLmStudioToken": () => ({ hasToken: false }),
    "llm:isActive": () => ({ active: false }),
    "alerts:status": () => ({ hasUrl: false, host: null }),

    // ── Issue tracker ────────────────────────────────────────────────────
    // Enough behaviour to exercise the pane's two states in a tab: a key that
    // is empty is refused the way the real backend refuses it, and anything
    // else connects. A preview cannot reach Linear, so "verify" is local — the
    // thing being previewed is the pane, not the network.
    "issues:status": (): ConnectionStatus => issuesStatus(),
    "issues:vocabulary": (): ProviderVocabulary => ({
      name: "Linear",
      container: "Team",
      subContainer: "Project",
      keyHelpUrl: "https://linear.app/settings/api",
      keyPlaceholder: "lin_api_…",
    }),
    "issues:connect": (p): ConnectionStatus => {
      const key = typeof p?.key === "string" ? p.key.trim() : "";
      state.issues.connected = key.length > 0;
      state.issues.error = key.length > 0 ? null : "Linear API key is empty.";
      return issuesStatus();
    },
    "issues:verify": (): ConnectionStatus => issuesStatus(),
    "issues:disconnect": (): ConnectionStatus => {
      state.issues.connected = false;
      state.issues.error = null;
      state.issues.defaults = { containerId: null, subContainerId: null };
      return issuesStatus();
    },
    "issues:listContainers": (): IssueContainer[] => [
      { id: "team-eng", name: "Engineering", key: "ENG" },
      { id: "team-design", name: "Design", key: "DES" },
      { id: "team-web", name: "Web Platform", key: "WEB" },
    ],
    "issues:listSubContainers": (): IssueSubContainer[] => [
      { id: "proj-checkout", name: "Checkout revamp", containerId: "team-eng" },
      { id: "proj-a11y", name: "Accessibility debt", containerId: null },
      { id: "proj-design-sys", name: "Design system", containerId: "team-design" },
    ],
    "issues:listLabels": (): IssueLabel[] => [
      { id: "lbl-bug", name: "Bug", color: "#ff4d61" },
      { id: "lbl-a11y", name: "Accessibility", color: "#35e0ff" },
      { id: "lbl-visual", name: "Visual", color: "#b98cff" },
    ],
    /** A draft shaped like the real one, so the compose dialog can be looked at
     *  in a tab. The attachments carry a 1×1 PNG rather than a real screenshot:
     *  the strip's LAYOUT is the thing worth seeing here, and a fixture holding
     *  a plausible-looking page would make the preview feel like it had data it
     *  does not. */
    "issues:buildDraft": (p): IssueDraft | null => {
      const source = (p?.source ?? null) as IssueDraft["source"] | null;
      if (!source) return null;
      const png =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const visual = source.kind === "visual";
      return {
        source,
        title:
          source.kind === "a11y"
            ? "a11y: color-contrast on Checkout — happy path"
            : visual
              ? "Visual change (3.1%) — Checkout — happy path · click Place order"
              : "Checkout — happy path failed at click Place order — Timeout <ms> exceeded",
        body: [
          source.kind === "a11y"
            ? "**serious** · `color-contrast`\n\nElements must meet minimum contrast ratio thresholds"
            : visual
              ? "**3.1% of pixels changed** on this step's screenshot."
              : "**Failure**\n\n```\nTimeout <ms> exceeded\n```",
          "",
          "---",
          "",
          "- **Test:** Checkout — happy path",
          "- **URL:** `https://shop.example.com/cart`",
          "- **Step:** `click Place order`",
          "",
          "_Filed from Good Looks!_",
        ].join("\n"),
        attachments: visual
          ? [
              { label: "Baseline", file: "baseline:s5", previewUrl: png, bytes: 148_231 },
              { label: "This run", file: "5.png", previewUrl: png, bytes: 151_004 },
              { label: "Difference", file: "5.diff.png", previewUrl: png, bytes: 22_887 },
            ]
          : source.kind === "failure"
            ? [{ label: "At failure", file: "5.png", previewUrl: png, bytes: 151_004 }]
            : [],
        notices: [],
      };
    },
    "issues:createIssue": (p): CreatedIssue => {
      const source = (p?.source ?? {}) as IssueLink;
      const issue = {
        id: `iss-${state.issues.links.length + 1}`,
        identifier: `ENG-${42 + state.issues.links.length}`,
        url: "https://linear.app/northwind/issue/ENG-42",
      };
      // Recorded, so the SECOND send of the same defect shows the recurrence
      // branch — which is the half of this feature worth being able to look at.
      state.issues.links.push({
        provider: "linear",
        testId: String(source.testId ?? ""),
        stepId: String(source.stepId ?? ""),
        runId: String((source as { runId?: string }).runId ?? ""),
        kind: (source.kind ?? "visual") as IssueLink["kind"],
        ruleId: String((source as { ruleId?: string }).ruleId ?? ""),
        issueId: issue.id,
        identifier: issue.identifier,
        url: issue.url,
        createdAt: 0,
      });
      return issue;
    },
    "issues:linksForTest": (p): IssueLink[] =>
      state.issues.links.filter((l) => l.testId === p?.testId),
    "issues:commentRecurrence": (p): IssueLink => {
      const source = (p?.source ?? {}) as IssueLink;
      const link = state.issues.links.find(
        (l) => l.testId === source.testId && l.stepId === source.stepId && l.kind === source.kind,
      );
      if (!link) throw new Error("This defect has no issue to comment on.");
      link.lastCommentedAt = 0;
      return link;
    },
    "issues:getDefaults": (): IssueDefaults => state.issues.defaults,
    "issues:setDefaults": (p): IssueDefaults => {
      const patch = (p ?? {}) as Partial<IssueDefaults>;
      const containerChanged =
        patch.containerId !== undefined && patch.containerId !== state.issues.defaults.containerId;
      state.issues.defaults = {
        containerId:
          patch.containerId !== undefined
            ? (patch.containerId ?? null)
            : state.issues.defaults.containerId,
        subContainerId:
          patch.subContainerId !== undefined
            ? (patch.subContainerId ?? null)
            : containerChanged
              ? null
              : state.issues.defaults.subContainerId,
      };
      return state.issues.defaults;
    },
    // Only the Settings window asks for this, and only to print it inside a
    // description. The real value comes from the main process's accelerator
    // constant; this is the same string so the row reads correctly under
    // `?view=settings`.
    "debug:shortcut": () => "⌘⌥⇧S",

    // ── Visual ───────────────────────────────────────────────────────────
    /** `BaselineEntry[]`, NOT `string[]`. The first version of this returned bare
     *  step ids with a `: string[]` annotation — which type-checked, because the
     *  annotation was the thing being checked rather than `api.ts`'s actual
     *  return type. The manager then rendered four rows with no label and
     *  "Invalid Date", which is precisely the "looks like a broken feature"
     *  failure this file's header is about. Annotate with the app's own type. */
    "visual:listBaselines": (): BaselineEntry[] =>
      REPLAY.steps
        .filter((st) => st.screenshot)
        .map((st) => ({
          stepId: st.stepId,
          runId: REPLAY.runId,
          at: REPLAY.startedAt,
          label: st.label,
          ...(st.rect ? { rect: st.rect } : null),
        })),
    /** One mask, on the step whose diff reports `maskedCount: 1` — the two
     *  numbers describing the same thing have to agree, or the panel says a
     *  mask was applied and the list shows none. */
    "visual:getMasks": (): VisualMask[] => [
      { id: "m-1", stepId: "s2", x: 0.62, y: 0.06, w: 0.3, h: 0.09 },
    ],
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
    //
    // `?view=recorder` IS THE EXCEPTION, and it exists for the same reason
    // `?view=settings` does: `RootShell` swaps the whole outlet for
    // `RecordingView` only while `state.recording`, and nothing in a browser
    // tab can make that true — there is no training window to record. So the
    // trainer, which is a fifth of this app's UI, had no address at all. The
    // flag reports a recorder mid-session over a fixture test's steps; it does
    // NOT pretend to capture, and the banner still says so.
    "recorder:getSteps": () => (recorderPreview() ? structuredClone(TESTS[0].steps) : []),
    "recorder:getDebugLogs": () => [],
    "recorder:listCookies": () => [],
    "recorder:getState": (): RecorderState =>
      recorderPreview()
        ? {
            recording: true,
            paused: false,
            assertMode: null,
            stepCount: TESTS[0].steps.length,
            testId: TESTS[0].id,
            url: TESTS[0].url,
            // Deliberately a DEEPER url than `url` above: the two fields mean
            // different things (start vs. now), and a fixture where they match
            // would hide a view that renders the wrong one.
            liveUrl: TESTS[0].url.replace(/\/*$/, "") + "/cart",
            name: TESTS[0].name,
            editing: editingPreview(),
            assertSoft: false,
            cursor: previewCursor(),
            refineMode: false,
            replaying: false,
            pageReady: true,
            loading: false,
          }
        : {
      recording: false,
      paused: false,
      assertMode: null,
      stepCount: 0,
      testId: null,
      url: null,
      liveUrl: null,
      name: null,
      editing: false,
      assertSoft: false,
      cursor: 0,
      refineMode: false,
      replaying: false,
      pageReady: false,
      loading: false,
          },

    // ── Batch ────────────────────────────────────────────────────────────
    "batch:list": (): BatchRecord[] => structuredClone(BATCHES),
    /** `BatchState | null`, and idle is `null` — not a half-filled state
     *  object. A `{ running: false }` stand-in is missing every other field the
     *  view reads once it decides a batch exists. */
    "batch:status": (): BatchState | null => null,

    // ── Branch switcher ──────────────────────────────────────────────────
    /** Answered explicitly, and answered UNAVAILABLE.
     *
     *  This is the one feature in the app that cannot have a fake. Everything
     *  else here stands in for data; the branch switcher's job is to run git,
     *  build a checkout, and relaunch the Electron app onto it — none of which
     *  a browser tab can pretend to do, and a pretend one would end in a button
     *  that does nothing. So the preview reports the truth, the sidebar entry
     *  never renders, and there is no dead end to find.
     *
     *  `defaultFor` would return null here (the verb is "status"), and the view
     *  destructures the answer — a crash rather than a degraded panel. */
    "branches:status": (): BranchStatus => ({
      available: false,
      switched: false,
      hasToken: false,
      reason:
        "The browser preview has no backend — no git, no build, no way to relaunch anything. Branch switching only works in the Electron app.",
    }),
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

/**
 * A run that actually finishes.
 *
 * WHY THIS IS SCRIPTED RATHER THAN INSTANT. The screens this feeds are about
 * a run in PROGRESS as much as a run that is over: steps go cyan one at a time,
 * the log grows, and the verdict chip flips from the holo "Running" treatment to
 * a tone. Resolving the whole thing in one tick would render the end state and
 * nothing else, which is exactly the half that was already reachable.
 *
 * The outcome comes from the FIXTURE, not from a coin flip. `t-login`'s stored
 * run failed, so its preview run fails at the same step — which is what makes
 * `?test=t-login` a stable address for "show me the failed path", and it is the
 * only reason the failed console path can be reviewed at all outside a Mac.
 * Math.random() here would mean a screenshot you cannot ask for twice.
 *
 * Nothing real happens: no browser, no Playwright, no file written. The banner
 * says so, permanently.
 */
function startFakeRun(
  payload: Payload,
  state: ReturnType<typeof seed>,
  emit: (channel: string, value: unknown) => void,
): { runId: string } {
  // `api.ts` sends `{ id, headed, ... }` — the key is `id`, not `testId`, and
  // the store keys its run map by the TEST id, so the two have to agree or the
  // panel watches a run nobody is reporting on.
  const runId = String(payload?.id ?? "preview-run");
  const test = state.tests.find((t) => t.id === runId);
  const steps = test?.steps ?? [];
  // Which step fails, or -1 for a clean run. Read from the fixture's own run
  // history so the preview agrees with the sidebar's status dot.
  const stored = state.runs.find((r) => r.testId === runId);
  const failAt =
    stored && stored.status !== "passed" ? Math.min(steps.length - 1, Math.max(0, steps.length - 2)) : -1;

  const TICK = 260;
  let at = 0;
  const later = (fn: () => void) => {
    at += TICK;
    setTimeout(fn, at);
  };

  emit("runner:output", { runId, chunk: `Running ${steps.length} steps…\n` });
  for (let i = 0; i < steps.length; i++) {
    const index = i;
    later(() => emit("runner:step", { runId, index, status: "begin", ok: true }));
    later(() => {
      const ok = index !== failAt;
      emit("runner:step", { runId, index, status: "end", ok });
      emit("runner:output", {
        runId,
        chunk: ok
          ? `  ok ${index + 1} — ${test?.name ?? "step"}\n`
          : `  ✘ ${index + 1} — ${test?.name ?? "step"}\n\n` +
            `    Error: Timeout 5000ms exceeded waiting for locator\n` +
            `    at ${test?.url ?? "about:blank"}\n`,
      });
    });
    // Everything after the failing step is never attempted, exactly as
    // Playwright would leave it — the rows stay unmarked rather than going
    // green, which is the difference between "these passed" and "these did not
    // run".
    if (index === failAt) break;
  }
  later(() =>
    emit("runner:done", {
      runId,
      code: failAt === -1 ? 0 : 1,
      recordId: stored?.id,
    }),
  );
  return { runId };
}

/**
 * A canned AI diagnosis, streamed a chunk at a time.
 *
 * The reply ENDS IN A REQUEST BLOCK on purpose. The debug panel's most
 * intricate surface is what happens after the model asks for more data — the
 * card, the fetch, the review, the two-step send — and none of it is reachable
 * without a reply that actually contains the block. Every other way to see it
 * needs a local model installed and cooperating, which no agent and no
 * non-Mac reviewer has.
 *
 * `structure` rather than `console`, because that is the ask this fixture was
 * added for: a locator that matched several elements, which the model cannot
 * resolve without being shown the page.
 */
function startFakeChat(emit: (channel: string, value: unknown) => void): { requestId: string } {
  const requestId = "preview-llm-1";
  const reply =
    "The click failed because getByRole(\"button\", { name: \"Pause\" }) matched 10 " +
    "elements, so Playwright refused to guess which one you meant. I can see that " +
    "it is ambiguous, but not which of the ten is the video player's pause " +
    "button.\n\n```glaze-request\n" +
    '{"need": ["structure"], "why": "to see which elements matched and pick the right one"}' +
    "\n```";
  // Chunked, so the preview shows the streaming path rather than a reply that
  // appears whole. The request block is only parsed once `llm:done` lands —
  // a half-streamed fence is not a request.
  const chunks = reply.match(/[\s\S]{1,40}/g) ?? [reply];
  chunks.forEach((delta, i) => {
    setTimeout(() => emit("llm:chunk", { requestId, delta }), 120 * (i + 1));
  });
  setTimeout(() => emit("llm:done", { requestId }), 120 * (chunks.length + 1));
  return { requestId };
}

export function installPreviewBridge(): PreviewDiagnostics {
  const state = seed();
  const handlers = { ...buildHandlers(state), ...SDK_CHANNELS };
  const diagnostics: PreviewDiagnostics = { misses: {}, calls: [] };

  // ── Push ────────────────────────────────────────────────────────────────
  //
  // `on` USED TO BE A NO-OP, and that quietly bounded what the preview could
  // show to whatever a view renders before anything happens to it. Everything
  // in this app that has a *result* arrives by push: a run's output, its
  // per-step status, its exit code. So "Run test" started a run that could
  // never finish, and the run panel — the whole subject of the test detail
  // screen — was only ever reachable in its Running state. A reskin of the
  // FAILED path could not be looked at at all.
  //
  // A map of channel → listeners, and `emit` below. Deliberately tiny: this is
  // not an IPC implementation, it is enough of one that a scripted run can
  // report what it did.
  //
  // THE LISTENER SIGNATURE IS `(event, payload)`, NOT `(payload)`, and getting
  // that wrong is silent in exactly the way this file's header warns about.
  // `api.on` unwraps with `cb(args[1] as T)` — the real preload hands Electron's
  // IpcRendererEvent first — so a bus that emitted the payload alone would call
  // every subscriber with `undefined` and render nothing, with no error and no
  // miss recorded. The first version of this did that; the run simply never
  // finished. The `null` below stands in for the event nobody reads.
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const subscribe = (channel: string, fn: (...args: unknown[]) => void) => {
    const set = listeners.get(channel) ?? new Set();
    set.add(fn);
    listeners.set(channel, set);
    return () => {
      set.delete(fn);
    };
  };
  const emit = (channel: string, payload: unknown) => {
    for (const fn of listeners.get(channel) ?? []) fn(null, payload);
  };

  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    diagnostics.calls.push(channel);
    if (channel === "runner:run") return startFakeRun(args[0] as Payload, state, emit);
    if (channel === "llm:chat") return startFakeChat(emit);
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
        on: (channel: string, fn: (...args: unknown[]) => void) => subscribe(channel, fn),
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
