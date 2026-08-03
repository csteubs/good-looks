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
