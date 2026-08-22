// THE AUTHORITY for the iframe ENGINE: the generator emits a `frameLocator`
// chain for a framed locator, and real Playwright resolves that chain to the
// element the recorder meant — one hop, two hops, and with element context.
//
// Why real Playwright: `frame-engine.test.ts` pins the emission SHAPE in Node,
// but the shape is only right if Playwright's `frameLocator` resolves it the
// way this app assumes. A model of that cannot answer it — the same reason
// context-parity.spec.ts and shadow-parity.spec.ts run here. Element inside a
// frame is the property; the generator is unchanged apart from the frame
// prefix, so this is where "the prefix is correct" is actually established.
//
// Deliberately NOT an Electron test: the subject is locator resolution, not a
// window. Served over HTTP so the outer page and its frames share an origin
// (Playwright pierces same-origin frames; cross-origin is out of scope for the
// engine — see docs/IFRAMES.md).
//
// VERIFIED TO FAIL by construction: drop the `root()` prefix in
// script-generator.ts and every framed row resolves nothing (the bare
// `page.getByRole` cannot see into the frame).

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type Page } from "@playwright/test";

import { generateSpec } from "../main/services/script-generator.js";
import type { Locator, Step } from "../main/recorder/types.js";

// The inner frame documents, addressed by path. Each control carries a unique
// data-el so a verdict is a NAME, not a count.
const INNER = `<!doctype html><html><body>
  <button data-el="inner-pay" class="pay">Pay</button>
  <button data-el="inner-cancel">Cancel</button>
  <div data-testid="card"><button data-el="inner-edit" data-qa="edit">Edit</button></div>
</body></html>`;
const DEEP = `<!doctype html><html><body><button data-el="deep-go" data-testid="go">Go</button></body></html>`;
const MIDDLE = `<!doctype html><html><body><iframe name="inner" src="/deep"></iframe></body></html>`;
const OUTER = `<!doctype html><html><head><title>Frames</title></head><body>
  <button data-el="top-pay" class="pay">Pay</button>
  <iframe name="checkout" src="/inner"></iframe>
  <iframe name="outer" src="/middle"></iframe>
</body></html>`;

let server: http.Server;
let base: string;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(path === "/inner" ? INNER : path === "/middle" ? MIDDLE : path === "/deep" ? DEEP : OUTER);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** The REAL emitted expression for a locator, executed by real Playwright.
 *  Cut out of generated source rather than rebuilt — see context-parity. */
function emittedExpr(loc: Locator): string {
  const step = { id: "c", type: "assert", assert: "visible", locator: loc, timestamp: 0 } as Step;
  const src = generateSpec({ name: "frames", url: base, steps: [step] });
  const line = src.split("\n").find((l) => l.trim().startsWith("await expect"));
  if (!line) throw new Error("no assertion emitted for " + JSON.stringify(loc));
  return line.trim().replace(/^await expect\(/, "").replace(/\)\.toBeVisible\(\);?$/, "");
}

async function names(page: Page, loc: Locator): Promise<string[]> {
  const build = new Function("page", `return ${emittedExpr(loc)};`);
  return (await build(page).evaluateAll((els: Element[]) =>
    els.map((el) => el.getAttribute("data-el") || "?"),
  )) as string[];
}

interface Row {
  label: string;
  loc: Locator;
  expected: string[];
}

const ROWS: Row[] = [
  { label: "role+name in a named frame", loc: { k: "role", role: "button", name: "Pay", frame: [{ k: "name", v: "checkout" }] }, expected: ["inner-pay"] },
  { label: "testid in a named frame", loc: { k: "role", role: "button", name: "Cancel", frame: [{ k: "name", v: "checkout" }] }, expected: ["inner-cancel"] },
  { label: "css in a named frame", loc: { k: "css", v: "button.pay", frame: [{ k: "name", v: "checkout" }] }, expected: ["inner-pay"] },
  { label: "a frame by src substring", loc: { k: "role", role: "button", name: "Pay", frame: [{ k: "url", v: "/inner" }] }, expected: ["inner-pay"] },
  { label: "two frames deep", loc: { k: "testid", v: "go", frame: [{ k: "name", v: "outer" }, { k: "name", v: "inner" }] }, expected: ["deep-go"] },
  {
    label: "element context resolves INSIDE the frame",
    loc: {
      k: "role",
      role: "button",
      name: "Edit",
      frame: [{ k: "name", v: "checkout" }],
      ctx: { within: { k: "testid", v: "card" }, and: [{ k: "css", v: "[data-qa=edit]" }] },
    },
    expected: ["inner-edit"],
  },
  {
    label: "the SAME locator without a frame stays in the top document",
    loc: { k: "css", v: "button.pay" },
    expected: ["top-pay"],
  },
];

for (const row of ROWS) {
  test(`frame parity: ${row.label}`, async ({ page }) => {
    await page.goto(base);
    expect((await names(page, row.loc)).slice().sort()).toEqual(row.expected.slice().sort());
  });
}

test("a framed click actually acts inside the frame", async ({ page }) => {
  // Not just resolution — the generated action runs where it points. Clicking
  // the framed Pay button flips a flag the top page can read back.
  await page.goto(base);
  await page.frameLocator('iframe[name="checkout"]').locator("button.pay").evaluate((b) => {
    b.addEventListener("click", () => b.setAttribute("data-clicked", "yes"));
  });
  const step = { id: "a", type: "click", timestamp: 0, locator: { k: "role", role: "button", name: "Pay", frame: [{ k: "name", v: "checkout" }] } } as Step;
  const src = generateSpec({ name: "t", url: base, steps: [step] });
  const clickExpr = src.split("\n").find((l) => l.includes(".click("))!.trim().replace(/^await\s+/, "").replace(/;$/, "");
  await new Function("page", `return ${clickExpr}`)(page);
  await expect(page.frameLocator('iframe[name="checkout"]').locator("button.pay")).toHaveAttribute("data-clicked", "yes");
});
