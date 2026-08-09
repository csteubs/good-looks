// Real windows, opened by the real main process.
//
// This is the clearest example of what only an end-to-end run can check. The
// settings window is created by main/windows/settings-window.ts in response to
// an IPC call; jsdom has no concept of a second window, so the unit suite
// covers the settings VIEW while nobody covers the thing that puts it on
// screen.
//
// The window is opened by invoking the channel directly rather than by clicking
// the sidebar's gear. That entry point goes through `Menu.popup`, a real macOS
// menu whose items never enter the DOM — deliberately, and documented as such.
// Driving the channel tests the half that is actually testable; the menu
// template itself is covered at the unit level.

import { test, expect } from "./fixtures.js";

test("opening settings creates a second window", async ({ app, window }) => {
  expect(app.windows()).toHaveLength(1);

  const opened = app.waitForEvent("window");
  await window.evaluate(() =>
    (window as unknown as { glazeAPI: { glaze: { ipc: { invoke(c: string): Promise<unknown> } } } }).glazeAPI.glaze.ipc.invoke(
      "window:openSettings",
    ),
  );

  const settings = await opened;
  await settings.waitForLoadState("domcontentloaded");

  expect(new URL(settings.url()).pathname).toContain("settings-window");
  expect(app.windows().length).toBeGreaterThanOrEqual(2);

  // Asking twice must focus the existing window, not stack a second copy.
  // A duplicate is invisible in a screenshot — the top one looks right — and
  // the two then write the same settings file from two renderers.
  const before = app.windows().length;
  await window.evaluate(() =>
    (window as unknown as { glazeAPI: { glaze: { ipc: { invoke(c: string): Promise<unknown> } } } }).glazeAPI.glaze.ipc.invoke(
      "window:openSettings",
    ),
  );
  await expect.poll(() => app.windows().length, { timeout: 5_000 }).toBe(before);
});

test("the main process exposes exactly one main window at startup", async ({ app, window }) => {
  // Guards a specific startup failure: main/index.ts creates the main window
  // in whenReady AND on the "activate" event. If activate fires during launch
  // without the "no windows open" guard, the app starts with two.
  //
  // Taking the `window` fixture is load-bearing, not decoration. Asking the
  // main process for its window count the instant `app` resolves races
  // whenReady and reads 0 — which is a green "not two" for the wrong reason,
  // and would keep passing after the guard was removed.
  await expect(window.getByRole("heading", { name: "GOOD LOOKS!" })).toBeVisible();

  const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  expect(count).toBe(1);
});
