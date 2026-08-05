// Types for mcp/debug-shots.mjs.
//
// The module itself is plain JavaScript because the MCP server runs under bare
// node with no build step. This declaration exists so the drift test in
// main/services/debug-capture.test.ts can import it from TypeScript and compare
// it against the app's implementation — which is the only thing keeping the two
// halves of the protocol in agreement.

export declare const DEBUG_DIRNAME: string;
export declare const REQUEST_FILE: string;
export declare const REQUEST_TIMEOUT_MS: number;
export declare const POLL_INTERVAL_MS: number;

export interface DebugShotRef {
  file: string;
  window: string;
  width?: number;
  height?: number;
}

export interface DebugSession {
  id: string;
  at: number;
  reason: "shortcut" | "request" | "manual";
  shots: DebugShotRef[];
  error?: string;
}

export declare function debugDir(dataDir: string): string;
export declare function responseFileFor(id: string): string;
export declare function shotFileFor(id: string, index: number): string;
export declare function isValidRequestId(id: unknown): boolean;
export declare function newCaptureId(): string;
export declare function listSessions(dataDir: string): DebugSession[];
export declare function readShots(
  dataDir: string,
  session: { shots: DebugShotRef[] },
  maxShots?: number,
): { window: string; width?: number; height?: number; base64: string }[];
export declare function requestCapture(
  dataDir: string,
  timeoutMs?: number,
): Promise<{ ok: true; session: DebugSession } | { ok: false; reason: string }>;
