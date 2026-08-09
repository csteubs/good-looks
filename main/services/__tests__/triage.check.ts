// Standalone regression check for the triage classifier.
//
// WHY THIS EXISTS. Triage is the one feature in this app whose failure mode is
// being CONFIDENTLY WRONG. Every other subsystem either works or throws; this
// one hands somebody a verdict and a next step, and a wrong verdict during a
// real outage sends them to the wrong team with a citation. Nothing about that
// looks broken on screen — the panel renders, the confidence is high, the
// evidence list is full of true statements pointing the wrong way.
//
// So each row of the plan's signal table is pinned HERE, in BOTH directions:
// the signal fires when its condition holds, and — the half that actually
// catches regressions — it does NOT fire when the condition does not. A rule
// that always fires is invisible in a suite that only tests the positive case,
// and it degrades every verdict it appears in.
//
// Four properties beyond the table, each a rule from the plan:
//
//   1. `unknown` is reachable and honest. A run with no artifacts and no
//      siblings must not be classified from pass/fail alone.
//   2. Never fatal, asserted at SOURCE level like check:ai-debug-scroll: the
//      classifier must not contain the machinery to change a run's status. A
//      behavioural test cannot prove this — it can only prove the code paths it
//      happened to walk.
//   3. Arguments from ABSENCE are suppressed when the capture was lossy. This
//      is the subtlest one: the per-run console/network cap discards whole
//      steps' worth of entries on a busy site, and "no failing request on that
//      step" then means "we threw the requests away".
//   4. The two cross-run signals are mutually exclusive. "Fails on every
//      engine" and "fails on one engine only" citing the same run would be an
//      unfalsifiable classifier.
//
// Run with: npm run check:triage

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { triageRun } from "../../../shared/triage.mjs";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

/** Did this signal fire, whichever way it points? */
function fired(result: { evidence: { signal: string }[] }, signal: string): boolean {
  return result.evidence.some((e) => e.signal === signal);
}

function direction(
  result: { evidence: { signal: string; direction: string }[] },
  signal: string,
): string | null {
  return result.evidence.find((e) => e.signal === signal)?.direction ?? null;
}

// ── Fixtures ──────────────────────────────────────────────────────────
//
// A failed run with capture, one failing step, and nothing else interesting.
// Every case below is this plus exactly one changed field, so a signal that
// fires can only have fired for the reason under test.

type Run = Record<string, unknown>;
type Step = Record<string, unknown>;

function baseRun(over: Run = {}): Run {
  return {
    id: "run-1",
    test_id: "test-1",
    test_name: "Checkout",
    status: "failed",
    kind: "run",
    started_at: 1_000,
    duration_ms: 5_000,
    browser: "chromium",
    healed_steps: 0,
    heal_failed_steps: 0,
    has_artifacts: true,
    console_dropped: 0,
    network_dropped: 0,
    failed_step_id: "step-2",
    error_signature: "Error: expect(received).toBe(expected)",
    ...over,
  };
}

function steps(over: Step = {}): Step[] {
  return [
    { run_id: "run-1", step_index: 0, step_id: "step-1", status: "passed", healed: 0 },
    {
      run_id: "run-1",
      step_index: 1,
      step_id: "step-2",
      label: "Click Pay",
      status: "failed",
      healed: 0,
      ...over,
    },
  ];
}

/** The whole run, its steps and its cohort, in one call. */
function triage(over: Run = {}, stepOver: Step = {}, siblings: Run[] = [], stepHistory = null) {
  return triageRun({
    run: baseRun(over) as never,
    steps: steps(stepOver) as never,
    siblings: siblings as never,
    stepHistory,
  });
}

// ── Site signals, in both directions ──────────────────────────────────

{
  const hit = triage({}, { net_worst_status: 503 });
  assert(direction(hit, "server-error") === "site", "5xx on the failing step points at the site");
  assert(hit.verdict === "site", "a 5xx with nothing against it yields a site verdict");

  const miss = triage({}, { net_worst_status: 204 });
  assert(!fired(miss, "server-error"), "a 2xx on the failing step is not a server error");
}

{
  const hit = triage({}, { net_worst_api_status: 422 });
  assert(direction(hit, "api-error") === "site", "4xx on a non-navigational request is site-ward");

  // The split that makes the signal usable: a 4xx on a NAVIGATION is a page a
  // test may legitimately be asserting on, and only the API column is evidence.
  const miss = triage({}, { net_worst_status: 404 });
  assert(!fired(miss, "api-error"), "a 404 navigation alone does not raise an API error");

  const both = triage({}, { net_worst_status: 500, net_worst_api_status: 500 });
  assert(
    !fired(both, "api-error"),
    "one broken request is not counted twice as both a 5xx and a 4xx",
  );
}

{
  const hit = triage({}, { console_page_errors: 2 });
  assert(direction(hit, "page-error") === "site", "a pageerror on the failing step is site-ward");

  const miss = triage({}, { console_errors: 9, console_page_errors: 0 });
  assert(
    !fired(miss, "page-error"),
    "console.error lines are not page errors — healthy sites emit them",
  );
}

{
  const hit = triage({}, { heal_failed: "exhausted" });
  assert(
    direction(hit, "heal-exhausted") === "site",
    "a heal that tried every candidate and failed is site-ward",
  );

  const other = triage({}, { healed: 1 });
  assert(
    direction(other, "heal-succeeded") === "runner",
    "a heal that SUCCEEDED is runner-ward — the element existed",
  );
  assert(
    !fired(other, "heal-exhausted"),
    "a successful heal does not also count as an exhausted one",
  );
}

{
  const hit = triage({}, { diff_state: "changed" });
  assert(direction(hit, "visual-changed") === "site", "a visual change on the failing step is site-ward");

  const miss = triage({}, { diff_state: "same" });
  assert(!fired(miss, "visual-changed"), "an unchanged screenshot raises nothing");
}

// ── Runner signals, in both directions ────────────────────────────────

{
  const hit = triage({ test_timeout_ms: 30_000 }, { ms: 29_500 });
  assert(
    direction(hit, "timeout-budget") === "runner",
    "a step that ran out the test's timeout points at the budget, not the page",
  );

  const miss = triage({ test_timeout_ms: 30_000 }, { ms: 4_000 });
  assert(!fired(miss, "timeout-budget"), "a step well inside the budget raises nothing");

  const noBudget = triage({ test_timeout_ms: undefined }, { ms: 29_500 });
  assert(
    !fired(noBudget, "timeout-budget"),
    "without a known timeout the proximity cannot be judged, so it is not claimed",
  );
}

{
  const hit = triage({}, {}, [], { heals: 4, healFailures: 0, runs: 12 } as never);
  assert(
    direction(hit, "chronic-healing") === "runner",
    "a step healed repeatedly before is locator decay",
  );

  const miss = triage({}, {}, [], { heals: 1, healFailures: 0, runs: 12 } as never);
  assert(!fired(miss, "chronic-healing"), "a single past heal is not chronic");

  const none = triage();
  assert(!fired(none, "chronic-healing"), "no step history means no claim about decay");
}

// ── The argument from absence, and its gate ───────────────────────────

{
  const wait = { error_signature: "TimeoutError: locator.click: Timeout <ms> exceeded" };

  const hit = triage(wait, { net_worst_status: 200, console_page_errors: 0 });
  assert(
    direction(hit, "clean-wait") === "runner",
    "a wait that timed out while the page stayed healthy points at the locator",
  );

  // The whole point of the dropped counters. Same run, same clean columns, but
  // the capture threw entries away — so the cleanliness is not observed.
  const lossy = triage(
    { ...wait, network_dropped: 1_861 },
    { net_worst_status: 200, console_page_errors: 0 },
  );
  assert(
    !fired(lossy, "clean-wait"),
    "a lossy network capture withdraws the clean-wait claim rather than making it",
  );
  assert(
    lossy.limits.some((l) => l.includes("1861") || l.includes("lossy")),
    "and it says so in limits rather than silently dropping the signal",
  );

  const noisy = triage(wait, { net_worst_status: 500 });
  assert(!fired(noisy, "clean-wait"), "a wait alongside a 5xx is not a clean wait");
}

// ── Cross-run signals, and their mutual exclusivity ───────────────────

{
  const allEngines = triage({}, {}, [
    baseRun({ id: "r2", browser: "firefox", status: "failed" }),
    baseRun({ id: "r3", browser: "webkit", status: "failed" }),
  ]);
  assert(direction(allEngines, "all-engines") === "site", "failing on every engine is site-ward");
  assert(
    !fired(allEngines, "single-engine"),
    "and it does not also fire the single-engine signal — they must be exclusive",
  );

  const oneEngine = triage({}, {}, [
    baseRun({ id: "r2", browser: "firefox", status: "passed" }),
    baseRun({ id: "r3", browser: "webkit", status: "passed" }),
  ]);
  assert(
    direction(oneEngine, "single-engine") === "runner",
    "failing on one engine while others pass is runner-ward",
  );
  assert(!fired(oneEngine, "all-engines"), "and it does not also claim every engine fails");

  // The easiest possible bug in this file: concluding "fails on every engine"
  // from a cohort that only ever ran on one.
  const single = triage({}, {}, [baseRun({ id: "r2", browser: "chromium", status: "failed" })]);
  assert(
    !fired(single, "all-engines"),
    "one engine tried is not every engine tried, however many runs it has",
  );
}

{
  const allRows = triage({ dataset_id: "row-1" }, {}, [
    baseRun({ id: "r2", dataset_id: "row-2", status: "failed" }),
  ]);
  assert(direction(allRows, "all-datasets") === "site", "failing on every dataset row is site-ward");

  const oneRow = triage({ dataset_id: "row-1", dataset_name: "Bad card" }, {}, [
    baseRun({ id: "r2", dataset_id: "row-2", status: "passed" }),
  ]);
  assert(
    direction(oneRow, "single-dataset") === "runner",
    "failing on one dataset row while others pass is the data, not the site",
  );
  assert(!fired(oneRow, "all-datasets"), "and the two dataset signals are exclusive");
}

{
  const captureOnly = triage({ capture_ms: 4_000 }, {}, [
    baseRun({ id: "r2", capture_ms: undefined, status: "passed" }),
  ]);
  assert(
    direction(captureOnly, "capture-only") === "runner",
    "failing only when capture is on is instrumentation overhead",
  );

  const both = triage({ capture_ms: 4_000 }, {}, [
    baseRun({ id: "r2", capture_ms: undefined, status: "failed" }),
  ]);
  assert(
    !fired(both, "capture-only"),
    "failing with capture off too is not a capture problem",
  );
}

// ── `unknown` is first-class ──────────────────────────────────────────

{
  const blind = triageRun({
    run: baseRun({ has_artifacts: false, error_signature: "" }) as never,
    steps: [],
    siblings: [],
  });
  assert(
    blind.verdict === "unknown",
    "a run with no artifacts and no siblings is unknown, not guessed from status",
  );
  assert(blind.confidence === 0, "and its confidence is zero rather than a low number");
  assert(
    blind.limits.some((l) => l.includes("captured no artifacts")),
    "and it says why it cannot tell",
  );
  assert(
    blind.suggestedNext.length > 0 && !blind.suggestedNext.includes("unknown"),
    "and it still suggests something actionable rather than restating the verdict",
  );

  // Loaded deliberately: a 5xx, a page error and a cohort that would all fire
  // if this run were classified. An empty fixture here would pass whether the
  // guard existed or not — which is what it did before a mutation said so.
  const passed = triageRun({
    run: baseRun({ status: "passed" }) as never,
    steps: steps({ net_worst_status: 503, console_page_errors: 2 }) as never,
    siblings: [baseRun({ id: "r2", browser: "firefox", status: "failed" })] as never,
  });
  assert(
    passed.verdict === "unknown" && passed.evidence.length === 0,
    "a passed run is not classified even when its steps carry signals that would fire",
  );

  const missing = triageRun({ run: null });
  assert(missing.verdict === "unknown", "a missing run is unknown rather than a throw");
}

// ── Mixed, confidence, and evidence ordering ──────────────────────────

{
  // A stale locator on a page that also started erroring — the most common real
  // shape, and the one a two-way classifier is most likely to force.
  const mixed = triage({}, { console_page_errors: 1, healed: 1 });
  assert(mixed.verdict === "mixed", "strong evidence both ways is mixed, not a coin toss");
  assert(
    mixed.evidence.length === 2,
    "and mixed keeps both sides' evidence rather than discarding the loser",
  );

  const strong = triage({}, { net_worst_status: 503, console_page_errors: 3 });
  const weak = triage({}, { diff_state: "changed" });
  assert(
    strong.confidence > weak.confidence,
    "two strong site signals beat one weak one on confidence",
  );
  assert(strong.confidence <= 0.95, "confidence is never certainty");
  assert(
    strong.evidence[0].signal === "server-error" || strong.evidence[0].signal === "page-error",
    "evidence is strongest-first, so a truncated read still gets the load-bearing part",
  );

  // Limits must cost confidence whichever way the verdict points: the evidence
  // that was discarded had no reason to favour one side.
  const clean = triage({ network_dropped: 0 }, { net_worst_status: 503 });
  const lossy = triage({ network_dropped: 900 }, { net_worst_status: 503 });
  assert(
    lossy.confidence < clean.confidence,
    "a lossy capture lowers confidence even when the verdict is unchanged",
  );
  assert(lossy.verdict === clean.verdict, "without changing what the evidence says");
}

// ── Never fatal, at source level ──────────────────────────────────────

{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../../../shared/triage.mjs"), "utf-8");

  // The same shape as a11y-diff's assertion. A behavioural test proves only the
  // paths it walks; this proves the machinery is absent.
  assert(
    !/\brunStatus\b/.test(src),
    "the classifier does not mention runStatus — it cannot change a run's outcome",
  );
  assert(
    !/\bexitCode\b/.test(src),
    "and it does not reason about exit codes",
  );
  assert(
    !/\bthrow\b/.test(src),
    "and it never throws — a classifier that can fail a caller gets switched off",
  );

  // Pure, per shared/'s admission rule. A static import of any of these would
  // break the MCP, which loads this module with no build step.
  assert(
    !/require\(|from "node:|from "fs"|@glaze\/core/.test(src),
    "and it imports nothing — shared/ is pure by rule, and this file has no dependencies at all",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll triage checks passed.");
