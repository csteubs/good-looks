// Hand-written types for a11y-rollup.mjs. See the module header for why this
// is a `.mjs` with a `.d.mts` beside it rather than a `.ts`: the app compiles
// and bundles, the MCP server is plain ESM with no build step, and this keeps
// `npm run type-check` a real gate over every TypeScript caller.

export type A11yImpact = "critical" | "serious" | "moderate" | "minor";

export declare const IMPACTS: readonly A11yImpact[];

export declare function violationKey(id: string, target: string): string;

export declare function keysOf(v: { id: string; nodes?: string[] }): string[];

export declare function gateFailures(
  violations: { id: string; impact?: string; help?: string; nodes?: string[] }[],
  minImpact: string,
  baselineKeys: string[],
): { id: string; impact: string; help: string; nodes: string[] }[];

export declare function selectLatestA11yRuns<
  T extends { testId: string; startedAt: number; kind?: string; a11yChecks?: number },
>(runs: readonly T[]): T[];

/** One place a rule fired: the step, and the run and test it belongs to. */
export interface A11yRuleSite {
  testId: string;
  testName: string | null;
  runId: string;
  startedAt: number;
  stepId: string | null;
  stepLabel: string | null;
  index: number;
  /** offending nodes of this rule on this step that are NOT accepted */
  nodes: number;
}

export interface A11yRuleRollup {
  /** axe rule id, e.g. "color-contrast" */
  id: string;
  impact: A11yImpact;
  /** axe's short help text, falling back to the rule id */
  help: string;
  /** steps carrying a new violation of this rule */
  steps: number;
  /** offending nodes across those steps */
  nodes: number;
  where: A11yRuleSite[];
}

export interface A11yRollup {
  /** runs rolled up — one per test that has ever completed checks */
  checkedRuns: number;
  /** steps carrying at least one unaccepted violation, counted once each */
  stepsWithNew: number;
  /** per-impact totals. These OVERLAP — a step with a critical and a moderate
   *  violation is in both — so they deliberately do not sum to `stepsWithNew`. */
  byImpact: { impact: A11yImpact; steps: number; rules: number }[];
  /** worst impact first, then most steps */
  rules: A11yRuleRollup[];
}

export declare function rollupA11y(
  runs: readonly {
    testId: string;
    testName?: string | null;
    runId: string;
    startedAt?: number;
    steps: readonly {
      stepId?: string;
      label?: string | null;
      index?: number;
      a11y?: {
        violations?: { id: string; impact: string; help?: string; nodes?: string[] }[];
        newKeys?: string[];
      };
    }[];
  }[],
): A11yRollup;
