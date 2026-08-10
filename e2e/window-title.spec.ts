// The main window has no title, and cannot get one.
//
// Only a real window can answer this. `BrowserWindow.getTitle()` does not exist
// in jsdom, and the interesting half is not the initial value but what happens
// AFTERWARDS: Chromium pushes a document's title up to the window whenever it
// changes, so a window created with `title: ""` silently regains a title bar
// the moment anything in the renderer — the app, a router, a library — assigns
// `document.title`. main/index.ts refuses `page-title-updated` for exactly that
// reason, and this is the only place that refusal can be exercised.
//
// `check:app-identity` pins the source of both halves; this pins the behaviour.

import type { ElectronApplication } from "@playwright/test";

import { test, expect } from "./fixtures.js";

const windowTitle = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());

test("the main window is untitled, and a page title cannot retitle it", async ({ app, window }) => {
  expect(await windowTitle(app)).toBe("");

  // The regression this exists to catch: a renderer setting its own title.
  await window.evaluate(() => {
    document.title = "Good Looks!";
  });

  // NOT `expect.poll`. The title arrives asynchronously, so a poll would pass on
  // its first call — before the update it is meant to reject could even have
  // been delivered — and go on passing after the guard was removed. Wait for the
  // renderer to have handed the title over, then assert once.
  await window.waitForFunction(() => document.title === "Good Looks!");
  await window.waitForTimeout(500);

  expect(await windowTitle(app)).toBe("");
});
