// Test-only stand-in for `@shell/backend`, used by the standalone
// end-to-end check. `@shell/backend` only resolves through Glaze's
// runtime ESM hooks (not plain node/esbuild), so the check bundles with
// `--alias:@shell/backend=<this file>`. It provides just the two symbols
// the visual-pipeline stores touch: `app.getPath` (points at a throwaway temp
// dir chosen by the check via GLAZE_TEST_USERDATA) and a no-op `logger`.
//
// This is NEVER imported by app code — only by the aliased check bundle.

import * as os from "os";
import * as path from "path";

// Resolved lazily on every call so the check can set GLAZE_TEST_USERDATA in its
// body (after these imports initialize) and still have the stores land there.
//
// `setPath` overrides that for the rest of the process, mirroring Electron's
// own semantics — it exists so `installUserDataPath()` (shell/user-data.ts) can
// be driven under test rather than only its pure helpers. An override always
// wins over GLAZE_TEST_USERDATA, since a caller that set a path explicitly
// meant it.
const overrides = new Map<string, string>();

export const app = {
  getPath(key: string): string {
    const override = overrides.get(key);
    if (override !== undefined) return override;
    return (
      process.env.GLAZE_TEST_USERDATA ?? path.join(os.tmpdir(), "glaze-visual-pipeline-check")
    );
  },
  setPath(key: string, value: string): void {
    overrides.set(key, value);
  },
  /** Test-only: forget every override, so one test cannot leak into the next. */
  __resetPaths(): void {
    overrides.clear();
  },

  // ── Launch identity, for the branch switcher ────────────────────────
  // `isPackaged` DEFAULTS TO FALSE, matching a checkout — the state in which
  // that feature is available. A test that wants the packaged branch sets it.
  isPackaged: false,
  getAppPath(): string {
    return appPathOverride ?? process.cwd();
  },
  /** A recognizably fake version, so a test that forgot to inject its own
   *  cannot mistake the stub's answer for the app's. */
  getVersion(): string {
    return "0.0.0-test";
  },
  /** Records rather than performs. A test asserting on a relaunch must never
   *  actually restart anything, and `relaunched` is the only way to see that
   *  the switcher got as far as scheduling one. */
  relaunch(options?: { args?: string[] }): void {
    relaunched.push(options?.args ?? []);
  },
  quit(): void {
    quitCalls++;
  },
  /** Inert event surface. proxy-service registers a `login` listener at init;
   *  nothing in a check ever emits one. */
  on(_event: string, _listener: (...args: unknown[]) => void): void {},
};

let appPathOverride: string | null = null;
const relaunched: string[][] = [];
let quitCalls = 0;

/** Test-only controls for the launch identity above. */
export function setAppPath(dir: string | null): void {
  appPathOverride = dir;
}
export function setPackaged(packaged: boolean): void {
  app.isPackaged = packaged;
}
export function relaunchCalls(): string[][] {
  return relaunched.map((args) => [...args]);
}
export function quitCallCount(): number {
  return quitCalls;
}
export function resetLaunchState(): void {
  appPathOverride = null;
  app.isPackaged = false;
  relaunched.length = 0;
  quitCalls = 0;
}

const noop = (..._args: unknown[]): void => {};
export const logger = { info: noop, warn: noop, error: noop, debug: noop };

/** What the next directory picker answers with.
 *
 *  DEFAULTS TO A CANCEL, so a check that never thinks about the picker cannot
 *  accidentally start an import — cancelling is the honest stand-in for "the
 *  user was never asked". A check that wants the import pipeline itself, which
 *  is reachable no other way (`importFound` is private and `importFromFiles` is
 *  the only path that writes a record), says so by setting a folder here. */
let openDialogResult: { canceled: boolean; filePaths: string[] } = {
  canceled: true,
  filePaths: [],
};

/** Answer the next `showOpenDialog` with `dir`, or `null` to go back to
 *  cancelling. Remember to reset it. */
export function setOpenDialogResult(dir: string | null): void {
  openDialogResult = dir ? { canceled: false, filePaths: [dir] } : { canceled: true, filePaths: [] };
}

/** Inert file/message dialogs. A check drives the import pipeline with paths it
 *  supplies directly, so the picker must never actually open. */
export const dialog = {
  async showOpenDialog(_options?: unknown): Promise<{ canceled: boolean; filePaths: string[] }> {
    return openDialogResult;
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

/**
 * Inert window and display stand-ins.
 *
 * check:trainer-panel imports `trainer-panel-window.ts` for its FOLLOW_EVENTS
 * list, which drags in `BrowserWindow` and `screen`. The check reads SOURCE and
 * never opens anything, so these exist only to make the module importable —
 * constructing a window here must never reach the native host.
 *
 * `screen` returns a plausible display so that if a future check does call the
 * geometry helpers, it gets arithmetic rather than a crash.
 */
export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return [];
  }
  constructor(_options?: unknown) {}
  isDestroyed(): boolean {
    return true;
  }
  on(): this {
    return this;
  }
  once(): this {
    return this;
  }
  show(): void {}
  hide(): void {}
  close(): void {}
  setBounds(_bounds?: unknown): void {}
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 1200, height: 820 };
  }
  async loadURL(_url: string): Promise<void> {}
  contentView = { addChildView(_view?: unknown): void {}, removeChildView(_view?: unknown): void {} };
}

/**
 * Inert `WebContentsView` stand-in, same contract as the window above: it exists
 * so a check that imports `recorder-service.ts` can link, not so anything runs.
 * The recorder's page now lives in one of these, so a check reaching the real
 * class would try to spawn a renderer inside a plain node bundle.
 */
export class WebContentsView {
  constructor(_options?: unknown) {}
  webContents = {
    id: 0,
    on(): void {},
    once(): void {},
    removeAllListeners(): void {},
    setWindowOpenHandler(): void {},
    getURL(): string {
      return "";
    },
    getZoomFactor(): number {
      return 1;
    },
    setZoomFactor(_factor: number): void {},
    focus(): void {},
    isDestroyed(): boolean {
      return true;
    },
    close(): void {},
    async loadURL(_url: string): Promise<void> {},
    async executeJavaScriptInIsolatedWorld(): Promise<unknown> {
      return undefined;
    },
    sendInputEvent(_event?: unknown): void {},
    session: {
      setPermissionRequestHandler(): void {},
      setPermissionCheckHandler(): void {},
      // The proxy trio, recorded like the standalone stub sessions above —
      // recorder-service applies the proxy to this session before the first
      // navigation, and a check that constructs a session must not throw there.
      async setProxy(config: unknown): Promise<void> {
        proxyCalls.push(config);
      },
      setCertificateVerifyProc(_proc: unknown): void {},
      async resolveProxy(_url: string): Promise<string> {
        return "DIRECT";
      },
      cookies: {
        async get() {
          return [];
        },
        async set() {},
        async remove() {},
      },
    },
  };
  setBounds(_bounds?: unknown): void {}
  setBackgroundColor(_color?: string): void {}
}

/**
 * Inert `session` stand-in, one shared shape for the default session and any
 * partition. `setProxy` calls are RECORDED (see `sessionProxyCalls`) so a test
 * can assert what configuration would have reached Chromium; `resolveProxy`
 * answers DIRECT, which is what a machine with no OS proxy says.
 */
interface StubSession {
  setProxy(config: unknown): Promise<void>;
  setCertificateVerifyProc(proc: unknown): void;
  resolveProxy(url: string): Promise<string>;
  closeAllConnections(): Promise<void>;
}

const proxyCalls: unknown[] = [];

function makeStubSession(): StubSession {
  return {
    async setProxy(config: unknown): Promise<void> {
      proxyCalls.push(config);
    },
    setCertificateVerifyProc(_proc: unknown): void {},
    async resolveProxy(_url: string): Promise<string> {
      return "DIRECT";
    },
    async closeAllConnections(): Promise<void> {},
  };
}

export const session = {
  defaultSession: makeStubSession(),
  fromPartition: (_partition: string): StubSession => makeStubSession(),
};

/** Every `setProxy` config any stub session has been handed, oldest first. */
export function sessionProxyCalls(): unknown[] {
  return [...proxyCalls];
}

export function clearSessionProxyCalls(): void {
  proxyCalls.length = 0;
}

/** `net.request` has no inert stand-in that wouldn't lie — a check that
 *  reaches it should know it did. The proxy validators are exercised through
 *  their pure decision helpers instead. */
export const net = {
  request(_options: unknown): never {
    throw new Error("net.request is not available in the shell-backend stub");
  },
};

const STUB_DISPLAY = {
  id: 1,
  label: "stub",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 25, width: 1920, height: 1055 },
};

export const screen = {
  getPrimaryDisplay: () => STUB_DISPLAY,
  getAllDisplays: () => [STUB_DISPLAY],
  getDisplayMatching: (_rect?: unknown) => STUB_DISPLAY,
  getDisplayNearestPoint: (_point?: unknown) => STUB_DISPLAY,
};

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

/** `utilityProcess` is Electron's child-process API; there is none under
 *  Vitest. Forking throws, which is the path the TS-service client turns into
 *  "type intelligence unavailable" — tests that want a live service hand the
 *  client a forker of their own (`tsService.useForker`). */
export const utilityProcess = {
  fork(): never {
    throw new Error("utilityProcess is not available outside Electron");
  },
};
export type UtilityProcess = never;
