// `${var}` inside a regex-backed assertion.
//
// Five kinds embed their expected value in a RegExp rather than comparing it
// as a string — url / urlEndsWith / urlIs / urlPathIs / titleContains, plus
// `css` with `contains` and the two page-level waits. They used to regex-escape
// the REFERENCE, so the run compared against the literal text "${slug}" and
// could never pass, while the trainer — which resolves variables before it
// replays — showed the same step green.
//
// Four layers, each able to fail on its own: EMISSION (which of the two
// run-time helpers a kind reaches for), the RUNTIME itself (the emitted module
// is imported as real JS, because "escaped at run time" is a behaviour claim),
// ROUND-TRIP (a hand-edited spec must not lose the assertion), and the
// NO-VARIABLES regression, which is what keeps the existing library
// regenerating byte-identically.
//
// The cross-engine half — that the trainer and real Playwright now agree — is
// in e2e/assert-parity.spec.ts, which is the only place that question can be
// answered.

import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

import { describe, expect, it } from "vitest";

import { generateSpec } from "./script-generator.js";
import { parseSpec } from "./spec-parser.js";
import { glazeRuntimeSource } from "../../shared/glaze-runtime-source.mjs";
import type { Step, TestVariable } from "../recorder/types.js";

let seq = 0;
function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: `s${seq++}`, timestamp: 0, ...partial } as Step;
}

const VARS: TestVariable[] = [
  { name: "slug", kind: "plain", value: "cart" },
  { name: "orderId", kind: "plain", value: "A-1" },
];

function gen(steps: Step[], variables: TestVariable[] = VARS): string {
  return generateSpec({ name: "t", url: "https://x.test", steps, variables } as Parameters<
    typeof generateSpec
  >[0]);
}

/** The emitted assertion line for a single step. */
function line(s: Step, variables: TestVariable[] = VARS): string {
  const found = gen([s], variables)
    .split("\n")
    .find((l) => l.trim().startsWith("await expect"));
  if (!found) throw new Error("no assertion emitted");
  return found.trim();
}

const KINDS: { label: string; step: Step; helper: string }[] = [
  {
    label: "url contains",
    step: step({ type: "assert", assert: "url", value: "/${slug}/x" }),
    helper: "glazeReEscape(V.slug)",
  },
  {
    label: "urlEndsWith",
    step: step({ type: "assert", assert: "urlEndsWith", value: "/${slug}" }),
    helper: "glazeReEscape(V.slug)",
  },
  {
    label: "urlIs",
    step: step({ type: "assert", assert: "urlIs", value: "https://x.test/${slug}" }),
    helper: "glazeReEscape(V.slug)",
  },
  {
    label: "titleContains",
    step: step({ type: "assert", assert: "titleContains", value: "Order ${orderId}" }),
    helper: "glazeReEscape(V.orderId)",
  },
  {
    label: "css contains",
    step: step({
      type: "assert",
      assert: "css",
      cssMatch: "contains",
      cssProp: "color",
      locator: { k: "testid", v: "x" },
      value: "rgb(${slug})",
    }),
    helper: "glazeReEscape(V.slug)",
  },
  {
    label: "wait until url contains",
    step: step({ type: "wait", waitUntil: "urlContains", value: "/${slug}" }),
    helper: "glazeReEscape(V.slug)",
  },
  {
    label: "wait until title contains",
    step: step({ type: "wait", waitUntil: "titleContains", value: "Order ${orderId}" }),
    helper: "glazeReEscape(V.orderId)",
  },
  {
    // The odd one out: its whole pattern is built at run time, because the
    // slash rules read the ENDS of the path and a reference is opaque until
    // the run supplies it. See the note in `urlPathExpr`.
    label: "urlPathIs",
    step: step({ type: "assert", assert: "urlPathIs", value: "/order/${orderId}" }),
    helper: "glazeUrlPathPattern(",
  },
];

describe("emission", () => {
  for (const { label, step: s, helper } of KINDS) {
    it(`${label} reaches for ${helper.replace(/\(.*/, "")}`, () => {
      expect(line(s)).toContain(helper);
    });
  }

  it("imports only the helper the body actually used", () => {
    // Derived from the emitted body rather than predicted from the steps —
    // a missing import makes the spec throw at load, and a spurious one does
    // too, since the runtime only exports what it exports.
    const pathOnly = gen([step({ type: "assert", assert: "urlPathIs", value: "/o/${orderId}" })]);
    expect(pathOnly).toContain("import { glazeUrlPathPattern }");
    expect(pathOnly).not.toContain("glazeReEscape");

    const escOnly = gen([step({ type: "assert", assert: "url", value: "/${slug}" })]);
    expect(escOnly).toContain("import { glazeReEscape }");
    expect(escOnly).not.toContain("glazeUrlPathPattern");
  });

  it("leaves an UNDECLARED reference as literal text", () => {
    // The same rule `valueExpr` follows, so a price of ${9.99} or a pasted
    // shell snippet is never silently turned into a variable lookup. Asserted
    // as "no helper, and the value survives a round trip" rather than by
    // matching the escaped source, which says the same thing and does not
    // depend on how many backslashes a JSON string literal needs.
    const s = step({ type: "assert", assert: "url", value: "/${nope}" });
    expect(line(s)).not.toContain("glazeReEscape");
    expect(parseSpec(gen([s])).find((b) => b.type === "assert")?.value).toBe("/${nope}");
  });
});

describe("no variables: the existing library must regenerate unchanged", () => {
  for (const { label, step: s } of KINDS) {
    it(`${label} emits a plain quoted pattern`, () => {
      const src = line(s, []);
      expect(src).not.toContain("glazeReEscape");
      expect(src).not.toContain("glazeUrlPathPattern");
      expect(src).toContain("new RegExp(\"");
    });
  }

  it("adds no runtime import at all", () => {
    expect(gen([step({ type: "assert", assert: "url", value: "/cart" })], [])).not.toContain(
      "glaze-runtime.mjs",
    );
  });
});

describe("the emitted runtime, imported as real JavaScript", () => {
  it("parses and exports both helpers, and escapes rather than widens", async () => {
    // The runtime is a STRING in this repo, so nothing else proves it is valid
    // JavaScript — and it is assembled by `toString()`ing shared functions into
    // a template literal, where one stray backtick ends the module early.
    const dir = mkdtempSync(join(tmpdir(), "glaze-rx-"));
    const file = join(dir, "glaze-runtime.mjs");
    writeFileSync(file, glazeRuntimeSource);
    const mod = (await import(pathToFileURL(file).href)) as {
      glazeReEscape: (s: string) => string;
      glazeUrlPathPattern: (s: string) => string;
    };

    expect(typeof mod.glazeReEscape).toBe("function");
    expect(typeof mod.glazeUrlPathPattern).toBe("function");

    // The property the whole design exists for: a value carrying a regex
    // metacharacter must match ITSELF, not act as a pattern.
    const re = new RegExp("/o/" + mod.glazeReEscape("a.b") + "/z");
    expect(re.test("/o/a.b/z")).toBe(true);
    expect(re.test("/o/aXb/z")).toBe(false);

    // And the path helper still normalises the slashes it always did.
    expect(new RegExp(mod.glazeUrlPathPattern("/"), "i").test("https://x.test/")).toBe(true);
    expect(new RegExp(mod.glazeUrlPathPattern("/cart"), "i").test("https://x.test/cart?a=1")).toBe(
      true,
    );
  });
});

describe("round-trip", () => {
  for (const { label, step: s } of KINDS) {
    it(`restores the value with its reference intact: ${label}`, () => {
      const back = parseSpec(gen([s]));
      const found = back.find((b) => b.type === s.type);
      expect(found?.value).toBe(s.value);
    });

    it(`regenerates byte-identically: ${label}`, () => {
      // A round trip that changed the file would rewrite the user's spec on
      // every hand edit and every applied AI fix, pushing the value one escape
      // further from what they typed each time.
      const once = gen([s]);
      expect(gen(parseSpec(once))).toBe(once);
    });
  }

  it("keeps a value whose static text carries regex metacharacters", () => {
    const s = step({ type: "assert", assert: "url", value: "/a.b?c=${slug}&d" });
    const back = parseSpec(gen([s]));
    expect(back.find((b) => b.type === "assert")?.value).toBe("/a.b?c=${slug}&d");
  });
});
