// Does the Add-step dialog fit inside the 360pt trainer panel?
//
// WHY THIS CANNOT BE A UNIT TEST, and it is the whole reason the bug shipped:
// jsdom has no layout engine, so every rectangle it reports is zeros. A row
// rendered 476px wide inside a 360px panel measures identically to one that
// fits, and `truncate` — which is what is supposed to prevent this — is a CSS
// rule jsdom never applies. `renderer/main/add-step-dialog.test.tsx` passes
// against both the broken and the fixed markup.
//
// WHY A `scrollWidth` CHECK IS NOT ENOUGH EITHER, which is the trap. The
// oversized block is inside a `justify-end` flex row, so it is RIGHT-aligned
// and its overflow spills off the LEFT edge at negative coordinates. Negative
// overflow does not extend `scrollWidth`: the document reported
// `scrollWidth === clientWidth === 360` in the broken build, exactly as in the
// fixed one. There is no scrollbar, so the clipped locators cannot be reached
// at all — the user sees text sliced off at both edges and no way to read it.
// The assertion that actually catches it is "no row starts left of zero".
//
// Measured in the REAL panel window rather than a fixture, because the width
// that matters (360pt) is the docked panel's, set by `panel-dock.ts`.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { test, expect } from "./fixtures.js";

type Invoke = { glaze: { ipc: { invoke(channel: string, params?: unknown): Promise<unknown> } } };

/** A page to train against that is not the network. */
async function servePage(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>overflow fixture</title><h1>overflow fixture</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * The locators a real element on a real site produces.
 *
 * The long ones are the point. A generated CSS path and an xpath contain no
 * space, no hyphen and no other break opportunity, so their MIN-CONTENT width
 * is their full width — which is what makes a flex item refuse to shrink and
 * every `truncate` inside it inert. A fixture with short locators passes
 * against the broken build.
 */
const PICKED = {
  tag: "a",
  description: "a.results_list_qAJ8BP__link.is-active",
  candidates: [
    { k: "role", role: "link", name: "Essential for Women Multivitamin 18+" },
    { k: "testid", v: "product-card-link-essential-for-women-18-plus" },
    { k: "css", v: "div.results_list_qAJ8BP > div > div > a:nth-of-type(2)" },
    { k: "xpath", v: '//*[@id="controller"][1]/div[2]/div[1]/div[1]/a[2]' },
  ],
  css: { color: "rgb(27, 42, 94)" },
  attributes: { href: "/products/essential-for-women" },
};

test("the Add-step dialog's Target element list fits the trainer panel", async ({
  app,
  window,
}) => {
  const page = await servePage();
  try {
    await window.evaluate(async () => {
      const api = (window as unknown as { glazeAPI: Invoke }).glazeAPI;
      await api.glaze.ipc.invoke("recorder:setSettings", { trainerPanelEnabled: true });
    });
    await window.evaluate(async (url) => {
      const api = (window as unknown as { glazeAPI: Invoke }).glazeAPI;
      await api.glaze.ipc.invoke("recorder:start", { url, name: "overflow e2e", viewport: null });
    }, page.url);

    const panelPage = await expect
      .poll(
        () => app.windows().find((p) => p.url().includes("trainer-window")) ?? null,
        { timeout: 20_000 },
      )
      .not.toBeNull()
      .then(() => app.windows().find((p) => p.url().includes("trainer-window"))!);

    // Drive the panel exactly as a right-click in the training browser does —
    // `recorder:contextAction` with a picked element is what opens the Add-step
    // dialog on the Target element picker. Sent straight to the panel's
    // webContents because the native "+ Add step" menu is a real macOS menu and
    // cannot be driven from here.
    await app.evaluate(({ BrowserWindow }, picked) => {
      const panel = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes("trainer-window"),
      );
      if (!panel) throw new Error("the trainer panel is not open");
      panel.webContents.send("recorder:contextAction", {
        kind: "assertion",
        assert: "css",
        prefillText: "",
        prefillValue: "",
        target: "panel",
        picked,
      });
    }, PICKED);

    // Wait for the dialog's own content, not for a container — the dialog
    // mounts before the picked element is applied to it.
    await panelPage.getByText("Target element").waitFor({ timeout: 10_000 });

    const report = await panelPage.evaluate(() => {
      const doc = document.documentElement;
      const rows = Array.from(document.querySelectorAll("code, button, input, [role='combobox']")).map((c) => {
        const r = c.getBoundingClientRect();
        return {
          left: Math.round(r.left),
          right: Math.round(r.right),
          text: (c.textContent ?? "").slice(0, 40),
        };
      });
      return { clientWidth: doc.clientWidth, scrollWidth: doc.scrollWidth, rows };
    });

    // Every field's control must stay inside its own column.
    //
    // This is the same defect one level in, and the check above cannot see it:
    // these controls overflow their FIELD while staying inside the panel, so
    // nothing starts at a negative coordinate. Measured in the broken build,
    // the Assertion select began 12px left of its own field and the Match
    // control 25px left of its own — sliced first characters, spilling into the
    // neighbouring column, no scrollbar.
    const fieldOverflow = await panelPage.evaluate(() => {
      const out: { text: string; fieldLeft: number; controlLeft: number }[] = [];
      document.querySelectorAll("[data-orientation]").forEach((f) => {
        const control = f.querySelector("button,select,input,[role='combobox']");
        if (!control) return;
        const fieldLeft = Math.round(f.getBoundingClientRect().left);
        const controlLeft = Math.round(control.getBoundingClientRect().left);
        // 1px of slack for subpixel rounding, not for a real overflow.
        if (controlLeft < fieldLeft - 1) {
          out.push({ text: (f.textContent ?? "").slice(0, 30), fieldLeft, controlLeft });
        }
      });
      return out;
    });
    expect(fieldOverflow, "no field's control spills out of its own column").toEqual([]);
    // A control must not clip its own label either. At 360pt the two-up rows
    // collapse to one column (`sm:grid-cols-2`); without that, "Is exactly /
    // Contains" measured client=125 against scroll=150 and lost "Contains".
    const clipped = await panelPage.evaluate(() =>
      Array.from(document.querySelectorAll("[data-orientation]"))
        .map((f) => {
          const control = f.querySelector("button,[role='combobox']")?.parentElement;
          if (!control) return null;
          return control.scrollWidth > control.clientWidth + 1
            ? { text: (f.textContent ?? "").slice(0, 30), client: control.clientWidth, scroll: control.scrollWidth }
            : null;
        })
        .filter(Boolean),
    );
    expect(clipped, "no control clips its own label").toEqual([]);

    const offLeft = report.rows.filter((r) => r.left < 0);
    const offRight = report.rows.filter((r) => r.right > report.clientWidth);

    // The one that catches the real bug. In the broken build these read
    // left=-287, -207, -193, -208, -198 — sliced off the edge with no scrollbar.
    expect(offLeft, "no locator row starts off the left edge of the panel").toEqual([]);
    expect(offRight, "no locator row runs off the right edge of the panel").toEqual([]);
    // Kept as a second, weaker net: it did NOT fire for the left-spill bug (see
    // the header), but it is what would catch the same mistake in a container
    // that aligns its content the other way.
    expect(report.scrollWidth, "the panel never scrolls sideways").toBeLessThanOrEqual(
      report.clientWidth + 1,
    );
  } finally {
    await page.close();
  }
});

test("the tile strip fits the 360pt panel and does not move when an assert arms", async ({
  app,
  window,
}) => {
  // The 2026-09-01 reorganisation's contract, measured for real: the four
  // ToolTiles fit the panel's width without wrapping, and arming an assertion
  // — which used to inject a prompt, a strictness toggle and a cancel button
  // INLINE into the tool row — moves nothing. check:narrow-layout §5 pins the
  // same contract at source level; only a real layout engine can measure it.
  const page = await servePage();
  try {
    await window.evaluate(async () => {
      const api = (window as unknown as { glazeAPI: Invoke }).glazeAPI;
      await api.glaze.ipc.invoke("recorder:setSettings", { trainerPanelEnabled: true });
    });
    await window.evaluate(async (url) => {
      const api = (window as unknown as { glazeAPI: Invoke }).glazeAPI;
      await api.glaze.ipc.invoke("recorder:start", { url, name: "tile strip e2e", viewport: null });
    }, page.url);

    const panelPage = await expect
      .poll(
        () => app.windows().find((p) => p.url().includes("trainer-window")) ?? null,
        { timeout: 20_000 },
      )
      .not.toBeNull()
      .then(() => app.windows().find((p) => p.url().includes("trainer-window"))!);

    await panelPage.locator(".gl-panelwin-tiles").waitFor({ timeout: 10_000 });

    const measure = () =>
      panelPage.evaluate(() => {
        const doc = document.documentElement;
        const tiles = Array.from(document.querySelectorAll(".gl-panelwin-tiles .gl-tooltile")).map(
          (t) => {
            const r = t.getBoundingClientRect();
            return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top) };
          },
        );
        const zone = document.querySelector(".gl-panelwin-context")!.getBoundingClientRect();
        return {
          clientWidth: doc.clientWidth,
          tiles,
          zoneTop: Math.round(zone.top),
          zoneHeight: Math.round(zone.height),
        };
      });

    const before = await measure();
    expect(before.tiles, "four tiles render").toHaveLength(4);
    for (const t of before.tiles) {
      expect(t.left, "no tile starts off the left edge").toBeGreaterThanOrEqual(0);
      expect(t.right, "no tile runs off the right edge").toBeLessThanOrEqual(before.clientWidth);
    }
    expect(
      new Set(before.tiles.map((t) => t.top)).size,
      "the strip does not wrap — all four tiles share one row",
    ).toBe(1);

    // Arm an assertion the way the menu handler does, then measure again: the
    // armed prompt and the Hard/Soft toggle land in the context band, and the
    // band's reserved height means NOTHING moved.
    await window.evaluate(async () => {
      const api = (window as unknown as { glazeAPI: Invoke }).glazeAPI;
      await api.glaze.ipc.invoke("recorder:setAssert", { mode: "visible", soft: false });
    });
    await panelPage.getByRole("button", { name: "Soft" }).waitFor({ timeout: 10_000 });

    const after = await measure();
    expect(after.tiles, "arming an assert moved no tile").toEqual(before.tiles);
    expect(after.zoneTop, "the context band did not move").toBe(before.zoneTop);
    expect(
      after.zoneHeight,
      "the armed content fits the band's reserved height — growth here is the reflow returning one band down",
    ).toBe(before.zoneHeight);
  } finally {
    await page.close();
  }
});
