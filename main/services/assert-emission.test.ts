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
import { ASSERT_SEMANTICS, matchesValue, reEscape, urlPathPattern } from "../../shared/step-semantics.mjs";
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

describe("'URL path is': the query-immune kind", () => {
  // WHY THIS KIND EXISTS. Every URL assertion recorded in this app's own store
  // had failed the same way: the value was a path, the kind compared the FULL
  // URL, and the run-time URL carried a `?variant=` or `utm_*` the recording
  // did not. These rows are that history, stated as the fix.
  it("passes against the same path with any query string or fragment", () => {
    const arg = matcherArg(emit(assertStep({ assert: "urlPathIs", value: "/products/synbiotic" })));
    expect(playwrightWouldPass(arg, "https://s.test/products/synbiotic")).toBe(true);
    expect(playwrightWouldPass(arg, "https://s.test/products/synbiotic?variant=42283")).toBe(true);
    expect(playwrightWouldPass(arg, "https://s.test/products/synbiotic?utm_source=email&v=2")).toBe(true);
    expect(playwrightWouldPass(arg, "https://s.test/products/synbiotic#reviews")).toBe(true);
  });

  it("rejects a different path, a prefix, and a subpath", () => {
    const arg = matcherArg(emit(assertStep({ assert: "urlPathIs", value: "/cart" })));
    expect(playwrightWouldPass(arg, "https://s.test/checkout")).toBe(false);
    // A prefix: the pattern must consume the WHOLE path.
    expect(playwrightWouldPass(arg, "https://s.test/cart/2")).toBe(false);
    // A subpath: the host class must stop at the first slash, so a path that
    // merely ENDS with the value cannot pass.
    expect(playwrightWouldPass(arg, "https://s.test/en/cart")).toBe(false);
  });

  it("tolerates one trailing slash in either direction", () => {
    // /cart and /cart/ are the same resource on every server this app has met,
    // and servers canonicalize in both directions — a spurious failure either
    // way would be the old fragility back under a new name.
    const bare = matcherArg(emit(assertStep({ assert: "urlPathIs", value: "/cart" })));
    expect(playwrightWouldPass(bare, "https://s.test/cart/")).toBe(true);
    const slashed = matcherArg(emit(assertStep({ assert: "urlPathIs", value: "/cart/" })));
    expect(playwrightWouldPass(slashed, "https://s.test/cart")).toBe(true);
    expect(playwrightWouldPass(slashed, "https://s.test/cart/?x=1")).toBe(true);
  });

  it("supplies the leading slash a hand-typed path may drop", () => {
    const arg = matcherArg(emit(assertStep({ assert: "urlPathIs", value: "cart" })));
    expect(playwrightWouldPass(arg, "https://s.test/cart")).toBe(true);
    expect(playwrightWouldPass(arg, "https://s.test/mycart")).toBe(false);
  });

  it("the site root matches with or without its slash, and nothing deeper", () => {
    const arg = matcherArg(emit(assertStep({ assert: "urlPathIs", value: "/" })));
    expect(playwrightWouldPass(arg, "https://s.test/")).toBe(true);
    expect(playwrightWouldPass(arg, "https://s.test/?utm_source=x")).toBe(true);
    expect(playwrightWouldPass(arg, "https://s.test/cart")).toBe(false);
  });

  it("ignores case, same as the other URL kinds", () => {
    const arg = matcherArg(emit(assertStep({ assert: "urlPathIs", value: "/Cart" })));
    expect(playwrightWouldPass(arg, "https://s.test/cart")).toBe(true);
  });

  it("escapes exactly what reEscape escapes", () => {
    // `urlPathPattern` inlines the escape rule because it is serialized into
    // the injected replayer and cannot reference module scope. This pins the
    // inlined spelling to the shared one, so they cannot drift apart.
    const META = "/a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o";
    expect(urlPathPattern(META)).toBe("^[a-z][a-z0-9+.-]*://[^/?#]*" + reEscape(META) + "/?(?:[?#]|$)");
  });

  it("refuses an empty value, like every page-level kind", () => {
    const line = emit(assertStep({ assert: "urlPathIs", value: "" }));
    expect(line).toContain("UNGENERATABLE");
    expect(line).not.toContain("toHaveURL");
  });

  it("generated code and the replayer pattern return the same verdict", () => {
    // `urlPathIs` compares via `urlPathPattern`, not `matchesValue`, so it gets
    // its own parity check against the same actuals shape the shared table's
    // kinds use below.
    const expected = "/cart";
    const actuals = [
      "https://s.test/cart",
      "https://s.test/cart/",
      "https://s.test/cart?x=1",
      "https://s.test/cart#top",
      "https://s.test/cart/2",
      "https://s.test/en/cart",
      "HTTPS://S.TEST/CART",
    ];
    const arg = matcherArg(emit(assertStep({ assert: "urlPathIs", value: expected })));
    for (const actual of actuals) {
      const viaPlaywright = playwrightWouldPass(arg, actual);
      const viaReplayer = new RegExp(urlPathPattern(expected), "i").test(actual);
      expect(
        viaPlaywright,
        `urlPathIs against ${JSON.stringify(actual)}: spec says ${viaPlaywright}, trainer says ${viaReplayer}`,
      ).toBe(viaReplayer);
    }
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

describe("the UNGENERATABLE comment is not a code sink", () => {
  // A comment is where people stop thinking about escaping, which is exactly
  // what made this one dangerous. `describeStep` interpolates step fields RAW —
  // it was UI copy until the generator started emitting it — and a `//` comment
  // ends at the first LINE TERMINATOR. Anything after one lands in the spec as a
  // statement inside the `test()` callback, which Playwright executes in Node
  // with the user's privileges: the same class of hole as the `count` field that
  // was RCE for having the right TypeScript type.
  //
  // Found by review of the very commit that introduced it, which is the only
  // reason it is a test rather than an incident.

  /** All four JS line terminators. U+2028/U+2029 matter as much as `\n`: they
   *  end a comment identically, and unlike a control character they survive
   *  places that reject one — a hostile page can put one in `document.cookie`,
   *  and the Cookies panel pre-fills a step from that live read. */
  const TERMINATORS: [string, string][] = [
    ["LF", String.fromCharCode(10)],
    ["CR", String.fromCharCode(13)],
    ["U+2028", String.fromCharCode(0x2028)],
    ["U+2029", String.fromCharCode(0x2029)],
  ];

  /** Steps that reach the UNGENERATABLE arm, each through a different builder
   *  that interpolates raw text: capture (describeCapture), cookie
   *  (describeCookie) and runFlow-shaped labels (describeFlow). */
  function sinks(payload: string): Step[] {
    return [
      { id: "c1", type: "capture", captureVar: "v" + payload, captureFrom: "attribute", captureAttr: "href" + payload },
      { id: "k1", type: "cookie", cookieAction: "set", cookie: { name: "sid" + payload, value: "1" + payload } },
    ] as unknown as Step[];
  }

  for (const [name, term] of TERMINATORS) {
    it(`a ${name} in a step field cannot escape the comment`, () => {
      const payload = term + "globalThis.__PWNED = 1;";
      for (const step of sinks(payload)) {
        const src = generateSpec({ name: "t", url: "https://x.test", steps: [step] });
        const body = src.slice(src.indexOf("=> {") + 4, src.lastIndexOf("});"));
        // The generated body, split on every terminator: no line that came from
        // the comment may survive as a statement.
        const lines = body
          .split(new RegExp("[" + String.fromCharCode(10, 13, 0x2028, 0x2029) + "]"))
          .map((l) => l.trim())
          .filter(Boolean);
        const leaked = lines.filter((l) => l.includes("__PWNED") && !l.startsWith("//"));
        expect(leaked, `payload escaped its comment in:\n${src}`).toEqual([]);
      }
    });

    it(`a ${name} payload does not execute when the spec body is run`, () => {
      const payload = term + "globalThis.__PWNED = 1;";
      for (const step of sinks(payload)) {
        const src = generateSpec({ name: "t", url: "https://x.test", steps: [step] });
        const body = src.slice(src.indexOf("=> {") + 4, src.lastIndexOf("});"));
        const g = globalThis as unknown as Record<string, unknown>;
        g.__PWNED = 0;
        // Runs the generated body the way Playwright would. A syntax error is
        // also a failure — the feature exists to keep the spec runnable.
        expect(() => new Function("page", "expect", body)({}, () => ({}))).not.toThrow();
        expect(g.__PWNED, "the generated spec executed injected code").toBe(0);
      }
    });
  }
});
