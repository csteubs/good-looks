// IPC handlers the Glaze runtime used to register automatically.
//
// The preload exposes `window.glazeAPI.{dialog,shell,clipboard,nativeTheme,Menu}`
// as invoke() calls on these channels; under Glaze the native host answered
// them. Under Electron nobody does unless we register them — a missed one
// surfaces as "No handler registered" the first time a menu or copy button is
// used, so the set below is the full surface the renderer actually calls
// (enumerated by grep, not guessed).

import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
} from "electron";
import type { MenuItemConstructorOptions } from "electron";

import { checkExternalUrl } from "./external-url.js";
import { logger } from "./logger.js";

/** Renderer-side native menu item (see NativeMenu in the views): a plain-data
 *  template where picking an item answers with its commandId. */
interface PopupItem {
  label?: string;
  type?: "separator" | "normal";
  enabled?: boolean;
  checked?: boolean;
  commandId?: number;
  submenu?: PopupItem[];
}

interface PopupOptions {
  items?: PopupItem[];
  x?: number;
  y?: number;
}

export function registerHostHandlers(): void {
  // ── Dialogs ─────────────────────────────────────────────────────────
  ipcMain.handle("dialog:showOpenDialog", (e, options) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
  });
  ipcMain.handle("dialog:showSaveDialog", (e, options) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options);
  });
  ipcMain.handle("dialog:showMessageBox", (e, options) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  });
  ipcMain.handle("dialog:showErrorBox", (_e, title: string, content: string) => {
    dialog.showErrorBox(String(title ?? ""), String(content ?? ""));
  });

  // ── Shell ───────────────────────────────────────────────────────────
  ipcMain.handle("shell:beep", () => shell.beep());
  ipcMain.handle("shell:showItemInFolder", (_e, fullPath: string) => {
    if (typeof fullPath === "string" && fullPath) shell.showItemInFolder(fullPath);
  });
  // Opens a pull request in the user's real browser. The URL arrives from the
  // renderer having originated in a GitHub API response, so it is checked here
  // rather than trusted — see `external-url.ts` for what the OS would otherwise
  // do with a scheme we didn't expect. Refusals are logged and swallowed: the
  // renderer's icon has nothing useful to do with the error, and the honest
  // report of a URL this app won't open belongs in the main log.
  ipcMain.handle("shell:openExternal", async (_e, url: string) => {
    const verdict = checkExternalUrl(url);
    if (!verdict.ok) {
      logger.warn("shell", "Refused to open a URL externally", { problem: verdict.problem });
      return;
    }
    try {
      // `verdict.href`, NOT `url` — the checked value is the only one opened.
      await shell.openExternal(verdict.href);
    } catch (err) {
      logger.warn("shell", "The OS refused to open a URL", { err: String(err) });
    }
  });

  // ── Clipboard ───────────────────────────────────────────────────────
  ipcMain.handle("clipboard:writeText", (_e, text: string) => {
    clipboard.writeText(typeof text === "string" ? text : String(text ?? ""));
  });
  ipcMain.handle("clipboard:readText", () => clipboard.readText());

  // ── Native theme ────────────────────────────────────────────────────
  //
  // THIS APP IS DARK ONLY AND SAYS SO (REDESIGN §0). The palette is near-black
  // with phosphor accents over two texture layers; a light variant is a second
  // design rather than a token swap, and the CRT treatment has no light reading
  // at all. So there is one line here instead of four handlers and a broadcast.
  //
  // It is set rather than left alone because `themeSource` is what Electron's
  // OWN chrome reads — the native menus this app pops up for every Select and
  // dropdown, the file pickers, the message boxes. Following the OS from here
  // would put a white menu on top of a black app for anyone whose Mac is in
  // light mode, which is the one part of the window we do not draw ourselves.
  //
  // The renderer no longer asks: `useTheme()` is gone, `.dark` is applied
  // unconditionally by each window's entry HTML, and the `nativeTheme:*`
  // handlers, the preload bridge and the `nativeTheme:updated` push went with
  // it. Nothing was left registered-but-unused — an IPC surface nobody calls is
  // indistinguishable from one that is about to be needed again.
  nativeTheme.themeSource = "dark";

  // ── Native menus (renderer-driven popups) ───────────────────────────
  //
  // The app's DropdownMenu-style components hand a plain-data template to
  // `glazeAPI.Menu.popup` and act on the commandId that comes back. Click
  // resolves with the picked id; the menu closing without a pick resolves {}.
  // The callback fires on close BEFORE a click handler can run on some
  // platforms, so resolution is deferred a tick and the first writer wins.
  ipcMain.handle("Menu:popup", (e, options: PopupOptions) => {
    return new Promise<{ commandId?: number }>((resolve) => {
      let done = false;
      const finish = (result: { commandId?: number }) => {
        if (!done) {
          done = true;
          resolve(result);
        }
      };
      const toTemplate = (items: PopupItem[]): MenuItemConstructorOptions[] =>
        items.map((item) => {
          if (item.type === "separator") return { type: "separator" };
          const base: MenuItemConstructorOptions = {
            label: typeof item.label === "string" ? item.label : "",
            enabled: item.enabled !== false,
          };
          if (item.checked === true) {
            base.type = "checkbox";
            base.checked = true;
          }
          if (Array.isArray(item.submenu)) {
            base.submenu = toTemplate(item.submenu);
          } else {
            const id = item.commandId;
            base.click = () => finish(typeof id === "number" ? { commandId: id } : {});
          }
          return base;
        });

      let menu: Menu;
      try {
        menu = Menu.buildFromTemplate(toTemplate(options?.items ?? []));
      } catch (err) {
        logger.warn("shell", "Menu:popup got an unbuildable template", { err: String(err) });
        finish({});
        return;
      }
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      menu.popup({
        window: win,
        x: typeof options?.x === "number" ? Math.round(options.x) : undefined,
        y: typeof options?.y === "number" ? Math.round(options.y) : undefined,
        callback: () => {
          // Menu closed. If a click is going to land it does so on this tick;
          // resolve "nothing picked" strictly after it had the chance.
          setTimeout(() => finish({}), 0);
        },
      });
    });
  });

  ipcMain.handle("Menu:setApplicationMenu", (_e, template: MenuItemConstructorOptions[] | null) => {
    Menu.setApplicationMenu(template ? Menu.buildFromTemplate(template) : null);
  });

  logger.info("shell", "Host IPC handlers registered");
}

/**
 * Forward a window's console errors and warnings into the main log.
 *
 * Under Glaze the native host surfaced these; under Electron they live only in
 * that window's DevTools. Without this, a renderer that throws during mount
 * presents as a blank window and a completely clean main-process log — which is
 * exactly how the first run of this port failed, and it cost real time to
 * diagnose. Errors only: routine logging stays in DevTools where it belongs.
 */
export function forwardRendererConsole(win: Electron.BrowserWindow, label: string): void {
  win.webContents.on("console-message", (event) => {
    if (event.level !== "error" && event.level !== "warning") return;
    logger.warn("renderer", event.message, {
      window: label,
      level: event.level,
      source: event.sourceId,
      line: event.lineNumber,
    });
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    logger.error("renderer", "Render process gone", { window: label, ...details });
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    logger.error("renderer", "Preload threw", { window: label, preloadPath, error: String(error) });
  });
}
