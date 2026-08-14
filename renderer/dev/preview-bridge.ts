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

import { missedRoutines } from "../../shared/routine-schedule.mjs";
import {
  BATCHES,
  ROUTINES,
  HEALS,
  SCRIPT_CHANGES,
  LLM_CONFIG,
  LLM_STATUS,
  PICKED_ELEMENT,
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
  Routine,
  BatchState,
  EmitResult,
  CaptureOverheadSummary,
  FlakeReport,
  Locator,
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
  ProviderChoice,
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
  // `trainer-panel` is here because it is the same LIVE SESSION seen from the
  // docked window — it runs the same store, and without a session in flight it
  // renders its "Loading…" state forever, which is not the screen anyone opened
  // it to look at.
  return view === "recorder" || view === "recorder-editing" || view === "trainer-panel";
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

/**
 * Runs for tests that are not in the library, so Stats → Cost reaches page two.
 *
 * The hand-written fixtures cover three tests, and the spend table pages at 25 —
 * so without these the pager renders not at all, which is the state that panel
 * is least likely to be broken in. Same reasoning, and the same shape, as the
 * 58 filler rows the step-health fixture already carries.
 *
 * THEY ARE RUNS OF DELETED TESTS as far as the library is concerned, which is
 * deliberate: the Cost table names a test from the run record itself, so these
 * render correctly there, while nothing in the sidebar or the test list gains a
 * row it cannot open. `testDeleted` is left FALSE because the cost model filters
 * those out — these are meant to be counted.
 */
function costFiller(): RunRecord[] {
  const day = 86_400_000;
  return Array.from({ length: 30 }, (_, i): RunRecord => {
    const startedAt = Date.now() - (i + 2) * day;
    // Descending duration, so the table's "dearest first" order is legible and
    // page two is visibly the cheap tail rather than an arbitrary cut.
    const durationMs = (40 - i) * 4_000;
    const failed = i % 9 === 0;
    return {
      id: `r-cost-${i}`,
      testId: `t-cost-${i}`,
      testName: `Suite check ${String(i + 1).padStart(2, "0")}`,
      url: "https://example.com",
      status: failed ? "failed" : "passed",
      exitCode: failed ? 1 : 0,
      startedAt,
      finishedAt: startedAt + durationMs,
      durationMs,
      logFile: "/preview/runs/cost.log",
      logBytes: 2_048,
    };
  });
}

/** Mutable copies, so the preview behaves like an app with state: renaming a
 *  test or deleting a tag persists for the session. Reloading resets it, which
 *  is the right amount of persistence for a preview. */
function seed() {
  return {
    tests: structuredClone(TESTS),
    runs: [...structuredClone(RUNS), ...costFiller()],
    heals: structuredClone(HEALS),
    scriptChanges: structuredClone(SCRIPT_CHANGES),
    // Edited in place, so a save made in the preview STICKS for the session — a
    // bridge that forgot every save would make the Routine editor look broken
    // in the one place a person can actually drive it.
    routines: structuredClone(ROUTINES),
    settings: structuredClone(SETTINGS),
    llmConfig: structuredClone(LLM_CONFIG),
    // Starts DISCONNECTED, so the preview opens on the state that actually
    // needs looking at: the empty pane someone sees before they have a key.
    // Connecting works and persists for the session, so both halves of the
    // Integrations pane are reachable in a tab.
    issues: {
      connected: false,
      error: null as string | null,
      // Which tracker the preview is filing into. Switchable in a tab, because
      // the switch is the thing that has to be LOOKED at: the pane's whole job
      // is to make the destination obvious, and that cannot be reviewed from a
      // fixture pinned to one provider.
      provider: "linear" as "linear" | "github",
      defaults: { containerId: null as string | null, subContainerId: null as string | null },
      // Grows as issues are filed, so the recurrence branch is reachable in a tab:
      // send the same defect twice and the second opens on "already filed".
      links: [] as IssueLink[],
    },
  };
}

/** What each tracker calls its own concepts. A copy of the real providers'
 *  vocabularies, which is what a preview fixture IS — the preview has no
 *  backend to ask, and the pane's labels are the thing being looked at. */
const VOCABULARIES: Record<"linear" | "github", ProviderVocabulary> = {
  linear: {
    name: "Linear",
    container: "Team",
    containerPlural: "Teams",
    subContainer: "Project",
    keyHelpUrl: "https://linear.app/settings/api",
    keyPlaceholder: "lin_api_…",
    supportsImageUpload: true,
  },
  github: {
    name: "GitHub",
    container: "Repository",
    containerPlural: "Repositories",
    subContainer: "Milestone",
    keyHelpUrl: "https://github.com/settings/tokens",
    keyPlaceholder: "ghp_… or github_pat_…",
    // False, so the compose dialog's "these will NOT be attached" warning is
    // reachable in a tab. It is a security-relevant piece of copy and jsdom
    // cannot show what it looks like next to the thumbnails.
    supportsImageUpload: false,
  },
};

function buildHandlers(state: ReturnType<typeof seed>): Record<string, Handler> {
  const findTest = (id: unknown) => state.tests.find((t) => t.id === id) ?? null;

  /** Settle a missed occurrence, the way both real answers do — running it and
   *  declining it both stamp, or the prompt returns on every reload. */
  const stampScheduled = (id: string): boolean => {
    const i = state.routines.findIndex((r) => r.id === id);
    if (i < 0) return false;
    state.routines[i] = { ...state.routines[i], lastScheduledRunAt: Date.now() };
    return true;
  };

  /** One place the connection state is shaped, since four handlers return it. */
  const issuesStatus = (): ConnectionStatus => ({
    provider: state.issues.provider,
    hasKey: state.issues.connected,
    account: state.issues.connected
      ? state.issues.provider === "github"
        ? // No workspace name, matching the real provider: a GitHub token is not
          // scoped to one organisation the way a Linear key is to one workspace.
          { accountName: "Sam Rivera", workspaceName: null }
        : { accountName: "Sam Rivera", workspaceName: "Northwind" }
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
    /** Validates the way the real handler does — empty clears, a non-URL is
     *  refused — because the field's error path (revert + toast) is the half
     *  worth looking at, and a preview that accepted anything would never show
     *  it. */
    "tests:setBaseUrl": (p) => {
      const test = findTest(p?.id);
      if (!test) return null;
      const raw = typeof p?.baseUrl === "string" ? p.baseUrl.trim() : "";
      if (raw === "") {
        delete test.baseUrl;
        return test;
      }
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new Error("Invalid base URL: " + raw);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Invalid base URL: " + raw);
      }
      test.baseUrl = url.href;
      return test;
    },
    "tests:setTags": (p) => {
      const test = findTest(p?.id);
      if (test && Array.isArray(p?.tags)) test.tags = p.tags as string[];
      return test;
    },
    // Folders. Trimmed here as well, matching `normalizeGroup` — the preview's
    // job is to behave like the backend, and a bridge that stored what the
    // renderer sent would let a bug through that the real app catches.
    "tests:setGroup": (p) => {
      const test = findTest(p?.id);
      if (!test) return null;
      const group = typeof p?.group === "string" ? p.group.trim() : "";
      if (group) test.group = group;
      else delete test.group;
      return test;
    },
    "tests:renameGroup": (p) => {
      const from = typeof p?.from === "string" ? p.from.trim() : "";
      const to = typeof p?.to === "string" ? p.to.trim() : "";
      let changed = 0;
      if (from) {
        for (const test of state.tests) {
          if ((test.group ?? "") !== from) continue;
          if (to) test.group = to;
          else delete test.group;
          changed++;
        }
      }
      return { from, to, changed };
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

    // ── Script changes ───────────────────────────────────────────────────
    //
    // Keep and Revert mutate the fixture rather than returning a value and
    // leaving the row as it was: the whole point of these two buttons is that
    // the row settles, and a preview where clicking Keep does nothing visible
    // teaches the opposite of what the app does.
    "scriptChanges:list": () => state.scriptChanges,
    "scriptChanges:listAll": () => state.scriptChanges,
    "scriptChanges:pending": () => state.scriptChanges.filter((c) => c.status === "pending"),
    "scriptChanges:accept": (p) => {
      const entry = state.scriptChanges.find((c) => c.id === p?.id);
      if (entry) entry.status = "accepted";
      return entry ?? null;
    },
    "scriptChanges:revert": (p) => {
      const entry = state.scriptChanges.find((c) => c.id === p?.id);
      if (entry) entry.status = "reverted";
      return entry ?? null;
    },
    "scriptChanges:remove": (p) => {
      const before = state.scriptChanges.length;
      state.scriptChanges = state.scriptChanges.filter((c) => c.id !== p?.id);
      return { removed: before - state.scriptChanges.length };
    },
    "scriptChanges:clearSettled": (p) => {
      const before = state.scriptChanges.length;
      state.scriptChanges = state.scriptChanges.filter(
        (c) => c.testId !== p?.testId || c.status === "pending",
      );
      return { removed: before - state.scriptChanges.length };
    },
    "scriptChanges:clearAllSettled": () => {
      const before = state.scriptChanges.length;
      state.scriptChanges = state.scriptChanges.filter((c) => c.status === "pending");
      return { removed: before - state.scriptChanges.length };
    },

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

    // The Documentation pane's one piece of live state. A preview has no
    // filesystem to check, so it answers with the shape a real checkout gives —
    // the interesting half of the pane to look at is the copyable command, and
    // the absent case is one line of prose.
    "docs:mcpServer": () => ({
      path: "/path/to/good-looks/mcp/server.mjs",
      exists: true,
      command:
        'claude mcp add --scope user good-looks -- node "/path/to/good-looks/mcp/server.mjs"',
    }),

    // ── Issue tracker ────────────────────────────────────────────────────
    // Enough behaviour to exercise the pane's two states in a tab: a key that
    // is empty is refused the way the real backend refuses it, and anything
    // else connects. A preview cannot reach Linear, so "verify" is local — the
    // thing being previewed is the pane, not the network.
    "issues:status": (): ConnectionStatus => issuesStatus(),
    "issues:vocabulary": (): ProviderVocabulary => VOCABULARIES[state.issues.provider],
    "issues:providers": (): ProviderChoice[] =>
      (["linear", "github"] as const).map((id) => ({
        id,
        vocabulary: VOCABULARIES[id],
        hasKey: state.issues.connected && state.issues.provider === id,
      })),
    "issues:setActiveProvider": (p): ConnectionStatus => {
      const next = p?.provider;
      if (next !== "linear" && next !== "github") return issuesStatus();
      state.issues.provider = next;
      // Mirrors the real backend: each provider has its own key and its own
      // destination, so switching lands on the other one's connection rather
      // than carrying this one's across.
      state.issues.connected = false;
      state.issues.error = null;
      state.issues.defaults = { containerId: null, subContainerId: null };
      return issuesStatus();
    },
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
    "issues:listContainers": (): IssueContainer[] =>
      state.issues.provider === "github"
        ? [
            { id: "acme/storefront", name: "storefront", key: "acme" },
            { id: "acme/checkout-api", name: "checkout-api", key: "acme" },
            { id: "csteubs/good-looks", name: "good-looks", key: "csteubs" },
          ]
        : [
            { id: "team-eng", name: "Engineering", key: "ENG" },
            { id: "team-design", name: "Design", key: "DES" },
            { id: "team-web", name: "Web Platform", key: "WEB" },
          ],
    // Scoped for GitHub and workspace-wide for Linear, exactly as the real
    // providers answer — so the preview shows the empty-until-you-pick-a-repo
    // state, which is the one a Linear-only fixture would hide.
    "issues:listSubContainers": (p): IssueSubContainer[] => {
      const containerId = typeof p?.containerId === "string" ? p.containerId : null;
      if (state.issues.provider === "github") {
        return containerId
          ? [
              { id: "1", name: "v2.0", containerId },
              { id: "2", name: "Bug bash", containerId },
            ]
          : [];
      }
      return [
        { id: "proj-checkout", name: "Checkout revamp", containerId: "team-eng" },
        { id: "proj-a11y", name: "Accessibility debt", containerId: null },
        { id: "proj-design-sys", name: "Design system", containerId: "team-design" },
      ];
    },
    "issues:listLabels": (p): IssueLabel[] => {
      const containerId = typeof p?.containerId === "string" ? p.containerId : null;
      if (state.issues.provider === "github") {
        return containerId
          ? [
              { id: "bug", name: "bug", color: "#d73a4a" },
              { id: "accessibility", name: "accessibility", color: "#0e8a16" },
            ]
          : [];
      }
      return [
        { id: "lbl-bug", name: "Bug", color: "#ff4d61" },
        { id: "lbl-a11y", name: "Accessibility", color: "#35e0ff" },
        { id: "lbl-visual", name: "Visual", color: "#b98cff" },
      ];
    },
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
      const n = state.issues.links.length;
      // Shaped like the real answer for whichever provider is selected. The
      // identifier is what the toast and the "already filed" branch render, and
      // the two providers spell it very differently.
      const issue =
        state.issues.provider === "github"
          ? {
              id: `acme/storefront#${101 + n}`,
              identifier: `acme/storefront#${101 + n}`,
              url: `https://github.com/acme/storefront/issues/${101 + n}`,
            }
          : {
              id: `iss-${n + 1}`,
              identifier: `ENG-${42 + n}`,
              url: "https://linear.app/northwind/issue/ENG-42",
            };
      // Recorded, so the SECOND send of the same defect shows the recurrence
      // branch — which is the half of this feature worth being able to look at.
      state.issues.links.push({
        provider: state.issues.provider,
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
    // Element context. The picker's live readout asks the page how many
    // elements the CURRENT selection matches; there is no page here, so the
    // answer comes from the fixture's own per-signal counts. Several ticked
    // signals report the tightest of them, which is what a real intersection
    // would do for this fixture — every signal here narrows the same two-button
    // set. A ctx the fixture does not recognise reports the base count rather
    // than 0: "we could not price this" must never render as "nothing matches".
    "recorder:countMatches": (p: Payload) => {
      const ctx = (p?.locator as Locator | undefined)?.ctx;
      if (!ctx) return PICKED_ELEMENT.contextBaseCount;
      const key = JSON.stringify(ctx);
      const exact = PICKED_ELEMENT.contextSignals.find((s) => JSON.stringify(s.ctx) === key);
      if (exact) return exact.count;
      const parts = PICKED_ELEMENT.contextSignals.filter(
        (s) =>
          (ctx.within && JSON.stringify(s.ctx.within) === JSON.stringify(ctx.within)) ||
          (ctx.and ?? []).some((a) => JSON.stringify(s.ctx.and?.[0]) === JSON.stringify(a)),
      );
      return parts.length > 0
        ? Math.min(...parts.map((s) => s.count))
        : PICKED_ELEMENT.contextBaseCount;
    },
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
    // REDESIGN §6.5. The preview has no filesystem and no save dialog, so it
    // reports the cancel the real dialog reports when the user backs out — the
    // panel's own "nothing was written" path, which is the one an unbacked
    // preview can honestly exercise. A fake success would put a path on screen
    // that names a file nobody can open.
    "report:emit": (): EmitResult => ({ path: null, bytes: 0, count: 0, cancelled: true }),
    "batch:list": (): BatchRecord[] => structuredClone(BATCHES),

    // ── Routines ─────────────────────────────────────────────────────────
    // docs/ROUTINES.md. Backed by mutable session state (see `seed`), so an
    // edit made in the preview sticks for the rest of the session.
    "routines:list": (): Routine[] => structuredClone(state.routines),
    "routines:get": (params?: unknown): Routine | null => {
      const id = (params as { id?: string } | undefined)?.id;
      return structuredClone(state.routines.find((r) => r.id === id) ?? null);
    },
    "routines:save": (params?: unknown): Routine | null => {
      const sent = (params as { routine?: Routine } | undefined)?.routine;
      if (!sent || typeof sent.id !== "string") return null;
      // `updatedAt` MOVES on every save, as the real store's does — the editor
      // keys its re-seed on it, so a bridge that left it alone would leave the
      // screen showing what it sent instead of what was stored.
      const next = { ...structuredClone(sent), updatedAt: Date.now() };
      const i = state.routines.findIndex((r) => r.id === next.id);
      if (i >= 0) state.routines[i] = next;
      else state.routines.push(next);
      return structuredClone(next);
    },
    "routines:delete": (params?: unknown): { removed: number } => {
      const id = (params as { id?: string } | undefined)?.id;
      const before = state.routines.length;
      state.routines = state.routines.filter((r) => r.id !== id);
      return { removed: before - state.routines.length };
    },
    /** Occurrences missed while the app was closed. Computed from the SAME
     *  rules the backend uses rather than hard-coded, so a fixture whose
     *  schedule stops being overdue stops appearing here too — a preview that
     *  disagrees with the app about what is due is worse than no preview. */
    "routines:missed": (): Routine[] =>
      structuredClone(missedRoutines(state.routines, Date.now())),
    "routines:runMissed": (params?: unknown): { routineId: string; outcome: string } => {
      const id = (params as { id?: string } | undefined)?.id ?? "";
      stampScheduled(id);
      return { routineId: id, outcome: "started" };
    },
    "routines:dismissMissed": (params?: unknown): { dismissed: boolean } => {
      const id = (params as { id?: string } | undefined)?.id ?? "";
      return { dismissed: stampScheduled(id) };
    },
    /** The preview HAS a runner (see the run bridge above), so this answers the
     *  way the real one does rather than pretending nothing happened. */
    "routines:run": (): {
      batchId: string;
      alreadyRunning: boolean;
      skipped: string[];
      plannedRuns: number;
    } => ({ batchId: `b-${Date.now()}`, alreadyRunning: false, skipped: [], plannedRuns: 0 }),
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
  // The real runner persists the record and then broadcasts `runs:changed`,
  // which is what refreshes the six run-derived caches (see
  // `renderer/lib/run-derived-cache.ts`). Omitting it here made the preview
  // quietly unable to show a whole class of bug: the Stats board's tiles going
  // stale after a run reproduced in the app and NEVER in `dev:web`, because
  // nothing in a tab could make the event happen.
  later(() => emit("runs:changed", {}));
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
    // Refine mode, which in the real app pauses the session and waits for the
    // user to click an element in the training browser. There is no training
    // browser here, so the pick is delivered on a timer — without it neither
    // the Refine dialog nor the composer's target picker (nor, now, the
    // element-context picker) can be reached in a browser tab at all.
    if (channel === "recorder:startRefine") {
      setTimeout(() => emit("recorder:picked", structuredClone(PICKED_ELEMENT)), 400);
      return handlers["recorder:getState"]?.({} as Payload);
    }
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
    //
    // But "dismissed" is also a DEAD END, and it hides more of this app than it
    // looks: every step the composer can add is reached through one of these,
    // so the whole Add-step flow — and with it the target picker, the element
    // context picker and the per-kind forms — has no address in the preview at
    // all. `?menu=<label>` picks the item whose label contains that text, so a
    // flow can be driven to the screen being worked on. Off by default, because
    // a menu that silently chooses for you is worse than one that closes.
    Menu: {
      popup: async (options?: { items?: { label?: string; commandId?: number }[] }) => {
        const want = new URLSearchParams(window.location.search).get("menu");
        if (!want) return { commandId: undefined };
        const hit = (options?.items ?? []).find(
          (i) => i.label && i.label.toLowerCase().includes(want.toLowerCase()),
        );
        return { commandId: hit?.commandId };
      },
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
