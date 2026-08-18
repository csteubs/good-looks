// The dialog that started a recording must not still be on screen afterwards.
//
// The bug (docs/issue-audit/fix-137.md): the composed `Dialog`'s confirm calls
// `onConfirm()` and never `onOpenChange(false)`, so "Start recording" opened
// the trainer and left the modal — and Radix's full-viewport overlay — over the
// main window, swallowing every pointer event behind it for the rest of the
// session.
//
// WHY THE EXISTING SUITE WAS GREEN AGAINST IT. `record-then-run.spec.ts` starts
// a recording by invoking `recorder:start` over IPC directly, which is the
// right call for a test about capture and generation and is exactly why it
// could never see this: no dialog was ever opened, so none could be left
// behind. This spec takes the user's path instead.
//
// It goes through the ⌘K palette rather than the library rail's `+`, which is
// the honest broken path AND the drivable one: the rail's `+` is a real macOS
// menu (`Menu.popup`) whose items never enter the DOM, so Playwright cannot
// click them. Both mount the same component, outside the outlet `RootShell`
// swaps — which is the property that makes the leak survive.
//
// The overlay is asserted as well as the dialog because they fail
// independently and only one of them is visible: a dialog panel is obvious in a
// screenshot, while a transparent full-viewport overlay that eats clicks looks
// exactly like an app that has hung.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { test, expect } from "./fixtures.js";

const PAGE = `<!doctype html>
<html><head><title>Fixture</title></head>
<body><h1 data-testid="heading">Recording fixture</h1></body></html>`;

async function serveSite(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("the New recording dialog is gone once the recording has started", async ({ app, window }) => {
  const site = await serveSite();
  try {
    // The palette is opened by CLICKING the top strip's ⌘K cap, not by pressing
    // the chord. The cap exists precisely so the palette is reachable without
    // the keyboard, and it lands in the same place.
    //
    // Two attempts at the chord failed on CI before this. `Meta+k` was wrong on
    // its own terms — on Linux "Meta" is the Super key and sets neither
    // modifier `isPaletteChord` reads — but `ControlOrMeta+k` failed there too,
    // so the keystroke is not reaching the renderer's `window` keydown listener
    // at all under xvfb, where nothing has given the window focus. That is a
    // property of the harness, not of the app, and it is not what this test is
    // about: the subject is what happens to the DIALOG after the recording
    // starts. Driving the app's own button keeps the test on its subject and
    // off a headless focus quirk. (The chord itself is covered in
    // `command-palette.test.tsx`, where `isPaletteChord` is called directly.)
    await window.getByRole("button", { name: /Run a command/i }).click();

    // Asserted before the row, so a palette that did not open says so. Both CI
    // failures above reported "option not found", which reads as a missing
    // command and sent the diagnosis to the wrong place twice.
    await expect(window.getByRole("combobox", { name: "Run a command" })).toBeVisible();

    // The row is picked with `mouseDown` rather than a click on purpose (the
    // palette closes on blur, so a click would dismiss the row out from under
    // the pointer) — `click()` here dispatches the full sequence, mousedown
    // included.
    const record = window.getByRole("option", { name: /Record a test/i });
    await expect(record).toBeVisible();
    await record.click();

    const dialog = window.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await window.getByPlaceholder("https://example.com").fill(site.url);

    // The trainer window is what proves the recording actually started — a
    // dialog that closed without starting anything would pass a
    // "no dialog on screen" assertion trivially.
    const trainerOpened = app.waitForEvent("window");
    await window.getByRole("button", { name: /start recording/i }).click();
    const trainer = await trainerOpened;
    await trainer.waitForLoadState("domcontentloaded");

    // 1. No dialog left in the main window.
    await expect(window.getByRole("dialog")).toHaveCount(0);

    // 2. No overlay left either — the half nobody can see. `DialogOverlay` is
    //    Radix's `fixed inset-0` sheet carrying `data-state`; it draws a wash
    //    but its damage is that it takes every pointer event. Selected by that
    //    shape rather than by a bare `[data-state="open"]`, which also matches
    //    accordions and tabs and would go red for unrelated reasons.
    await expect
      .poll(async () => window.locator('.fixed.inset-0[data-state="open"]').count(), {
        timeout: 5_000,
      })
      .toBe(0);

    // 3. The app behind it is reachable. This is the symptom the user reports —
    //    "the window stopped responding" — and it is the one that stays true
    //    however the overlay is spelled, so it is the assertion that survives a
    //    Radix upgrade renaming the attributes above.
    const blocked = await window.evaluate(() => {
      const el = document.elementFromPoint(globalThis.innerWidth / 2, globalThis.innerHeight / 2);
      return Boolean(el?.closest('[role="dialog"]') || el?.matches(".fixed.inset-0"));
    });
    expect(blocked).toBe(false);
  } finally {
    await site.close();
  }
});
