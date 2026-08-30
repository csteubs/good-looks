// ⌘R toggles recording/paused — and does NOT reload the window.
//
// ── Why this can only be checked end to end ────────────────────────────────
// The chord is contested: the application menu carries `role: "viewMenu"`,
// whose Reload item owns CmdOrCtrl+R, and a menu accelerator is dispatched
// ahead of any renderer keydown listener. The fix rides on a main-process
// `before-input-event` handler whose `preventDefault()` is documented to stop
// both the page event and the menu shortcut — an interplay that exists only
// between a real menu, a real webContents and a real key event. jsdom has none
// of the three, and a unit test of the matcher/decision
// (recording-shortcut.test.ts) cannot see who WINS the chord. The losing
// outcome reloads the window that is showing the session.
//
// ── Why the key is sent with `sendInputEvent`, not `window.keyboard` ───────
// Playwright's keyboard drives CDP `Input.dispatchKeyEvent`, which injects the
// event into the RENDERER'S input pipeline directly — `before-input-event`
// never fires for it (measured here: a probe listener saw nothing for
// `keyboard.press`, and a full Input object for `sendInputEvent`). A real key
// press and `webContents.sendInputEvent` both go through the browser-side
// pipeline the feature lives in, so the main-process send is the honest
// stand-in for a finger on ⌘R.
//
// ── What each assertion proves, and where ──────────────────────────────────
// VERIFIED TO FAIL against the previous implementation by removing
// `attachRecorderShortcuts`: the toggle assertions go red (`paused` never
// changes). The reload sentinel is a weaker tripwire than it looks on THIS
// platform: on Linux/xvfb the View menu's Reload accelerator does not fire
// for synthesized input at all (measured — deleting only `preventDefault()`
// leaves this spec green here), so the sentinel pins the no-reload half on
// macOS, where the menu is real, and costs nothing to carry in CI. The
// CI-load-bearing assertions are the toggles.

import { test, expect, type AppFixtures } from "./fixtures.js";

import * as http from "node:http";
import type { AddressInfo } from "node:net";

type Invoke = { glaze: { ipc: { invoke(channel: string, params?: unknown): Promise<unknown> } } };

function invoke<T>(window: AppFixtures["window"], channel: string, params?: unknown): Promise<T> {
  return window.evaluate(
    async (args) =>
      (window as unknown as { glazeAPI: Invoke }).glazeAPI.glaze.ipc.invoke(
        args.channel,
        args.params,
      ) as Promise<T>,
    { channel, params },
  ) as Promise<T>;
}

/** How long `/slow` holds its response. Long enough that the not-ready press
 *  below reliably lands while `pageReady` is still false, short enough not to
 *  drag the suite. */
const SLOW_PAGE_MS = 3000;

async function serveSite(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const body = `<!doctype html><html><body><h1>Shortcut site</h1><button id="b">Go</button></body></html>`;
    if (path === "/slow") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(body);
      }, SLOW_PAGE_MS);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Press Ctrl+R on the webContents of the window whose URL contains
 *  `urlPart`, through the browser-side input pipeline (see the header). Windows
 *  are found by URL because a session has up to three open — main, training,
 *  panel — and "the first window" is whichever won a race. */
function pressToggle(app: AppFixtures["app"], urlPart: string): Promise<void> {
  return app.evaluate(({ BrowserWindow }, part) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes(part),
    );
    if (!win) throw new Error(`no window matching ${part}`);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "r", modifiers: ["control"] });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "r", modifiers: ["control"] });
  }, urlPart);
}

async function recorderState(
  window: AppFixtures["window"],
): Promise<{ paused: boolean; pageReady: boolean; recording: boolean }> {
  return invoke(window, "recorder:getState");
}

test("⌘R pauses and resumes the session instead of reloading the window", async ({
  app,
  window,
}) => {
  const site = await serveSite();
  try {
    // The docked panel is the second window this shortcut is wired to — the
    // attach happens on open, so it must be enabled before the session starts.
    await invoke(window, "recorder:setSettings", { trainerPanelEnabled: true });

    // A SLOW page, so the not-ready branch below has a window to land in.
    const started = invoke(window, "recorder:start", {
      url: `${site.url}slow`,
      name: "shortcut",
    });

    // ── A live session that is NOT ready consumes the chord, no toggle ─────
    // The wrong outcomes here are a reload (the accelerator winning — the
    // main-process gate must claim the chord for ANY live session) and a
    // toggle (pausing a page that has not loaded). recording-shortcut.test.ts
    // pins the decision table; this pins the wiring on the real window.
    await expect.poll(async () => (await recorderState(window)).recording).toBe(true);
    expect((await recorderState(window)).pageReady).toBe(false);
    await pressToggle(app, "main-window");
    // No state change is expected, so give the press time to have done its
    // (non-)work rather than racing the assertion past it.
    await new Promise((r) => setTimeout(r, 700));
    const notReady = await recorderState(window);
    expect(notReady.paused).toBe(false);

    await started;
    await expect
      .poll(async () => (await recorderState(window)).pageReady, { timeout: 20_000 })
      .toBe(true);

    // The tripwire for the losing outcome (see the header for its platform
    // caveat). A reload replaces the document, so if Reload ever wins the
    // chord, this property is gone by the time it is read back.
    await window.evaluate(() => {
      (window as unknown as { __glShortcutSentinel?: number }).__glShortcutSentinel = 1;
    });

    // ── The main window's chord toggles, both ways ──────────────────────────
    await pressToggle(app, "main-window");
    await expect.poll(async () => (await recorderState(window)).paused).toBe(true);
    await pressToggle(app, "main-window");
    await expect.poll(async () => (await recorderState(window)).paused).toBe(false);

    const sentinel = await window.evaluate(
      () => (window as unknown as { __glShortcutSentinel?: number }).__glShortcutSentinel,
    );
    expect(sentinel).toBe(1);

    // ── The docked panel's chord toggles too ────────────────────────────────
    // The panel is attached separately (on open, in recorder-service.ts), and
    // "the two trainers disagree about what the key does" is the failure that
    // wiring exists to prevent — so it gets its own press.
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((w) =>
            w.webContents.getURL().includes("trainer-window"),
          ),
        ),
      )
      .toBe(true);
    await pressToggle(app, "trainer-window");
    await expect.poll(async () => (await recorderState(window)).paused).toBe(true);
    await pressToggle(app, "trainer-window");
    await expect.poll(async () => (await recorderState(window)).paused).toBe(false);

    // ── The chip is the other half of the same control ──────────────────────
    // The state word IS the toggle; drive the real UI round trip both ways.
    await window.getByRole("button", { name: "Recording" }).click();
    await expect.poll(async () => (await recorderState(window)).paused).toBe(true);
    await window.getByRole("button", { name: "Paused" }).click();
    await expect.poll(async () => (await recorderState(window)).paused).toBe(false);
  } finally {
    await invoke(window, "recorder:discardExit").catch(() => {});
    await site.close();
  }
});
