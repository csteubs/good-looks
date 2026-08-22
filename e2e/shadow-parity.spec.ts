// THE AUTHORITY for shadow DOM: one fixture page of real web components, both
// engines, the same elements required.
//
// A web component's internals are reached twice, by two different mechanisms:
//
//   • In the TRAINER, by `scanAll` inside `matchesFor` — an injected DOM walk
//     (main/recorder/capture-script.ts) that descends into open shadow roots.
//     This is what prices the picker's rows, what `pickLocator` records
//     against, and what Auto-Heal judges a candidate's uniqueness with.
//   • In a RUN, by real Playwright's selector engines, which pierce open roots
//     on their own — the generator emits nothing special for these steps.
//
// If those disagree the trainer shows one number and the run acts on another;
// the 2026-08-22 bug was the worst version of it, where a click inside a
// component was recorded against the component and "passed" by doing nothing.
// `shadow-dom-capture.dom.test.ts` covers the walk at laptop speed in jsdom,
// but jsdom cannot say what PLAYWRIGHT resolves — and the question here is
// precisely whether our model of Playwright is right. Same shape as
// context-parity.spec.ts, one level down.
//
// Deliberately NOT an Electron test: the subject is locator semantics, not a
// window. Served over HTTP so the page has a real origin.
//
// VERIFIED TO FAIL, each separately: make `scanAll` stop at the document
// (`document.querySelectorAll` alone) and every "inside a root" row reports []
// from the injected side against Playwright's one element; make
// `composedContains` a plain `contains` and the "within a host" row does the
// same; drop the shadowRoot line from `pwText` and "hasText on a host" does;
// count <script> text again and "a text locator inside an open root" reports
// body as a second match. The ORDER test fails if either engine changes
// traversal order. Its first run found the last three — none of which had
// ever been measured against real Playwright.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type Page } from "@playwright/test";

import {
  buildCaptureScript,
  DOM_HELPERS,
  UNIQUENESS_HELPERS,
  WORLD_STATE_KEY,
} from "../main/recorder/capture-script.js";
import { normalizeRawSteps } from "../main/recorder/types.js";
import type { Locator, RawStep, Step } from "../main/recorder/types.js";
import { buildHealProbeScript } from "../main/services/auto-heal.js";
import { generateSpec } from "../main/services/script-generator.js";

// Every element that can be an answer carries a unique `data-el`, so a verdict
// is a list of NAMES rather than a count — two engines can agree on "1" while
// pointing at different buttons, and that is the failure that passes.
//
// The roots are attached by script rather than declaratively so the CLOSED one
// and the NESTED one are built the way real pages build them, and so the
// fixture does not depend on declarative-shadow-DOM support.
const FIXTURE = `<!doctype html>
<html><head><title>Components</title></head>
<body>
  <div id="light">
    <button data-el="light-save">Save</button>
    <button data-el="light-other" data-testid="light-only">Other</button>
  </div>

  <x-card id="card-a"></x-card>
  <x-card id="card-b"></x-card>
  <x-consent id="consent"></x-consent>
  <x-vault id="vault"></x-vault>
  <x-outer id="outer"></x-outer>
  <x-label id="labelled"><span data-el="slotted-text">Projected label</span></x-label>

  <script>
    function open(id, html) {
      document.getElementById(id).attachShadow({ mode: "open" }).innerHTML = html;
    }
    // Two identical components: the same locator is ambiguous ACROSS roots.
    open("card-a", '<button data-el="save-a" class="card-save">Save</button>');
    open("card-b", '<button data-el="save-b" class="card-save">Save</button>');
    // The consent banner shape that found the bug: a host with real controls.
    open("consent",
      '<div class="dg-consent-banner">' +
        '<button data-el="consent-accept" class="dg-button accept_all">Accept All</button>' +
        '<button data-el="consent-close" data-testid="dg-header-close" aria-label="Close">×</button>' +
      '</div>');
    // CLOSED: neither engine may reach it, and both must say so.
    document.getElementById("vault").attachShadow({ mode: "closed" }).innerHTML =
      '<button data-el="vault-btn" data-testid="vault-btn">Vault</button>';
    // NESTED: a host inside a root.
    open("outer", '<div id="mid"></div>');
    document.getElementById("outer").shadowRoot.getElementById("mid")
      .attachShadow({ mode: "open" }).innerHTML =
      '<button data-el="deep" data-testid="deep-btn">Deep</button>';
    // SLOTTED: light-DOM content projected into a root.
    open("labelled", '<div class="lbl"><slot></slot></div>');
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

/** What the TRAINER resolves this locator to, by the real injected helpers. */
async function injectedNames(page: Page, loc: Locator): Promise<string[]> {
  const script = `(function () {
    ${DOM_HELPERS}
    ${UNIQUENESS_HELPERS}
    var found = matchesFor(${JSON.stringify(loc)});
    return found.map(function (el) { return el.getAttribute("data-el") || "?"; });
  })()`;
  return (await page.evaluate(script)) as string[];
}

/**
 * What a RUN resolves it to: the REAL emitted expression, executed by real
 * Playwright. Cut out of generated source rather than rebuilt — see
 * context-parity.spec.ts for why. `evaluateAll` rather than `all()` because
 * strictness is not the question; WHICH elements is.
 */
function emittedLocatorExpr(loc: Locator): string {
  const step = { id: "c", type: "assert", assert: "visible", locator: loc, timestamp: 0 } as Step;
  const src = generateSpec({ name: "shadow", url: base, steps: [step] });
  const line = src.split("\n").find((l) => l.trim().startsWith("await expect"));
  if (!line) throw new Error("no assertion emitted for: " + JSON.stringify(loc));
  return line.trim().replace(/^await expect\(/, "").replace(/\)\.toBeVisible\(\);?$/, "");
}

async function playwrightNames(page: Page, loc: Locator): Promise<string[]> {
  const build = new Function("page", `return ${emittedLocatorExpr(loc)};`);
  const locator = build(page);
  return (await locator.evaluateAll((els: Element[]) =>
    els.map((el) => el.getAttribute("data-el") || "?"),
  )) as string[];
}

interface Row {
  label: string;
  loc: Locator;
  /** Stated independently of both engines, so a row where they agree and are
   *  both wrong still fails. */
  expected: string[];
}

const ROWS: Row[] = [
  // ---- inside one open root, every kind the recorder prefers --------------
  { label: "a testid inside an open root", loc: { k: "testid", v: "dg-header-close" }, expected: ["consent-close"] },
  {
    label: "a role + name inside an open root",
    loc: { k: "role", role: "button", name: "Accept All" },
    expected: ["consent-accept"],
  },
  { label: "a text locator inside an open root", loc: { k: "text", v: "Accept All" }, expected: ["consent-accept"] },
  { label: "a css locator inside an open root", loc: { k: "css", v: "button.accept_all" }, expected: ["consent-accept"] },
  { label: "an aria-label is a role name inside a root", loc: { k: "role", role: "button", name: "Close" }, expected: ["consent-close"] },

  // ---- across roots --------------------------------------------------------
  {
    label: "the same component twice is ambiguous across roots",
    loc: { k: "css", v: "button.card-save" },
    expected: ["save-a", "save-b"],
  },
  { label: "a testid two roots deep", loc: { k: "testid", v: "deep-btn" }, expected: ["deep"] },

  // ---- what neither engine reaches, and both must agree is nothing --------
  { label: "a CLOSED root is invisible to both", loc: { k: "testid", v: "vault-btn" }, expected: [] },
  {
    label: "an xpath cannot reach inside a root, in either engine",
    loc: { k: "xpath", v: '//button[@data-testid="dg-header-close"]' },
    expected: [],
  },
  { label: "an xpath still works in the light DOM", loc: { k: "xpath", v: '//button[@data-el="light-save"]' }, expected: ["light-save"] },

  // ---- context pinned to a host ------------------------------------------
  {
    label: "within a component's HOST reaches inside its root",
    loc: { k: "role", role: "button", name: "Save", ctx: { within: { k: "css", v: "#card-b" } } },
    expected: ["save-b"],
  },
  {
    // `filter({ hasText })` reads Playwright's elementText, which INCLUDES a
    // host's shadow-root text. A host whose only text is inside its root has
    // none by `textContent`, so the old filter kept no container at all.
    label: "hasText on a host reads its root's text",
    loc: {
      k: "role",
      role: "button",
      name: "Save",
      ctx: { within: { k: "css", v: "x-card" }, withinHasText: "Save" },
    },
    expected: ["save-a", "save-b"],
  },
  {
    label: "within a light-DOM container does not leak into roots",
    loc: { k: "role", role: "button", name: "Save", ctx: { within: { k: "css", v: "#light" } } },
    expected: ["light-save"],
  },

  // ---- slotted content is light DOM, in both --------------------------------
  { label: "slotted text is matched where it lives", loc: { k: "text", v: "Projected label" }, expected: ["slotted-text"] },
];

for (const row of ROWS) {
  test(`shadow parity: ${row.label}`, async ({ page }) => {
    await page.goto(base);
    const injected = await injectedNames(page, row.loc);
    const playwright = await playwrightNames(page, row.loc);

    expect(injected.slice().sort(), "the trainer's resolver").toEqual(row.expected.slice().sort());
    expect(playwright.slice().sort(), "real Playwright").toEqual(row.expected.slice().sort());
    expect(injected.slice().sort(), "the two engines must agree").toEqual(playwright.slice().sort());
  });
}

test("the ORDER across light DOM and roots agrees, because `.nth()` indexes it", async ({ page }) => {
  // A sorted comparison would hide this. When nothing is unique the recorder
  // writes `nth`, and an index is only as good as the traversal order both
  // sides share: light DOM first, then each host's root in document order.
  await page.goto(base);
  const loc: Locator = { k: "role", role: "button", name: "Save" };
  const injected = await injectedNames(page, loc);
  const playwright = await playwrightNames(page, loc);
  expect(injected).toEqual(["light-save", "save-a", "save-b"]);
  expect(playwright).toEqual(injected);

  for (const [index, name] of [
    [1, "save-a"],
    [2, "save-b"],
  ] as const) {
    const indexed: Locator = { ...loc, nth: index };
    expect(await injectedNames(page, indexed), `trainer nth(${index})`).toContain(name);
    const build = new Function("page", `return ${emittedLocatorExpr(indexed)};`);
    expect(await build(page).getAttribute("data-el"), `Playwright nth(${index})`).toBe(name);
  }
});

/** Install the real capture script into a plain page and read back what a
 *  real click queued, through `normalizeRawSteps` — the boundary every
 *  recorded step crosses. The script's console egress is harmless here. */
async function recordClick(page: Page, target: string): Promise<RawStep> {
  await page.evaluate(buildCaptureScript("e2e-nonce"));
  await page.locator(target).click();
  const queued = (await page.evaluate(
    `(window[${JSON.stringify(WORLD_STATE_KEY)}] || { queue: [] }).queue.map(function (e) { return e.s; })`,
  )) as unknown[];
  const steps = normalizeRawSteps(queued).filter((s) => s.type === "click");
  expect(steps.length, "one click was recorded").toBe(1);
  return steps[0];
}

test("a click inside a component records the control, and the run resolves the control", async ({ page }) => {
  // The 2026-08-22 bug end to end: the recorded locator used to be the HOST
  // (`css: html > body > aside`), which resolved to one element and dismissed
  // nothing. The step must name the button, be marked as recorded inside a
  // web component, carry no xpath, and resolve — by real Playwright, through
  // the real emitted expression — to that button and not its host.
  await page.goto(base);
  const step = await recordClick(page, "#consent >> internal:testid=[data-testid=\"dg-header-close\"s]");

  expect(step.shadow, "marked as recorded inside a web component").toBe(true);
  expect(step.locator?.k).not.toBe("xpath");
  expect(await playwrightNames(page, step.locator as Locator)).toEqual(["consent-close"]);
});

test("a light-DOM click records no mark, so the chip means something", async ({ page }) => {
  await page.goto(base);
  const step = await recordClick(page, '[data-testid="light-only"]');
  expect(step.shadow).toBeUndefined();
  expect(await playwrightNames(page, step.locator as Locator)).toEqual(["light-other"]);
});

test("Auto-Heal can propose a replacement that lives inside a component", async ({ page }) => {
  // The probe collects candidates with `scanAll`; with `document.querySelectorAll`
  // it proposed nothing on any page built from components. The proposed
  // locator has to resolve by REAL Playwright to the element inside the root.
  await page.goto(base);
  const stale = { id: "h", type: "click", timestamp: 0, locator: { k: "testid", v: "dg-header-close-old" } } as Step;
  const out = (await page.evaluate(buildHealProbeScript(stale, []))) as
    | { candidates?: { locator: Locator }[] }
    | { locator: Locator }[];
  const candidates = Array.isArray(out) ? out : (out.candidates ?? []);
  expect(candidates.length, "the probe proposed something").toBeGreaterThan(0);

  const resolved: string[][] = [];
  for (const c of candidates) resolved.push(await playwrightNames(page, c.locator));
  const insideARoot = new Set(["consent-accept", "consent-close", "save-a", "save-b", "deep"]);
  expect(
    resolved.some((names) => names.length === 1 && insideARoot.has(names[0])),
    `a candidate resolves inside a root: ${JSON.stringify(resolved)}`,
  ).toBe(true);
  expect(candidates.every((c) => c.locator.k !== "xpath"), "no dead xpath is offered").toBe(true);
});
