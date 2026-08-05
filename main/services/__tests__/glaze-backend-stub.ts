// Test-only stand-in for `@glaze/core/backend`, used by the standalone
// end-to-end check. `@glaze/core/backend` only resolves through Glaze's
// runtime ESM hooks (not plain node/esbuild), so the check bundles with
// `--alias:@glaze/core/backend=<this file>`. It provides just the two symbols
// the visual-pipeline stores touch: `app.getPath` (points at a throwaway temp
// dir chosen by the check via GLAZE_TEST_USERDATA) and a no-op `logger`.
//
// This is NEVER imported by app code — only by the aliased check bundle.

import * as os from "os";
import * as path from "path";

// Resolved lazily on every call so the check can set GLAZE_TEST_USERDATA in its
// body (after these imports initialize) and still have the stores land there.
export const app = {
  getPath(_key: string): string {
    return (
      process.env.GLAZE_TEST_USERDATA ?? path.join(os.tmpdir(), "glaze-visual-pipeline-check")
    );
  },
};

const noop = (..._args: unknown[]): void => {};
export const logger = { info: noop, warn: noop, error: noop, debug: noop };

/** Inert stand-in so modules that CAN post a notification are importable in a
 *  check. The checks drive the pure decision helper (buildRunNotice), not this
 *  — constructing one here must never try to reach the notification centre. */
export class Notification {
  constructor(_options?: { title?: string; body?: string }) {}
  show(): void {}
}

/** Stand-in for the encrypted-secret API. Reports encryption as UNAVAILABLE so
 *  a check can never accidentally write a real secret to disk; the "encryption"
 *  below is a reversible marker, not a cipher, and exists only so importing
 *  webhook-url-store / anthropic-key-store doesn't blow up in a bundle. The
 *  checks drive those stores' PURE helpers (validateWebhookUrl, hostOfUrl),
 *  never their persistence. */
export const safeStorage = {
  async isEncryptionAvailable(): Promise<boolean> {
    return false;
  },
  async encryptString(plain: string): Promise<Buffer> {
    return Buffer.from(`stub:${plain}`, "utf-8");
  },
  async decryptString(buf: Buffer): Promise<string> {
    return buf.toString("utf-8").replace(/^stub:/, "");
  },
};
