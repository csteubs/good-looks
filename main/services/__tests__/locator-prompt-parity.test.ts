// Parity between the locator the model is SHOWN and the locator that RAN.
//
// `locatorToPrompt` in renderer/lib/llm-prompts.ts renders a step's locator
// into the AI-debug prompts (step debug, the run-debug structure payload's
// "locator that failed", the generate-steps selector context). Its promise is
// stated in its own docstring: the expression the spec actually contains. The
// generator's `locatorExpr` is what decides that expression, in a world the
// renderer cannot import — the same backend↔renderer pair as describeStep,
// kept in sync the same way (see describe-step-parity.test.ts).
//
// This pins the whole path — prompt string against the LINE `generateSpec`
// emits — rather than diffing sibling functions, on purpose. Today
// `locatorToPrompt` delegates to the step list's mirror in describe-step.ts,
// which `describe-mirror.test.ts` already diffs against the generator's
// function; this test holds independently of that arrangement. It keeps
// holding if the prompt grows its own rendering again (how `.nth(k)` and then
// the whole `ctx` chain went missing the first time), and it fails if the
// generator ever emits a locator through something other than `locatorExpr`.
// Each case generates a real spec for a click on the locator and compares the
// prompt rendering against the expression extracted from the emitted line.

import { describe, expect, it } from "vitest";

import { generateSpec } from "../script-generator.js";
import { locatorToPrompt } from "../../../renderer/lib/llm-prompts.js";
import { LOCATOR_KINDS } from "../../recorder/types.js";
import type { Locator, Step } from "../../recorder/types.js";
import type { Locator as RendererLocator } from "../../../renderer/lib/recorder-types.js";

/** The expression the generated spec actually contains for a click on `loc`. */
function emittedExpr(loc: Locator): string {
  const step = { id: "s1", type: "click", timestamp: 0, locator: loc } as Step;
  const spec = generateSpec({ name: "t", url: "https://example.test", steps: [step] });
  const line = spec
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("await page.") && l.endsWith(".click();"));
  expect(line, "the spec should contain the click line").toBeDefined();
  return line!.slice("await page.".length, -".click();".length);
}

const cases: { label: string; loc: Locator }[] = [
  // Every bare kind, including the two testid attribute overrides — those emit
  // an attribute selector rather than getByTestId (shared/testid-attr.mjs).
  { label: "testid", loc: { k: "testid", v: "submit" } },
  { label: "testid on data-test-id", loc: { k: "testid", v: "submit", attr: "data-test-id" } },
  { label: "testid on data-test", loc: { k: "testid", v: "submit", attr: "data-test" } },
  { label: "role with name", loc: { k: "role", role: "button", name: "Sign in" } },
  { label: "role without name", loc: { k: "role", role: "navigation" } },
  { label: "label", loc: { k: "label", v: "Email" } },
  { label: "placeholder", loc: { k: "placeholder", v: "Search…" } },
  { label: "text", loc: { k: "text", v: "Save" } },
  { label: "exact text", loc: { k: "text", v: "Save", exact: true } },
  { label: "css", loc: { k: "css", v: "#main .btn" } },
  { label: "xpath", loc: { k: "xpath", v: "//button[1]" } },

  // The index disambiguator: both boundary values, the one legal negative
  // (`.nth(-1)` is Playwright's "last match"), and a forged deeper negative —
  // reachable through `updateStep`'s raw copy — which the generator floors to
  // 0 and the prompt must therefore floor identically.
  { label: "nth", loc: { k: "text", v: "Save", nth: 3 } },
  { label: "nth 0", loc: { k: "testid", v: "t", nth: 0 } },
  { label: "nth -1 (last match)", loc: { k: "text", v: "Save", nth: -1 } },
  { label: "forged nth -7 falls back with the generator", loc: { k: "text", v: "Save", nth: -7 } },

  // The user's pinned context, clause by clause and composed.
  {
    label: "within",
    loc: { k: "role", role: "button", name: "Edit", ctx: { within: { k: "testid", v: "billing" } } },
  },
  {
    label: "within + hasText",
    loc: {
      k: "role",
      role: "button",
      name: "Edit",
      ctx: { within: { k: "role", role: "listitem" }, withinHasText: "Billing" },
    },
  },
  {
    label: "and (single predicate)",
    loc: { k: "role", role: "button", name: "Edit", ctx: { and: [{ k: "css", v: "[data-qa='edit']" }] } },
  },
  {
    label: "and (two predicates, order-sensitive)",
    loc: { k: "text", v: "Edit", ctx: { and: [{ k: "css", v: ".a" }, { k: "role", role: "button" }] } },
  },
  {
    label: "the full chain: within + hasText + and + nth",
    loc: {
      k: "role",
      role: "button",
      name: "Edit",
      nth: 1,
      ctx: {
        within: { k: "testid", v: "billing" },
        withinHasText: "Billing",
        and: [{ k: "css", v: "[data-qa]" }],
      },
    },
  },
  {
    label: "container on a non-default testid attribute",
    loc: {
      k: "role",
      role: "button",
      name: "Edit",
      ctx: { within: { k: "testid", attr: "data-test", v: "card" } },
    },
  },
  {
    label: "quotes in the container value",
    loc: { k: "role", role: "button", name: "Edit", ctx: { within: { k: "testid", v: 'a"b' } } },
  },
  {
    label: "punctuation in hasText",
    loc: {
      k: "text",
      v: "Edit",
      ctx: { within: { k: "testid", v: "card" }, withinHasText: "Total: $9.99 (inc. tax)" },
    },
  },

  // Degenerate shapes. `normalizeLocatorContext` prevents most of these from
  // being STORED, but the generator renders whatever the record on disk holds,
  // so both sides must degrade identically rather than one dropping a clause
  // the other renders.
  { label: "hasText with no container is ignored", loc: { k: "text", v: "Edit", ctx: { withinHasText: "x" } } },
  { label: "empty and array", loc: { k: "text", v: "Edit", ctx: { and: [] } } },
  {
    label: "a container's own nth is dropped by both sides",
    loc: { k: "text", v: "Edit", ctx: { within: { k: "testid", v: "card", nth: 2 } } },
  },
];

describe("locatorToPrompt parity (prompt ↔ generated spec)", () => {
  for (const c of cases) {
    it(`agrees on: ${c.label}`, () => {
      expect(locatorToPrompt(c.loc as unknown as RendererLocator)).toBe(emittedExpr(c.loc));
    });
  }

  it("covers every locator kind as a target", () => {
    // Guards the check itself, the describe-step-parity treatment: a kind added
    // without a case here would leave the parity untested for it.
    const covered = new Set(cases.map((c) => c.loc.k));
    expect(LOCATOR_KINDS.filter((k) => !covered.has(k))).toEqual([]);
  });
});
