// Seed data for the browser preview.
//
// Deliberately not empty. A preview whose library has no tests exercises every
// empty state and nothing else — which is the one part of the UI least likely
// to be what a change touched. These fixtures exist to put the interesting
// states on screen without anyone having to record anything first: a passing
// test, a failing one, one whose steps have diverged from its script, a hidden
// one, tags, and a heal waiting to be accepted.
//
// EVERY export is annotated with the app's own type. That is not tidiness — it
// is the only mechanism that catches a fixture answering the right channel with
// the wrong shape, which crashes a view exactly as hard as no answer at all and
// is far less obvious in review. Several of these shapes were wrong when this
// file was first written against an older copy of the app.

import type {
  BatchRecord,
  BatchTestResult,
  HealListEntry,
  RecorderSettings,
  RunRecord,
  RunReplay,
  RunReplaySummary,
  Step,
  TestRecord,
} from "../lib/recorder-types";
import type { LlmConfig, LlmProviderStatus } from "../lib/llm-types";

/** Fixed clock. `Date.now()` here would make "2 minutes ago" drift between the
 *  screenshot in a pull request and the page a reviewer opens an hour later,
 *  and would make any snapshot of this data unstable. */
export const NOW = Date.UTC(2026, 7, 7, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Fills in the two fields every step carries but no fixture wants to repeat.
 *  Typed against the real `Step`, so a field renamed in recorder-types.ts
 *  fails `type-check` here rather than rendering a subtly wrong preview. */
function steps(
  ...items: Array<Omit<Partial<Step>, "id" | "timestamp"> & { type: Step["type"] }>
): Step[] {
  return items.map((item, i) => ({
    id: `s${i + 1}`,
    timestamp: NOW - (items.length - i) * 1000,
    ...item,
  }));
}

export const TESTS: TestRecord[] = [
  {
    id: "t-checkout",
    name: "Checkout — happy path",
    url: "https://shop.example.com",
    createdAt: NOW - 9 * DAY,
    updatedAt: NOW - 2 * HOUR,
    scriptPath: "/preview/scripts/checkout.spec.ts",
    tags: ["smoke", "checkout"],
    runBrowser: "chromium",
    captureArtifacts: true,
    a11yChecks: true,
    steps: steps(
      { type: "goto", url: "https://shop.example.com" },
      { type: "click", locator: { k: "role", role: "button", name: "Add to cart" } },
      { type: "click", locator: { k: "role", role: "link", name: "Cart" } },
      { type: "fill", locator: { k: "label", v: "Email" }, value: "buyer@example.com" },
      { type: "click", locator: { k: "role", role: "button", name: "Place order" } },
      {
        type: "assert",
        assert: "text",
        locator: { k: "testid", v: "confirmation" },
        value: "Thank you",
      },
    ),
  },
  {
    id: "t-login",
    name: "Login — wrong password shows an error",
    url: "https://app.example.com/login",
    createdAt: NOW - 6 * DAY,
    updatedAt: NOW - 30 * MINUTE,
    scriptPath: "/preview/scripts/login.spec.ts",
    tags: ["smoke", "auth"],
    runBrowser: "webkit",
    steps: steps(
      { type: "goto", url: "https://app.example.com/login" },
      { type: "fill", locator: { k: "label", v: "Email" }, value: "nobody@example.com" },
      { type: "fill", locator: { k: "label", v: "Password" }, value: "hunter2" },
      { type: "click", locator: { k: "role", role: "button", name: "Sign in" } },
      { type: "assert", assert: "visible", locator: { k: "testid", v: "login-error" } },
    ),
  },
  {
    id: "t-search",
    name: "Search returns results",
    url: "https://docs.example.com",
    createdAt: NOW - 3 * DAY,
    updatedAt: NOW - 3 * DAY,
    scriptPath: "/preview/scripts/search.spec.ts",
    tags: ["search"],
    runBrowser: "firefox",
    // Steps and script disagree — one of the more visually distinctive states,
    // and easy to forget when restyling the detail view.
    stepsDiverged: true,
    stepsDivergedReason: "unapplied",
    steps: steps(
      { type: "goto", url: "https://docs.example.com" },
      { type: "fill", locator: { k: "role", role: "searchbox" }, value: "locator" },
      { type: "press", value: "Enter" },
    ),
  },
  {
    id: "t-archived",
    name: "Legacy signup flow",
    url: "https://old.example.com/signup",
    createdAt: NOW - 40 * DAY,
    updatedAt: NOW - 30 * DAY,
    scriptPath: "/preview/scripts/legacy-signup.spec.ts",
    hidden: true,
    steps: steps({ type: "goto", url: "https://old.example.com/signup" }),
  },
];

export const RUNS: RunRecord[] = [
  {
    id: "r-1",
    testId: "t-checkout",
    testName: "Checkout — happy path",
    url: "https://shop.example.com",
    status: "passed",
    exitCode: 0,
    startedAt: NOW - 2 * HOUR,
    finishedAt: NOW - 2 * HOUR + 12_400,
    durationMs: 12_400,
    logFile: "/preview/runs/r-1.log",
    logBytes: 4_812,
    runBrowser: "chromium",
    speed: "medium",
    captureArtifacts: true,
    shotCount: 6,
    captureOverheadMs: 840,
    a11yMs: 210,
    a11yChecks: 6,
  },
  {
    id: "r-2",
    testId: "t-login",
    testName: "Login — wrong password shows an error",
    url: "https://app.example.com/login",
    status: "failed",
    exitCode: 1,
    startedAt: NOW - 30 * MINUTE,
    finishedAt: NOW - 30 * MINUTE + 8_100,
    durationMs: 8_100,
    logFile: "/preview/runs/r-2.log",
    logBytes: 9_233,
    runBrowser: "webkit",
    speed: "slow",
    healedSteps: 1,
  },
  {
    id: "r-3",
    testId: "t-checkout",
    testName: "Checkout — happy path",
    url: "https://shop.example.com",
    status: "passed",
    exitCode: 0,
    startedAt: NOW - 26 * HOUR,
    finishedAt: NOW - 26 * HOUR + 11_900,
    durationMs: 11_900,
    logFile: "/preview/runs/r-3.log",
    logBytes: 4_610,
    runBrowser: "chromium",
    speed: "medium",
  },
  // One batch of the same test across the three browsers, with webkit failing.
  // Here so the sidebar's blended verdict dot has something to draw in the
  // preview: pass/fail fixtures alone only ever produce plain green and plain
  // red, which is exactly the state the five-way scale was added to break out
  // of, and the preview is the only place any of it can be SEEN.
  ...(["chromium", "firefox", "webkit"] as const).map((browser, i) => ({
    id: `r-4-${browser}`,
    testId: "t-search",
    testName: "Search returns results",
    url: "https://docs.example.com",
    status: browser === "webkit" ? ("failed" as const) : ("passed" as const),
    exitCode: browser === "webkit" ? 1 : 0,
    startedAt: NOW - 3 * HOUR + i * 1_000,
    finishedAt: NOW - 3 * HOUR + i * 1_000 + 9_000,
    durationMs: 9_000,
    logFile: `/preview/runs/r-4-${browser}.log`,
    logBytes: 3_120,
    runBrowser: browser,
    speed: "medium" as const,
    batchId: "b-1",
  })),
];

/**
 * The captured run the Visual screen replays, and its summary row.
 *
 * `t-checkout` / `r-1`, which is the fixture that already declares
 * `captureArtifacts: true` and `shotCount: 6` — so the run list, the Stats
 * capture-overhead panel and this agree with each other rather than describing
 * three different worlds.
 *
 * ONE STEP OF EACH DIFF STATE, because the states are what the screen is for:
 * a match, a `changed` with a ratio over threshold, a `new-baseline` (nothing to
 * compare against yet), an `unable` (the comparison could not run), and one
 * uncaptured step with no screenshot at all. A fixture where everything matches
 * exercises exactly one branch of the viewer.
 */
export const REPLAY: RunReplay = {
  testId: "t-checkout",
  runId: "r-1",
  testName: "Checkout — happy path",
  url: "https://shop.example.com",
  status: "passed",
  startedAt: NOW - 2 * HOUR,
  finishedAt: NOW - 2 * HOUR + 12_400,
  failedIndex: null,
  visualThreshold: 0.2,
  steps: [
    {
      index: 0,
      stepId: "s1",
      label: "goto shop.example.com",
      type: "goto",
      status: "passed",
      screenshot: "0.png",
      diff: { state: "match", ratio: 0.0004, threshold: 0.2 },
    },
    {
      index: 1,
      stepId: "s2",
      label: "click Add to cart",
      type: "click",
      status: "passed",
      screenshot: "1.png",
      rect: { x: 0.06, y: 0.5, w: 0.27, h: 0.07 },
      diff: {
        state: "changed",
        ratio: 0.0413,
        threshold: 0.2,
        diffFile: "1.diff.png",
        maskedCount: 1,
      },
    },
    {
      index: 2,
      stepId: "s3",
      label: "click Cart",
      type: "click",
      status: "passed",
      screenshot: "2.png",
      diff: { state: "new-baseline" },
      // The only accessibility finding in the fixture, and it is here so the
      // a11y banner has an address: it is a SEPARATE callout from the visual
      // one with its own accept and its own dismiss, and with no step reporting
      // violations the preview rendered neither of them.
      a11y: {
        violations: [
          {
            id: "color-contrast",
            impact: "serious",
            help: "Elements must meet minimum colour contrast ratio thresholds",
            nodes: [".cart-subtotal", ".promo-code-hint"],
          },
        ],
        newKeys: ["color-contrast|.cart-subtotal", "color-contrast|.promo-code-hint"],
        acceptedCount: 0,
      },
    },
    {
      index: 3,
      stepId: "s4",
      label: "fill Email",
      type: "fill",
      status: "passed",
      screenshot: "3.png",
      diff: { state: "unable", reason: "The frames are different sizes — the viewport changed." },
    },
    {
      index: 4,
      stepId: "s5",
      label: "click Place order",
      type: "click",
      status: "passed",
      screenshot: null,
    },
  ],
};

export const REPLAY_SUMMARIES: RunReplaySummary[] = [
  {
    testId: REPLAY.testId,
    runId: REPLAY.runId,
    testName: REPLAY.testName,
    status: REPLAY.status,
    startedAt: REPLAY.startedAt,
    finishedAt: REPLAY.finishedAt,
    stepCount: REPLAY.steps.length,
    failedIndex: REPLAY.failedIndex,
    changedSteps: REPLAY.steps.filter((s) => s.diff?.state === "changed").length,
    // Derived, not hard-coded: the summary marker and the banner are two
    // readings of the same fact, and a fixture where they disagree teaches the
    // preview to lie about exactly the thing this screen reports.
    a11yNewSteps: REPLAY.steps.filter((s) => (s.a11y?.newKeys.length ?? 0) > 0).length,
  },
];

export const RUN_LOG = [
  "Running 1 test using 1 worker",
  "",
  "  ✘  1 login.spec.ts:3:1 › Login — wrong password shows an error (8.1s)",
  "",
  "    Error: expect(locator).toBeVisible() failed",
  "",
  "    Locator: getByTestId('login-error')",
  "    Expected: visible",
  "    Received: <element(s) not found>",
  "    Timeout:  5000ms",
  "",
  "  1 failed",
].join("\n");

/** Typed as `HealListEntry[]` — the superset — so one array serves both
 *  `heals:list` (`HealEntry[]`) and `heals:listAll` (`HealListEntry[]`).
 *  `status: "pending"` is the state the Heals view exists to resolve, so it is
 *  the one worth having on screen. */
export const HEALS: HealListEntry[] = [
  {
    id: "h-1",
    testId: "t-login",
    testName: "Login — wrong password shows an error",
    stepId: "s4",
    stepIndex: 3,
    stepLabel: 'click "Sign in"',
    source: "run",
    runId: "r-2",
    at: NOW - 30 * MINUTE,
    originalLocator: { k: "testid", v: "signin" },
    appliedLocator: { k: "role", role: "button", name: "Sign in" },
    candidates: [
      {
        locator: { k: "role", role: "button", name: "Sign in" },
        description: 'role=button, name "Sign in"',
        score: 0.91,
        matchedPastRun: true,
      },
      {
        locator: { k: "css", v: "form#login button[type=submit]" },
        description: "the form's only submit button",
        score: 0.64,
        matchedPastRun: false,
      },
    ],
    // Recorded but NOT written to the test: the default heal mode is "suggest",
    // and a preview that showed heals landing silently would misrepresent it.
    applied: false,
    status: "pending",
  },
];

/** The full settings record, because `RecorderSettings` has no optional fields
 *  and the panes read straight off it. Values are the app's own defaults except
 *  where a non-default makes a pane more interesting to look at. */
/**
 * A captured run, for the Visual screen.
 *
 * WITHOUT THIS, VISUAL ONLY EVER SHOWS ITS EMPTY STATE. It is the largest file
 * in the renderer and the one screen entirely about looking at pictures, and
 * every capability it has — frame selection, current/baseline/diff, masks, the
 * threshold slider — is behind having a run with artifacts. `artifacts:list`
 * returning `[]` is honest for a preview that cannot run Playwright, and it also
 * made the screen unreviewable.
 *
 * THE FRAMES ARE GENERATED SVG DATA URIs, not real screenshots. Three reasons:
 * a real PNG would be a binary blob in a source file that nobody can diff; a
 * remote image would be an egress path this repo bans outright
 * (`check:renderer-egress`); and what the screen is being judged on is the
 * CHROME around the frame — the bezel, the rail, the mode switch — for which a
 * legible placeholder that says what it is beats a photograph of someone's
 * checkout page. Each frame states its own identity, so a mode switch that
 * silently shows the wrong one is visible rather than plausible.
 */
function frame(label: string, bg: string, accent: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600">
    <rect width="960" height="600" fill="${bg}"/>
    <rect x="0" y="0" width="960" height="64" fill="${accent}" opacity="0.18"/>
    <rect x="24" y="20" width="180" height="24" rx="3" fill="${accent}" opacity="0.5"/>
    <rect x="24" y="112" width="420" height="34" rx="3" fill="#ffffff" opacity="0.13"/>
    <rect x="24" y="168" width="640" height="14" rx="3" fill="#ffffff" opacity="0.08"/>
    <rect x="24" y="196" width="560" height="14" rx="3" fill="#ffffff" opacity="0.08"/>
    <rect x="24" y="224" width="600" height="14" rx="3" fill="#ffffff" opacity="0.08"/>
    <rect x="24" y="300" width="260" height="44" rx="4" fill="${accent}" opacity="0.55"/>
    <text x="24" y="560" font-family="monospace" font-size="26" fill="${accent}">${label}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** The three frames one step can be shown as. Deliberately DIFFERENT from each
 *  other — a preview where current and baseline look identical cannot show that
 *  the compare-mode switch works. */
export const VISUAL_FRAMES = {
  current: frame("CURRENT", "#0f1113", "#35e0ff"),
  baseline: frame("BASELINE", "#0f1113", "#6bff9e"),
  diff: frame("DIFF", "#140f11", "#ff4d61"),
};

export const SETTINGS: RecorderSettings = {
  showUrlBar: true,
  trainerPanelEnabled: false,
  defaultRunSpeed: "medium",
  defaultWindowSize: { width: 1280, height: 800 },
  autoHealEnabled: true,
  autoHealRetries: 3,
  autoHealAttemptTimeoutMs: 4_000,
  autoHealApply: "suggest",
  defaultA11yChecks: false,
  debugScreenshots: false,
  defaultCaptureArtifacts: true,
  defaultRecordLogs: true,
  recordAllHeaders: false,
  siteIconsFromWeb: false,
  keepRunningAiDebugJobs: false,
  defaultRunHeadless: false,
  defaultRunBrowser: "chromium",
  defaultTestTimeoutMs: 60_000,
  alertWebhookEnabled: false,
  batchOrder: [],
  batchTestOptions: {},
  defaultBatchConcurrency: 2,
  artifactRetainedRuns: 10,
  artifactRetentionDays: 30,
  notifyOnRunIssues: false,
  notifyOnBatchDone: true,
  notifyOnAiDebugDone: false,
  autoAcceptAiDebugFixes: false,
  disabledAestheticEnhancements: [],
  // Both at their defaults. `uiScale` does nothing in the preview — there is no
  // main process to zoom a webContents — but it has to be present and valid or
  // the Appearance pane renders its size control with no segment selected.
  uiScale: 1,
  uiTypeface: "space",
};

export const LLM_CONFIG: LlmConfig = {
  provider: "ollama",
  model: "qwen2.5-coder:7b",
  baseUrls: { ollama: "http://127.0.0.1:11434" },
};

/** `llm:detect` answers with one status PER PROVIDER, not one overall — the
 *  AI pane renders a row for each.
 *
 *  The preview has no backend, so none is reachable. Saying so plainly is
 *  better than pretending one is up: the pane's offline state is real UI that
 *  deserves to be visible here. */
export const LLM_STATUS: LlmProviderStatus[] = [
  {
    provider: "ollama",
    reachable: false,
    models: [],
    baseUrl: "http://127.0.0.1:11434",
    error: "No backend in preview mode — this is a UI preview, not a running app.",
  },
  {
    provider: "lmstudio",
    reachable: false,
    models: [],
    baseUrl: "http://127.0.0.1:1234",
    error: "No backend in preview mode — this is a UI preview, not a running app.",
  },
  {
    provider: "anthropic",
    reachable: false,
    models: [],
    baseUrl: "https://api.anthropic.com",
    hasKey: false,
    error: "No backend in preview mode — this is a UI preview, not a running app.",
  },
];

/** Past batches, one per verdict.
 *
 *  FOUR RECORDS BECAUSE THERE ARE FOUR VERDICTS, and three of them are only
 *  distinguishable by colour. A batch that finished with some passes and some
 *  failures is amber; one where NOTHING passed is red; a clean one is
 *  phosphor; a stopped one is untinted, because it never produced a verdict at
 *  all. `batch:list` used to answer `[]`, which meant the Previous batches
 *  panel — and the finished-batch panel above it — could not be seen in the
 *  preview at all, and those are precisely the surfaces where the tone is the
 *  whole signal.
 *
 *  The counts are deliberately awkward on the mixed record (2 failed, 1
 *  passed): that is the case where an all-red reading is most tempting and
 *  most wrong. */
const batchResults = (
  outcomes: Array<[testId: string, testName: string, status: BatchTestResult["status"]]>,
): BatchTestResult[] =>
  outcomes.map(([testId, testName, status]) => ({
    testId,
    testName,
    status,
    browser: "chromium",
    startedAt: NOW - 10 * MINUTE,
    finishedAt: NOW - 9 * MINUTE,
    durationMs: 41_000,
    ...(status === "failed" ? { exitCode: 1 } : null),
  }));

export const BATCHES: BatchRecord[] = [
  {
    batchId: "b-mixed",
    running: false,
    startedAt: NOW - 2 * HOUR,
    finishedAt: NOW - 2 * HOUR + 3 * MINUTE,
    currentIndex: -1,
    stopped: false,
    results: batchResults([
      ["t-checkout", "Checkout — happy path", "failed"],
      ["t-login", "Login — wrong password shows an error", "failed"],
      ["t-search", "Search returns results", "passed"],
    ]),
    summary: { total: 3, passed: 1, failed: 2, skipped: 0, ok: false, durationMs: 182_000 },
  },
  {
    batchId: "b-total",
    running: false,
    startedAt: NOW - 5 * HOUR,
    finishedAt: NOW - 5 * HOUR + 1 * MINUTE,
    currentIndex: -1,
    stopped: false,
    results: batchResults([
      ["t-checkout", "Checkout — happy path", "failed"],
      ["t-login", "Login — wrong password shows an error", "failed"],
      ["t-search", "Search returns results", "failed"],
    ]),
    summary: { total: 3, passed: 0, failed: 3, skipped: 0, ok: false, durationMs: 61_000 },
  },
  {
    batchId: "b-clean",
    running: false,
    startedAt: NOW - 1 * DAY,
    finishedAt: NOW - 1 * DAY + 4 * MINUTE,
    currentIndex: -1,
    stopped: false,
    results: batchResults([
      ["t-checkout", "Checkout — happy path", "passed"],
      ["t-login", "Login — wrong password shows an error", "passed"],
      ["t-search", "Search returns results", "passed"],
    ]),
    summary: { total: 3, passed: 3, failed: 0, skipped: 0, ok: true, durationMs: 240_000 },
  },
  {
    batchId: "b-stopped",
    running: false,
    startedAt: NOW - 2 * DAY,
    finishedAt: NOW - 2 * DAY + 1 * MINUTE,
    currentIndex: -1,
    stopped: true,
    results: batchResults([
      ["t-checkout", "Checkout — happy path", "failed"],
      ["t-login", "Login — wrong password shows an error", "passed"],
      ["t-search", "Search returns results", "pending"],
    ]),
    summary: { total: 3, passed: 1, failed: 1, skipped: 0, ok: false, durationMs: 52_000 },
  },
];
