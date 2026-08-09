// The flake analysis moved to shared/flake-analysis.mjs in Phase 4, so the MCP
// can serve the same stability verdicts the app's Stability panel shows. An MCP
// that re-derived "flaky" from its own rules would disagree with the screen the
// user is looking at, and neither would be obviously wrong.
//
// This file stays as the app's import site — the same shape strip-ansi.ts and
// run-comparison.ts have — so no backend caller moved and the existing tests
// point at the same specifier they always did.

export {
  analyseFlake,
  countTransitions,
  errorSignature,
  MIN_RUNS_FOR_VERDICT,
} from "../../shared/flake-analysis.mjs";

export type {
  FailureCluster,
  FlakeReport,
  RunDetail,
  StabilityVerdict,
  StepFlake,
  TestFlake,
} from "../../shared/flake-analysis.mjs";
