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
  AiDebugHistoryRecord,
  BatchRecord,
  Routine,
  BatchTestResult,
  HealListEntry,
  InsightReport,
  InsightsState,
  PickedElement,
  ScriptChangeListEntry,
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
    group: "Storefront",
    runBrowser: "chromium",
    captureArtifacts: true,
    a11yChecks: true,
    // A seeded acceptance, so the Accessibility view's Baseline tab has a test
    // to list and a rule to revoke without running anything first.
    a11yBaseline: {
      s2: ["image-alt|.hero-banner img", "link-name|.footer-social a"],
      s3: ["image-alt|.product-thumb img"],
    },
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
        // `text`, not `value`. A text assertion reads `step.text`, so the
        // fixture rendered `toContainText("")` in the preview's step list —
        // the empty-expectation shape the generator now refuses outright.
        text: "Thank you",
      },
      // The page-level kinds, so the preview shows what they COMPILE TO. They
      // are the assertions this app got wrong for longest, and the step list is
      // where a user would have had to notice: "URL contains" rendered as
      // `toHaveURL("/order/confirmed")` — an exact whole-URL match, which is
      // not what the label says and could never pass.
      { type: "assert", assert: "url", value: "/order/confirmed" },
      // The robust default: path-only, so the step list shows the structural
      // pattern (`^scheme://host` + path + `/?(?:[?#]|$)`) a run executes.
      { type: "assert", assert: "urlPathIs", value: "/order/confirmed" },
      { type: "assert", assert: "titleContains", value: "Order" },
      // LAST, so the s1–s8 ids above keep meaning what the visual baselines,
      // drift ratios and the s4 heal say they mean. A parameterized flow call:
      // the recorder preview serves THIS test's steps as its live session, so
      // this is what renders the `name=value` runFlow row and the kebab's
      // "Edit Flow Arguments…" dialog.
      {
        type: "runFlow",
        flowId: "t-login",
        label: "Login — wrong password shows an error",
        flowArgs: { email: "buyer@example.com" },
        // Repeated, so the call-site loop's ×N suffix — and its Repeat
        // controls in the args dialog — are visible in the preview.
        repeat: 2,
      },
      // Both scroll forms, LAST for the same id-stability reason. The position
      // form is the one the capture script auto-records; its row is also the
      // only inline-editable scroll (the element form edits via Refine), so
      // this is where that field can be SEEN.
      { type: "scroll", scrollX: 0, scrollY: 1240 },
      { type: "scroll", locator: { k: "testid", v: "reviews" } },
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
    group: "Storefront",
    runBrowser: "webkit",
    // The preview's one reusable flow: what the Variables tab's "Reusable
    // flow" section, the composer's argument fields, and the rail glyph render
    // against. The email fill references the parameter the way a real flow
    // would, so the argument form's default placeholder shows a true value.
    isFlow: true,
    flowParams: ["email"],
    variables: [{ name: "email", kind: "plain", value: "nobody@example.com" }],
    steps: steps(
      { type: "goto", url: "https://app.example.com/login" },
      { type: "fill", locator: { k: "label", v: "Email" }, value: "${email}" },
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
      // A repeat block early in the LONG fixture: renders the "repeat"/"end
      // repeat" chips, the inline count edit, and the body's indent.
      // A named group wrapping the repeat — renders the section chip, the
      // label, and the nested indent.
      { type: "group", label: "Search three ways" },
      { type: "loop", loopCount: 3 },
      { type: "fill", locator: { k: "role", role: "searchbox" }, value: "locator" },
      { type: "press", value: "Enter" },
      { type: "endLoop" },
      { type: "endGroup" },
      // An elsed conditional — renders the "else" chip at its if's depth with
      // both bodies indented one deeper.
      { type: "if", cond: "visible", locator: { k: "testid", v: "no-results" } },
      { type: "click", locator: { k: "role", role: "button", name: "Clear filters" } },
      { type: "else" },
      { type: "click", locator: { k: "role", role: "link", name: "First result" } },
      { type: "endif" },
      // A download expectation right after its trigger — renders the
      // "download" chip and the worded description with its capture note.
      { type: "click", locator: { k: "role", role: "button", name: "Export results" } },
      { type: "download", value: "results.csv", captureVar: "exportName" },
      // An AI visual check — renders the "ai check" chip and the quoted claim.
      { type: "aiCheck", text: "the first result links to the locator guide" },
      // A dialog-arming step — renders the "dialog" chip and the worded answer.
      { type: "dialog", dialogAction: "accept", value: "saved-search" },
      // An accessibility gate — renders the "a11y" chip and the worded floor.
      { type: "a11y", a11yImpact: "serious" },
      // An upload against a staged fixture — renders the chip and the worded
      // filename.
      {
        type: "upload",
        locator: { k: "label", v: "Import a saved search" },
        value: "uploads/t-search/saved-search.json",
      },
      // An API request — renders the "api" chip and the worded method/status.
      {
        type: "api",
        apiMethod: "POST",
        url: "https://api.example.com/search-index",
        expectStatus: 202,
        captureVar: "indexJobId",
        capturePath: "job.id",
      },
      // A positional-path locator — the recorder's last-resort shape — so the
      // fragility glyph and the detail view's rollup callout render.
      { type: "click", locator: { k: "xpath", v: "/html[1]/body[1]/div[3]/button[2]" } },
      // The three input-fidelity shapes, which are only visible as a step row
      // if a fixture carries one: a per-character fill (whose description says
      // pressSequentially, not fill), the same with a delay, an action with its
      // own timeout, and the reload step.
      {
        type: "fill",
        locator: { k: "label", v: "City" },
        value: "Lon",
        typeMode: "sequential",
      },
      {
        type: "fill",
        locator: { k: "label", v: "Postcode" },
        value: "SW1A",
        typeMode: "sequential",
        typeDelayMs: 40,
      },
      {
        type: "click",
        locator: { k: "role", role: "button", name: "Rebuild index" },
        timeoutMs: 30_000,
      },
      { type: "reload" },
      // The variable checks, which are only visible as step rows if a fixture
      // carries one: the assertion, the condition wrapping a step, and the echo.
      {
        type: "assert",
        assert: "variable",
        captureVar: "indexJobId",
        compareOp: "startsWith",
        value: "job-",
      },
      { type: "if", cond: "variable", captureVar: "exportName", compareOp: "contains", value: ".csv" },
      { type: "echo", text: "export was ${exportName}" },
      { type: "endif" },
      // The teardown divider, with a step under it — the only way to see the
      // row that says everything below it survives a failure, and the only
      // place the divider's own styling is visible at all.
      { type: "teardown" },
      { type: "click", locator: { k: "role", role: "button", name: "Delete saved search" } },
      // Long enough to overflow the pane in both directions, which is the
      // state the step list's scrolling exists for and the one nothing in the
      // preview showed: 43 steps outrun the viewport vertically, and the fill
      // below outruns it sideways. See `.gl-step-list` in theme/shared.css.
      {
        type: "fill",
        locator: { k: "label", v: "Search the documentation for a locator strategy" },
        value:
          "a query long enough that this row runs past the right edge of the panel it is drawn in, rather than ending in an ellipsis",
      },
      ...Array.from({ length: 40 }, (_, i) => ({
        type: "click" as const,
        locator: { k: "role" as const, role: "link", name: `Result ${i + 1}` },
      })),
    ),
  },
  {
    // An IMPORTED test, which is a materially different screen: no Steps tab,
    // no Variables, no Heals — and a Base URL field none of the others have.
    // Nothing in the preview showed that state, so the only way to look at the
    // field was to build the app and import a real project.
    //
    // Base URL filled in, as it is for an import whose project wrote one down
    // in its playwright.config. Clear it in the field to see the other half.
    id: "t-imported",
    name: "adds a product to cart and shows quantity of 1",
    url: "https://shop.example.com/",
    createdAt: NOW - 5 * DAY,
    updatedAt: NOW - 5 * DAY,
    scriptPath: "/preview/scripts/imported/t-imported/tests/add-to-cart.spec.js",
    // The two fields that make a record an import: where it came from, and the
    // base URL its relative navigations resolve against.
    sourceDir: "/projects/shop-e2e/tests",
    baseUrl: "https://shop.example.com/",
    scriptEdited: true,
    // Adopted from the source project's own config, like a real import.
    testTimeoutMs: 120_000,
    tags: ["imported"],
    // An imported spec is never regenerated from steps, and the parser only
    // recovers what it recognises — a helper-wrapped navigation is not one.
    steps: steps(),
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
    // ONE STEP WITH UNACCEPTED VIOLATIONS, matching REPLAY's own `s3` below.
    // Absent, this said zero while the replay carried a serious finding — which
    // the Stats a11y tile read from here and its dashboard read from there, so
    // the preview showed a headline of 0 over a breakdown listing a rule. The
    // real app derives both from the same run; a fixture that disagrees with
    // itself teaches the preview to lie about exactly what the screen reports.
    a11yNewSteps: 1,
  },
  {
    id: "r-2",
    testId: "t-login",
    testName: "Login — wrong password shows an error",
    url: "https://app.example.com/login",
    status: "failed",
    exitCode: 1,
    hasTrace: true,
    startedAt: NOW - 30 * MINUTE,
    finishedAt: NOW - 30 * MINUTE + 8_100,
    durationMs: 8_100,
    logFile: "/preview/runs/r-2.log",
    logBytes: 9_233,
    runBrowser: "webkit",
    speed: "slow",
    healedSteps: 1,
    // Auto-categorized, so `?test=t-login` shows the run panel's reason row in
    // the state the runner actually produces — a label with its evidence tag.
    failureReasonId: "regression",
    failureReasonBy: "auto",
    failureReasonSignal: "page-error",
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
        // §6.6's "what moved". Three areas of unequal weight, so the list has a
        // ranking to show and one of them is dominant — a fixture where every
        // region is the same size exercises the layout and none of the reading.
        regions: [
          { x: 0.02, y: 0.48, w: 0.32, h: 0.12, pixels: 18_400, share: 0.71 },
          { x: 0.55, y: 0.02, w: 0.42, h: 0.09, pixels: 5_200, share: 0.2 },
          { x: 0.06, y: 0.88, w: 0.14, h: 0.06, pixels: 2_300, share: 0.09 },
        ],
        regionsOmitted: 2,
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

/**
 * The runs BEFORE the one on screen, for the drift strip (§6.6).
 *
 * Drift is a statement about a series, so a fixture with one run in it renders
 * nothing at all — the same trap as `artifacts:list` returning `[]` above, one
 * level up. These exist so the strip, its two verdicts and its gaps are visible
 * in the preview rather than only in an app with a week of history.
 *
 * TWO STEPS TELL DIFFERENT STORIES ON PURPOSE. `s2` is over threshold in most
 * of the window — a baseline nobody re-pinned, which is the finding the strip
 * was built for — while `s1` moved once and settled, which is the ordinary case
 * the strip must NOT cry wolf about. `s4` is `unable` throughout, so its slots
 * draw as gaps: the distinction between "measured, identical" and "no reading"
 * is the one thing here that cannot be checked in jsdom, which has no layout.
 */
const DRIFT_RATIOS: Record<string, (number | null)[]> = {
  // Newest first, matching the order the runs are listed in.
  s1: [0.0004, 0.0002, 0.0003, 0.0221, 0.0002, 0.0001, 0.0003, 0.0002],
  s2: [0.0413, 0.0388, 0.0026, 0.0451, 0.0402, 0.0019, 0.0367, 0.0009],
};

/** Eight earlier runs of the same test, differing only in what the comparison
 *  found. Cloned from `REPLAY` rather than written out, so a step added to the
 *  fixture above cannot silently go missing from its own history. */
export const REPLAY_HISTORY: RunReplay[] = DRIFT_RATIOS.s1.slice(1).map((_, i) => {
  const n = i + 1;
  return {
    ...REPLAY,
    runId: `r-${n + 1}`,
    startedAt: REPLAY.startedAt - n * 6 * HOUR,
    finishedAt: REPLAY.startedAt - n * 6 * HOUR + 11_900,
    steps: REPLAY.steps.map((s) => {
      const ratio = DRIFT_RATIOS[s.stepId]?.[n];
      if (ratio === undefined || ratio === null || !s.diff) return s;
      const changed = ratio * 100 > (REPLAY.visualThreshold ?? 0.2);
      return {
        ...s,
        diff: {
          ...s.diff,
          state: changed ? ("changed" as const) : ("match" as const),
          ratio,
          diffFile: changed ? s.diff.diffFile : undefined,
        },
      };
    }),
  };
});

function summarise(r: RunReplay): RunReplaySummary {
  return {
    testId: r.testId,
    runId: r.runId,
    testName: r.testName,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    stepCount: r.steps.length,
    failedIndex: r.failedIndex,
    changedSteps: r.steps.filter((s) => s.diff?.state === "changed").length,
    // Derived, not hard-coded: the summary marker and the banner are two
    // readings of the same fact, and a fixture where they disagree teaches the
    // preview to lie about exactly the thing this screen reports.
    a11yNewSteps: r.steps.filter((s) => (s.a11y?.newKeys.length ?? 0) > 0).length,
  };
}

export const REPLAY_SUMMARIES: RunReplaySummary[] = [REPLAY, ...REPLAY_HISTORY].map(summarise);

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

/** Two spec versions, so the preview's diff is a real diff rather than one
 *  line against another. */
const SPEC_BEFORE = [
  "import { test, expect } from '@playwright/test';",
  "",
  "test('login', async ({ page }) => {",
  "  await page.goto('https://example.test/login');",
  "  await page.getByTestId('signin').click();",
  "  await expect(page.getByText('Welcome')).toBeVisible();",
  "});",
  "",
].join("\n");

const SPEC_AFTER = [
  "import { test, expect } from '@playwright/test';",
  "",
  "test('login', async ({ page }) => {",
  "  await page.goto('https://example.test/login');",
  "  await page.getByRole('button', { name: 'Sign in' }).click();",
  "  await expect(page.getByText('Welcome')).toBeVisible({ timeout: 10_000 });",
  "});",
  "",
].join("\n");

/** Typed as the superset for the same reason `HEALS` is: one array serves both
 *  `scriptChanges:list` and `scriptChanges:listAll`.
 *
 *  Both states are here on purpose, because they are the whole point of the
 *  feature and they render differently. The first landed while the AI debug job
 *  was minimized — nobody read it, so it is in the review queue. The second is
 *  a hand edit, which is settled history the moment it is saved. */
export const SCRIPT_CHANGES: ScriptChangeListEntry[] = [
  {
    id: "sc-1",
    testId: "t-login",
    testName: "Login — wrong password shows an error",
    origin: "ai-debug",
    model: "claude-sonnet-4",
    reviewed: false,
    before: SPEC_BEFORE,
    after: SPEC_AFTER,
    addedLines: 2,
    removedLines: 2,
    status: "pending",
    at: NOW - 20 * MINUTE,
  },
  // A KEPT fix, on the passing test — the state the Cost panel's "Debugging
  // avoided" tile claims time for (`summariseFixes` counts it via `accepted`),
  // and without which that tile could only ever be seen at its dash.
  {
    id: "sc-3",
    testId: "t-checkout",
    testName: "Checkout — happy path",
    origin: "ai-debug",
    model: "claude-sonnet-4",
    reviewed: true,
    before: SPEC_BEFORE,
    after: SPEC_AFTER,
    addedLines: 1,
    removedLines: 1,
    status: "accepted",
    at: NOW - 2 * DAY + 60_000,
  },
  {
    id: "sc-2",
    testId: "t-login",
    testName: "Login — wrong password shows an error",
    origin: "manual",
    reviewed: true,
    before: SPEC_AFTER,
    after: SPEC_AFTER.replace("Welcome", "Welcome back"),
    addedLines: 1,
    removedLines: 1,
    status: "accepted",
    at: NOW - 3 * HOUR,
  },
];

/**
 * AI debug history — the rows the Stats board's AI Debug category counts.
 *
 * SHAPED TO EXERCISE THE PANELS RATHER THAN TO BE TYPICAL, which is this
 * file's standing rule. Between them these rows produce: all four outcomes, a
 * local/hosted split with one pre-provider unknown, two error kinds, an
 * attempt that never produced a first token, and records in both trend windows
 * so "the week before" has something to compare against. `ad-1` is the fix
 * `SCRIPT_CHANGES` above applied and nobody reviewed, which is what makes the
 * tile amber in the preview.
 */
export const AI_DEBUG_HISTORY: AiDebugHistoryRecord[] = [
  {
    id: "ad-1",
    key: "run:t-login",
    kind: "run",
    testId: "t-login",
    testName: "Login — wrong password shows an error",
    trigger: "manual",
    provider: "anthropic",
    model: "claude-sonnet-4",
    status: "done",
    errorKind: null,
    startedAt: NOW - 22 * MINUTE,
    endedAt: NOW - 22 * MINUTE + 41_000,
    firstTokenMs: 2_100,
    promptChars: 9_200,
    answerChars: 3_400,
    runKey: "r-2",
  },
  {
    id: "ad-2",
    key: "step:t-login:3",
    kind: "step",
    testId: "t-login",
    testName: "Login — wrong password shows an error",
    trigger: "manual",
    provider: "ollama",
    model: "qwen2.5-coder:7b",
    status: "done",
    errorKind: null,
    startedAt: NOW - 3 * HOUR,
    endedAt: NOW - 3 * HOUR + 96_000,
    firstTokenMs: 8_400,
    promptChars: 6_100,
    answerChars: 2_800,
    runKey: null,
  },
  {
    id: "ad-3",
    key: "run:t-checkout",
    kind: "run",
    testId: "t-checkout",
    testName: "Checkout — happy path",
    trigger: "manual",
    provider: "ollama",
    model: "qwen2.5-coder:7b",
    // Never got an answer, and never got a token either — the state the
    // "First token" card has to report as "nothing ever arrived".
    status: "error",
    errorKind: "connection",
    startedAt: NOW - 26 * HOUR,
    endedAt: NOW - 26 * HOUR + 12_000,
    firstTokenMs: null,
    promptChars: 11_800,
    answerChars: 0,
    runKey: "r-1",
  },
  {
    id: "ad-4",
    key: "run:t-checkout",
    kind: "run",
    testId: "t-checkout",
    testName: "Checkout — happy path",
    trigger: "manual",
    provider: "lmstudio",
    model: "llama-3.1-8b",
    status: "cancelled",
    errorKind: null,
    startedAt: NOW - 2 * DAY,
    endedAt: NOW - 2 * DAY + 21_000,
    firstTokenMs: 3_900,
    promptChars: 10_400,
    answerChars: 900,
    runKey: "r-1",
  },
  {
    id: "ad-5",
    key: "run:t-search",
    kind: "run",
    testId: "t-search",
    testName: "Search — results render",
    trigger: "manual",
    provider: "ollama",
    model: "qwen2.5-coder:7b",
    status: "error",
    errorKind: "empty-response",
    startedAt: NOW - 9 * DAY,
    endedAt: NOW - 9 * DAY + 33_000,
    firstTokenMs: null,
    promptChars: 24_000,
    answerChars: 0,
    runKey: null,
  },
  {
    id: "ad-6",
    key: "run:t-search",
    kind: "run",
    testId: "t-search",
    testName: "Search — results render",
    trigger: "manual",
    // Written before the provider was stamped: counted as neither local nor
    // hosted, and the panel says so out loud.
    provider: null,
    model: null,
    status: "interrupted",
    errorKind: null,
    startedAt: NOW - 10 * DAY,
    endedAt: NOW - 10 * DAY + 5_000,
    firstTokenMs: null,
    promptChars: 0,
    answerChars: 1_200,
    runKey: null,
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
  extraTestIdAttributes: [],
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
  collapsedTestGroups: [],
  batchTestOptions: {},
  defaultBatchConcurrency: 2,
  artifactRetainedRuns: 10,
  runLogRetainedRuns: 1000,
  artifactRetentionDays: 30,
  notifyOnRunIssues: false,
  notifyOnBatchDone: true,
  notifyOnAiDebugDone: false,
  // ON in the preview, unlike the shipped default: the enabled state is the
  // one with surface to review (Generate now, the dependent Alerts rows), and
  // the off-state explainer is covered by insights-view.test.tsx.
  aiInsightsEnabled: true,
  aiInsightsCadence: "weekly",
  notifyOnInsightsReady: true,
  insightsSlackEnabled: false,
  autoFailureReasons: true,
  autoAcceptAiDebugFixes: false,
  disabledAestheticEnhancements: [],
  // Both at their defaults. `uiScale` does nothing in the preview — there is no
  // main process to zoom a webContents — but it has to be present and valid or
  // the Appearance pane renders its size control with no segment selected.
  uiScale: 1,
  uiTypeface: "space",
  // The shipped cost guesses. Left at their defaults deliberately: the Cost
  // panel's "both are this app's guesses" sentence only renders while they are,
  // and the preview is the only place that sentence can be looked at.
  costCurrency: "usd",
  costPerCiMinute: 0.008,
  costMinutesPerManualRun: 12,
  costMinutesPerManualDebug: 15,
  // A rate IS stated here, unlike the app's own default of 0 — the preview is
  // the only place the money half of the AI Debug savings panel can be looked
  // at, and a fixture that leaves it off makes a whole card unreachable.
  costHourlyRate: 90,
  // A CONFIGURED manual proxy, unlike the shipped defaults, for the same
  // reason the insights fixture ships enabled: manual mode is the state with
  // surface to review — the URL/credential rows, SSL Verify and the validate
  // dialog all render only there, and the preview is the only place to look
  // at them without a corporate proxy to hand.
  proxyTraffic: "test",
  proxySource: "manual",
  proxyUrl: "http://192.168.0.10:8080",
  proxyUsername: "",
  proxySslVerify: true,
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

/**
 * Saved jobs. docs/ROUTINES.md — the Batch screen is one Routine's editor now,
 * so a preview with none shows the "no routines yet" state and nothing else.
 *
 * TWO OF THEM, DELIBERATELY. One is the whole point of the feature: "Smoke,
 * Chromium, headless" and "Nightly, all three engines, headed" are exactly the
 * pair the old single checklist could not express, and a preview with one
 * Routine cannot show that switching between them changes the screen.
 */
export const ROUTINES: Routine[] = [
  {
    id: "r-smoke",
    name: "Smoke",
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - 2 * DAY,
    steps: [
      {
        kind: "test",
        testId: "t-login",
        browsers: ["chromium"],
        headless: true,
        onFailure: "continue",
      },
      {
        kind: "test",
        testId: "t-checkout",
        browsers: ["chromium"],
        headless: true,
        onFailure: "continue",
      },
    ],
    // A SUB-HOUR cadence, so the preview's schedule chip shows the shape the
    // hour-floored version could not express at all.
    schedule: { kind: "everyMinutes", minutes: 15 },
    defaults: { captureArtifacts: false, concurrency: 2 },
  },
  {
    id: "r-nightly",
    name: "Nightly regression",
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 10 * DAY,
    // SCHEDULED AND OVERDUE on purpose: this is what makes the launch prompt
    // reachable in a browser tab. Its last scheduled fire was two days ago, so
    // `routines:missed` claims it and `MissedRunsDialog` opens on load.
    schedule: { kind: "dailyAt", minute: 3 * 60 },
    lastScheduledRunAt: NOW - 2 * DAY,
    steps: [
      {
        kind: "test",
        testId: "t-checkout",
        browsers: ["chromium", "firefox", "webkit"],
        headless: false,
        onFailure: "continue",
      },
      {
        kind: "test",
        testId: "t-search",
        browsers: ["chromium", "webkit"],
        headless: false,
        onFailure: "continue",
      },
    ],
    defaults: { captureArtifacts: true, concurrency: 1 },
  },
];

/**
 * Past batches, ATTRIBUTED ACROSS THE TWO ROUTINES and one left unattributed.
 *
 * The Batch screen scopes its history to the job on screen, so a fixture where
 * every batch belongs to the same Routine cannot show that scoping working —
 * the list would look identical if the filter were missing. `b-stopped` carries
 * no `routineId` on purpose: that is every batch run before Routines shipped,
 * and it has to appear under the migrated "Batch" Routine and nowhere else.
 * Here the migrated Routine does not exist, so it appears nowhere — which is
 * itself the state worth being able to look at.
 */
export const BATCHES: BatchRecord[] = [
  {
    batchId: "b-mixed",
    routineId: "r-smoke",
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
    routineId: "r-smoke",
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
    routineId: "r-nightly",
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

/**
 * The element a refine-mode pick reports — and the only way to see the
 * element-context picker outside a packaged build.
 *
 * `recorder:picked` is pushed by the backend when the user clicks an element in
 * the training browser. A browser tab has no training browser, so nothing in
 * the preview could ever produce one, and both consumers of a picked element —
 * the Refine dialog and the composer's target picker — were unreachable here.
 *
 * Deliberately the AMBIGUOUS case: two identical "Edit" buttons in two cards,
 * which is the shape the whole feature exists for and the one where the picker
 * opens expanded. `contextBaseCount: 2` is what makes it so, and the per-signal
 * counts are the ones the real capture script would compute against this DOM.
 */
export const PICKED_ELEMENT: PickedElement = {
  tag: "button",
  description: "button.btn.edit",
  candidates: [
    { k: "role", role: "button", name: "Edit" },
    { k: "text", v: "Edit" },
    { k: "css", v: "body > section:nth-of-type(1) > button" },
    { k: "xpath", v: "/html[1]/body[1]/section[1]/button[1]" },
  ],
  css: { color: "rgb(17, 17, 17)", "font-size": "14px" },
  attributes: { class: "btn edit", "aria-label": "Edit" },
  ambiguous: true,
  contextBase: { k: "role", role: "button", name: "Edit" },
  contextBaseCount: 2,
  contextSignals: [
    {
      kind: "within",
      name: "within",
      value: "section",
      locator: { k: "testid", v: "billing-card" },
      ctx: { within: { k: "testid", v: "billing-card" } },
      count: 1,
      resolves: true,
    },
    {
      kind: "withinHasText",
      name: "within + text",
      value: "Billing Edit",
      locator: { k: "testid", v: "billing-card" },
      ctx: { within: { k: "testid", v: "billing-card" }, withinHasText: "Billing Edit" },
      count: 1,
      resolves: true,
    },
    {
      kind: "attr",
      name: "data-qa",
      value: "edit-billing",
      ctx: { and: [{ k: "css", v: '[data-qa="edit-billing"]' }] },
      count: 1,
      resolves: true,
    },
    {
      kind: "attr",
      name: "aria-label",
      value: "Edit",
      ctx: { and: [{ k: "css", v: '[aria-label="Edit"]' }] },
      count: 2,
      resolves: false,
    },
    {
      kind: "class",
      name: "class",
      value: "edit",
      ctx: { and: [{ k: "css", v: ".edit" }] },
      count: 2,
      resolves: false,
    },
    {
      kind: "class",
      name: "class",
      value: "btn",
      ctx: { and: [{ k: "css", v: ".btn" }] },
      count: 6,
      resolves: false,
    },
  ],
  text: "Edit",
  neighborText: "Billing",
};

/** Shared numbers strip for the insight fixtures — kept plausible against the
 *  RUNS fixture rather than exact, since the reports are canned prose. */
const INSIGHT_STATS_BASE = {
  runs: 12,
  failed: 3,
  previousRuns: 9,
  flakyRuns: 1,
  healedSteps: 2,
  healFailures: 1,
  visualChanges: 4,
  newClusters: 1,
  a11yNewSteps: 0,
  testsCreated: 1,
  unreviewedScriptChanges: 1,
  expiringSignatures: 1,
};

const INSIGHT_SENDING = [
  { label: "Report period", chars: 120 },
  { label: "Run and failure counts, worst tests by name", chars: 640 },
  { label: "Failure signatures", chars: 380 },
  { label: "Auto-Heal activity, test names", chars: 210 },
  { label: "Test ids and names", chars: 260 },
];

/** Three reports, three states the view has to get right: a healthy period; a
 *  rough one whose recommendations carry actions — including one pointing at a
 *  test that no longer exists, so the disabled-button path is drivable; and a
 *  DEGRADED one where the model ignored the JSON contract. The middle one is
 *  unread, so the rail dot has something to show. */
export const INSIGHT_REPORTS: InsightReport[] = [
  {
    id: "ins-3",
    cadence: "weekly",
    periodStart: NOW - 7 * DAY,
    periodEnd: NOW - 2 * HOUR,
    generatedAt: NOW - 2 * HOUR,
    provider: "ollama",
    model: "qwen2.5-coder:14b",
    headline: "Login is failing on a selector that changed Tuesday — everything else held steady.",
    sections: [
      {
        title: "How the week went",
        body: "12 runs this week against 9 the week before, with 3 failures — all of them Login. The failures share one error signature that first appeared on Tuesday, which points at the site changing rather than the test decaying.\n\nCheckout and Search passed every run, and Search's median duration is unchanged.",
      },
      {
        title: "Worth watching",
        body: "Auto-Heal substituted a locator twice on Login before it started failing outright — a step that heals repeatedly is usually a selector one release away from breaking. One heal could not find any candidate at all, which usually means the element is gone.\n\nThe crawler signature for shop.example.com expires in 5 days; scheduled runs against it will start failing silently when it does.",
      },
      {
        title: "In the app",
        body: "This is the first report from this install. Reports generate on your weekly schedule while the app is open, and after launch when one was missed.",
      },
    ],
    actions: [
      {
        kind: "debug-test",
        testId: "t-login",
        testName: "Login — wrong password shows an error",
        label: "Login has failed 3 times on the same new signature — worth a diagnosis.",
      },
      {
        kind: "run-test",
        testId: "t-deleted",
        testName: "Legacy signup flow",
        label: "This test hasn't run since the failures started.",
      },
      {
        kind: "open-settings-integrations",
        label: "The shop.example.com crawler signature expires in 5 days.",
      },
    ],
    stats: INSIGHT_STATS_BASE,
    sending: INSIGHT_SENDING,
    promptChars: 6480,
    answerChars: 1910,
    durationMs: 41_000,
    firstTokenMs: 900,
    read: false,
  },
  {
    id: "ins-2",
    cadence: "weekly",
    periodStart: NOW - 14 * DAY,
    periodEnd: NOW - 7 * DAY,
    generatedAt: NOW - 7 * DAY,
    provider: "ollama",
    model: "qwen2.5-coder:14b",
    headline: "A quiet week: 9 runs, all passed, nothing new to watch.",
    sections: [
      {
        title: "How the week went",
        body: "9 runs, all passed — up 4 on the week before. No new failure signatures, no visual changes over threshold, and no heals.",
      },
    ],
    actions: [],
    stats: {
      ...INSIGHT_STATS_BASE,
      runs: 9,
      failed: 0,
      previousRuns: 5,
      flakyRuns: 0,
      healedSteps: 0,
      healFailures: 0,
      visualChanges: 0,
      newClusters: 0,
      unreviewedScriptChanges: 0,
      expiringSignatures: 0,
    },
    sending: INSIGHT_SENDING,
    promptChars: 5220,
    answerChars: 640,
    durationMs: 28_000,
    firstTokenMs: 700,
    read: true,
  },
  {
    id: "ins-1",
    cadence: "weekly",
    periodStart: NOW - 21 * DAY,
    periodEnd: NOW - 14 * DAY,
    generatedAt: NOW - 14 * DAY,
    provider: "lmstudio",
    model: "bonsai-27b",
    headline: "Sure! Here's a summary of your testing week.",
    sections: [
      {
        title: "Report",
        body: "Sure! Here's a summary of your testing week.\n\nYou ran your tests 7 times and most of them passed. The checkout test is doing great. I'd suggest keeping an eye on the login test as it seems a bit unstable.\n\nLet me know if you'd like more detail on any of these!",
      },
    ],
    actions: [],
    stats: {
      ...INSIGHT_STATS_BASE,
      runs: 7,
      failed: 1,
      previousRuns: 0,
      newClusters: null,
      visualChanges: null,
    },
    sending: INSIGHT_SENDING,
    degraded: true,
    promptChars: 5100,
    answerChars: 320,
    durationMs: 64_000,
    firstTokenMs: 12_000,
    read: true,
  },
];

/** The scheduler's readout beside the fixtures above: last success two hours
 *  ago, no pending failure. The bridge derives `generating: false`. */
export const INSIGHTS_STATE: InsightsState = {
  lastGeneratedAt: NOW - 2 * HOUR,
  lastAttemptAt: null,
  lastError: null,
  lastSeenAppVersion: "1.0.0",
};
