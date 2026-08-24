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

test("the application menu lands on a settings section", async ({ app, window }) => {
  // ⌘, and the six Help items are built in the MAIN PROCESS, before any window
  // exists, and they now have to reach a route in the renderer. Nothing short
  // of a real run covers that path: the push, the renderer's re-check against
  // the pane registry, and the navigation.
  //
  // The menu item is invoked through its own click handler rather than by
  // driving the native menu — a macOS menu's items never enter the DOM, and on
  // the Linux runner CI uses there is no menu bar to open at all.
  await expect(window.getByRole("heading", { name: "GOOD LOOKS!" })).toBeVisible();

  await app.evaluate(({ Menu }) => {
    const help = Menu.getApplicationMenu()?.items.find((i) => i.role === "help");
    const item = help?.submenu?.items.find((i) => i.label === "Set up the MCP server");
    if (!item) throw new Error("the Help menu has no 'Set up the MCP server' item");
    item.click();
  });

  // The pane AND the topic below it — the deep link's whole promise is that
  // every Help item opens a different passage.
  await expect(window.getByRole("heading", { level: 2, name: /setup/i })).toBeVisible();
  expect(app.windows()).toHaveLength(1);
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
