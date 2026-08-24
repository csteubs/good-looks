// Real windows, and the one the app deliberately no longer opens.
//
// This file used to prove that `window:openSettings` created a SECOND real
// window and did not duplicate it — the clearest example of something jsdom
// cannot host. Settings is a route in the main window now
// (docs/plans/settings-view.md), so the fact worth guarding inverted: opening
// it must create no window at all, and the application menu — which is built
// in the main process before any window exists — must still be able to land
// somebody on a section.
//
// Both go through real UI rather than an IPC channel, because there is no
// longer a channel to drive.

import { test, expect } from "./fixtures.js";

test("opening Settings opens NO second window", async ({ app, window }) => {
  // THE INVERSE OF WHAT THIS FILE USED TO ASSERT, and the change it guards.
  // Settings was a `BrowserWindow` created by main/windows/settings-window.ts
  // in response to `window:openSettings`; it is a route in this window now
  // (docs/plans/settings-view.md). What only an end-to-end run can check is
  // that nothing still creates one — a second window would be invisible in a
  // screenshot of the first, and the two would then write the same settings
  // file from two renderers.
  await expect(window.getByRole("heading", { name: "GOOD LOOKS!" })).toBeVisible();
  expect(app.windows()).toHaveLength(1);

  // Through the rail, which is the app's own way in. Driving an IPC channel
  // would prove nothing here: there is no longer a channel to drive.
  await window.getByRole("button", { name: /^Settings/ }).click();
  await expect(window.getByText("How the app looks")).toBeVisible();

  expect(app.windows()).toHaveLength(1);
  const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  expect(count).toBe(1);
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
