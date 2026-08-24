// The interface scale, on real windows with real zoom factors.
//
// Everything else about this setting is checkable elsewhere — the store's
// allowlist in `handlers.test.ts`, the service's own logic in
// `ui-scale.test.ts` against a fake window. What neither can see is the thing
// that actually matters: whether a real `webContents` ends up at the chosen
// factor, whether a real layout survives the zoom, and — the one that would be
// a bug in the product rather than in the code — whether the training browser
// was scaled along with the app.
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

/** Zoom factors of every live webContents, keyed by something recognisable in
 *  its URL. Read from the MAIN process, which is the only place the real number
 *  lives — `window.devicePixelRatio` in a renderer answers a different
 *  question.
 *
 *  ENUMERATES `webContents`, NOT `BrowserWindow.getAllWindows()`. The training
 *  browser stopped being one webContents when it grew a URL strip: the page is
 *  in a child WebContentsView and the strip is in another, and neither is a
 *  window. Walking windows would find the recorder window reporting the STRIP's
 *  app:// URL, classify the training browser as "main", and leave the assertion
 *  below with no `training-page` key to look at — a test that hangs on its poll
 *  rather than one that fails on the thing it guards. */
async function zoomByUrl(app: AppFixtures["app"]): Promise<Record<string, number>> {
  return app.evaluate(({ webContents }) => {
    const out: Record<string, number> = {};
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue;
      const url = wc.getURL();
      const key = url.startsWith("http://127.0.0.1")
        ? "training-page"
        : url.includes("recorder-chrome")
          ? "training-url-strip"
          : url.includes("trainer-window")
            ? "trainer-panel"
            : "main";
      out[key] = wc.getZoomFactor();
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

test("the Settings screen lays itself out at 125%", async ({ window }) => {
  // WHAT THIS REPLACED, and why it is one test rather than three. Settings was
  // its own `BrowserWindow`, created at a fixed 760 points — 608 CSS pixels at
  // 125%, under the 620 its own layout declared — so it opened with the size
  // control that caused it already cut off the right-hand edge, and a window
  // already open when the scale went up was left clipped by the same
  // arithmetic. Both were bugs about a window's minimum size expressed in
  // points, and the window is gone: Settings is a pane inside the main one,
  // whose floor is 960 CSS pixels and is scaled with everything else.
  //
  // The layout question survives the window and is still worth asking here,
  // because jsdom has no layout engine and cannot answer it: at 125%, with the
  // rail beside it, does the settings screen overflow sideways?
  await expect(window.getByRole("heading", { name: "GOOD LOOKS!" })).toBeVisible();
  await setSettings(window, { uiScale: 1.25 });

  await window.getByRole("button", { name: /^Settings/ }).click();
  await expect(window.getByText("How the app looks")).toBeVisible();

  // Assert on what the RENDERER reports, not on a screenshot: Playwright
  // captures a zoomed Electron window as a crop at the pre-zoom device scale,
  // so a correct window looks clipped in the image. That cost an hour.
  await expect
    .poll(async () =>
      window.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);

  // And one section below the board, which is where the rows with a control on
  // the right-hand edge actually are.
  await window.getByRole("button", { name: /^Storage/ }).first().click();
  await expect(window.getByText(/How long captured screenshots stay on disk/i)).toBeVisible();
  const overflow = await window.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "nothing overflows the settings pane sideways").toBeLessThanOrEqual(1);
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

    await expect.poll(async () => Object.keys(await zoomByUrl(app))).toContain("training-page");
    const zoom = await zoomByUrl(app);

    // The app scales…
    expect(zoom.main, "the main window").toBeCloseTo(1.25, 5);
    expect(zoom["trainer-panel"], "the trainer panel").toBeCloseTo(1.25, 5);
    // …including the training browser's own URL strip, which is app chrome and
    // would be a band of 11px type marooned at 100% inside a 125% app.
    expect(zoom["training-url-strip"], "the training browser's URL strip").toBeCloseTo(1.25, 5);
    // …and the page under test does not. Scaling it would change what a
    // responsive site serves, what a click lands on, and what every visual
    // baseline captured from here on compares against.
    //
    // This is the assertion the strip made delicate: both live in the same
    // window now, one point apart, and the natural way to write the feature —
    // scale the window — gets the strip right and the page wrong.
    expect(zoom["training-page"], "the page under test").toBeCloseTo(1, 5);
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
