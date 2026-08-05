// Standalone regression check for the Stats run-history filters.
//
// The Stats table filters on three independent axes (status, tag, test), and
// the tricky case is baseline-update rows: they are not test runs, so they must
// be reachable ONLY via status "baseline" (never counted as passed/failed) and
// must be excluded by any tag filter, since they carry no browser/headless/
// capture tags. This check pins that behavior plus the neutral-"all" semantics.
//
// No test runner exists in this project (see package.json) — plain assertions +
// a non-zero exit code on failure stand in for one. Run with:
//   npx tsx main/services/__tests__/run-filters.check.ts

import type { RunRecord } from "../../../renderer/lib/recorder-types";
import {
  NO_FILTERS,
  filtersActive,
  runMatchesFilters,
  testFilterOptions,
  type RunFilters,
} from "../../../renderer/lib/run-filters";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function run(over: Partial<RunRecord>): RunRecord {
  return {
    id: "r1",
    testId: "t1",
    testName: "Test One",
    url: "https://example.com",
    status: "passed",
    exitCode: 0,
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    logFile: "r1.log",
    logBytes: 10,
    ...over,
  };
}

const f = (over: Partial<RunFilters>): RunFilters => ({ ...NO_FILTERS, ...over });

// ── Neutral state ────────────────────────────────────────────────────
assert(!filtersActive(NO_FILTERS), "NO_FILTERS is not active");
assert(filtersActive(f({ status: "failed" })), "a status filter counts as active");
assert(filtersActive(f({ tag: "headless" })), "a tag filter counts as active");
assert(filtersActive(f({ test: "t1" })), "a test filter counts as active");

const passedRun = run({ status: "passed" });
const failedRun = run({ id: "r2", status: "failed" });
const baselineRun = run({ id: "r3", kind: "baseline-update", status: "passed" });

assert(
  [passedRun, failedRun, baselineRun].every((r) => runMatchesFilters(r, NO_FILTERS)),
  "no filters matches every run",
);

// ── Status ───────────────────────────────────────────────────────────
assert(runMatchesFilters(passedRun, f({ status: "passed" })), "status=passed matches a passed run");
assert(!runMatchesFilters(failedRun, f({ status: "passed" })), "status=passed excludes a failed run");
assert(runMatchesFilters(failedRun, f({ status: "failed" })), "status=failed matches a failed run");

// The critical case: a baseline row whose incidental `status` is "passed" must
// NOT show up under the passed filter — it isn't a test run.
assert(
  !runMatchesFilters(baselineRun, f({ status: "passed" })),
  "status=passed excludes a baseline-update row (even one marked passed)",
);
assert(
  !runMatchesFilters(baselineRun, f({ status: "failed" })),
  "status=failed excludes a baseline-update row",
);
assert(
  runMatchesFilters(baselineRun, f({ status: "baseline" })),
  "status=baseline matches a baseline-update row",
);
assert(
  !runMatchesFilters(passedRun, f({ status: "baseline" })),
  "status=baseline excludes a real run",
);

// ── Tags ─────────────────────────────────────────────────────────────
const headlessRun = run({ id: "r4", runHeadless: true });
const browserRun = run({ id: "r5", runHeadless: false });
const legacyRun = run({ id: "r6" }); // runHeadless undefined — pre-feature runs
const capturedRun = run({ id: "r7", captureArtifacts: true });

assert(runMatchesFilters(headlessRun, f({ tag: "headless" })), "tag=headless matches a headless run");
assert(!runMatchesFilters(browserRun, f({ tag: "headless" })), "tag=headless excludes a headed run");
assert(runMatchesFilters(browserRun, f({ tag: "headed" })), "tag=headed matches a headed run");
assert(!runMatchesFilters(headlessRun, f({ tag: "headed" })), "tag=headed excludes a headless run");
assert(
  runMatchesFilters(legacyRun, f({ tag: "headed" })),
  "tag=headed matches a run predating runHeadless (undefined = headed, as the table shows it)",
);
assert(runMatchesFilters(capturedRun, f({ tag: "captured" })), "tag=captured matches a capture run");
assert(
  !runMatchesFilters(passedRun, f({ tag: "captured" })),
  "tag=captured excludes a run with no artifacts",
);
for (const tag of ["headed", "headless", "captured", "firefox"] as const) {
  assert(
    !runMatchesFilters(baselineRun, f({ tag })),
    `tag=${tag} excludes baseline-update rows (they carry no tags)`,
  );
}

// ── Browser engine (same axis as the mode/capture tags) ──────────────
const firefoxRun = run({ id: "r9", runBrowser: "firefox" });
const webkitRun = run({ id: "r10", runBrowser: "webkit" });

assert(runMatchesFilters(firefoxRun, f({ tag: "firefox" })), "tag=firefox matches a Firefox run");
assert(!runMatchesFilters(webkitRun, f({ tag: "firefox" })), "tag=firefox excludes a WebKit run");
assert(runMatchesFilters(webkitRun, f({ tag: "webkit" })), "tag=webkit matches a WebKit run");
// Runs predating the picker have no runBrowser — they all ran on chromium, so
// they must still be reachable under the chromium filter.
assert(
  runMatchesFilters(legacyRun, f({ tag: "chromium" })),
  "tag=chromium matches a run predating the browser picker (undefined = chromium)",
);
assert(
  !runMatchesFilters(firefoxRun, f({ tag: "chromium" })),
  "tag=chromium excludes a Firefox run",
);
// Engine and mode are independent properties even though they share the axis:
// a Firefox run is still headed/headless.
assert(
  runMatchesFilters(run({ runBrowser: "firefox", runHeadless: true }), f({ tag: "headless" })),
  "a Firefox run is still matched by tag=headless",
);

// ── Test ─────────────────────────────────────────────────────────────
const otherTest = run({ id: "r8", testId: "t2", testName: "Test Two" });
assert(runMatchesFilters(passedRun, f({ test: "t1" })), "test filter matches its own test");
assert(!runMatchesFilters(otherTest, f({ test: "t1" })), "test filter excludes another test");

// ── Axes combine (AND, not OR) ───────────────────────────────────────
assert(
  runMatchesFilters(run({ status: "failed", runHeadless: true }), f({ status: "failed", tag: "headless", test: "t1" })),
  "all three axes match together",
);
assert(
  !runMatchesFilters(run({ status: "failed", runHeadless: false }), f({ status: "failed", tag: "headless" })),
  "one failing axis rejects the run (AND semantics)",
);

// ── Test options ─────────────────────────────────────────────────────
const opts = testFilterOptions([
  run({ testId: "b", testName: "Beta" }),
  run({ testId: "a", testName: "Alpha" }),
  run({ testId: "b", testName: "Beta" }),
]);
assert(opts.length === 2, `testFilterOptions dedupes by testId (got ${opts.length})`);
assert(opts[0].name === "Alpha" && opts[1].name === "Beta", "testFilterOptions sorts by name");
assert(testFilterOptions([]).length === 0, "testFilterOptions handles an empty history");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll run-filters checks passed");
