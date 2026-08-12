// The app's chrome is reachable by mouse.
//
// This is the one place in the repo where that can be asserted at all. jsdom
// has no layout engine, so an element covering a button is not a thing it can
// represent: `app-launch.spec.ts` already asserts the "+" is VISIBLE, and
// `library-sidebar.test.tsx` already clicks it and asserts the menu opens, and
// both passed for the entire life of the bug below. The dom project also runs
// with `css: false`, so no unit test can read a computed cursor either.
//
// The bug: `root-view.tsx` carried a `drag-region fixed left-0 right-0 top-0
// h-13` overlay left over from the frameless Glaze host window. The main window
// takes Electron's default native title bar, so it dragged nothing — but a
// `fixed` box paints above in-flow content regardless of DOM order, so it won
// every hit test in the top 52px. That band is the sidebar header, and the "+"
// (Add test) button in it is the app's primary entry point: clicking it did
// nothing and hovering it didn't even change the cursor, because the pointer
// never reached it.
//
// Both halves are asserted here against real layout and real CSS. The
// source-level `check:clickable-chrome` guards the same two properties in the
// fast local gate; this is the one that could actually have caught it.

import { test, expect } from "./fixtures.js";

test("the sidebar's + button is not covered by anything", async ({ window }) => {
  const add = window.getByRole("button", { name: "Add test" });
  await expect(add).toBeVisible();

  // `trial` runs Playwright's full actionability check — visible, stable, and
  // RECEIVES EVENTS — and then does not click. The click itself would open a
  // native menu (`Menu.popup`), which blocks the main process until something
  // dismisses it; the trial is what lets the real window be tested without
  // hanging on a modal nothing can close.
  await add.click({ trial: true });

  // Said again directly, because the trial's failure ("element intercepts
  // pointer events") names the covering element in a way that is easy to read
  // past. This one states the property: the topmost thing at the button's
  // centre IS the button.
  const hit = await add.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top) return "nothing (the point is outside the viewport)";
    if (top === el || el.contains(top)) return "the button";
    return `${top.tagName.toLowerCase()}.${top.className}`;
  });
  expect(hit, "the topmost element over the + button").toBe("the button");
});

test("the top strip's controls are not covered by the atmosphere overlays", async ({ window }) => {
  // NEW IN A4, AND THE ONE THING ONLY THIS SUITE CAN ANSWER ABOUT IT.
  //
  // `<Atmosphere />` mounts two full-viewport `position: fixed` layers —
  // portalled to `document.body`, at `z-index: 600`, painted above every piece
  // of chrome in the window. They carry `pointer-events: none`, which is the
  // only reason the app is usable at all, and `check:theme-tokens` pins that in
  // the stylesheet. But a stylesheet assertion is a claim about text: it cannot
  // say whether the rule reached the element, whether something later in the
  // cascade overrode it, or whether a third layer arrives without it.
  //
  // The failure would be total and would look like nothing: a transparent sheet
  // over the whole app, every click landing on it, no error anywhere — the same
  // shape as the `drag-region` overlay this file was written for, except across
  // the entire window instead of its top 52px.
  //
  // jsdom cannot see it (no layout engine, and the dom project runs with
  // `css: false`), and the browser preview does not run the real shell. So:
  // here, against real layout, on the two controls the strip owns.
  const layers = await window.locator("[data-gl-atmo]").count();
  expect(layers, "the atmosphere layers are actually mounted").toBeGreaterThan(0);

  for (const name of ["Hide library", "Settings"]) {
    const control = window.getByRole("button", { name });
    await expect(control).toBeVisible();
    await control.click({ trial: true });

    const hit = await control.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!top) return "nothing (the point is outside the viewport)";
      if (top === el || el.contains(top)) return "the control";
      return `${top.tagName.toLowerCase()}.${top.className}`;
    });
    expect(hit, `the topmost element over "${name}"`).toBe("the control");
  }
});

test("buttons show the pointer cursor on hover", async ({ window }) => {
  // `body` sets `cursor: default` app-wide and Tailwind v4's preflight sets the
  // same on `button`, so this is not inherited from anywhere — `@ui`'s Button
  // has to ask for it, and for a while it didn't. A button that gives no hover
  // feedback reads as decoration.
  const cursor = await window
    .getByRole("button", { name: "Add test" })
    .evaluate((el) => getComputedStyle(el).cursor);
  expect(cursor).toBe("pointer");
});
