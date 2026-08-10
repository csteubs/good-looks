// No dialog action may be laid out outside the dialog.
//
// This is the only place the property can be checked at all. jsdom has no
// layout engine and the dom project runs with `css: false`, so a flex row that
// overflows its container is not a thing the unit suite can represent —
// `renderer/ui/dialog-actions.test.tsx` renders this exact footer and every
// assertion in it passed for the whole life of the bug.
//
// The bug: `DialogFooter` was a nowrap `flex ... justify-end` row of
// `whitespace-nowrap` buttons. `justify-end` anchors the row's END to the
// container, so when the buttons did not fit the surplus hung off the LEFT. In
// the trainer panel the exit dialog held "Discard Edits", "Cancel" and
// "Save & Exit", and the destructive button was laid out outside the panel,
// over the step list behind it, on both the Discard and the Save Test paths.
//
// The fixture is the REAL `DialogActions` (see dialog-footer-fixtures.tsx),
// injected into the RUNNING app's renderer — so it is measured against the real
// stylesheet, the real fonts and a real layout engine. Radix portals the dialog
// and needs a live React tree, which is why the panel is rebuilt from
// `dialogPanelClass` rather than driven through the app's UI;
// `check:dialog-footer` pins the two numbers that reconstruction depends on.
//
// The nowrap CONTROL is what keeps this test honest. If a label were shortened
// until the row fitted on one line, the containment assertion would start
// passing for a reason that has nothing to do with the fix — so the same markup
// is measured a second time with wrapping forced off, and that one MUST
// overflow. Its failure reads "this fixture stopped exercising the bug", which
// is the message you want.

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

import { test, expect } from "./fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The trainer panel is 360 DIP wide (`PANEL_WIDTH`, main/services/panel-dock.ts)
 *  and the dialog is `w-[calc(100vw-4rem)]` — so 296px, with 264px of content
 *  inside `p-4`. The narrowest surface any dialog is shown on, and the one the
 *  footer overflowed. Both halves of this arithmetic are pinned by
 *  `check:dialog-footer`, so a change to either shows up as a failure with a
 *  name rather than as a test quietly measuring the wrong box. */
const PANEL_DIALOG_WIDTH = 296;

type Fixtures = { panelClass: string; withCancel: string; shipped: string };

const fixtures: Fixtures = JSON.parse(
  execFileSync(
    path.join(here, "..", "node_modules", ".bin", "tsx"),
    [path.join(here, "dialog-footer-fixtures.tsx")],
    { encoding: "utf8" },
  ),
) as Fixtures;

type Measured = {
  /** Buttons whose box is not fully inside the panel's content box. */
  escaped: { label: string; left: number; right: number }[];
  /** Present so a fixture that renders nothing cannot pass as "none escaped". */
  buttons: string[];
  contentLeft: number;
  contentRight: number;
  /** Row count, inferred from distinct button tops. */
  rows: number;
};

async function measure(
  window: Page,
  args: { panelClass: string; footerHtml: string; width: number; nowrap: boolean },
): Promise<Measured> {
  return window.evaluate(({ panelClass, footerHtml, width, nowrap }) => {
    const panel = document.createElement("div");
    panel.className = panelClass;
    // The one thing overridden: `w-[calc(100vw-4rem)]` reads the REAL viewport,
    // and the main window has a 928px floor (check:narrow-layout) it cannot be
    // resized below. This is that expression evaluated at the panel's width.
    panel.style.width = `${width}px`;
    panel.innerHTML = footerHtml;
    document.body.appendChild(panel);

    const footer = panel.querySelector("[data-dialog-footer]");
    if (!(footer instanceof HTMLElement)) throw new Error("no [data-dialog-footer] in the fixture");
    if (nowrap) footer.style.flexWrap = "nowrap";

    // The panel's CONTENT box: the padding is what the buttons must stay inside
    // of, not the border box.
    const panelBox = panel.getBoundingClientRect();
    const style = getComputedStyle(panel);
    const contentLeft = panelBox.left + parseFloat(style.paddingLeft);
    const contentRight = panelBox.right - parseFloat(style.paddingRight);

    const boxes = [...footer.querySelectorAll("button")].map((b) => {
      const r = b.getBoundingClientRect();
      return { label: (b.textContent ?? "").trim(), left: r.left, right: r.right, top: r.top };
    });

    panel.remove();

    return {
      // Half a pixel of subpixel rounding is not a button hanging out of a
      // dialog; the failure this catches is tens of pixels wide.
      escaped: boxes
        .filter((b) => b.left < contentLeft - 0.5 || b.right > contentRight + 0.5)
        .map(({ label, left, right }) => ({ label, left, right })),
      buttons: boxes.map((b) => b.label),
      contentLeft,
      contentRight,
      rows: new Set(boxes.map((b) => Math.round(b.top))).size,
    };
  }, args);
}

/** The app's own stylesheet and fonts have to be up, or every width measured
 *  is a fallback-font width and none of this means anything. */
async function readyToMeasure(window: Page): Promise<void> {
  await expect(window.getByRole("heading", { name: "GOOD LOOKS!" })).toBeVisible();
  await window.evaluate(() => document.fonts.ready.then(() => undefined));
}

test("no dialog action is laid out outside the dialog, at the narrowest width", async ({ window }) => {
  await readyToMeasure(window);

  const real = await measure(window, {
    panelClass: fixtures.panelClass,
    footerHtml: fixtures.withCancel,
    width: PANEL_DIALOG_WIDTH,
    nowrap: false,
  });

  // Said first: the fixture rendered the buttons it claims to be measuring.
  expect(real.buttons).toEqual(["Discard Edits", "Cancel", "Save & Exit"]);
  expect(
    real.escaped,
    `buttons laid out outside the dialog's content box (${real.contentLeft}…${real.contentRight})`,
  ).toEqual([]);

  // The CONTROL. Same markup, wrapping forced off — the shipped behaviour. If
  // it passes, the fixture no longer overflows on one line and the assertion
  // above has stopped proving anything.
  const control = await measure(window, {
    panelClass: fixtures.panelClass,
    footerHtml: fixtures.withCancel,
    width: PANEL_DIALOG_WIDTH,
    nowrap: true,
  });
  expect(
    control.escaped.length,
    "the nowrap control must still overflow — otherwise this fixture no longer exercises the bug and the assertion above is vacuous",
  ).toBeGreaterThan(0);

  // And the mechanism, stated directly: the real row spent a second line on the
  // button the control pushed out of the panel.
  expect(control.rows).toBe(1);
  expect(real.rows).toBeGreaterThan(1);
});

test("the shipped exit-dialog footer fits on one row", async ({ window }) => {
  // Removing Cancel was not only about the overflow — with it gone the
  // trainer's exit dialog fits on a single row again. Wrapping is the floor
  // that makes escaping impossible; it is not the intended look.
  await readyToMeasure(window);

  const result = await measure(window, {
    panelClass: fixtures.panelClass,
    footerHtml: fixtures.shipped,
    width: PANEL_DIALOG_WIDTH,
    nowrap: false,
  });

  expect(result.buttons).toEqual(["Discard Edits", "Save & Exit"]);
  expect(result.escaped).toEqual([]);
  expect(result.rows).toBe(1);
});
