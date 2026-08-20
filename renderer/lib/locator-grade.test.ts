// The grade is a pure function of the stored locator, and the cases that
// matter are the recorder's own fallback shapes — the exact strings
// `xpathFor` and `cssPath` produce — because those are what the indicator
// exists to surface. The healthy majority must grade null: a badge on every
// row stops meaning anything.

import { describe, expect, it } from "vitest";

import { gradeCounts, gradeLocator } from "./locator-grade";
import type { Locator } from "./recorder-types";

describe("gradeLocator", () => {
  it("is silent for the healthy shapes", () => {
    const healthy: Locator[] = [
      { k: "testid", v: "submit" },
      { k: "role", role: "button", name: "Save" },
      { k: "label", v: "Email" },
      { k: "text", v: "Add to cart" },
      { k: "css", v: "#login-form" },
      { k: "css", v: "button.add-to-cart" },
      { k: "xpath", v: "//button[@data-qa='submit']" },
      { k: "role", role: "button", name: "Edit", ctx: { within: { k: "testid", v: "card" } } },
    ];
    for (const loc of healthy) expect(gradeLocator(loc), JSON.stringify(loc)).toBeNull();
  });

  it("flags xpathFor's positional walk", () => {
    // The exact fallback shape the capture script emits when nothing names
    // the element — unique today, wrong after the next deploy.
    expect(gradeLocator({ k: "xpath", v: "/html[1]/body[1]/div[3]/button[2]" })?.tier).toBe(
      "positional",
    );
  });

  it("flags cssPath's nth-of-type chain", () => {
    expect(
      gradeLocator({ k: "css", v: "body > section:nth-of-type(1) > button" })?.tier,
    ).toBe("positional");
  });

  it("flags a hand-written selector with the same fragile shape", () => {
    expect(gradeLocator({ k: "css", v: "ul li:nth-child(2) div:nth-child(1)" })?.tier).toBe(
      "positional",
    );
    // One :nth-child alone is a legitimate hand-written choice.
    expect(gradeLocator({ k: "css", v: "li:nth-child(2)" })).toBeNull();
  });

  it("flags an index, phrasing last as the stable one", () => {
    expect(gradeLocator({ k: "text", v: "Save", nth: 1 })?.detail).toContain("match 2");
    expect(gradeLocator({ k: "text", v: "Save", nth: -1 })?.detail).toContain("LAST");
  });

  it("grades a positional path by the path even when it also has an index", () => {
    expect(gradeLocator({ k: "xpath", v: "/html[1]/body[1]/div[3]", nth: 2 })?.tier).toBe(
      "positional",
    );
  });
});

describe("gradeCounts", () => {
  it("tallies the two risky tiers and nothing else", () => {
    const counts = gradeCounts([
      { locator: { k: "testid", v: "a" } },
      { locator: { k: "xpath", v: "/html[1]/body[1]/div[2]" } },
      { locator: { k: "text", v: "Save", nth: 0 } },
      {},
    ]);
    expect(counts).toEqual({ positional: 1, indexed: 1 });
  });
});
