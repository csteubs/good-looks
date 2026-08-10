// The interface scale, on real windows with real zoom factors.
//
// Everything else about this setting is checkable elsewhere — the store's
// allowlist in `handlers.test.ts`, the service's own logic in
// `ui-scale.test.ts` against a fake window. What neither can see is the thing
// that actually matters: whether a real `webContents` ends up at the chosen
// factor, whether a window opened AFTER the change inherits it, and — the one
// that would be a bug in the product rather than in the code — whether the
// training browser was scaled along with the app.
//
// That last one is why this file exists. A zoomed training browser is not a
// cosmetic slip: the viewport width decides what a responsive site renders, so
// the recorded selectors, the click targets and every visual baseline would
// quietly become a function of the user's reading preference. Nothing in the
// unit suite has a second real window to notice it in.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { test, expect, type AppFixtures } from "./fixtures.js";

type Invoke = { glaze: { ipc: { invoke(channel: string, params?: unknown): Promise<unknown> } } };

/** A page to train against that is not the network. */
async function servePage(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>scale fixture</title><h1>scale fixture</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function setSettings(
  window: AppFixtures["window"],
  patch: Record<string, unknown>,
): Promise<void> {
  await window.evaluate(async (p) => {
    const api = (window as unknown as { glazeAPI: Invoke }).glazeAPI;
    await api.glaze.ipc.invoke("recorder:setSettings", p);
  }, patch);
}

/** Zoom factors of every open window, keyed by something recognisable in its
 *  URL. Read from the MAIN process, which is the only place the real number
 *  lives — `window.devicePixelRatio` in a renderer answers a different
 *  question. */
async function zoomByUrl(app: AppFixtures["app"]): Promise<Record<string, number>> {
  return app.evaluate(({ BrowserWindow }) => {
    const out: Record<string, number> = {};
    for (const win of BrowserWindow.getAllWindows()) {
      const url = win.webContents.getURL();
      const key = url.startsWith("http://127.0.0.1")
        ? "training-browser"
        : url.includes("settings-window")
          ? "settings"
          : url.includes("trainer-window")
            ? "trainer-panel"
            : "main";
      out[key] = win.webContents.getZoomFactor();
    }
    return out;
  });
}

test("the app opens at 100% until something says otherwise", async ({ app, window }) => {
  await expect(window.getByRole("heading", { name: "GOOD LOOKS!" })).toBeVisible();
  expect((await zoomByUrl(app)).main).toBeCloseTo(1, 5);
});

test("changing the scale re-draws the open window immediately", async ({ app, window }) => {
  // Immediately, not on next launch: a size control that appears to do nothing
  // is one the user presses four more times.
  await expect(window.getByRole("heading", { name: "GOOD LOOKS!" })).toBeVisible();
  await setSettings(window, { uiScale: 1.25 });
  await expect.poll(async () => (await zoomByUrl(app)).main).toBeCloseTo(1.25, 5);
});

test("a window opened afterwards inherits the scale", async ({ app, window }) => {
  await setSettings(window, { uiScale: 0.9 });

  const opened = app.waitForEvent("window");
  await window.evaluate(() =>
    (window as unknown as { glazeAPI: Invoke }).glazeAPI.glaze.ipc.invoke("window:openSettings"),
  );
  const settings = await opened;
  await settings.waitForLoadState("domcontentloaded");

  // The settings window is NOT an aux window, so it never receives the
  // appearance push — it has to be scaled by the creation-site call. This is
  // the window the setting is changed in, so it is the one where getting this
  // wrong is most visible.
  await expect.poll(async () => (await zoomByUrl(app)).settings).toBeCloseTo(0.9, 5);
});

test("the settings window opens wide enough to lay itself out", async ({ app, window }) => {
  // The failure this catches, and it shipped in the first draft of this
  // feature: the settings window is created at a fixed 760 points, which is 608
  // CSS pixels at 125% — under the 620 its own layout declares — so it opened
  // with the size control that caused it already cut off the right-hand edge.
  // A minimum expressed in points is not a minimum for the VIEW.
  await setSettings(window, { uiScale: 1.25 });

  const opened = app.waitForEvent("window");
  await window.evaluate(() =>
    (window as unknown as { glazeAPI: Invoke }).glazeAPI.glaze.ipc.invoke("window:openSettings"),
  );
  const settings = await opened;
  await settings.waitForLoadState("domcontentloaded");

  // What the RENDERER sees, which is the number the layout was measured in.
  const viewport = await settings.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.width, "the settings pane's viewport in CSS pixels").toBeGreaterThanOrEqual(620);
  expect(viewport.scrollWidth, "nothing overflows it sideways").toBeLessThanOrEqual(
    viewport.width + 1,
  );
});

test("a settings window ALREADY OPEN when the scale goes up is not left clipped", async ({
  app,
  window,
}) => {
  // The case the test above does not cover, and it is the one a real user hits
  // — nobody changes the interface scale and then opens Settings, they change
  // it IN Settings. `setMinimumSize` constrains dragging; on macOS it does not
  // resize a window already smaller than the new minimum, so this window sat at
  // 608 CSS pixels — under the 620 its own layout declares. It passed the
  // newly-opened case above throughout, and was found by measuring the running
  // app.
  //
  // Assert on what the RENDERER reports, not on a screenshot: Playwright
  // captures a zoomed Electron window as a crop at the pre-zoom device scale,
  // so a correct window looks clipped in the image. That cost an hour.
  const opened = app.waitForEvent("window");
  await window.evaluate(() =>
    (window as unknown as { glazeAPI: Invoke }).glazeAPI.glaze.ipc.invoke("window:openSettings"),
  );
  const settings = await opened;
  await settings.waitForLoadState("domcontentloaded");

  await setSettings(settings, { uiScale: 1.25 });

  await expect
    .poll(() => settings.evaluate(() => document.documentElement.clientWidth))
    .toBeGreaterThanOrEqual(620);
  const overflow = await settings.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "nothing overflows it sideways").toBeLessThanOrEqual(1);
});

test("the main window's floor stays the width its toolbar was measured at", async ({
  app,
  window,
}) => {
  await setSettings(window, { uiScale: 1.25 });
  // 960 CSS px × 1.25. Left at 960 points the user could shrink the window to
  // 768 CSS px — below the ~928 the widest toolbar needs, with no horizontal
  // scroll anywhere to bring `Run test` back.
  await expect
    .poll(async () =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMinimumSize()[0]),
    )
    .toBe(1200);
});

test("a value the store refuses leaves the app where it was", async ({ app, window }) => {
  await setSettings(window, { uiScale: 1.1 });
  await expect.poll(async () => (await zoomByUrl(app)).main).toBeCloseTo(1.1, 5);

  // 0 is the case with no way back: at zero zoom the Settings window is the
  // only place to undo it and it would be unreadable too.
  await setSettings(window, { uiScale: 0 });
  expect((await zoomByUrl(app)).main).toBeCloseTo(1.1, 5);
});

test("the training browser is never scaled with the app", async ({ app, window }) => {
  const page = await servePage();
  try {
    await setSettings(window, { trainerPanelEnabled: true, uiScale: 1.25 });
    await window.evaluate(
      async (url) => {
        const api = (window as unknown as { glazeAPI: Invoke }).glazeAPI;
        await api.glaze.ipc.invoke("recorder:start", { url, name: "scale e2e", viewport: null });
      },
      page.url,
    );

    await expect.poll(async () => Object.keys(await zoomByUrl(app))).toContain("training-browser");
    const zoom = await zoomByUrl(app);

    // The app scales…
    expect(zoom.main, "the main window").toBeCloseTo(1.25, 5);
    expect(zoom["trainer-panel"], "the trainer panel").toBeCloseTo(1.25, 5);
    // …and the page under test does not. Scaling it would change what a
    // responsive site serves, what a click lands on, and what every visual
    // baseline captured from here on compares against.
    expect(zoom["training-browser"], "the page under test").toBeCloseTo(1, 5);
  } finally {
    await page.close();
  }
});

test("the typeface reaches an already-open window", async ({ window }) => {
  // The CSS effect is covered in the preview and the attribute logic in
  // `typeface.test.tsx`; what only a real app has is the round trip — a save in
  // one renderer, through the backend, out as a push, applied in another.
  await expect(window.getByRole("heading", { name: "GOOD LOOKS!" })).toBeVisible();
  expect(await window.evaluate(() => document.documentElement.dataset.glTypeface)).toBeUndefined();

  await setSettings(window, { uiTypeface: "classic" });
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.glTypeface))
    .toBe("classic");

  // And back to the default REMOVES the attribute rather than writing "space".
  await setSettings(window, { uiTypeface: "space" });
  await expect
    .poll(() => window.evaluate(() => document.documentElement.dataset.glTypeface))
    .toBeUndefined();
});
