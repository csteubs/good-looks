// Where the trainer panel actually lands, on a real display.
//
// The docked panel shipped "not yet live-verified" (DECISIONS 2026-08-06) and
// this is the gap that let through: `panel-dock.test.ts` proves the arithmetic
// and `check:trainer-panel` proves the source shape, but neither can see two
// real windows on a real screen — and the bug was in the case where the
// arithmetic was never called at all. A window created without x/y is centred
// on the display by the window layer, so a session that could not dock opened
// its panel dead centre over the page under test.
//
// Both cases below are ordinary user setups, not contrivances: the first is the
// default New Recording, the second is any window-size preset wide enough that
// the preset plus a 360pt panel exceeds the display — which on a laptop is the
// Desktop 1280×800 and Laptop 1440×900 presets, two of the four on offer.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { test, expect, type AppFixtures } from "./fixtures.js";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const right = (r: Rect): number => r.x + r.width;
const bottom = (r: Rect): number => r.y + r.height;

/** The panel's fixed width, from `main/services/panel-dock.ts`. */
const PANEL_WIDTH = 360;

/** A page to train against that is not the network. */
async function servePage(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>dock fixture</title><h1>dock fixture</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Invoke = { glaze: { ipc: { invoke(channel: string, params?: unknown): Promise<unknown> } } };

async function startSession(
  window: AppFixtures["window"],
  url: string,
  viewport: { width: number; height: number } | null,
): Promise<void> {
  await window.evaluate(async () => {
    const api = (window as unknown as { glazeAPI: Invoke }).glazeAPI;
    await api.glaze.ipc.invoke("recorder:setSettings", { trainerPanelEnabled: true });
  });
  await window.evaluate(
    async (args) => {
      const api = (window as unknown as { glazeAPI: Invoke }).glazeAPI;
      await api.glaze.ipc.invoke("recorder:start", {
        url: args.url,
        name: "dock e2e",
        viewport: args.viewport,
      });
    },
    { url, viewport },
  );
}

/**
 * The two training windows and the display they are on.
 *
 * Found by the URL of a webContents INSIDE the window, not by the window's own
 * URL and not by its title.
 *
 * Not the window's URL: the training browser stopped loading the site itself
 * when it grew a URL strip. The page is in a child WebContentsView, so the
 * window's own webContents reports the strip's `app://` URL and a match on
 * `http://127.0.0.1` finds nothing — every geometry assertion below would then
 * fail as "the training browser window was null", which reads like the dock
 * feature breaking rather than like the finder being out of date.
 *
 * Not the title either: it is whatever the PAGE calls itself, so matching on
 * "Recording — …" finds nothing the moment the site under test has a `<title>`.
 * (The service now refuses `page-title-updated`, so that is no longer true —
 * but the URL is still the more direct question to ask.)
 */
async function geometry(app: AppFixtures["app"]): Promise<{
  workArea: Rect;
  panel: Rect | null;
  browser: Rect | null;
}> {
  return app.evaluate(({ BrowserWindow, screen, webContents }) => {
    const find = (match: (url: string) => boolean): Electron.Rectangle | null => {
      const win = BrowserWindow.getAllWindows().find((w) => match(w.webContents.getURL()));
      return win ? win.getBounds() : null;
    };
    /** The WINDOW that hosts a webContents matching `match`, whether that
     *  webContents is the window's own or one of its child views. */
    const findByChild = (match: (url: string) => boolean): Electron.Rectangle | null => {
      const wc = webContents.getAllWebContents().find((c) => !c.isDestroyed() && match(c.getURL()));
      if (!wc) return null;
      // `fromWebContents` answers for a window's own contents; a view's parent
      // is reached through the ownerBrowserWindow it was added to.
      const win =
        BrowserWindow.fromWebContents(wc) ??
        BrowserWindow.getAllWindows().find((w) =>
          w.contentView.children.some(
            (child) => (child as Electron.WebContentsView).webContents?.id === wc.id,
          ),
        );
      return win ? win.getBounds() : null;
    };
    const browser = findByChild((u) => u.startsWith("http://127.0.0.1"));
    return {
      workArea: screen.getDisplayMatching(
        browser ?? screen.getPrimaryDisplay().workArea,
      ).workArea,
      panel: find((u) => u.includes("trainer-window")),
      browser,
    };
  });
}

test("the panel docks flush against the training browser", async ({ app, window }) => {
  const page = await servePage();
  try {
    await startSession(window, page.url, null);
    const { workArea, panel, browser } = await geometry(app);
    expect(panel, "the trainer panel window").not.toBeNull();
    expect(browser, "the training browser window").not.toBeNull();

    // The default recording is 1200 wide and docking splits that footprint, so
    // this needs only a display that can hold a usable pair at all.
    test.skip(
      workArea.width < 960,
      `this display is ${workArea.width}pt wide — too narrow to hold any docked pair`,
    );

    expect(panel!.x, "the panel's left edge sits on the browser's right edge").toBe(right(browser!));
    expect(panel!.y).toBe(browser!.y);
    expect(panel!.height).toBe(browser!.height);
    expect(panel!.width).toBe(PANEL_WIDTH);
    expect(right(panel!)).toBeLessThanOrEqual(right(workArea));
  } finally {
    await page.close();
  }
});

test("a panel that cannot dock never opens over the page", async ({ app, window }) => {
  const page = await servePage();
  try {
    // Sized from the actual display so the case reproduces on any screen: wide
    // enough that the preset plus a panel cannot fit, narrow enough to open.
    const probe = await geometry(app);
    const preset = {
      width: Math.max(400, probe.workArea.width - 100),
      height: Math.max(400, Math.min(800, probe.workArea.height - 120)),
    };
    expect(preset.width + PANEL_WIDTH).toBeGreaterThan(probe.workArea.width);

    await startSession(window, page.url, preset);
    const { workArea, panel, browser } = await geometry(app);
    expect(panel, "the trainer panel window").not.toBeNull();
    expect(browser, "the training browser window").not.toBeNull();

    // Refusing to dock must stay a refusal: the preset is the size the recorded
    // test replays at, so shrinking the browser to make room would silently
    // record against a layout the run will never see.
    expect(browser!.width, "the preset width is untouched").toBe(preset.width);

    // The bug. A window created with no coordinates is centred on the display,
    // which is exactly where the page under test is.
    const middleOfPage = browser!.x + browser!.width / 2;
    expect(
      panel!.x <= middleOfPage && right(panel!) >= middleOfPage,
      `panel ${JSON.stringify(panel)} covers the middle of ${JSON.stringify(browser)}`,
    ).toBe(false);

    // Placed, not merely elsewhere: against an edge of the display, wholly on it.
    const onAnEdge = panel!.x === workArea.x || right(panel!) === right(workArea);
    expect(onAnEdge, `panel ${JSON.stringify(panel)} is flush to ${JSON.stringify(workArea)}`).toBe(
      true,
    );
    expect(panel!.x).toBeGreaterThanOrEqual(workArea.x);
    expect(right(panel!)).toBeLessThanOrEqual(right(workArea));
    expect(panel!.y).toBeGreaterThanOrEqual(workArea.y);
    expect(bottom(panel!)).toBeLessThanOrEqual(bottom(workArea));

    // And the panel knows. The push saying "no room" is emitted while this
    // window is still loading, so only a panel that ASKS can label its own
    // control correctly — otherwise it offers "Undock" for a panel that is not
    // docked, and pressing it does nothing.
    const panelPage = app.windows().find((p) => p.url().includes("trainer-window"));
    expect(panelPage, "the panel's page").toBeTruthy();
    await panelPage!.waitForLoadState("domcontentloaded");
    await expect(
      panelPage!.getByRole("button", { name: "Dock panel to the browser" }),
    ).toBeVisible();
  } finally {
    await page.close();
  }
});
