// The describe mirror, pinned mechanically.
//
// renderer/lib/describe-step.ts promises the step list shows the call the
// generated script contains, and every function in it says "keep in sync"
// with its script-generator counterpart — a promise that held by COMMENT
// until 2026-08-19, when the mirror turned out to have stopped at the base
// builder: context chains and `.nth()` were generated but never displayed.
// This test replaces the comment with a diff: both `locatorExpr`s run over a
// battery of locators — every kind, every context clause shape, every legal
// index including -1 — and any drift fails here first instead of shipping as
// a step list that under-describes exactly the steps that needed pinning.

import { describe, expect, it } from "vitest";

import { locatorExpr as generatorExpr } from "../../main/services/script-generator.js";
import { locatorExpr as displayExpr } from "./describe-step";
import type { Locator } from "./recorder-types";

const BASES: Locator[] = [
  { k: "testid", v: "submit" },
  { k: "testid", v: "submit", attr: "data-test" },
  { k: "role", role: "button", name: "Save" },
  { k: "role", role: "navigation" },
  { k: "label", v: "Email" },
  { k: "placeholder", v: "Search…" },
  { k: "text", v: "Add to cart" },
  { k: "text", v: "Add to cart", exact: true },
  { k: "css", v: "form#login button.primary" },
  { k: "xpath", v: "//td[text()='A']/ancestor::tr" },
];

const DRESSINGS: ((base: Locator) => Locator)[] = [
  (b) => b,
  (b) => ({ ...b, nth: 0 }),
  (b) => ({ ...b, nth: 2 }),
  (b) => ({ ...b, nth: -1 }),
  (b) => ({ ...b, ctx: { within: { k: "testid", v: "billing-card" } } }),
  (b) => ({
    ...b,
    ctx: { within: { k: "role", role: "region" }, withinHasText: "Billing" },
  }),
  (b) => ({ ...b, ctx: { and: [{ k: "css", v: '[data-qa="x"]' }] } }),
  (b) => ({
    ...b,
    nth: 1,
    ctx: {
      within: { k: "testid", v: "card" },
      withinHasText: 'He said "ok"',
      and: [{ k: "css", v: ".btn" }, { k: "text", v: "Save" }],
    },
  }),
];

describe("the step list renders the same chain the generator emits", () => {
  for (const base of BASES) {
    for (const dress of DRESSINGS) {
      const loc = dress(base);
      it(JSON.stringify(loc), () => {
        expect(displayExpr(loc)).toBe(generatorExpr(loc));
      });
    }
  }
});
