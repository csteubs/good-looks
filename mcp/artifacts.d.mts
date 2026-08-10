// Hand-written types for artifacts.mjs.
//
// The MCP server is plain .mjs with no build step, so these cannot be inferred
// — but a TypeScript caller exists (check:run-logs imports this module to prove
// the app's reader and this one agree about the same files on disk), and
// `type-check` is the only gate over a bundled check. See CLAUDE.md on the
// .mjs + .d.mts pairing.
//
// The shapes are deliberately loose where the data is: everything read here
// comes off disk as JSON written by an earlier build of the app, so an older
// run legitimately lacks fields a newer one has.

export function artifactsRoot(dataDir: string): string;

export function runDir(dataDir: string, testId: string, runId: string): string;

export function readReplay(dataDir: string, testId: string, runId: string): unknown | null;

export function readManifest(dataDir: string, testId: string, runId: string): unknown | null;

export interface McpRunLogs {
  console: Record<string, unknown>[];
  network: Record<string, unknown>[];
  consoleDropped: number;
  networkDropped: number;
  headersFiltered: boolean;
}

export function readRunLogs(
  dataDir: string,
  testId: string,
  runId: string,
): McpRunLogs | null;

/** One element a failing locator resolved to. Page-authored, every field. */
export interface McpStepMatch {
  index?: number;
  tag?: string;
  id?: string;
  testid?: string;
  ariaLabel?: string;
  text?: string;
  classes?: string[];
  ancestors?: string[];
  visible?: boolean;
  enabled?: boolean;
  rect?: { x: number; y: number; w: number; h: number };
}

/** One failing step, joined from the run's two page-structure files.
 *  `matches` is what the locator literally resolved to; `candidates` is what
 *  Auto-Heal thought resembled the element the step wanted. */
export interface McpStepStructure {
  stepIndex: number;
  stepLabel?: string;
  method?: string;
  originalLocator?: unknown;
  matchCount?: number;
  matches: McpStepMatch[];
  outcome?: "exhausted" | "no-candidates";
  candidates: Record<string, unknown>[];
}

export function readStepStructures(
  dataDir: string,
  testId: string,
  runId: string,
): McpStepStructure[] | null;

export function listRunDirs(dataDir: string, testId: string): { id: string; at: number }[];
