// Does the app actually come up?
//
// Every assertion here is one the Vitest suite structurally cannot make. jsdom
// renders components; it does not boot a main process, register a custom
// scheme, run a preload, or open a window. The failures this catches are the
// ones that leave the unit suite entirely green:
//
//   - the renderer served from file:// and silently CORS-blocked (the reason
//     app:// exists at all — blank window, clean log)
//   - a preload that throws, so window.glazeAPI never exists and every view
//     renders its error state
//   - a main-process module that throws at import, before whenReady

import { test, expect } from "./fixtures.js";
import { fillWorkArea } from "../main/services/window-fill.js";

test("the main window opens and renders the library", async ({ window }) => {
  // Served over the custom scheme, not file://. This is the regression that
  // produced a blank window with nothing in any log.
  expect(new URL(window.url()).protocol).toBe("app:");

  await expect(window.getByRole("heading", { name: "GOOD LOOKS!" })).toBeVisible();

  // A fresh userData dir means an empty library, so the empty state is the
  // correct thing to see. Asserting it — rather than just "something rendered"
  // — is what proves the store was read rather than merely constructed.
  await expect(window.getByText(/No tests yet/)).toBeVisible();
});

test("the main window opens filling the display", async ({ app, window }) => {
  // ONLY AN END-TO-END RUN CAN CHECK THIS. `fillWorkArea` is unit-tested, but
  // the arithmetic being right is not the property here — the property is that
  // the real window is created against a real display's work area. Deleting the
  // call in main/index.ts leaves every unit test green and the app opening at
  // 1000×700 again, which is the regression this file exists to notice.
  // The `window` fixture is load-bearing before its first use below: it awaits
  // the app's first window, and without it `getAllWindows()` can run against an
  // app whose window has not been created yet and read `undefined`.
  const geometry = await app.evaluate(({ BrowserWindow, screen }) => {
    const bounds = BrowserWindow.getAllWindows()[0].getBounds();
    return { bounds, workArea: screen.getDisplayMatching(bounds).workArea };
  });

  // The floor is in the expectation rather than assumed away: a headless CI
  // display can be smaller than the main window's 960×456 minimum, and there
  // the correct window is the floor-sized one, not the screen-sized one.
  expect(geometry.bounds).toEqual(
    fillWorkArea(geometry.workArea, { width: 960, height: 456 }),
  );

  // And the renderer got the room, rather than a window that merely reports it.
  // A viewport is what the sidebar and the toolbar actually lay out against.
  const viewport = await window.evaluate(() => document.documentElement.clientWidth);
  expect(viewport).toBeGreaterThanOrEqual(Math.min(geometry.workArea.width, 960));
});

test("the preload bridge is exposed to the renderer", async ({ window }) => {
  // Not a style preference: if this is missing every view falls back to an
  // empty state that looks exactly like "you have no data yet".
  const bridge = await window.evaluate(() => {
    const api = (window as unknown as { glazeAPI?: Record<string, unknown> }).glazeAPI;
    if (!api) return null;
    return {
      hasIpc: typeof (api.glaze as { ipc?: { invoke?: unknown } })?.ipc?.invoke === "function",
      hasClipboard: typeof (api.clipboard as { writeText?: unknown })?.writeText === "function",
      hasMenu: typeof (api.Menu as { popup?: unknown })?.popup === "function",
    };
  });

  expect(bridge).not.toBeNull();
  expect(bridge).toEqual({ hasIpc: true, hasClipboard: true, hasMenu: true });
});

test("the sidebar offers every view", async ({ window }) => {
  // SCOPED TO THE RAIL'S "Views" GROUP, not the whole window, and the reason is
  // a failure this test has already had: it used to search the window for a
  // button whose name STARTS WITH "Heals", and the home screen then grew a
  // readout called "Heals to review: 0, opens the Heals view". Two matches is a
  // strict-mode violation, so a green test turned red over a control that has
  // nothing to do with the sidebar — and the red reads as "the rail lost its
  // Heals entry", which is the opposite of what happened.
  //
  // `RailGroup` renders `role="group"` with its label, so the scope is the same
  // structure a screen-reader user navigates by. That also makes the assertion
  // say what it means: these four are reachable FROM THE RAIL, which is the
  // claim in the test's name and the one a home-screen shortcut cannot satisfy.
  const views = window.getByRole("group", { name: "Views" });
  // "Routines", not "Batch": the word changed in the UI when the Batch screen
  // became one Routine's editor (REDESIGN §7.1). The ROUTE is still `/batch`
  // and so are the channels — per ROUTINES.md's rename table, only what a
  // person reads changed. This assertion is on what a person reads.
  for (const name of ["Stats", "Visual", "Routines", "Heals"]) {
    await expect(views.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await expect(window.getByRole("button", { name: "Add test" })).toBeVisible();
});

test("the renderer loads without console errors", async ({ app }) => {
  const window = await app.firstWindow();
  const errors: string[] = [];
  window.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // The LLM provider probe runs on mount and there is no Ollama on a CI
    // runner. That failure is the app working correctly, and the footer
    // reports it — filtering it here rather than not asserting at all keeps
    // the check meaningful for every OTHER error.
    if (text.includes("11434") || text.includes("127.0.0.1") || text.includes("localhost")) return;
    errors.push(text);
  });

  await window.reload();
  await expect(window.getByRole("heading", { name: "GOOD LOOKS!" })).toBeVisible();

  expect(errors).toEqual([]);
});
