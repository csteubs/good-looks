// Where the branch flyout actually lands, in a window that has a height.
//
// WHY THIS IS HERE AND NOT IN THE UNIT SUITE. `rail-flyout.test.tsx` can pin
// which edge the panel is anchored by, and it does — but it cannot check the
// consequence, because jsdom has no layout engine: `getBoundingClientRect`
// returns zeros, so every placement number is 0 and a panel hanging off the
// bottom of the window measures exactly like one that fits. That is how the
// bug this file exists for shipped and survived a green suite.
//
// THE BUG. The panel was positioned from a `top` computed against its measured
// height. This menu fetches nothing until its first open, so it is placed while
// it still reads "Reading branches…" and then grows by however many branches
// the repo has. Pinned by `top`, that growth goes DOWNWARD, off the bottom of
// the window — on a rail row that sits near the bottom, which is where this row
// sits. Anchoring `bottom` makes upward growth a property of the layout.
//
// So the assertion that matters is made TWICE: once while the list is still
// loading and once after it has arrived. One measurement cannot see a placement
// that is only wrong after the content changes.

import { test, expect } from "./fixtures.js";

test("the branch flyout stays inside the window as its list arrives", async ({ window }) => {
  const row = window.getByRole("button", { name: /Branches/ });
  await expect(row).toBeVisible();

  await row.hover();

  const panel = window.getByRole("menu", { name: "Branches" });
  await expect(panel).toBeVisible();

  /** The panel's box against the window's, as the browser really laid it out. */
  const fits = async () =>
    await panel.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        height: r.height,
        viewport: document.documentElement.clientHeight,
        anchoredByBottom: el.style.bottom !== "" && el.style.top === "",
      };
    });

  // As placed. `maxHeight` is allowed to clamp it, so the test is "inside the
  // window", not "the height I expected".
  const before = await fits();
  expect(before.anchoredByBottom).toBe(true);
  expect(before.top).toBeGreaterThanOrEqual(0);
  expect(before.bottom).toBeLessThanOrEqual(before.viewport);

  // NOW MAKE IT GROW, DELIBERATELY.
  //
  // Waiting for the real branch list to arrive does not test this. Against a
  // repo whose branches resolve quickly the panel is already at full height by
  // the first measurement, so an assertion that it "got taller" passes with
  // nothing having moved — the vacuous shape this file exists to replace.
  // Measured on this machine: both readings were identical. Forcing the growth
  // is also the truer reproduction, because the bug is not about branches, it
  // is about ANY content arriving after placement.
  const grownBy = 120;
  await panel.evaluate((el, px) => {
    const filler = document.createElement("div");
    filler.style.height = `${px}px`;
    el.appendChild(filler);
  }, grownBy);

  const after = await fits();
  expect(after.height).toBeGreaterThan(before.height);

  // The property, three ways. Anchored by `top` all three fail together: the
  // panel keeps its top, its bottom slides down by `grownBy`, and on a row this
  // close to the bottom of the window that is off the screen.
  expect(after.bottom).toBeLessThanOrEqual(before.bottom + 1);
  expect(after.top).toBeLessThan(before.top);
  expect(after.bottom).toBeLessThanOrEqual(after.viewport);
});
