// Standalone regression check for flake and failure analytics.
//
// The two cases this must never confuse are the whole reason the module exists,
// and they produce IDENTICAL pass rates:
//
//   • A test that alternates pass/fail — unstable, next result is a coin toss.
//   • A test swept over dataset rows that fails every time on one row — 100%
//     reliable, and telling you something true about that row.
//
// Both sit at, say, 50%. Calling the second one flaky sends someone hunting for
// a race condition that isn't there; calling the first one data-dependent sends
// them to look at data that's fine. So the tests below assert the VERDICT, not
// the arithmetic.
//
// analyseFlake is pure, so this drives it directly with synthetic histories —
// which is the only practical way to exercise "alternated on every run for
// twenty runs".
//
// Run with: npm run check:flake-analysis

import {
  analyseFlake,
  countTransitions,
  errorSignature,
  MIN_RUNS_FOR_VERDICT,
  type RunDetail,
  type StabilityVerdict,
} from "../flake-analysis.js";
import { extractError } from "../flake-source.js";
import type { RunRecord } from "../../recorder/types.js";

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
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(
      `FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  } else {
    console.log(`ok   ${label}`);
  }
}

let clock = 1_700_000_000_000;

/** A run record, with the fields the analysis reads. Runs are handed to
 *  `analyseFlake` NEWEST-first, as runHistoryStore.list() returns them — the
 *  module sorts internally, and passing them pre-sorted would hide a bug there. */
function run(
  testId: string,
  status: "passed" | "failed",
  extra: Partial<RunRecord> = {},
): RunRecord {
  clock += 60_000;
  return {
    id: `run-${clock}-${Math.round(Math.random() * 1e6)}`,
    testId,
    testName: `Test ${testId}`,
    url: "https://example.com",
    status,
    exitCode: status === "passed" ? 0 : 1,
    startedAt: clock,
    finishedAt: clock + 1000,
    durationMs: 1000,
    logFile: "",
    logBytes: 0,
    ...extra,
  } as RunRecord;
}

/** Build a history from a pass/fail pattern, oldest-first, then reverse it so
 *  the analysis receives it the way the store hands it over. */
function history(testId: string, pattern: string, extra: (i: number) => Partial<RunRecord> = () => ({})): RunRecord[] {
  const runs = [...pattern].map((c, i) => run(testId, c === "P" ? "passed" : "failed", extra(i)));
  return runs.reverse();
}

function verdictOf(records: RunRecord[], details: RunDetail[] = []): StabilityVerdict {
  return analyseFlake(records, details).tests[0].verdict;
}

function main(): void {
  // ── transitions, the actual measure ──────────────────────────────────────
  assertEqual(countTransitions(["passed", "passed", "passed"]), 0, "no transitions when nothing changes");
  assertEqual(countTransitions(["passed", "failed", "passed", "failed"]), 3, "every flip counts");
  assertEqual(countTransitions(["passed", "passed", "failed", "failed"]), 1, "broke once and stayed");
  assertEqual(countTransitions([]), 0, "an empty history has no transitions");

  // ── the distinction the whole module exists for ──────────────────────────
  //
  // Both of these are 50% pass rate. They are not the same problem.
  {
    const alternating = history("flaky", "PFPFPFPF");
    assertEqual(verdictOf(alternating), "flaky", "a test that alternates is flaky");

    const brokeAndStayed = history("broke", "PPPPFFFF");
    assertEqual(
      verdictOf(brokeAndStayed),
      "changed-since",
      "a test that broke once and stayed broken is a regression, NOT flake",
    );

    const both = analyseFlake([...alternating, ...brokeAndStayed]);
    const flaky = both.tests.find((t) => t.testId === "flaky")!;
    const broke = both.tests.find((t) => t.testId === "broke")!;
    assertEqual(
      [flaky.passed, flaky.runs],
      [broke.passed, broke.runs],
      "…and the two have an identical pass rate, which is why the rate can't tell them apart",
    );
    assert(
      flaky.flakeRate > broke.flakeRate,
      `the flake rate does tell them apart (${flaky.flakeRate} vs ${broke.flakeRate})`,
    );
    assertEqual(both.tests[0].testId, "flaky", "the flaky test is listed first");
  }

  // ── dataset-dependence is not flake ──────────────────────────────────────
  {
    // Three rows swept twice each. One row fails every time; the others never
    // do. Pass rate: 67%. Transitions: several. Reads as flake unless the
    // dataset dimension is used.
    const rows = [
      { id: "d1", name: "GBP", fails: false },
      { id: "d2", name: "USD", fails: false },
      { id: "d3", name: "JPY", fails: true },
    ];
    const runs: RunRecord[] = [];
    for (let sweep = 0; sweep < 2; sweep++) {
      for (const r of rows) {
        runs.push(
          run("sweep", r.fails ? "failed" : "passed", { datasetId: r.id, datasetName: r.name }),
        );
      }
    }
    const report = analyseFlake(runs.reverse());
    const t = report.tests[0];
    assertEqual(t.verdict, "data-dependent", "failures confined to one row are data-dependent");
    assert(t.transitions > 1, `…even though it transitions repeatedly (${t.transitions})`);
    assertEqual(
      t.failingDatasets.map((d) => d.name),
      ["JPY"],
      "the failing row is named, so it's actionable",
    );

    // A row that itself flips is flake WITHIN that row — calling the test
    // data-dependent would hide it.
    const flakyRow: RunRecord[] = [
      run("mixed", "passed", { datasetId: "d1", datasetName: "GBP" }),
      run("mixed", "passed", { datasetId: "d2", datasetName: "USD" }),
      run("mixed", "failed", { datasetId: "d1", datasetName: "GBP" }),
      run("mixed", "passed", { datasetId: "d2", datasetName: "USD" }),
      run("mixed", "passed", { datasetId: "d1", datasetName: "GBP" }),
      run("mixed", "failed", { datasetId: "d2", datasetName: "USD" }),
    ];
    assertEqual(
      verdictOf(flakyRow.reverse()),
      "flaky",
      "a row that flips is flake, not data-dependence",
    );

    // Mixing swept and un-swept runs makes the comparison meaningless, so the
    // data-dependent verdict is withheld rather than guessed at.
    const mixed = [
      ...history("part", "PP"),
      run("part", "failed", { datasetId: "d3", datasetName: "JPY" }),
      run("part", "failed", { datasetId: "d3", datasetName: "JPY" }),
    ];
    assert(
      verdictOf(mixed) !== "data-dependent",
      "a history mixing swept and un-swept runs is not called data-dependent",
    );
  }

  // ── verdicts that aren't flake ───────────────────────────────────────────
  assertEqual(verdictOf(history("s", "PPPPP")), "stable", "all passing is stable");
  assertEqual(verdictOf(history("f", "FFFFF")), "still-failing", "all failing is broken, not flaky");
  assertEqual(verdictOf(history("x", "FFFPP")), "fixed", "failing then passing and staying is fixed");
  assertEqual(
    verdictOf(history("few", "PF")),
    "unknown",
    `under ${MIN_RUNS_FOR_VERDICT} runs there is no verdict — "50%" from two runs is noise`,
  );
  assertEqual(
    analyseFlake(history("few", "PF")).analysedTests,
    0,
    "a test with no verdict isn't counted as analysed",
  );

  // Baseline-update events are not executions and must not distort anything.
  {
    const withBaseline = [
      ...history("b", "PPPP"),
      run("b", "passed", { kind: "baseline-update", note: "Accepted 3 screenshots" }),
    ];
    assertEqual(analyseFlake(withBaseline).tests[0].runs, 4, "baseline-update events are excluded");
  }

  // ── per-step attribution and healing ─────────────────────────────────────
  {
    const runs = history("steps", "PFPF");
    const details: RunDetail[] = runs.map((r, i) => ({
      runId: r.id,
      ...(r.status === "failed"
        ? { failedStepId: "step-7", failedStepLabel: 'getByTestId("pay").click()' }
        : {}),
      ...(i === 0 ? { healedStepIds: ["step-3"] } : {}),
    }));
    const t = analyseFlake(runs, details).tests[0];
    const failing = t.steps.find((s) => s.stepId === "step-7")!;
    assertEqual(failing.failures, 2, "the failing step is identified and counted");
    assertEqual(failing.label, 'getByTestId("pay").click()', "…with a readable label");
    assertEqual(failing.failureRate, 0.5, "…and a failure rate over the analysed runs");
    const healed = t.steps.find((s) => s.stepId === "step-3")!;
    assertEqual(healed.heals, 1, "a step that needed healing is surfaced as unstable too");
    assertEqual(healed.failures, 0, "…without being counted as a failure");
    assertEqual(t.steps[0].stepId, "step-7", "outright failures rank above heals");
  }

  // ── failure clustering ───────────────────────────────────────────────────
  {
    // The same failure, worded slightly differently each time — which is what
    // real logs look like. Ungrouped, this reads as three problems.
    const runs = history("cluster", "FFF");
    const details: RunDetail[] = runs.map((r, i) => ({
      runId: r.id,
      failedStepId: "step-2",
      error: `Error: Timeout ${30000 + i}ms exceeded waiting for locator '#pay-${i}'`,
    }));
    const report = analyseFlake(runs, details);
    assertEqual(report.clusters.length, 1, "run-to-run noise doesn't split one cause into three");
    assertEqual(report.clusters[0].count, 3, "…and the cluster counts every occurrence");
    assert(!!report.clusters[0].example, "a real example is kept, so the cluster is recognizable");
    assertEqual(report.clusters[0].stepId, "step-2", "the cluster names the step it happened on");

    // Two different steps failing the same way are two problems, not one:
    // merging them would point at neither.
    const twoSteps = history("two", "FF");
    const twoDetails: RunDetail[] = [
      { runId: twoSteps[0].id, failedStepId: "a", error: "Error: Timeout 30000ms exceeded" },
      { runId: twoSteps[1].id, failedStepId: "b", error: "Error: Timeout 30000ms exceeded" },
    ];
    assertEqual(
      analyseFlake(twoSteps, twoDetails).clusters.length,
      2,
      "the same error on different steps stays two clusters",
    );

    // Genuinely different failures must not be collapsed by over-normalizing.
    const distinct = history("distinct", "FF");
    const distinctDetails: RunDetail[] = [
      { runId: distinct[0].id, failedStepId: "a", error: "Error: Timeout 30000ms exceeded" },
      { runId: distinct[1].id, failedStepId: "a", error: "Error: strict mode violation" },
    ];
    assertEqual(
      analyseFlake(distinct, distinctDetails).clusters.length,
      2,
      "different failures on the same step stay separate",
    );

    // A passing run has nothing to cluster.
    const passing = history("clean", "PP");
    assertEqual(
      analyseFlake(passing, [{ runId: passing[0].id, error: "Error: ignore me" }]).clusters.length,
      0,
      "a passing run is never clustered, whatever its log says",
    );
  }

  // ── error normalization ──────────────────────────────────────────────────
  assertEqual(
    errorSignature("Error: Timeout 30000ms exceeded"),
    errorSignature("Error: Timeout 5000ms exceeded"),
    "timeout durations normalize to the same signature",
  );
  assertEqual(
    errorSignature("Error at /Users/me/scripts/a1b2.spec.ts:12"),
    errorSignature("Error at /Users/you/other/c3d4.spec.ts:99"),
    "paths and line numbers normalize away",
  );
  assert(
    errorSignature("Error: Timeout exceeded") !== errorSignature("Error: element not visible"),
    "genuinely different messages keep different signatures",
  );
  assertEqual(errorSignature(undefined), "", "no error means no signature");
  assertEqual(
    errorSignature("Error: first line\nsecond line"),
    "Error: first line",
    "only the first line is used — stack frames vary and would defeat grouping",
  );

  // ── pulling the error out of a real-shaped log ───────────────────────────
  {
    const log = [
      "Running 1 test using 1 worker",
      "",
      "  1) checkout.spec.ts:3:1 › checkout ──────────",
      "",
      "    Error: Timeout 30000ms exceeded waiting for locator('#pay')",
      "",
      "       at checkout.spec.ts:12",
    ].join("\n");
    assert(
      (extractError(log) ?? "").startsWith("Error: Timeout"),
      `the failure line is found in a Playwright log (got ${JSON.stringify(extractError(log))})`,
    );
    assertEqual(
      extractError("Running 1 test\n\n  1 passed (2.0s)"),
      undefined,
      "a clean log yields no error rather than a guess",
    );
  }

  // ── empty input ──────────────────────────────────────────────────────────
  {
    const empty = analyseFlake([]);
    assertEqual(empty.tests.length, 0, "no runs means no tests");
    assertEqual(empty.clusters.length, 0, "no runs means no clusters");
    assertEqual(empty.analysedTests, 0, "no runs means nothing analysed");
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll flake-analysis checks passed");
}

main();
