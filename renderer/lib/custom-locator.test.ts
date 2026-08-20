// The custom-locator gate. What these pin is the REFUSAL set as much as the
// acceptance set: everything the in-page oracle can't count (engines, >>,
// Playwright pseudo-classes) must be refused with directions, because the
// alternative is a live match count that's confidently wrong — the
// oracle-vs-run disagreement class the trainer exists to prevent.

import { describe, expect, it } from "vitest";

import { classifyCustomLocator, lintCustomLocator } from "./custom-locator";

describe("classifyCustomLocator", () => {
  it("classifies plain CSS", () => {
    expect(classifyCustomLocator("button.add-to-cart")).toEqual({
      ok: true,
      loc: { k: "css", v: "button.add-to-cart" },
    });
  });

  it("classifies xpath= with the prefix stripped", () => {
    expect(classifyCustomLocator('xpath=//button[@id="submit"]')).toEqual({
      ok: true,
      loc: { k: "xpath", v: '//button[@id="submit"]' },
    });
  });

  it("accepts pasted XPath without the prefix, // and (// forms both", () => {
    expect(classifyCustomLocator("//td[text()='Widget A']/ancestor::tr")).toEqual({
      ok: true,
      loc: { k: "xpath", v: "//td[text()='Widget A']/ancestor::tr" },
    });
    expect(classifyCustomLocator("(//li[@role='option'])[3]")).toEqual({
      ok: true,
      loc: { k: "xpath", v: "(//li[@role='option'])[3]" },
    });
  });

  it("refuses chaining with directions to the context picker", () => {
    const res = classifyCustomLocator('li:has-text("x") >> button');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Inside clause/i);
  });

  it("refuses Playwright engine prefixes", () => {
    for (const s of ["text=Add to cart", "role=button", "id=submit", "nth=0"]) {
      const res = classifyCustomLocator(s);
      expect(res.ok, s).toBe(false);
    }
  });

  it("refuses Playwright-only pseudo-classes the oracle can't evaluate", () => {
    for (const s of [
      'li:has-text("Product 2")',
      "button:visible",
      ":nth-match(button, 3)",
      'div:text("Hi")',
    ]) {
      const res = classifyCustomLocator(s);
      expect(res.ok, s).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/Playwright/i);
    }
  });

  it("does NOT mistake standard pseudo-classes for Playwright ones", () => {
    // :hover/:not/:nth-child are real CSS; refusing them would make the field
    // useless for exactly the selectors it exists for.
    for (const s of ["button:not(.disabled)", "li:nth-child(3)", "input:checked"]) {
      expect(classifyCustomLocator(s).ok, s).toBe(true);
    }
  });

  it("refuses an empty or bare-prefix input", () => {
    expect(classifyCustomLocator("").ok).toBe(false);
    expect(classifyCustomLocator("   ").ok).toBe(false);
    expect(classifyCustomLocator("xpath=").ok).toBe(false);
  });
});

describe("lintCustomLocator", () => {
  it("flags stacked positional hops in CSS", () => {
    const w = lintCustomLocator({
      k: "css",
      v: "div:nth-child(2) > ul > li:nth-of-type(5)",
    });
    expect(w.some((x) => /reorder/i.test(x))).toBe(true);
  });

  it("flags build-generated class names", () => {
    for (const v of [".css-1q2w3e", ".sc-bdfBwQ", ".Button_primary_x8k2p"]) {
      const w = lintCustomLocator({ k: "css", v });
      expect(w.some((x) => /build-generated/i.test(x)), v).toBe(true);
    }
  });

  it("flags deep descendant paths", () => {
    const w = lintCustomLocator({ k: "css", v: "#app > div > main > section div span.price" });
    expect(w.some((x) => /deep/i.test(x))).toBe(true);
  });

  it("flags positional XPath", () => {
    const w = lintCustomLocator({ k: "xpath", v: "/html[1]/body[1]/div[3]/button[2]" });
    expect(w.some((x) => /positional/i.test(x))).toBe(true);
  });

  it("stays quiet for a reasonable selector", () => {
    expect(lintCustomLocator({ k: "css", v: "button.add-to-cart" })).toEqual([]);
    expect(lintCustomLocator({ k: "xpath", v: "//button[@data-qa='submit']" })).toEqual([]);
  });
});
