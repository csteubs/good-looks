// What the three new action steps DO, executed by real Playwright.
//
// The capture half — that a real double-click and a real drag come out as one
// step each — is in `retrain-capture.spec.ts`, which drives the real app. This
// file is the other half: the line the generator writes, run against a page
// that can tell the difference. A page reacting only to `dblclick`, a page
// reacting only to `contextmenu`, a drop zone reacting only to a completed
// pointer gesture. None of that can be settled by looking at the emitted text.
//
// A plain browser page rather than `_electron`, for the same reason
// assert-parity is: the subject is emission semantics, not a window.
//
// VERIFIED TO FAIL: emit `.click()` for a `dblclick` step and "a double-click
// reaches a page listening for one" goes red while its single-click control
// stays green — which is the whole distinction.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type Page } from "@playwright/test";

import { generateSpec } from "../main/services/script-generator.js";
import type { Step } from "../main/recorder/types.js";

// `#row` counts each kind of interaction separately, so a step that fired the
// wrong one is visible rather than merely unproven.
//
// The drop zone is POINTER-DRIVEN, which is what Playwright's `dragTo` performs
// — a real mouse down, moves, and up. HTML5 `draggable=true` is a different
// mechanism that Chromium does not start from synthetic mouse input, so a page
// built on it is not covered by this step and the fixture does not pretend
// otherwise.
const FIXTURE = `<!doctype html>
<html><head><title>Actions fixture</title></head>
<body>
  <button id="row" data-testid="row" data-clicks="0" data-dbl="0" data-ctx="0">Row</button>
  <p id="menu" hidden>Context menu</p>

  <div id="card" data-testid="card" style="position:absolute;left:0;top:120px;width:80px;height:60px;background:#ddd">Card</div>
  <div id="done" data-testid="done" style="position:absolute;left:320px;top:120px;width:140px;height:60px;background:#eee">Done</div>
  <p id="dropped" hidden>Card is done</p>

  <script>
    var row = document.getElementById("row");
    var bump = function (attr) {
      row.setAttribute(attr, String(Number(row.getAttribute(attr)) + 1));
    };
    row.addEventListener("click", function () { bump("data-clicks"); });
    row.addEventListener("dblclick", function () { bump("data-dbl"); });
    row.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      bump("data-ctx");
      document.getElementById("menu").hidden = false;
    });

    // A pointer-driven drop zone: it only completes when a press that STARTED
    // on the card is released over the target.
    var dragging = false;
    document.getElementById("card").addEventListener("mousedown", function () { dragging = true; });
    document.getElementById("done").addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      document.getElementById("dropped").hidden = false;
    });
    document.addEventListener("mouseup", function (e) {
      if (e.target && e.target.id !== "done") dragging = false;
    });
  </script>
</body></html>`;

let server: http.Server;
let base: string;

test.beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

let n = 0;
const s = (over: Partial<Step>): Step => ({ id: "ra" + ++n, timestamp: 0, ...over }) as Step;

/** Run the line the generator emits for a step, with real Playwright. The
 *  emitted TEXT is executed rather than re-derived — a test that rebuilt the
 *  call would assert this file's model of the generator, not the generator. */
async function runStepLine(page: Page, step: Step): Promise<{ ok: boolean; error?: string }> {
  const src = generateSpec({ name: "actions", url: base, steps: [step] });
  const line = src.split("\n").find((l) => l.trim().startsWith("await page."));
  if (!line) throw new Error("no line emitted for step: " + JSON.stringify(step));
  const run = new Function("page", "expect", `return (async () => { ${line.trim()} })();`);
  try {
    await run(page, expect);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

const ROW = { k: "testid" as const, v: "row" };

test("a click does NOT reach a page listening for a double-click", async ({ page }) => {
  // The control. Without it, the double-click row below proves only that
  // something happened.
  await page.goto(base);
  expect((await runStepLine(page, s({ type: "click", locator: ROW }))).ok).toBe(true);
  await expect(page.locator("#row")).toHaveAttribute("data-clicks", "1");
  await expect(page.locator("#row")).toHaveAttribute("data-dbl", "0");
});

test("a double-click reaches a page listening for one", async ({ page }) => {
  await page.goto(base);
  expect((await runStepLine(page, s({ type: "dblclick", locator: ROW }))).ok).toBe(true);
  await expect(page.locator("#row")).toHaveAttribute("data-dbl", "1");
  // And the two clicks underneath it are real too — which is why the recorder
  // has to withdraw them rather than never record them.
  await expect(page.locator("#row")).toHaveAttribute("data-clicks", "2");
});

test("a right-click opens a page's own context menu", async ({ page }) => {
  await page.goto(base);
  expect((await runStepLine(page, s({ type: "rightclick", locator: ROW }))).ok).toBe(true);
  await expect(page.locator("#menu")).toBeVisible();
  await expect(page.locator("#row")).toHaveAttribute("data-ctx", "1");
  // A right-click is not a left one: the page's click counter must not move.
  await expect(page.locator("#row")).toHaveAttribute("data-clicks", "0");
});

test("a drag completes a pointer-driven drop", async ({ page }) => {
  await page.goto(base);
  const res = await runStepLine(
    page,
    s({
      type: "drag",
      locator: { k: "testid", v: "card" },
      toLocator: { k: "testid", v: "done" },
    }),
  );
  expect(res.ok, res.error).toBe(true);
  await expect(page.locator("#dropped")).toBeVisible();
});

test("a drag with a timeout gives up when its target never arrives", async ({ page }) => {
  // Proves the option reached the call rather than merely appearing in the
  // source: without it this would wait out Playwright's 30s default.
  await page.goto(base);
  const started = Date.now();
  const res = await runStepLine(
    page,
    s({
      type: "drag",
      locator: { k: "testid", v: "card" },
      toLocator: { k: "css", v: "#nowhere" },
      timeoutMs: 500,
    }),
  );
  expect(res.ok).toBe(false);
  expect(Date.now() - started).toBeLessThan(2500);
});
