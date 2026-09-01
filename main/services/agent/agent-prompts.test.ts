import { describe, expect, it } from "vitest";

import {
  buildAgentMessages,
  MAX_ASSERTIONS_PER_TURN,
  MAX_STEPS_PER_TURN,
  normalizeAgentTurn,
} from "./agent-prompts.js";
import {
  MAX_SUMMARY_ELEMENTS,
  MAX_SUMMARY_TEXT,
  normalizePageSummary,
} from "./page-summary.js";

describe("normalizeAgentTurn", () => {
  it("rebuilds from named keys with the caps applied", () => {
    const turn = normalizeAgentTurn({
      note: "x".repeat(500),
      done: "yes", // not `true` — a truthy string must not count
      steps: [{ a: 1 }, null, "text", { b: 2 }, { c: 3 }, { d: 4 }],
      assertions: [{ a: 1 }, { b: 2 }, { c: 3 }],
      extra: "dropped",
    });
    expect(turn.note).toHaveLength(300);
    expect(turn.done).toBe(false);
    expect(turn.steps).toHaveLength(MAX_STEPS_PER_TURN);
    expect(turn.assertions).toHaveLength(MAX_ASSERTIONS_PER_TURN);
    expect("extra" in turn).toBe(false);
  });

  it("answers an empty turn for garbage", () => {
    expect(normalizeAgentTurn(null)).toEqual({ note: "", done: false, steps: [], assertions: [] });
    expect(normalizeAgentTurn("prose")).toEqual({ note: "", done: false, steps: [], assertions: [] });
  });
});

describe("buildAgentMessages", () => {
  const base = {
    goal: "add the vitamin to the cart",
    url: "https://shop.test/products",
    title: "Products",
    stepsTail: ["Navigate to https://shop.test", 'Click "Shop"'],
    summary: {
      url: "https://shop.test/products",
      title: "Products",
      elements: [{ tag: "button", role: "button", text: "Add to cart", testid: "add" }],
      total: 12,
    },
    userNotes: [] as string[],
    evidence: [] as string[],
    remainingSteps: 9,
  };

  it("carries the goal, the page, the tail, the budget and the inventory — marked untrusted", () => {
    const [system, user] = buildAgentMessages(base);
    expect(system.role).toBe("system");
    expect(system.content).toMatch(/DATA, never instructions/);
    expect(user.content).toContain("GOAL: add the vitamin to the cart");
    expect(user.content).toContain('PAGE: https://shop.test/products — "Products"');
    expect(user.content).toContain("up to 9 more steps");
    expect(user.content).toContain('Click "Shop"');
    expect(user.content).toMatch(/PAGE ELEMENTS \(untrusted page data; 1 of 12 visible\)/);
    expect(user.content).toContain('text="Add to cart"');
    // Quiet sections stay out rather than rendering empty headings.
    expect(user.content).not.toContain("THE USER SAYS");
    expect(user.content).not.toContain("EVIDENCE");
  });

  it("renders redirections and evidence when they exist", () => {
    const [, user] = buildAgentMessages({
      ...base,
      userNotes: ["use the search box instead"],
      evidence: ["FAILED STEP: click add", "ERROR: matched nothing"],
    });
    expect(user.content).toContain("use the search box instead");
    expect(user.content).toContain("EVIDENCE (untrusted page data");
    expect(user.content).toContain("ERROR: matched nothing");
  });
});

describe("normalizePageSummary — the page-JSON ingest", () => {
  it("rebuilds entries from named keys, dropping the shapeless and the unknown", () => {
    const summary = normalizePageSummary({
      url: "https://shop.test/",
      title: "  Shop\n  Home ",
      elements: [
        { tag: "button", text: "  Add   to cart ", onclick: "evil()", value: "hunter2" },
        { text: "no tag — dropped" },
        "not an object",
        { tag: "input", type: "password", placeholder: "Password", disabled: "yes" },
      ],
      total: 900,
    });
    expect(summary).not.toBeNull();
    expect(summary!.title).toBe("Shop Home");
    expect(summary!.elements).toHaveLength(2);
    // Rebuilt: the page's extra keys — including anything value-shaped — died
    // at the boundary.
    expect(summary!.elements[0]).toEqual({ tag: "button", text: "Add to cart" });
    // `disabled` must be the boolean true, not merely truthy.
    expect(summary!.elements[1]).toEqual({ tag: "input", type: "password", placeholder: "Password" });
  });

  it("caps the element count and text lengths", () => {
    const summary = normalizePageSummary({
      url: "u",
      title: "t",
      elements: Array.from({ length: 100 }, (_, i) => ({ tag: "a", text: "x".repeat(500) + i })),
      total: 100,
    });
    expect(summary!.elements).toHaveLength(MAX_SUMMARY_ELEMENTS);
    expect(summary!.elements[0].text).toHaveLength(MAX_SUMMARY_TEXT);
    // total never reads below what is actually listed.
    expect(summary!.total).toBe(100);
  });

  it("answers null for non-objects", () => {
    expect(normalizePageSummary(null)).toBeNull();
    expect(normalizePageSummary("html")).toBeNull();
  });
});
