// Types for select-tests.mjs.
//
// The MCP server is plain ESM JavaScript on purpose — it runs standalone via
// `node mcp/server.mjs`, with no build step and without the app. This
// declaration exists so TypeScript checks (notably check:batch-runner, which
// imports summarizeResults to pin app↔MCP parity) can consume it with types
// instead of `any`.

export declare const UNTAGGED: "__untagged__";

export interface McpTestRecord {
  id: string;
  name: string;
  tags?: string[];
  hidden?: boolean;
  [key: string]: unknown;
}

export interface McpSelection {
  tests: McpTestRecord[];
  /** explicitly-requested ids that don't exist */
  missing: string[];
}

export declare function selectTests(
  tests: McpTestRecord[] | undefined,
  selector?: { testIds?: string[]; tag?: string },
): McpSelection;

export interface McpBatchSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  ok: boolean;
  durationMs: number;
}

export declare function summarizeResults(
  results: { status: string }[],
  durationMs: number,
): McpBatchSummary;
