// What the generator EMITS for an assertion, and whether that code agrees with
// the replayer about what the step means.
//
// The suite had no test of this at all. `script-generator.test.ts` covers the
// line map and the viewport log; `spec-parser.check.ts` covers the round trip —
// and a round trip is exactly the property that HID the bug, because the parser
// read the generator's wrong output back into the right step and the cycle
// closed green. Not one assertion anywhere in the repo said what
// `assert: "url"` should produce, so "URL contains" generated an exact
// whole-URL match for its entire life and 3292 passing tests had nothing to say
// about it.
//
// The trick that makes this cheap: the emitted argument is EVALUATED here, and
// Playwright's own rule is applied to it — a string argument is exact equality,
// a RegExp argument is `.test()`. That answers "would this line pass against
// this URL?" without launching a browser, so escaping, anchoring and case bugs
// are all caught in milliseconds. `e2e/assert-parity.spec.ts` then proves the
// model itself is right by running the same table through real Playwright; this
// file is the fast gate, that one is the authority.

import { describe, expect, it } from "vitest";

import { generateSpec } from "./script-generator.js";
import { ASSERT_SEMANTICS, matchesValue } from "../../shared/step-semantics.mjs";
import type { AssertKind, Step } from "../recorder/types.js";

let seq = 0;
function assertStep(over: Partial<Step>): Step {
  return { id: "s" + ++seq, type: "assert", ...over } as Step;
}

/** The single generated line for a one-step spec, without indent/`await`/`;`. */
function emit(step: Step): string {
  const src = generateSpec({ name: "t", url: "https://example.com", steps: [step] });
  const line = src
    .split("\n")
    .find((l) => l.includes("expect(") || l.includes("UNGENERATABLE"));
  return (line ?? "").trim();
}

/** The matcher argument as a live JS value — a string or a RegExp, which is
 *  exactly the distinction that decides what Playwright does with it. */
function matcherArg(line: string): string | RegExp {
  const m = line.match(/\.toHave(?:URL|Title)\((.*)\);$/);
  if (!m) throw new Error("no page-level matcher in: " + line);
  // The argument is generated source this file just produced, not user input.
  return eval("(" + m[1] + ")") as string | RegExp;
}

/** Playwright's rule, from playwright-core's `serializeExpectedTextValues`: a
 *  RegExp is tested against the value; a STRING is compared for equality, with
 *  no substring and no glob. `toHaveTitle` additionally normalizes whitespace
 *  on both sides before comparing. */
function playwrightWouldPass(arg: string | RegExp, actual: string, normalizeWhitespace = false): boolean {
  const norm = (s: string) => (normalizeWhitespace ? s.replace(/\s+/g, " ").trim() : s);
  return arg instanceof RegExp ? arg.test(norm(actual)) : norm(actual) === norm(arg);
}

describe("URL assertions: what runs must be what the label promises", () => {
  // THE BUG. Kept as its own test with the real values from the field, because
  // this is the line that shipped and it must never come back.
  it("'URL contains' does not emit an exact whole-URL match", () => {
    const line = emit(assertStep({ assert: "url", value: "/cart?step=2" }));
    // The old output, verbatim. A string argument here is an equality check
    // against the WHOLE url, and the recorder pre-fills this field with a path,
    // so it could not pass on any page — and there is no `baseURL` in the
    // generated config to resolve the path against either.
    expect(line).not.toContain('toHaveURL("/cart?step=2")');
    expect(matcherArg(line)).toBeInstanceOf(RegExp);
  });

  it("'URL contains' passes against a real URL containing the value", () => {
    const line = emit(assertStep({ assert: "url", value: "/cart?step=2" }));
    const arg = matcherArg(line);
    expect(playwrightWouldPass(arg, "https://shop.test/cart?step=2")).toBe(true);
    expect(playwrightWouldPass(arg, "https://shop.test/cart?step=3")).toBe(false);
  });

  it("escapes the two metacharacters every URL contains", () => {
    // `?` un-escaped makes the preceding character optional — the pattern then
    // matches neither the literal `?` nor the path, which is the "fails on
    // every single run" symptom. `.` un-escaped matches ANY character, which is
    // the opposite failure: it passes against a URL that is not the one meant.
    const q = matcherArg(emit(assertStep({ assert: "url", value: "/a?b=1" })));
    expect(playwrightWouldPass(q, "https://x.test/a?b=1")).toBe(true);
    expect(playwrightWouldPass(q, "https://x.test/ab=1")).toBe(false);

    const dot = matcherArg(emit(assertStep({ assert: "url", value: "example.com" })));
    expect(playwrightWouldPass(dot, "https://example.com/x")).toBe(true);
    expect(playwrightWouldPass(dot, "https://exampleXcom/x")).toBe(false);
  });

  it("anchors each kind the way its label reads", () => {
    const contains = matcherArg(emit(assertStep({ assert: "url", value: "/cart" })));
    const ends = matcherArg(emit(assertStep({ assert: "urlEndsWith", value: "/cart" })));
    const is = matcherArg(emit(assertStep({ assert: "urlIs", value: "https://s.test/cart" })));

    expect(playwrightWouldPass(contains, "https://s.test/cart?x=1")).toBe(true);
    // "ends with" must actually reject a URL that merely contains it.
    expect(playwrightWouldPass(ends, "https://s.test/cart?x=1")).toBe(false);
    expect(playwrightWouldPass(ends, "https://s.test/cart")).toBe(true);
    // "is" must reject a longer URL that starts with it.
    expect(playwrightWouldPass(is, "https://s.test/cart/2")).toBe(false);
    expect(playwrightWouldPass(is, "https://s.test/cart")).toBe(true);
  });

  it("ignores case, because a URL's host does", () => {
    const arg = matcherArg(emit(assertStep({ assert: "url", value: "Example.COM/Cart" })));
    expect(playwrightWouldPass(arg, "https://example.com/cart")).toBe(true);
  });

  it("refuses to generate an assertion that would pass unconditionally", () => {
    // `urlEndsWith` with no value emits `/$/i`, which every URL on every host
    // satisfies. Green forever, testing nothing — the most expensive kind of
    // wrong, because nobody looks at it again.
    const line = emit(assertStep({ assert: "urlEndsWith", value: "" }));
    expect(line).toContain("UNGENERATABLE");
    expect(line).not.toContain("toHaveURL");
  });
});

describe("title assertions", () => {
  it("'Page title is' is exact — the label is the contract", () => {
    const arg = matcherArg(emit(assertStep({ assert: "title", value: "Cart" })));
    // The replayer used to read this as a case-insensitive substring, so this
    // passed live against a page titled "Cart | Acme" and failed in every run.
    expect(playwrightWouldPass(arg, "Cart | Acme", true)).toBe(false);
    expect(playwrightWouldPass(arg, "Cart", true)).toBe(true);
  });

  it("'Page title contains' is the substring kind the vocabulary was missing", () => {
    const arg = matcherArg(emit(assertStep({ assert: "titleContains", value: "Cart" })));
    expect(playwrightWouldPass(arg, "Cart | Acme", true)).toBe(true);
    expect(playwrightWouldPass(arg, "Basket | Acme", true)).toBe(false);
  });

  it("title matching is case-SENSITIVE, unlike URL matching", () => {
    // Not an inconsistency: a heading that changed from "Checkout" to
    // "CHECKOUT" is a real content change, and Playwright's own default for
    // every text matcher is case-sensitive. See shared/step-semantics.mjs.
    const arg = matcherArg(emit(assertStep({ assert: "titleContains", value: "Cart" })));
    expect(playwrightWouldPass(arg, "CART | ACME", true)).toBe(false);
  });
});

describe("the emitted code and the replayer agree", () => {
  // The property that matters, stated directly: for a given page value, the
  // generated Playwright line and the trainer's predicate must return the SAME
  // verdict. Every divergence in the audit was a case where they did not, and
  // no test could express it because the two engines shared no fixture.
  const cases: { kind: AssertKind; expected: string; actuals: string[] }[] = [
    { kind: "url", expected: "/cart?step=2", actuals: ["https://s.test/cart?step=2", "https://s.test/cart", "https://S.TEST/CART?STEP=2", ""] },
    { kind: "urlEndsWith", expected: "/checkout", actuals: ["https://s.test/checkout", "https://s.test/checkout?x=1", "https://s.test/pre-checkout"] },
    { kind: "urlIs", expected: "https://s.test/a", actuals: ["https://s.test/a", "https://s.test/a/b", "HTTPS://S.TEST/A"] },
    { kind: "title", expected: "Cart", actuals: ["Cart", "Cart | Acme", "cart", "  Cart  "] },
    { kind: "titleContains", expected: "Cart", actuals: ["Cart | Acme", "Basket", "CART", "  Cart  "] },
  ];

  for (const { kind, expected, actuals } of cases) {
    it(`${kind}: generated code and replayer predicate return the same verdict`, () => {
      const semantics = ASSERT_SEMANTICS[kind];
      if (!semantics) throw new Error("no semantics declared for " + kind);
      const arg = matcherArg(emit(assertStep({ assert: kind, value: expected })));
      for (const actual of actuals) {
        const viaPlaywright = playwrightWouldPass(arg, actual, semantics.normalizeWhitespace);
        const viaReplayer = matchesValue(actual, expected, semantics);
        expect(
          viaPlaywright,
          `${kind} against ${JSON.stringify(actual)}: spec says ${viaPlaywright}, trainer says ${viaReplayer}`,
        ).toBe(viaReplayer);
      }
    });
  }
});
