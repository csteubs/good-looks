// THE AUTHORITY for element context: one fixture page, both engines, the same
// elements required.
//
// Element context is resolved twice, by two completely different mechanisms:
//
//   • In the TRAINER, by `ctxFilter` inside `matchesFor` — a DOM walk in an
//     injected script (main/recorder/capture-script.ts). This is what prices
//     the picker's rows, what `pickLocator` narrows against, and what Auto-Heal
//     judges a candidate's uniqueness with.
//   • In a RUN, by the chain `locatorExpr` emits — real Playwright resolving
//     `page.getByTestId("x").filter({hasText}).getByRole(…).and(…)`.
//
// If those disagree, the picker says "matches 1 of 9", the user believes the
// step is pinned, and the run acts on a different element — or on none. That is
// the same class of failure as `e2e/assert-parity.spec.ts`, one level down: not
// "what does this step MEAN" but "which element does it POINT AT". A model of
// Playwright's chaining rules could not settle it, because the question is
// precisely whether our model of them is right.
//
// Deliberately NOT an Electron test, for the same reason as assert-parity: the
// subject is locator semantics, not a window. Served over HTTP rather than a
// `data:` URL so the page has a real origin.
//
// VERIFIED TO FAIL by construction: give `ctxFilter`'s container clause
// `contains` without the identity check and the "a container is not a match for
// itself" row reports 2 elements from the injected side against Playwright's 1.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type Page } from "@playwright/test";

import { DOM_HELPERS, UNIQUENESS_HELPERS } from "../main/recorder/capture-script.js";
import { generateSpec } from "../main/services/script-generator.js";
import type { Locator, Step } from "../main/recorder/types.js";

// Every element that can be an answer carries a unique `data-el`, so a verdict
// is a list of NAMES rather than a count. A count would let two engines agree
// on "1" while pointing at different buttons — which is the failure that
// matters most, because it passes.
const FIXTURE = `<!doctype html>
<html><head><title>Cards</title></head>
<body>
  <section data-testid="billing-card" role="region" aria-label="Billing">
    <h3>Billing</h3>
    <button data-el="edit-billing" class="btn edit" data-qa="edit-billing" aria-label="Edit">Edit</button>
    <button data-el="remove-billing" class="btn" aria-label="Remove">Remove</button>
  </section>

  <section data-testid="shipping-card" role="region" aria-label="Shipping">
    <h3>Shipping</h3>
    <button data-el="edit-shipping" class="btn edit" data-qa="edit-shipping" aria-label="Edit">Edit</button>
  </section>

  <ul>
    <li role="listitem" data-el="row-north"><span>North region</span><button data-el="pick-north">Pick</button></li>
    <li role="listitem" data-el="row-south"><span>South region</span><button data-el="pick-south">Pick</button></li>
  </ul>

  <!-- A container that ALSO satisfies the base locator. Playwright's
       page.getByRole("group").getByRole("group") searches INSIDE, so the outer
       one is not a match for itself. -->
  <div role="group" data-testid="outer-group" data-el="outer-group">
    <div role="group" data-el="inner-group">inner</div>
  </div>

  <!-- Test ids that live on the attributes getByTestId does NOT resolve, and a
       value shared across two different attributes. The recorder accepts all
       three spellings; which one it records decides what a run can find. -->
  <section data-test="legacy-card" data-el="legacy-card">
    <button data-test-id="legacy-save" data-el="legacy-save">Keep</button>
  </section>
  <i data-testid="dup-id" data-el="dup-modern">m</i>
  <i data-test="dup-id" data-el="dup-legacy">l</i>
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
 * Playwright.
 *
 * The expression is cut out of generated source rather than rebuilt, because
 * rebuilding it here would be a third implementation of the very chain under
 * test — and the one place a bug could hide unexamined.
 *
 * `evaluateAll` rather than `all()`: it does not enforce strict mode, and half
 * these rows are deliberately ambiguous. Strictness is the recorder's job at
 * record time; this asks the narrower question of WHICH elements the chain
 * selects.
 */
async function playwrightNames(page: Page, loc: Locator): Promise<string[]> {
  const step = { id: "c", type: "assert", assert: "visible", locator: loc, timestamp: 0 } as Step;
  const src = generateSpec({ name: "ctx", url: base, steps: [step] });
  const line = src.split("\n").find((l) => l.trim().startsWith("await expect"));
  if (!line) throw new Error("no assertion emitted for: " + JSON.stringify(loc));
  const inner = line.trim().replace(/^await expect\(/, "").replace(/\)\.toBeVisible\(\);?$/, "");
  const build = new Function("page", `return ${inner};`);
  const locator = build(page);
  return (await locator.evaluateAll((els: Element[]) =>
    els.map((el) => el.getAttribute("data-el") || "?"),
  )) as string[];
}

interface Row {
  label: string;
  loc: Locator;
  /** Which elements this SHOULD select, stated independently of both engines so
   *  a row where they agree and are both wrong still fails. */
  expected: string[];
}

const ROWS: Row[] = [
  // ---- the baseline: without context, this is the ambiguity ---------------
  {
    label: "no context — both Edit buttons",
    loc: { k: "role", role: "button", name: "Edit" },
    expected: ["edit-billing", "edit-shipping"],
  },

  // ---- within -------------------------------------------------------------
  {
    label: "within a testid container",
    loc: {
      k: "role",
      role: "button",
      name: "Edit",
      ctx: { within: { k: "testid", v: "billing-card" } },
    },
    expected: ["edit-billing"],
  },
  {
    label: "within the OTHER container selects the other element",
    loc: {
      k: "role",
      role: "button",
      name: "Edit",
      ctx: { within: { k: "testid", v: "shipping-card" } },
    },
    expected: ["edit-shipping"],
  },
  {
    label: "within a role container",
    loc: {
      k: "text",
      v: "Edit",
      ctx: { within: { k: "role", role: "region", name: "Shipping" } },
    },
    expected: ["edit-shipping"],
  },
  {
    label: "a container that matches nothing selects nothing",
    loc: {
      k: "role",
      role: "button",
      name: "Edit",
      ctx: { within: { k: "testid", v: "no-such-card" } },
    },
    expected: [],
  },
  {
    label: "a container is not a match for itself",
    loc: { k: "role", role: "group", ctx: { within: { k: "testid", v: "outer-group" } } },
    expected: ["inner-group"],
  },

  // ---- withinHasText ------------------------------------------------------
  {
    label: "within + hasText picks the right row",
    loc: {
      k: "text",
      v: "Pick",
      ctx: { within: { k: "role", role: "listitem" }, withinHasText: "South" },
    },
    expected: ["pick-south"],
  },
  {
    label: "hasText matches a SUBSTRING, case-insensitively",
    loc: {
      k: "text",
      v: "Pick",
      ctx: { within: { k: "role", role: "listitem" }, withinHasText: "north region" },
    },
    expected: ["pick-north"],
  },
  {
    label: "hasText that matches no container selects nothing",
    loc: {
      k: "text",
      v: "Pick",
      ctx: { within: { k: "role", role: "listitem" }, withinHasText: "Eastern" },
    },
    expected: [],
  },

  // ---- and ----------------------------------------------------------------
  {
    label: "an `and` predicate intersects",
    loc: {
      k: "role",
      role: "button",
      name: "Edit",
      ctx: { and: [{ k: "css", v: '[data-qa="edit-shipping"]' }] },
    },
    expected: ["edit-shipping"],
  },
  {
    label: "two `and` predicates must both hold",
    loc: {
      k: "css",
      v: "button",
      ctx: { and: [{ k: "css", v: ".edit" }, { k: "css", v: '[data-qa="edit-billing"]' }] },
    },
    expected: ["edit-billing"],
  },
  {
    label: "an `and` that holds of nothing selects nothing",
    loc: {
      k: "role",
      role: "button",
      name: "Edit",
      ctx: { and: [{ k: "css", v: "[data-qa='nope']" }] },
    },
    expected: [],
  },

  // ---- which test-id attribute -------------------------------------------
  //
  // The disagreement these rows pin: the injected oracle used to count matches
  // across data-testid, data-test-id AND data-test for one "testid" locator,
  // while the emitted `getByTestId()` resolves only data-testid. A step
  // recorded off either other attribute was unique in the trainer and matched
  // nothing on a run.
  {
    label: "a test id on data-test-id names its attribute, and a run resolves it",
    loc: { k: "testid", attr: "data-test-id", v: "legacy-save" },
    expected: ["legacy-save"],
  },
  {
    label: "a data-test container scopes the same way it was recorded",
    loc: {
      k: "css",
      v: "button",
      ctx: { within: { k: "testid", attr: "data-test", v: "legacy-card" } },
    },
    expected: ["legacy-save"],
  },
  {
    label: "a bare testid means data-testid ONLY — an equal value on another attribute is not a match",
    loc: { k: "testid", v: "dup-id" },
    expected: ["dup-modern"],
  },

  // ---- everything together ------------------------------------------------
  {
    label: "within + hasText + and",
    loc: {
      k: "role",
      role: "button",
      name: "Edit",
      ctx: {
        within: { k: "testid", v: "billing-card" },
        withinHasText: "Billing",
        and: [{ k: "css", v: ".edit" }],
      },
    },
    expected: ["edit-billing"],
  },
];

for (const row of ROWS) {
  test(`context parity: ${row.label}`, async ({ page }) => {
    await page.goto(base);
    const injected = await injectedNames(page, row.loc);
    const playwright = await playwrightNames(page, row.loc);

    // Both against the fixture's own answer FIRST, so a row where the two
    // engines agree and are both wrong still fails. Two engines agreeing is not
    // evidence that either is right.
    expect(injected.slice().sort(), "the trainer's resolver").toEqual(row.expected.slice().sort());
    expect(playwright.slice().sort(), "real Playwright").toEqual(row.expected.slice().sort());
    expect(injected.slice().sort(), "the two engines must agree").toEqual(playwright.slice().sort());
  });
}

test("`.nth()` indexes the CONTEXT-NARROWED set, in both engines", async ({ page }) => {
  // The ordering requirement in `locatorExpr`, stated as a test. `.nth()` is
  // emitted last because it indexes whatever precedes it — emitted before the
  // context clauses it would index the unnarrowed set, so an indexed step with a
  // container would silently mean a different element than the trainer showed.
  await page.goto(base);

  const scoped: Locator = {
    k: "css",
    v: "button",
    ctx: { within: { k: "testid", v: "billing-card" } },
  };

  // Two buttons in the billing card, in document order.
  expect(await injectedNames(page, scoped)).toEqual(["edit-billing", "remove-billing"]);

  for (const [index, name] of [
    [0, "edit-billing"],
    [1, "remove-billing"],
  ] as const) {
    expect(await playwrightNames(page, { ...scoped, nth: index }), `nth(${index})`).toEqual([name]);
  }

  // And the SAME index means a different element without the context, which is
  // what makes the emission order load-bearing rather than stylistic.
  //
  // Scoped to the shipping card, index 0 is that card's only Edit button;
  // unscoped, index 0 is the first button in the document — in the billing card.
  // (The billing card is deliberately not used for this contrast: its buttons
  // come first in document order, so a scoped and an unscoped index there agree
  // by coincidence and would prove nothing.)
  const shipping: Locator = {
    k: "css",
    v: "button",
    nth: 0,
    ctx: { within: { k: "testid", v: "shipping-card" } },
  };
  expect(await playwrightNames(page, shipping)).toEqual(["edit-shipping"]);
  expect(await playwrightNames(page, { k: "css", v: "button", nth: 0 })).toEqual(["edit-billing"]);

  // ── The row that actually discriminates the emission ORDER ──────────────
  //
  // A container alone does not: the container is PREPENDED, so an index written
  // straight after the target still ends up last in the chain and the two
  // orders produce the same string. `and` is APPENDED, so it is the clause an
  // index can be emitted on the wrong side of — and this row was added after
  // reverting the ordering and finding every other row still green.
  //
  // Five buttons on the page; two carry `.edit`. Indexing the INTERSECTION
  // gives its second member. Indexing first and intersecting after gives the
  // second button on the page, which does not carry `.edit` at all — so the
  // wrong order does not select a different element, it selects NOTHING, and
  // the step fails with "element not found" on a locator that reads correctly.
  const andThenIndex: Locator = {
    k: "css",
    v: "button",
    nth: 1,
    ctx: { and: [{ k: "css", v: ".edit" }] },
  };
  expect(await playwrightNames(page, andThenIndex), "and() must be applied before nth()").toEqual([
    "edit-shipping",
  ]);
});
