/**
 * Preload — the secure bridge between renderer and main process.
 *
 * SECURITY MODEL (unchanged from the original app):
 * - This is the ONLY file that touches Electron's ipcRenderer.
 * - Renderer code accesses `window.glazeAPI` and nothing else. (The global
 *   keeps its historical name: every view, the injected page-world helpers and
 *   the test stubs address it, and renaming a global buys nothing.)
 * - Only APIs with actual renderer call sites are exposed. The Glaze template
 *   shipped location/systemPreferences/webUtils/date-picker surfaces here;
 *   nothing in this app called them, so the port drops them rather than
 *   carrying dead attack surface.
 *
 * Built as a single CJS bundle (scripts/build-main.mjs) so it loads in a
 * sandboxed Electron preload context, where `require("electron")` is provided
 * but ESM is not.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

import type {
  MessageBoxOptions,
  MessageBoxResult,
  NativeThemeInfo,
  OpenDialogOptions,
  OpenDialogResult,
  PopupOptions,
  PopupResult,
  SaveDialogOptions,
  SaveDialogResult,
} from "./lib/host-types";

// Re-export for renderer code that types against the bridge.
export type {
  MessageBoxOptions,
  MessageBoxResult,
  NativeThemeInfo,
  OpenDialogOptions,
  OpenDialogResult,
  SaveDialogOptions,
  SaveDialogResult,
};

type GlazeIpcEvent = {
  channel?: string;
  ports: MessagePort[];
};

type GlazeIpcListener = (event: GlazeIpcEvent, ...args: unknown[]) => void;

/** Adapt Electron's IpcRendererEvent to the app's listener shape: callbacks
 *  receive (event, ...payload) and `api.on` reads payload as args[1]. */
function addIpcListener(channel: string, callback: GlazeIpcListener, once: boolean): () => void {
  const listener = (event: IpcRendererEvent, ...args: unknown[]) => {
    callback({ channel, ports: event.ports as unknown as MessagePort[] }, ...args);
  };
  if (once) {
    ipcRenderer.once(channel, listener);
  } else {
    ipcRenderer.on(channel, listener);
  }
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const glazeAPI = {
  // ── Dialogs — native UI, requires explicit user interaction ─────────
  dialog: {
    showOpenDialog: (options?: OpenDialogOptions): Promise<OpenDialogResult> =>
      ipcRenderer.invoke("dialog:showOpenDialog", options),

    showSaveDialog: (options?: SaveDialogOptions): Promise<SaveDialogResult> =>
      ipcRenderer.invoke("dialog:showSaveDialog", options),

    showMessageBox: (options: MessageBoxOptions): Promise<MessageBoxResult> =>
      ipcRenderer.invoke("dialog:showMessageBox", options),

    showErrorBox: (title: string, content: string): Promise<void> =>
      ipcRenderer.invoke("dialog:showErrorBox", title, content),
  },

  // ── Shell — safe subset ─────────────────────────────────────────────
  shell: {
    beep(): void {
      void ipcRenderer.invoke("shell:beep").catch(() => {});
    },

    // Reveals a file the user already owns; used by "Reveal in Finder".
    showItemInFolder(fullPath: string): void {
      void ipcRenderer.invoke("shell:showItemInFolder", fullPath).catch(() => {});
    },
  },

  // ── Clipboard — used to copy failed-run output for external LLMs ────
  clipboard: {
    writeText(text: string): void {
      void ipcRenderer.invoke("clipboard:writeText", text).catch(() => {});
    },
    readText: (): Promise<string> => ipcRenderer.invoke("clipboard:readText"),
  },

  // ── Native theme ────────────────────────────────────────────────────
  nativeTheme: {
    getInfo: (): Promise<NativeThemeInfo> => ipcRenderer.invoke("nativeTheme:getInfo"),

    setThemeSource: (source: "system" | "light" | "dark"): Promise<boolean> =>
      ipcRenderer.invoke("nativeTheme:setThemeSource", source),

    getShouldUseDarkColors: (): Promise<boolean> =>
      ipcRenderer.invoke("nativeTheme:getShouldUseDarkColors"),

    getThemeSource: (): Promise<"system" | "light" | "dark"> =>
      ipcRenderer.invoke("nativeTheme:getThemeSource"),
  },

  // ── Native menus (popup answers with the picked commandId) ──────────
  Menu: {
    popup: (options: PopupOptions): Promise<PopupResult> =>
      ipcRenderer.invoke("Menu:popup", options),
  },

  // ── App IPC — custom handlers registered in main/handlers ───────────
  glaze: {
    ipc: {
      invoke: <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
        ipcRenderer.invoke(channel, ...args),

      send: (channel: string, ...args: unknown[]): void => ipcRenderer.send(channel, ...args),

      on: (channel: string, callback: GlazeIpcListener): (() => void) =>
        addIpcListener(channel, callback, false),

      once: (channel: string, callback: GlazeIpcListener): (() => void) =>
        addIpcListener(channel, callback, true),

      /** Glaze's JSON-RPC bridge needed explicit teardown; Electron's IPC does
       *  not. Kept as a no-op because view cleanup code calls it. */
      disconnect: (): void => {},
    },
  },
};

contextBridge.exposeInMainWorld("glazeAPI", glazeAPI);

export type GlazeAPI = typeof glazeAPI;
