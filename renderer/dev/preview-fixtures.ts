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
  HealListEntry,
  RecorderSettings,
  RunRecord,
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
