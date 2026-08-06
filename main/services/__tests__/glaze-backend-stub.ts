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

/** Inert file/message dialogs. A check drives the import pipeline with paths it
 *  supplies directly, so the picker must never actually open — cancelling is
 *  the honest stand-in for "the user was never asked". */
export const dialog = {
  async showOpenDialog(_options?: unknown): Promise<{ canceled: boolean; filePaths: string[] }> {
    return { canceled: true, filePaths: [] };
  },
  async showSaveDialog(_options?: unknown): Promise<{ canceled: boolean; filePath?: string }> {
    return { canceled: true };
  },
  async showMessageBox(_options?: unknown): Promise<{ response: number }> {
    return { response: 0 };
  },
  async showErrorBox(_title?: string, _content?: string): Promise<void> {},
};

/** Inert stand-in so modules that CAN post a notification are importable in a
 *  check. The checks drive the pure decision helper (buildRunNotice), not this
 *  — constructing one here must never try to reach the notification centre. */
export class Notification {
  constructor(_options?: { title?: string; body?: string }) {}
  show(): void {}
}

/** Stand-in for the encrypted-secret API.
 *
 *  The "encryption" below is a reversible marker, not a cipher. That's safe
 *  because the real protection is elsewhere: this stub only ever runs under a
 *  test whose userData points at a throwaway temp dir, so nothing it writes is
 *  a real secret in a real location.
 *
 *  Availability DEFAULTS TO FALSE so a test that doesn't think about secrets
 *  can't accidentally exercise a persistence path. Tests that need the save
 *  path (the IPC handler tests) opt in via setEncryptionAvailable(true). */
let encryptionAvailable = false;

/** Opt in to the fake-encrypted persistence path. Remember to reset it. */
export function setEncryptionAvailable(available: boolean): void {
  encryptionAvailable = available;
}

export const safeStorage = {
  async isEncryptionAvailable(): Promise<boolean> {
    return encryptionAvailable;
  },
  async encryptString(plain: string): Promise<Buffer> {
    return Buffer.from(`stub:${plain}`, "utf-8");
  },
  async decryptString(buf: Buffer): Promise<string> {
    return buf.toString("utf-8").replace(/^stub:/, "");
  },
};

/** Recording stand-in for `ipcMain`.
 *
 *  `registerHandlers()` is a big block of `ipcMain.handle(channel, fn)` calls
 *  with no other way in: without capturing those registrations there's no way
 *  to exercise the IPC layer at all. Tests call `invokeHandler(channel, params)`
 *  to run one exactly as the renderer would. */
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

export const ipcMain = {
  handle(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void {
    handlers.set(channel, fn);
  },
  removeHandler(channel: string): void {
    handlers.delete(channel);
  },
  on(): void {},
};

/** Channels registered so far — lets a test assert the surface exists. */
export function registeredChannels(): string[] {
  return [...handlers.keys()].sort();
}

/** Invoke a registered handler the way the renderer would. Throws a clear error
 *  for an unknown channel rather than a confusing "fn is not a function". */
export async function invokeHandler<T = unknown>(channel: string, params?: unknown): Promise<T> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No IPC handler registered for "${channel}"`);
  return (await fn({}, params)) as T;
}

export function clearHandlers(): void {
  handlers.clear();
}
