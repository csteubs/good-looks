// The Electron adapter — the one seam of the port.
//
// Application code imports this module (via the `@shell/backend` alias) exactly
// where it used to import `@glaze/core/backend`. Everything the app consumed
// from the Glaze SDK either maps 1:1 onto an Electron export (re-exported
// below), or is a small local implementation (logger, the BrowserWindow
// option-stripping wrapper, initDevToolsButtonState).
//
// Semantic differences that matter, handled here or noted at the site:
//   • `windowKey` (Glaze frame persistence) has no Electron equivalent — the
//     wrapper strips it so window creation code didn't have to change.
//   • Glaze's safeStorage methods are async; Electron's are sync. Call sites
//     `await` them, and awaiting a plain value is a no-op, so Electron's
//     safeStorage is a drop-in — the type below widens returns to Promise so
//     both stay legal.
//   • Navigation events (`will-navigate` etc.) carry url/isMainFrame/
//     isSameDocument on the event object in modern Electron, matching Glaze's
//     WebContentsNavigationEvent shape. No adaptation needed.
//   • `WebContentsView` has no Glaze ancestor — it arrived with the training
//     browser's URL strip, which needs the untrusted page in a child view so an
//     app-owned toolbar can sit above it. Re-exported raw (no wrapper): there is
//     no `windowKey` equivalent to strip, and the rule that only this directory
//     imports `electron` is what makes the re-export necessary at all.

import {
  app,
  BrowserWindow as ElectronBrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  net,
  Notification,
  safeStorage,
  screen,
  session,
  utilityProcess,
  WebContentsView,
} from "electron";
import type { BrowserWindowConstructorOptions } from "electron";

export {
  app,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  // `net` and `session` arrived with the proxy settings (proxy-service.ts):
  // applying a proxy is `session.setProxy` / `setCertificateVerifyProc`, OS
  // detection is `session.resolveProxy`, and validating test traffic is a
  // `net.request` through a throwaway session — the one request shape whose
  // `login` event lets stored credentials answer an authenticating proxy.
  // Re-exported raw, like WebContentsView: the rule that only this directory
  // imports `electron` is what makes the re-export necessary at all.
  net,
  Notification,
  safeStorage,
  screen,
  session,
  utilityProcess,
  WebContentsView,
};
export type { UtilityProcess } from "electron";
export { logger } from "./logger.js";

export type { MenuItemConstructorOptions, Cookie, CookiesSetDetails } from "electron";

/** Shape of the navigation events the recorder guards. Electron's modern
 *  `will-navigate`/`will-redirect`/`will-frame-navigate` events satisfy it. */
export interface WebContentsNavigationEvent {
  url?: string;
  isMainFrame?: boolean;
  isSameDocument?: boolean;
  preventDefault(): void;
}

/** Glaze window options = Electron's plus `windowKey` (frame persistence).
 *  Accepted and stripped so call sites port unchanged. */
export type WindowOptions = BrowserWindowConstructorOptions & { windowKey?: string };

type BrowserWindowStatics = {
  getAllWindows(): ElectronBrowserWindow[];
  getFocusedWindow(): ElectronBrowserWindow | null;
  fromWebContents(wc: Electron.WebContents): ElectronBrowserWindow | null;
};

/**
 * `new BrowserWindow(options)` with Glaze-only options removed.
 *
 * A plain function in constructor clothing rather than a subclass: Electron's
 * BrowserWindow is native-backed and does not support `class X extends`.
 * Returning the instance from the constructor body gives `new` the same result
 * without inheriting.
 */
export const BrowserWindow = Object.assign(
  function BrowserWindow(this: unknown, options: WindowOptions = {}): ElectronBrowserWindow {
    const { windowKey: _windowKey, ...rest } = options;
    return new ElectronBrowserWindow(rest);
  } as unknown as new (options?: WindowOptions) => ElectronBrowserWindow,
  {
    getAllWindows: () => ElectronBrowserWindow.getAllWindows(),
    getFocusedWindow: () => ElectronBrowserWindow.getFocusedWindow(),
    fromWebContents: (wc: Electron.WebContents) => ElectronBrowserWindow.fromWebContents(wc),
  } satisfies BrowserWindowStatics,
);

// The instance type, so `let win: BrowserWindow | null` keeps compiling.
export type BrowserWindow = ElectronBrowserWindow;

/** Glaze wired a DevTools toolbar button; Electron has the standard
 *  View → Toggle Developer Tools role instead. Kept as a no-op so the
 *  boot sequence didn't have to change. */
export async function initDevToolsButtonState(): Promise<void> {
  /* no-op under Electron */
}
