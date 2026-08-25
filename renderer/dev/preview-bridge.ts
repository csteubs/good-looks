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
import { rollupA11y } from "../../shared/a11y-rollup.mjs";
import { DEFAULT_FAILURE_REASONS } from "../../shared/failure-reasons.mjs";
import {
  BATCHES,
  NOW,
  ROUTINES,
  HEALS,
  AI_DEBUG_HISTORY,
  INSIGHT_REPORTS,
  INSIGHTS_STATE,
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
  visualFrame,
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
  CustomFailureReason,
  OverlayRule,
  FailureReasonCatalog,
  FlakeReport,
  Locator,
  RecorderState,
  RunLogs,
  Step,
  StepStructure,
  RunRecord,
  RunTotals,
  RunNoticeKind,
  RunReplay,
  RunReplaySummary,
  ScriptCheckResult,
  ScriptPreview,
  LivePageCount,
  LivePagePick,
  LivePageStatus,
  SecretStatus,
  TestRecord,
  TestVariable,
  VisualMask,
} from "../lib/recorder-types";
import type { LlmConfig, LlmModel, LlmProviderStatus, LlmRoleSlot } from "../lib/llm-types";
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

/** Variables the previewed session declares.
 *
 *  Module-level and mutable because the real ones live on the backend session,
 *  which the preview has no equivalent of — and because the create form is only
 *  worth previewing if what it creates then shows up in the picker. Seeded with
 *  one of each kind so the chips can be seen without typing anything. */
/** Secrets stored during a preview session. Names only — the value is never
 *  held here, for the same reason the real store never hands one back. */
const previewSecrets = new Set<string>();

const previewVariables: TestVariable[] = [
  { name: "storePassword", kind: "secret" },
  { name: "customerEmail", kind: "plain", value: "shopper@example.com" },
];

/** The previewed session's state.
 *
 *  Hoisted out of the handler map because two handlers now answer with it — a
 *  created variable has to come back in the same shape a push would deliver, or
 *  the picker that asked for it would not list what it just made. */
/** The preview's open inline-flow scope, so `?view=recorder` can exercise the
 *  whole enter → edit-banner → Done loop without a backend. */
let previewFlowScope: {
  flowId: string;
  callStepId: string;
  name: string;
  steps: Step[];
  cursor: number;
} | null = null;
/** Set by the flow-scope handlers; the invoke wrapper (which holds `emit`)
 *  flushes it as the `recorder:flowScope` + `recorder:state` pushes. */
let pendingFlowScopePush = false;

function recorderState(): RecorderState {
  if (!recorderPreview()) {
    return {
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
    };
  }
  return {
    recording: true,
    paused: false,
    assertMode: null,
    stepCount: TESTS[0].steps.length,
    testId: TESTS[0].id,
    url: TESTS[0].url,
    // Deliberately a DEEPER url than `url` above: the two fields mean different
    // things (start vs. now), and a fixture where they match would hide a view
    // that renders the wrong one.
    liveUrl: TESTS[0].url.replace(/\/*$/, "") + "/cart",
    name: TESTS[0].name,
    editing: editingPreview(),
    assertSoft: false,
    cursor: previewCursor(),
    refineMode: false,
    variables: previewVariables,
    replaying: false,
    pageReady: true,
    loading: false,
    flowScope: previewFlowScope
      ? {
          flowId: previewFlowScope.flowId,
          callStepId: previewFlowScope.callStepId,
          name: previewFlowScope.name,
          cursor: previewFlowScope.cursor,
          stepCount: previewFlowScope.steps.length,
        }
      : null,
  };
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
/** The push emitter of the bridge currently mounted, for handlers that
 *  announce a change the way the backend does (the live page's status). Set
 *  once the bridge exists; a handler reached before then has nobody
 *  listening anyway. */
let bridgeEmit: (channel: string, payload: unknown) => void = () => {};

function seed() {
  return {
    tests: structuredClone(TESTS),
    // The Script IDE's live page — see the livePage:* handlers.
    livePage: { open: false } as LivePageStatus,
    runs: [...structuredClone(RUNS), ...costFiller()],
    heals: structuredClone(HEALS),
    scriptChanges: structuredClone(SCRIPT_CHANGES),
    aiDebugHistory: structuredClone(AI_DEBUG_HISTORY),
    // One custom reason, so the picker, the Settings editor and the Stats
    // breakdown all have a non-built-in row to show.
    failureReasons: [
      {
        id: "fr-vendor",
        name: "Vendor outage",
        description: "A third-party service the site depends on was down.",
        createdAt: Date.now() - 86_400_000,
        updatedAt: Date.now() - 86_400_000,
      },
    ] as CustomFailureReason[],
    // Two overlay rules on one host, because that is the real shape: a site
    // typically has a consent modal AND a newsletter pop-up, and the pane's
    // grouping only means anything with more than one row under a host.
    // One is disabled, so the enabled/disabled treatment is visible.
    overlayRules: [
      {
        id: "or-consent",
        host: "ritual.com",
        label: "Cookie banner — Close",
        target: { k: "testid", v: "dg-header-close" },
        createdAt: Date.now() - 172_800_000,
        updatedAt: Date.now() - 172_800_000,
      },
      {
        id: "or-newsletter",
        host: "ritual.com",
        label: "Newsletter pop-up",
        target: { k: "role", role: "button", name: "Close dialog" },
        disabled: true,
        createdAt: Date.now() - 86_400_000,
        updatedAt: Date.now() - 3_600_000,
      },
      {
        id: "or-app",
        host: "example.com",
        label: "",
        target: { k: "css", v: "button.app-banner__dismiss" },
        createdAt: Date.now() - 3_600_000,
        updatedAt: Date.now() - 3_600_000,
      },
    ] as OverlayRule[],
    insightReports: structuredClone(INSIGHT_REPORTS),
    insightsState: structuredClone(INSIGHTS_STATE),
    // Edited in place, so a save made in the preview STICKS for the session — a
    // bridge that forgot every save would make the Routine editor look broken
    // in the one place a person can actually drive it.
    routines: structuredClone(ROUTINES),
    settings: structuredClone(SETTINGS),
    llmConfig: structuredClone(LLM_CONFIG),
    // Starts absent so the Proxy pane opens on the save-a-password state;
    // saving one sticks for the session, same rule as the issues connection.
    proxyHasPassword: false,
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
    "tests:listFlows": (
      p,
    ): { id: string; name: string; flowParams: string[]; paramDefaults: Record<string, string> }[] =>
      state.tests
        .filter((t) => t.isFlow && t.id !== (p?.fromId as string | undefined))
        .map((t) => ({
          id: t.id,
          name: t.name,
          flowParams: t.flowParams ?? [],
          paramDefaults: Object.fromEntries(
            (t.flowParams ?? []).map((name) => [
              name,
              (t.variables ?? []).find((v) => v.name === name)?.value ?? "",
            ]),
          ),
        })),
    "tests:setFlow": (p) => {
      const test = findTest(p?.id);
      if (!test) return null;
      test.isFlow = p?.isFlow === true;
      // Same filter as the backend: parameter names become object keys in the
      // generated spec, so an invalid one is dropped rather than stored.
      test.flowParams = Array.isArray(p?.flowParams)
        ? (p.flowParams as unknown[]).filter(
            (n): n is string => typeof n === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && n.length <= 40,
          )
        : [];
      test.updatedAt = Date.now();
      return structuredClone(test);
    },
    /** The "Used by" list on a flow's detail view. Same scan the real handler
     *  does: direct `runFlow` callers, hidden tests included. */
    "tests:flowUsage": (p): { id: string; name: string }[] =>
      state.tests
        .filter(
          (t) =>
            t.id !== p?.id &&
            t.steps.some((s) => s.type === "runFlow" && s.flowId === p?.id),
        )
        .map((t) => ({ id: t.id, name: t.name })),
    /** Unwrap a flow call into a copy of the flow's steps. The preview's
     *  binding is a simplification (no `${param}` substitution — that lives in
     *  the generator, which the preview doesn't ship) but the SHAPE matches:
     *  the call row disappears and the flow's steps take its place. */
    "tests:unwrapFlow": (p): TestRecord | null => {
      const test = findTest(p?.id);
      if (!test) return null;
      const at = test.steps.findIndex((s) => s.id === p?.stepId);
      const call = at >= 0 ? test.steps[at] : undefined;
      if (!call || call.type !== "runFlow" || !call.flowId) return structuredClone(test);
      const flow = findTest(call.flowId);
      if (!flow || flow.steps.length === 0) return structuredClone(test);
      const inline = flow.steps.map((s, i) => ({
        ...structuredClone(s),
        id: `${call.id}-u${i}`,
        timestamp: Date.now(),
      }));
      test.steps = [...test.steps.slice(0, at), ...inline, ...test.steps.slice(at + 1)];
      return structuredClone(test);
    },
    // CLONED, and that is what makes the preview behave like the app rather
    // than merely answer like it. The fixture handlers mutate `state.tests` in
    // place, so returning the live object hands React Query the SAME reference
    // it already holds — structural sharing then decides nothing changed and
    // no subscriber re-renders. A write lands, the record is correct, and the
    // screen does not move: exactly the symptom of the bug a reviewer would be
    // looking for. Real IPC serializes every reply, so the app never sees this.
    "tests:get": (p): TestRecord | null => {
      const test = findTest(p?.id);
      return test ? structuredClone(test) : null;
    },
    "tests:getScript": (p) => {
      const test = findTest(p?.id);
      if (!test) return "";
      // `?test=t-long`: a 2000-line spec, for looking at the Script IDE under
      // a file the size of an imported suite — the virtualised viewport,
      // the gutters and the search panel at a scale no fixture step list
      // reaches. Every 97th line is one the parser cannot map, so the
      // coverage gutter has something to show.
      if (test.id === "t-long") {
        const lines = [
          'import { test, expect } from "@playwright/test";',
          "",
          `test(${JSON.stringify(test.name)}, async ({ page }) => {`,
          `  await page.goto(${JSON.stringify(test.url)});`,
        ];
        for (let i = 1; lines.length < 1998; i++) {
          lines.push(
            i % 97 === 0
              ? `  await page.mouse.move(${i}, ${i * 2});`
              : `  await page.getByRole("button", { name: "Step ${i}" }).click();`,
          );
        }
        lines.push("});", "");
        return lines.join("\n");
      }
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
    /** The real handler hands the draft to the Playwright CLI. The preview has
     *  no CLI, so it answers the one thing the editor's error path needs to be
     *  visible here: an unbalanced bracket is reported on the line it is on,
     *  and anything that balances loads. Deliberately crude — the point is to
     *  render the failed-check state, not to parse TypeScript. */
    "tests:checkScript": (p): ScriptCheckResult => {
      const source = String(p?.source ?? "");
      const lines = source.split("\n");
      let depth = 0;
      let badLine = 0;
      for (let i = 0; i < lines.length; i++) {
        for (const ch of lines[i]) {
          if (ch === "(" || ch === "{" || ch === "[") depth += 1;
          else if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
          if (depth < 0 && !badLine) badLine = i + 1;
        }
      }
      if (depth !== 0 && !badLine) badLine = lines.length;
      const tests: { title: string; line: number }[] = [];
      lines.forEach((l, i) => {
        const m = l.match(/^\s*test\(\s*"([^"]*)"/);
        if (m) tests.push({ title: m[1], line: i + 1 });
      });
      if (badLine) {
        return {
          ok: false,
          errors: [{ message: 'SyntaxError: Unexpected token, expected "," (' + badLine + ":1)", line: badLine, column: 1 }],
          tests: [],
          durationMs: 420,
        };
      }
      if (tests.length === 0) {
        return {
          ok: false,
          errors: [{ message: "This script defines no tests — Playwright found nothing to run." }],
          tests: [],
          durationMs: 380,
        };
      }
      return { ok: true, errors: [], tests, durationMs: 410 };
    },
    /** The real handler runs the spec parser. The preview draws the parse-
     *  coverage gutter from line shapes instead: an `await page.…` statement
     *  is a step, `page.mouse`/`page.keyboard` calls are the parser's known
     *  misses, and the first miss that is not in the fixture's own script
     *  counts as new. Enough to see the gutter and the confirmation. */
    "tests:previewScript": (p): ScriptPreview => {
      const source = String(p?.source ?? "");
      const stepRanges: { from: number; to: number }[] = [];
      const skippedRanges: { from: number; to: number }[] = [];
      const newlySkipped: string[] = [];
      let offset = 0;
      for (const line of source.split("\n")) {
        const m = line.match(/^(\s*)(await page\.[\w.]+\(.*\);?)\s*$/);
        if (m) {
          const from = offset + m[1].length;
          const to = from + m[2].length;
          if (/^await page\.(mouse|keyboard|clock)\./.test(m[2])) {
            skippedRanges.push({ from, to });
            if (!/Step \d+|\/\/ …generated/.test(m[2])) newlySkipped.push(m[2].replace(/;$/, ""));
          } else {
            stepRanges.push({ from, to });
          }
        }
        offset += line.length + 1;
      }
      // Locators for the live page's counts: read off each statement line.
      const stepList = stepRanges.map((r, i) => {
        const text = source.slice(r.from, r.to);
        const m = text.match(/getBy(Role|TestId|Label|Text|Placeholder)\((['"])([^'"]*)\2(?:,\s*\{\s*name:\s*(['"])([^'"]*)\4)?/);
        const locator = m
          ? { k: m[1] === "Role" ? "role" : m[1].toLowerCase(), ...(m[1] === "Role" ? { role: m[3], name: m[5] } : { v: m[3] }) }
          : undefined;
        return { id: `p${i}`, type: "click", timestamp: 0, ...(locator ? { locator } : {}) } as Step;
      });
      return {
        tracked: !findTest(p?.id)?.sourceDir,
        steps: stepRanges.length,
        skipped: skippedRanges.length,
        stepRanges,
        skippedRanges,
        newlySkipped,
        stepList,
      };
    },
    // ── The Script IDE's live page ─────────────────────────────────────
    // No browser in the preview. `open` pretends, counts come from the
    // locator's shape (a test id matches once, a bare role matches three,
    // "Gone" matches nothing), and pick answers a fixed button after a beat —
    // enough to see every state the editor draws for it.
    "livePage:status": (): LivePageStatus => state.livePage,
    "livePage:open": (p): LivePageStatus => {
      state.livePage = { open: true, url: String(p?.url ?? ""), title: "Live page (preview)", browser: "chromium" };
      bridgeEmit("livePage:changed", state.livePage);
      return state.livePage;
    },
    "livePage:close": () => {
      state.livePage = { open: false };
      bridgeEmit("livePage:changed", state.livePage);
    },
    "livePage:countMany": (p): LivePageCount[] =>
      (Array.isArray(p?.locators) ? (p.locators as Locator[]) : []).map((l) => {
        if (!state.livePage.open) return { count: null, error: "No live page." };
        if (l.k === "text" && /gone/i.test(String(l.v ?? ""))) return { count: 0 };
        if (l.k === "role" && !l.name) return { count: 3 };
        return { count: 1 };
      }),
    "livePage:highlight": () => undefined,
    "livePage:pick": async (): Promise<LivePagePick | null> => {
      state.livePage = { ...state.livePage, picking: true };
      bridgeEmit("livePage:changed", state.livePage);
      await new Promise((r) => setTimeout(r, 900));
      state.livePage = { ...state.livePage, picking: false };
      bridgeEmit("livePage:changed", state.livePage);
      return { expr: "getByRole('button', { name: 'Sign in' })", locator: { k: "role", role: "button", name: "Sign in" } };
    },
    "livePage:cancelPick": () => undefined,
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
    /** Declaring a variable, from the Variables tab or from either step
     *  editor. Mutates the fixture in place — a bridge that accepted the write
     *  and answered with the record unchanged would make every create look
     *  like a silent failure, which is the one outcome the form is built to
     *  distinguish itself from. */
    "tests:setVariables": (p) => {
      const test = findTest(p?.id);
      if (test && Array.isArray(p?.variables)) {
        test.variables = p.variables as NonNullable<TestRecord["variables"]>;
      }
      return test;
    },
    /** The origin picker and the rewrite, mirroring the real handlers closely
     *  enough that the panel's two states — "nothing points there" and "N
     *  fields rewritten" — can both be seen in a tab. The transform itself is
     *  NOT reimplemented here: a second copy of the rule is how the preview
     *  comes to show something the app does not do. */
    "tests:originsIn": (p) => {
      const test = findTest(p?.id);
      if (!test) return [];
      const counts = new Map<string, number>();
      for (const step of test.steps ?? []) {
        const url = (step as { url?: string }).url;
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
        try {
          const { origin } = new URL(url);
          counts.set(origin, (counts.get(origin) ?? 0) + 1);
        } catch {
          /* not a URL */
        }
      }
      // The test's own site first, matching the real handler: "the site
      // address" means the site the test is about, not the host its steps
      // happen to mention most.
      let preferred = "";
      try {
        preferred = new URL(String(test.url ?? "")).origin;
      } catch {
        /* no usable url */
      }
      return [...counts.entries()]
        .map(([origin, count]) => ({ origin, count }))
        .sort((a, b) => {
          if (preferred) {
            if (a.origin === preferred && b.origin !== preferred) return -1;
            if (b.origin === preferred && a.origin !== preferred) return 1;
          }
          return b.count - a.count || a.origin.localeCompare(b.origin);
        });
    },
    "tests:parameteriseOrigin": (p) => {
      const test = findTest(p?.id);
      if (!test) return undefined;
      const origin = String(p?.origin ?? "");
      const name = typeof p?.name === "string" && p.name.trim() ? p.name.trim() : "SITE_URL";
      let rewritten = 0;
      for (const step of test.steps ?? []) {
        const s = step as { url?: string };
        if (typeof s.url === "string" && s.url.startsWith(origin)) {
          const rest = s.url.slice(origin.length);
          if (rest === "" || /^[/?#]/.test(rest)) {
            s.url = "${" + name + "}" + rest;
            rewritten++;
          }
        }
      }
      const vars = test.variables ?? [];
      const reusedVariable = vars.some((v) => v.name === name);
      if (!reusedVariable) {
        test.variables = [
          ...vars,
          { name, kind: "plain", value: origin, description: "The site address this test runs against." },
        ] as NonNullable<TestRecord["variables"]>;
      }
      return { test, rewritten, reusedVariable, name };
    },
    "tests:setSession": (p) => {
      const test = findTest(p?.id);
      if (!test) return undefined;
      if (p?.saveSession !== undefined) test.saveSession = p.saveSession === true ? true : undefined;
      if (p?.useSessionFrom !== undefined) {
        test.useSessionFrom =
          p.useSessionFrom === null || p.useSessionFrom === "" ? undefined : String(p.useSessionFrom);
      }
      return test;
    },
    /** The login fixture "has" a fresh saved session, so the status line's
     *  interesting arm renders; everything else has none. */
    "tests:sessionState": (p) =>
      p?.id === "t-login" ? { savedAt: NOW - 2 * 60 * 60 * 1000, fresh: true } : null,
    "tests:clearSessionState": () => null,
    "tests:setDatasets": (p) => {
      const test = findTest(p?.id);
      if (test && Array.isArray(p?.datasets)) {
        test.datasets = p.datasets as NonNullable<TestRecord["datasets"]>;
      }
      return test;
    },
    /** No file dialog exists in a browser tab, so the import is CANNED: two
     *  demo rows appended, with the same summary shape the real handler
     *  returns — which is what lets the toasts be seen at all in preview. */
    "tests:importDatasetCsv": (p) => {
      const test = findTest(p?.id);
      if (!test) {
        return { ok: false, imported: 0, problem: "Test not found.", createdVariables: [], skippedColumns: [], raggedRows: 0, truncated: false };
      }
      const existing = test.datasets ?? [];
      const rows = [
        { id: `d-demo-${existing.length + 1}`, name: `Row ${existing.length + 1}`, values: { user: "alice", city: "Berlin" } },
        { id: `d-demo-${existing.length + 2}`, name: `Row ${existing.length + 2}`, values: { user: "bob", city: "Lyon" } },
      ];
      test.datasets = [...existing, ...rows];
      const declared = new Set((test.variables ?? []).map((v) => v.name));
      const created = ["user", "city"].filter((n) => !declared.has(n));
      test.variables = [
        ...(test.variables ?? []),
        ...created.map((name) => ({ name, kind: "plain" as const, value: "" })),
      ];
      return { ok: true, imported: rows.length, createdVariables: created, skippedColumns: [], raggedRows: 0, truncated: false };
    },
    /** One-way, like the real handler: the value crosses and is never read
     *  back. The preview holds only the NAME, which is all `secretStatus`
     *  answers with anyway. */
    "tests:setSecret": (p) => {
      previewSecrets.add(String(p?.name ?? ""));
      return { name: String(p?.name ?? ""), hasValue: true };
    },
    "tests:clearSecret": (p) => {
      previewSecrets.delete(String(p?.name ?? ""));
      return { name: String(p?.name ?? ""), hasValue: false };
    },
    /** One row per declared secret that has a value stored this session. */
    "tests:secretStatus": (p): SecretStatus[] =>
      (findTest(p?.id)?.variables ?? [])
        .filter((v) => v.kind === "secret")
        .map((v) => ({ name: v.name, hasValue: previewSecrets.has(v.name) })),

    // ── Runs and artifacts ───────────────────────────────────────────────
    "runs:list": (): RunRecord[] => state.runs,
    /** PRUNED RUNS ON PURPOSE. The lifetime total is the one figure on the
     *  Stats board that cannot be derived from the run list — the real index is
     *  capped and this is not — so a preview answering `state.runs.length`
     *  would render precisely the state this counter exists to fix, and look
     *  right doing it. These numbers make the "older runs" note visible. */
    "runs:totals": (): RunTotals => {
      const real = state.runs.filter((r) => r.kind !== "baseline-update");
      const retained = real.length;
      const passed = real.filter((r) => r.status === "passed").length;
      const PRUNED = { runs: 240, passed: 220, failed: 20 };
      // DATED INTO THIS WEEK, because pruning takes the OLDEST records and a
      // busy suite therefore loses THIS WEEK's early days to the cap. Pruned
      // days sitting outside the digest's window would exercise the plumbing
      // and none of the arithmetic that made "1000 runs this week" wrong.
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      const DAY_MS = 86_400_000;
      const prunedDays = [5, 4, 3].map((back, i) => ({
        dayStart: midnight.getTime() - back * DAY_MS,
        runs: [100, 80, 60][i],
        passed: [92, 73, 55][i],
        failed: [8, 7, 5][i],
      }));
      return {
        runs: PRUNED.runs + retained,
        passed: PRUNED.passed + passed,
        failed: PRUNED.failed + (retained - passed),
        retained,
        pruned: PRUNED.runs,
        prunedDays,
      };
    },
    "runs:getLog": (): string => RUN_LOG,
    "runs:openTrace": () => ({
      ok: false,
      reason: "No backend in the preview — traces open from the real app.",
    }),
    "runs:logsDir": (): string => "/preview/runs",
    "runs:searchLogs": () => [],
    /** Mutates the fixture list in place so the picker's optimistic write and
     *  the requery agree — a stub that answered without storing would make the
     *  label revert on the next `runs:changed`. */
    "runs:setFailureReason": (p): RunRecord => {
      const rec = state.runs.find((r) => r.id === String(p?.id ?? ""));
      if (!rec || rec.status !== "failed") throw new Error("Only a failed run can carry a failure reason.");
      const reasonId = (p?.reasonId ?? null) as string | null;
      if (reasonId) {
        rec.failureReasonId = reasonId;
        rec.failureReasonBy = "user";
        delete rec.failureReasonSignal;
      } else {
        delete rec.failureReasonId;
        delete rec.failureReasonBy;
        delete rec.failureReasonSignal;
      }
      return rec;
    },
    // ── Failure reasons ──────────────────────────────────────────────────
    "failureReasons:list": (): FailureReasonCatalog => ({
      builtin: [...DEFAULT_FAILURE_REASONS],
      custom: state.failureReasons,
    }),
    "failureReasons:create": (p): CustomFailureReason => {
      const rec: CustomFailureReason = {
        id: `fr-${state.failureReasons.length + 1}`,
        name: String(p?.name ?? "").trim(),
        description: String(p?.description ?? "").trim(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.failureReasons.push(rec);
      return rec;
    },
    "failureReasons:update": (p): CustomFailureReason => {
      const rec = state.failureReasons.find((r) => r.id === String(p?.id ?? ""));
      if (!rec) throw new Error("No such custom reason: " + String(p?.id ?? ""));
      if (p?.name !== undefined) rec.name = String(p.name).trim();
      if (p?.description !== undefined) rec.description = String(p.description).trim();
      if (p?.disabled !== undefined) {
        if (p.disabled === true) rec.disabled = true;
        else delete rec.disabled;
      }
      rec.updatedAt = Date.now();
      return rec;
    },
    "overlayRules:list": (): OverlayRule[] => state.overlayRules,
    "overlayRules:create": (p): OverlayRule => {
      const rec: OverlayRule = {
        id: `or-${state.overlayRules.length + 1}`,
        host: String(p?.url ?? "").replace(/^https?:\/\//, "").split("/")[0] || "example.com",
        label: String(p?.label ?? ""),
        target: (p?.target ?? { k: "css", v: "button" }) as OverlayRule["target"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      state.overlayRules.push(rec);
      return rec;
    },
    "overlayRules:update": (p): OverlayRule => {
      const rec = state.overlayRules.find((r) => r.id === String(p?.id ?? ""));
      if (!rec) throw new Error("No such overlay rule: " + String(p?.id ?? ""));
      if (p?.label !== undefined) rec.label = String(p.label);
      if (p?.disabled === true) rec.disabled = true;
      else delete rec.disabled;
      rec.updatedAt = Date.now();
      return rec;
    },
    "overlayRules:remove": (p): boolean => {
      const i = state.overlayRules.findIndex((r) => r.id === String(p?.id ?? ""));
      if (i < 0) return false;
      state.overlayRules.splice(i, 1);
      return true;
    },
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
          failingBrowsers: [],
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
          failingBrowsers: [],
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
          failingBrowsers: [],
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
     *  diff mode is exactly the bug a preview should make visible.
     *
     *  A current frame is STAMPED WITH ITS FILENAME. Every run frame used to
     *  render the same placeholder, which made a whole class of bug invisible
     *  here: a step showing another step's picture looks identical to one
     *  showing its own. That is precisely what a carried frame does on purpose,
     *  and the only way to see it is doing it correctly is to read the file
     *  name off the picture. */
    "artifacts:readShot": (p): string =>
      typeof p?.file === "string" && p.file.includes(".diff.")
        ? VISUAL_FRAMES.diff
        : visualFrame(typeof p?.file === "string" ? p.file : "?"),
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
    /** The Stats a11y dashboard's rollup.
     *
     *  Computed from the fixture replay with the REAL `rollupA11y`, not
     *  hand-written. A hand-written answer here would let the preview show a
     *  severity breakdown the shipped code could never produce — which is the
     *  one thing a preview must not do, since it is where the screen gets
     *  looked at. It also means accepting a violation in the Visual view
     *  changes this screen, exactly as it does in the app. */
    "a11y:rollup": () =>
      // ONE run, because the fixture has one replay. Mapping over the summaries
      // would hand the same replay in once per summary and double every count,
      // which is how this first rendered "2 serious" over a single finding.
      rollupA11y([
        {
          testId: REPLAY.testId,
          testName: REPLAY.testName,
          runId: REPLAY.runId,
          startedAt: REPLAY.startedAt,
          steps: REPLAY.steps,
        },
      ]),
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
    /** The Accessibility view's rule-wide accept. Same shape as the real op:
     *  only the rule's keys leave `newKeys`, other rules on the step stay
     *  flagged — which is exactly what the board has to demonstrate. */
    "a11y:acceptRule": (p): { tests: number; steps: number } => {
      const ruleId = String((p as { ruleId?: unknown })?.ruleId ?? "");
      let steps = 0;
      for (const step of REPLAY.steps) {
        if (!step.a11y) continue;
        const ruleKeys = new Set(
          step.a11y.violations
            .filter((v) => v.id === ruleId)
            .flatMap((v) => (v.nodes.length ? v.nodes.map((t) => `${v.id}|${t}`) : [`${v.id}|`])),
        );
        if (ruleKeys.size === 0) continue;
        const remaining = step.a11y.newKeys.filter((k) => !ruleKeys.has(k));
        if (remaining.length === step.a11y.newKeys.length) continue;
        steps++;
        step.a11y = {
          violations: step.a11y.violations,
          newKeys: remaining,
          acceptedCount: step.a11y.acceptedCount + (step.a11y.newKeys.length - remaining.length),
        };
      }
      return { tests: steps > 0 ? 1 : 0, steps };
    },
    "a11y:revokeRule": (p): { removed: number } => {
      const testId = String((p as { testId?: unknown })?.testId ?? "");
      const ruleId = String((p as { ruleId?: unknown })?.ruleId ?? "");
      const rec = state.tests.find((t) => t.id === testId);
      if (!rec?.a11yBaseline) return { removed: 0 };
      let removed = 0;
      const next: Record<string, string[]> = {};
      for (const [stepId, keys] of Object.entries(rec.a11yBaseline)) {
        const kept = keys.filter((k) => !k.startsWith(`${ruleId}|`));
        removed += keys.length - kept.length;
        if (kept.length > 0) next[stepId] = kept;
      }
      rec.a11yBaseline = Object.keys(next).length > 0 ? next : undefined;
      return { removed };
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
      // Merges the way the real store does: `roles` per key (a patch naming
      // one role keeps the other two; `null` clears one), and the chat slot
      // and the flat pair kept in step.
      const patch = (p ?? {}) as Partial<LlmConfig> & { roles?: Record<string, LlmRoleSlot | null> };
      const roles: Record<string, LlmRoleSlot> = { ...(state.llmConfig.roles ?? {}) };
      for (const [role, slot] of Object.entries(patch.roles ?? {})) {
        if (slot === null) delete roles[role];
        else if (slot && (role !== "autocomplete" || slot.provider !== "anthropic")) roles[role] = { provider: slot.provider, model: slot.model ?? null };
      }
      let provider = patch.provider ?? state.llmConfig.provider;
      let model = patch.model !== undefined ? patch.model : state.llmConfig.model;
      if (patch.roles?.chat && roles.chat) {
        provider = roles.chat.provider;
        model = roles.chat.model;
      } else if (patch.provider !== undefined || patch.model !== undefined) {
        roles.chat = { provider, model };
      }
      if (!roles.chat) roles.chat = { provider, model };
      state.llmConfig = {
        provider,
        model,
        baseUrls: { ...state.llmConfig.baseUrls, ...(patch.baseUrls ?? {}) },
        roles: roles as LlmConfig["roles"],
      };
      return state.llmConfig;
    },
    /** The instant slot's JSON answer. One canned shape per affordance the
     *  preview can reach: a statement the parser reads back. */
    "llm:json": async (): Promise<{ value: unknown; raw: string; provider: string; model: string }> => {
      await new Promise((r) => setTimeout(r, 500));
      const value = { statement: 'await page.getByRole("button", { name: "Next" }).click();' };
      return { value, raw: JSON.stringify(value), provider: "ollama", model: "preview-instant" };
    },
    /** Ghost text: a plausible next statement, after the pause a local model
     *  would take. */
    "llm:fim": async (p): Promise<{ text: string; provider: string; model: string }> => {
      await new Promise((r) => setTimeout(r, 350));
      const prefix = String(p?.prefix ?? "");
      const atLineStart = /\n\s*$/.test(prefix) || prefix === "";
      return {
        text: atLineStart ? '  await expect(page.getByRole("heading", { name: "Products" })).toBeVisible();' : "",
        provider: "ollama",
        model: "preview-fim",
      };
    },
    /** One status per provider — the AI pane renders a row for each. */
    "llm:detect": (): LlmProviderStatus[] => LLM_STATUS,
    /** …but `llm:status` asks about ONE, and is passed which. */
    "llm:status": (p): LlmProviderStatus =>
      LLM_STATUS.find((s) => s.provider === p?.provider) ?? LLM_STATUS[0],
    "llm:listModels": (): LlmModel[] => [],
    // The TypeScript service needs a main process; the preview says so and
    // the editor keeps its syntax and CLI diagnostics.
    "ts:status": () => ({ available: false, reason: "No backend in preview mode — type intelligence needs the app." }),
    "ts:ensure": () => ({ available: false, reason: "No backend in preview mode — type intelligence needs the app." }),
    "ts:update": () => undefined,
    "ts:close": () => undefined,
    "ts:diagnostics": () => [],
    "ts:completions": () => [],
    "ts:hover": () => null,
    "ts:inspections": () => [],
    "ts:format": () => [],
    "llm:hasApiKey": () => ({ hasKey: false }),
    "llm:hasLmStudioToken": () => ({ hasToken: false }),
    "llm:isActive": () => ({ active: false }),
    "alerts:status": () => ({ hasUrl: false, host: null }),

    // ── Proxy (Settings → Proxy) ─────────────────────────────────────────
    // Password presence is real state so Save/Remove round-trip in the
    // preview; the validators answer one success and one failure so BOTH
    // outcome renderings of the validate dialog can be looked at — a canned
    // pair of greens would leave the failure layout unreviewable.
    "proxy:hasPassword": () => ({ hasPassword: state.proxyHasPassword }),
    "proxy:setPassword": () => {
      state.proxyHasPassword = true;
      return { hasPassword: true };
    },
    "proxy:clearPassword": () => {
      state.proxyHasPassword = false;
      return { hasPassword: false };
    },
    "proxy:verifyApp": () => ({
      ok: true,
      url: "http://127.0.0.1:11434",
      via: "direct — loopback never proxies",
      detail: "Reached 127.0.0.1:11434 (HTTP 200, direct — loopback never proxies).",
    }),
    "proxy:verifyTest": (p) => {
      const url = typeof (p as { url?: unknown })?.url === "string" ? (p as { url: string }).url : "";
      if (!url) {
        return { ok: false, url, via: "—", detail: "Enter a full URL, like https://staging.example.com." };
      }
      return {
        ok: false,
        url,
        via: `proxy ${state.settings.proxyUrl || "http://192.168.0.10:8080"}`,
        detail:
          "ERR_TUNNEL_CONNECTION_FAILED — could not connect through the proxy. Check the proxy URL and port.",
      };
    },

    // Shopify crawler signatures. Three entries rather than none, because the
    // whole reason the row exists is that its states look different — and the
    // two that read as errors are the ones worth being able to look at. Expiry
    // is relative to now so the labels stay meaningful whenever this is opened.
    "shopify:list": () => {
      const day = 24 * 60 * 60;
      const nowS = Math.floor(Date.now() / 1000);
      return [
        {
          id: "sig-live",
          host: "northwind-supply.com",
          expiresAt: nowS + 47 * day,
          createdAt: nowS - 43 * day,
          addedAt: Date.now() - 43 * day * 1000,
          state: "valid",
        },
        {
          id: "sig-soon",
          host: "northwind-supply.myshopify.com",
          expiresAt: nowS + 5 * day,
          createdAt: nowS - 85 * day,
          addedAt: Date.now() - 85 * day * 1000,
          state: "expiring",
        },
        {
          id: "sig-gone",
          // Deliberately the host `t-checkout` navigates to, so the expired
          // chip on the test detail toolbar is reachable in a tab. A fixture
          // set whose hosts match nothing in the library would render the
          // settings row and leave the other half of the feature invisible.
          host: "shop.example.com",
          expiresAt: nowS - 9 * day,
          createdAt: nowS - 99 * day,
          addedAt: Date.now() - 99 * day * 1000,
          state: "expired",
        },
      ];
    },

    // The Documentation pane's one piece of live state. A preview has no
    // filesystem to check, so it answers with the shape a real INSTALL gives —
    // the packaged case, which is the one nearly every user is in now that
    // `build.files` ships `mcp/**`, and the one whose command is easiest to get
    // subtly wrong. The absent case is one line of prose.
    //
    // SINGLE QUOTES, matching `registerCommand`. The path contains `Good Looks!`
    // and a `!` inside double quotes is history expansion in interactive zsh and
    // bash — a preview showing the double-quoted form would be showing a command
    // that does not paste.
    "docs:mcpServer": () => ({
      path: "/Applications/Good Looks!.app/Contents/Resources/app/mcp/server.mjs",
      exists: true,
      command:
        "claude mcp add --scope user good-looks -e ELECTRON_RUN_AS_NODE=1 " +
        "-- '/Applications/Good Looks!.app/Contents/MacOS/Good Looks!' " +
        "'/Applications/Good Looks!.app/Contents/Resources/app/mcp/server.mjs'",
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
      // A report files its own stored content, so the fixture draft comes
      // from the insight fixtures rather than the canned defect strings.
      if (source.kind === "insight-report") {
        const report = state.insightReports.find((r) => r.id === source.reportId);
        if (!report) return null;
        return {
          source,
          title: `Weekly testing report — ${report.headline.slice(0, 60)}`,
          body: `**${report.headline}**\n\n${report.sections.map((s) => s.body).join("\n\n")}`,
          attachments: [],
          notices: [],
        };
      }
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
    "issues:a11yLinks": (): IssueLink[] => state.issues.links.filter((l) => l.kind === "a11y"),
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
    /** The history the Stats board's AI Debug category counts. Fixtures rather
     *  than `[]`, because an empty history renders the "never used" tile — and
     *  the whole dashboard behind it then has no way of being looked at. */
    "aiDebug:history": () => state.aiDebugHistory,
    "aiDebug:record": (p) => {
      // The preview has no store to write to, so this reflects the record back
      // and leaves the list alone: nothing here can start a real stream, so a
      // row appended by this path would be a row about nothing.
      return (p as { record?: unknown } | undefined)?.record ?? null;
    },
    "aiDebug:clear": () => ({ removed: 0, historyRemoved: 0 }),
    /** Fire-and-forget in the app; the backend gates on the setting itself.
     *  Answering `{ ok: true }` keeps the renderer's post-completion path on
     *  its normal branch instead of its error one. */
    "aiDebug:notifyDone": () => ({ ok: true }),
    "annotations:list": () => [],

    // ── AI insights ──────────────────────────────────────────────────────
    // Three canned reports — healthy, rough-with-actions (one action names a
    // deleted test, so the disabled button is drivable), and degraded prose.
    // Mutations edit the session copy, like routines: read-marking has to
    // actually clear the rail dot or the preview shows the feature broken.
    "insights:list": () =>
      state.insightReports.map((r) => ({
        id: r.id,
        cadence: r.cadence,
        generatedAt: r.generatedAt,
        headline: r.headline,
        read: r.read,
        ...(r.degraded ? { degraded: true } : {}),
      })),
    "insights:get": (p) =>
      state.insightReports.find((r) => r.id === (p as { id?: string } | undefined)?.id) ?? null,
    "insights:status": () => ({ ...state.insightsState, generating: false }),
    /** Nothing can complete an LLM call here, so the honest preview answer is
     *  a refusal the pane already knows how to word. */
    "insights:generateNow": () => ({ started: false, reason: "alreadyRunning" }),
    /** No native save dialog in a browser tab — answered as a cancel, which
     *  the view treats silently. */
    "insights:exportPdf": () => null,
    "insightsSlack:status": () => ({ hasUrl: false, host: null }),
    "insightsSlack:setUrl": () => ({ hasUrl: true, host: "hooks.slack.com" }),
    "insightsSlack:clearUrl": () => ({ hasUrl: false, host: null }),
    "insightsSlack:test": () => ({ ok: true }),
    "insights:markRead": (p) => {
      const report = state.insightReports.find(
        (r) => r.id === (p as { id?: string } | undefined)?.id,
      );
      if (!report || report.read) return { changed: false };
      report.read = true;
      return { changed: true };
    },
    "insights:delete": (p) => {
      const id = (p as { id?: string } | undefined)?.id;
      const before = state.insightReports.length;
      state.insightReports = state.insightReports.filter((r) => r.id !== id);
      return { removed: state.insightReports.length !== before };
    },
    "insights:clearAll": () => {
      const removed = state.insightReports.length;
      state.insightReports = [];
      return { removed };
    },

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
    // AI-proposed steps, "verified" against a page that does not exist here.
    // A stated outcome — the first works, the second does not, the rest were
    // never attempted — so the generate-steps dialog's activity log, which only
    // appears on a failure, can be SEEN in the preview. Nothing is inserted.
    "recorder:verifySteps": (p) => {
      const steps = Array.isArray(p?.steps) ? (p.steps as { type?: string }[]) : [];
      const name = (s: { type?: string } | undefined) => s?.type ?? "step";
      if (steps.length === 0) return { inserted: 0, results: [] };
      if (steps.length === 1) return { inserted: 1, results: [{ label: name(steps[0]), status: "ran" }] };
      return {
        inserted: 1,
        results: [
          { label: name(steps[0]), status: "ran" },
          {
            label: name(steps[1]),
            status: "failed",
            detail: "No element matches — the preview has no page to try it on.",
          },
        ],
      };
    },
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
    // Variables declared during the previewed session. Held in the bridge for
    // the same reason the real ones are held on the session: the preview's
    // recording has no saved record behind it either, so a created variable
    // has nowhere else to live — and without this the composer's create form
    // could not be exercised in a tab at all.
    "recorder:addVariable": (p: Payload) => {
      const name = String(p?.name ?? "");
      const kind = (p?.kind as TestVariable["kind"]) ?? "plain";
      if (previewVariables.some((v) => v.name === name)) {
        throw new Error(`This test already declares “${name}”.`);
      }
      previewVariables.push({
        name,
        kind,
        ...(kind === "secret" || kind === "generated" ? {} : { value: String(p?.value ?? "") }),
        ...(kind === "generated"
          ? { genSpec: (p?.genSpec ?? "string") as TestVariable["genSpec"], value: "sample-9wq3k" }
          : {}),
      });
      return recorderState();
    },
    /** No native picker in a browser tab — the stage is CANNED, the same
     *  rule as the CSV import fake, so the composer's staged-file row and
     *  the emitted step can be seen at all in preview. */
    "recorder:stageUpload": () => ({
      relPath: "uploads/t-preview/fixture.csv",
      name: "fixture.csv",
    }),
    "recorder:getState": (): RecorderState => recorderState(),
    // Inline flow editing, over the fixtures: entering opens the sign-in
    // flow's steps as the working copy; edits are not simulated (there is no
    // capture here), but the banner, the gaps and Done are all drivable.
    "recorder:enterFlowScope": (p: Payload) => {
      const call = TESTS[0].steps.find((st) => st.id === p?.stepId);
      const flow = call?.flowId ? findTest(call.flowId) : null;
      if (!call || !flow) throw new Error("That step is not a flow call.");
      previewFlowScope = {
        flowId: flow.id,
        callStepId: call.id,
        name: flow.name,
        steps: structuredClone(flow.steps),
        cursor: flow.steps.length,
      };
      pendingFlowScopePush = true;
      return recorderState();
    },
    "recorder:exitFlowScope": () => {
      const scope = previewFlowScope;
      previewFlowScope = null;
      pendingFlowScopePush = true;
      return scope
        ? {
            committed: true,
            flowId: scope.flowId,
            name: scope.name,
            callers: 1,
            conflict: false,
            orphaned: false,
          }
        : null;
    },
    "recorder:setFlowCursor": (p: Payload) => {
      if (previewFlowScope) {
        const n = previewFlowScope.steps.length;
        previewFlowScope.cursor = Math.max(0, Math.min(n, Number(p?.index) || 0));
        pendingFlowScopePush = true;
      }
      return recorderState();
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
/** Pending ticks of each scripted run, so `runner:stop` can cancel them. The
 *  real Stop is a SIGKILL: the reporter dies with the step it opened still
 *  open, and no `end` for it ever arrives. The preview has to leave that step
 *  open too, or the one state Stop produces — a run that finished on a step
 *  nothing closed — is unreachable in a tab. */
const pendingRunTicks = new Map<string, ReturnType<typeof setTimeout>[]>();

function startFakeRun(
  payload: Payload,
  state: ReturnType<typeof seed>,
  emit: (channel: string, value: unknown) => void,
  tickMs: number,
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

  let at = 0;
  const ticks: ReturnType<typeof setTimeout>[] = [];
  pendingRunTicks.set(runId, ticks);
  const later = (fn: () => void) => {
    at += tickMs;
    ticks.push(setTimeout(fn, at));
  };

  emit("runner:output", { runId, chunk: `Running ${steps.length} steps…\n` });
  for (let i = 0; i < steps.length; i++) {
    const index = i;
    // `line` mirrors the fixture's own getScript: the goto sits on line 4 and
    // every later step is imagined one line further down.
    later(() => emit("runner:step", { runId, index, status: "begin", ok: true, line: 4 + index }));
    later(() => {
      const ok = index !== failAt;
      emit("runner:step", { runId, index, status: "end", ok, line: 4 + index });
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
  later(() => {
    pendingRunTicks.delete(runId);
    emit("runner:done", {
      runId,
      code: failAt === -1 ? 0 : 1,
      recordId: stored?.id,
    });
  });
  // The real runner persists the record and then broadcasts `runs:changed`,
  // which is what refreshes the six run-derived caches (see
  // `renderer/lib/run-derived-cache.ts`). Omitting it here made the preview
  // quietly unable to show a whole class of bug: the Stats board's tiles going
  // stale after a run reproduced in the app and NEVER in `dev:web`, because
  // nothing in a tab could make the event happen.
  later(() => emit("runs:changed", {}));
  return { runId };
}

/** Stop a scripted run where it stands. Cancels every tick still pending and
 *  reports the run done with a non-zero code — and deliberately NO `end` for
 *  the step that was in flight, which is what the real runner's SIGKILL
 *  leaves behind. A preview that tidily closed the step first would be unable
 *  to show the bug Stop used to cause: a finished run whose last step kept
 *  its spinner. Nothing to stop is a no-op, as `runner:stop` is in the app. */
function stopFakeRun(
  payload: Payload,
  emit: (channel: string, value: unknown) => void,
): void {
  const runId = String(payload?.runId ?? "");
  const ticks = pendingRunTicks.get(runId);
  if (!ticks) return;
  pendingRunTicks.delete(runId);
  for (const t of ticks) clearTimeout(t);
  emit("runner:output", { runId, chunk: "\nStopped by user.\n" });
  emit("runner:done", { runId, code: -1 });
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
function startFakeChat(
  emit: (channel: string, value: unknown) => void,
  params?: Payload,
): { requestId: string } {
  const requestId = "preview-llm-1";
  const reply = isGenerateStepsRequest(params) ? GENERATED_STEPS_REPLY : DEBUG_REPLY;
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

/** The generate-steps dialog's request, told apart by its system prompt — the
 *  one that asks for the recorder's own step model as JSON. Matched on the
 *  opening clause rather than imported, because the prompt is not exported
 *  and the preview must not become a reason to export it. */
function isGenerateStepsRequest(params?: Payload): boolean {
  const messages = Array.isArray(params?.messages) ? (params.messages as { role?: string; content?: string }[]) : [];
  return messages.some(
    (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("Turn a natural-language description into an ordered list of test STEPS"),
  );
}

/** What the generate-steps dialog receives: three steps, as the prompt asks
 *  for them. Paired with the bridge's `recorder:verifySteps` answer — the first
 *  works, the second does not — so "Try 3 steps" shows the activity log. */
const GENERATED_STEPS_REPLY =
  "Here are the steps:\n\n```json\n" +
  JSON.stringify(
    [
      { type: "click", locator: { k: "role", role: "button", name: "Add to cart" } },
      { type: "click", locator: { k: "role", role: "link", name: "Checkout" } },
      { type: "assert", assert: "visible", locator: { k: "text", v: "Order total" } },
    ],
    null,
    2,
  ) +
  "\n```\n";

const DEBUG_REPLY =
    "The click failed because getByRole(\"button\", { name: \"Pause\" }) matched 10 " +
    "elements, so Playwright refused to guess which one you meant. I can see that " +
    "it is ambiguous, but not which of the ten is the video player's pause " +
    "button.\n\n```glaze-request\n" +
    '{"need": ["structure"], "why": "to see which elements matched and pick the right one"}' +
    "\n```";

export interface PreviewBridgeOptions {
  /** Pace of the scripted run, in ms per event — two per step, one for done.
   *  260 by default, and the default is presentation: steps going cyan one at
   *  a time is the whole reason the run is scripted rather than instant. It is
   *  injectable because that same pacing makes a run's wall-clock a function
   *  of the fixture's STEP COUNT — so a test awaiting `runner:done` at the
   *  preview's pace inherits every step the fixture grows as real seconds
   *  against its own timeout. Those tests pass 1: same script, same events,
   *  same order (the delays still strictly increase), just not paced for
   *  human eyes. See "the scripted run" in preview-bridge.test.ts. */
  runTickMs?: number;
}

export function installPreviewBridge(options: PreviewBridgeOptions = {}): PreviewDiagnostics {
  const { runTickMs = 260 } = options;
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
  bridgeEmit = emit;

  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    diagnostics.calls.push(channel);
    if (channel === "runner:run") return startFakeRun(args[0] as Payload, state, emit, runTickMs);
    if (channel === "runner:stop") return stopFakeRun(args[0] as Payload, emit);
    if (channel === "llm:chat") return startFakeChat(emit, args[0] as Payload);
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
    if (handler) {
      const reply = handler(args[0] as Payload);
      if (pendingFlowScopePush) {
        pendingFlowScopePush = false;
        setTimeout(() => {
          emit("recorder:flowScope", previewFlowScope ? structuredClone(previewFlowScope) : null);
          emit("recorder:state", recorderState());
        }, 0);
      }
      return reply;
    }

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
