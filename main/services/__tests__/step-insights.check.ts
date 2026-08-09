// Standalone regression check for the step insights.
//
// These three functions decide what the Phase 4 views SAY, and each has a
// failure mode that renders perfectly:
//
//   1. `insufficient` collapsing into `clean`. 255 of the 305 steps on the
//      development machine have only ever run on one engine. If those read as
//      "clean", a suite that has never been tried anywhere but Chromium
//      displays a clean bill of cross-browser health — the single most
//      misleading thing this view could do, and nothing on screen looks wrong.
//   2. A slowdown reported from one sample. "3× slower" drawn from two numbers
//      is noise with a decimal point on it, and it is indistinguishable on
//      screen from a real regression.
//   3. Instrumentation attribution that includes an ESTIMATE. capture_ms and
//      a11y_ms are measured; slow-motion delay is not recorded as a total.
//      Folding a derived number in beside two measured ones would put a guess
//      on screen in the same sentence as two facts.
//
// Run with: npm run check:step-insights

import {
  costBreakdown,
  divergentSteps,
  MIN_SAMPLES_FOR_TREND,
  SLOWDOWN_RATIO,
  slowdowns,
} from "../../../shared/step-insights.mjs";
import type { StepBrowserRow, StepDurationRow } from "../../../shared/metrics-query.mjs";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(
      `FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  } else {
    console.log(`ok   ${label}`);
  }
}

function row(browser: string, runs: number, failed: number, over: Partial<StepBrowserRow> = {}): StepBrowserRow {
  return {
    stepId: "s1",
    label: "Click Pay",
    testId: "t1",
    testName: "Checkout",
    browser,
    runs,
    failed,
    ...over,
  };
}

const verdictOf = (rows: StepBrowserRow[]) => divergentSteps(rows)[0].verdict;

// ── Divergence, every verdict, both directions ────────────────────────

{
  assertEqual(
    verdictOf([row("chromium", 5, 0), row("firefox", 5, 2)]),
    "single-engine",
    "failing on one engine while another passes is single-engine",
  );
  assertEqual(
    verdictOf([row("chromium", 5, 1), row("firefox", 5, 2), row("webkit", 5, 1)]),
    "all-engines",
    "every engine failing is all-engines",
  );
  assertEqual(
    verdictOf([row("chromium", 5, 1), row("firefox", 5, 2), row("webkit", 5, 0)]),
    "mixed",
    "two of three failing is mixed — not overstated as all-engines",
  );
  assertEqual(
    verdictOf([row("chromium", 5, 0), row("firefox", 5, 0)]),
    "clean",
    "no engine failing is clean",
  );

  // THE one that matters. A step tried on a single engine has said nothing
  // about cross-browser behaviour, however many times it ran and however
  // reliably it passed.
  assertEqual(
    verdictOf([row("chromium", 50, 0)]),
    "insufficient",
    "one engine, fifty green runs, is INSUFFICIENT — not clean",
  );
  assertEqual(
    verdictOf([row("chromium", 50, 3)]),
    "insufficient",
    "…and one engine failing is not all-engines either",
  );

  // Both sides are named, because "fails on webkit" alone leaves the reader
  // asking "compared with what?".
  const one = divergentSteps([row("chromium", 5, 0), row("webkit", 5, 2)])[0];
  assertEqual(one.failingBrowsers, ["webkit"], "the failing engine is named");
  assertEqual(one.passingBrowsers, ["chromium"], "and so is the one it passes on");

  // Rows arrive grouped by (step, browser); steps must not merge across tests.
  const twoTests = divergentSteps([
    row("chromium", 5, 0),
    row("webkit", 5, 2),
    row("chromium", 5, 0, { testId: "t2", testName: "Login" }),
    row("webkit", 5, 0, { testId: "t2", testName: "Login" }),
  ]);
  assertEqual(twoTests.length, 2, "the same step id in two tests stays two rows");
  assertEqual(
    twoTests.map((s) => s.verdict),
    ["single-engine", "clean"],
    "…and divergence sorts above clean, so the finding is not buried",
  );
}

// ── Slowdowns ─────────────────────────────────────────────────────────

function duration(over: Partial<StepDurationRow> = {}): StepDurationRow {
  return {
    stepId: "s1",
    label: "Submit",
    type: "click",
    testId: "t1",
    testName: "Checkout",
    recentRuns: 5,
    previousRuns: 5,
    recentP50Ms: 4800,
    recentP95Ms: 5200,
    previousP50Ms: 1200,
    changeRatio: 4,
    ...over,
  };
}

{
  assertEqual(slowdowns([duration()]).length, 1, "a step whose median quadrupled is reported");

  assertEqual(
    slowdowns([duration({ changeRatio: 1.1, recentP50Ms: 1320 })]).length,
    0,
    "a 10% move is not a slowdown — step durations move that much for free",
  );
  assert(
    SLOWDOWN_RATIO > 1.2,
    "and the threshold is coarse enough that ordinary variance cannot trip it",
  );

  // The sample-size guard, in both directions. This is the one that turns a
  // young history into a wall of false findings if it is missing.
  assertEqual(
    slowdowns([duration({ recentRuns: 1, previousRuns: 1 })]).length,
    0,
    `fewer than ${MIN_SAMPLES_FOR_TREND} samples in a window yields no verdict`,
  );
  assertEqual(
    slowdowns([duration({ previousRuns: 0, previousP50Ms: null, changeRatio: null })]).length,
    0,
    "…and a missing baseline is not a slowdown, it is nothing to compare",
  );
  assertEqual(
    slowdowns([
      duration({ recentRuns: MIN_SAMPLES_FOR_TREND, previousRuns: MIN_SAMPLES_FOR_TREND }),
    ]).length,
    1,
    "exactly the minimum sample count is enough",
  );

  // Worst first — a list of slowdowns nobody sorts is a list nobody acts on.
  const ordered = slowdowns([
    duration({ stepId: "a", changeRatio: 2 }),
    duration({ stepId: "b", changeRatio: 9 }),
    duration({ stepId: "c", changeRatio: 4 }),
  ]);
  assertEqual(ordered.map((r) => r.stepId), ["b", "c", "a"], "slowdowns are worst-first");
}

// ── Cost attribution ──────────────────────────────────────────────────

{
  const cost = costBreakdown({
    runs: 10,
    totalMs: 100_000,
    captureMs: 20_000,
    a11yMs: 10_000,
    shots: 40,
    bySpeed: [{ speed: "slow", runs: 10, totalMs: 100_000 }],
  });
  assertEqual(cost.instrumentedMs, 30_000, "instrumentation is capture + a11y, both measured");
  assertEqual(cost.otherMs, 70_000, "and the rest is everything else");
  assertEqual(cost.instrumentedShare, 0.3, "reported as a share, which is the actionable form");

  // The speed setting is NOT folded in, deliberately: it is derivable but not
  // recorded as a total, and an estimate presented beside two measurements
  // reads as a third measurement.
  assert(
    cost.instrumentedMs === cost.captureMs + cost.a11yMs,
    "the speed setting is excluded from the instrumentation figure",
  );
  assert(cost.bySpeed.length === 1, "…and is reported separately instead, per speed");

  // An empty history must not divide by zero into NaN, which renders as "NaN%".
  const empty = costBreakdown({ runs: 0, totalMs: 0, captureMs: 0, a11yMs: 0, shots: 0, bySpeed: [] });
  assertEqual(empty.instrumentedShare, 0, "an empty history reports a zero share, not NaN");
  assert(Number.isFinite(empty.otherMs), "and a finite remainder");

  // Capture longer than the total would be a rollup bug, but it must not
  // render as a negative bar.
  const odd = costBreakdown({ runs: 1, totalMs: 100, captureMs: 900, a11yMs: 0, shots: 1, bySpeed: [] });
  assert(odd.otherMs >= 0, "an impossible total clamps rather than going negative");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll step-insights checks passed.");
