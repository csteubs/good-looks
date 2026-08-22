// Turning a test's baked-in site address into a variable.
//
// The properties that matter are the ones that would be silent if wrong: a
// rewrite that misses a URL assertion leaves the run navigating to the preview
// and asserting it is on production, and a rewrite that fires twice produces
// `${SITE}${SITE}/cart`, which is not a URL at all.

import { describe, it, expect } from "vitest";

import {
  DEFAULT_ORIGIN_VARIABLE,
  isOnOrigin,
  originOf,
  originsIn,
  parameteriseOrigin,
} from "./origin-variable";
import type { Step, TestVariable } from "../recorder/types";

const PROD = "https://shop.example.com";

function goto(url: string, id = "s1"): Step {
  return { id, type: "goto", url } as Step;
}

describe("recognising an origin", () => {
  it("normalises case and the default port, so one host is one entry", () => {
    expect(originOf("https://Shop.Example.com:443/cart")).toBe(PROD);
    expect(originOf("https://shop.example.com/cart")).toBe(PROD);
  });

  it("is not fooled by a host that merely shares a prefix", () => {
    // The bug a bare `startsWith` has: this is a DIFFERENT site, and rewriting
    // it would silently re-point a test at somewhere nobody asked for.
    expect(isOnOrigin("https://shop.example.commerce.test/cart", PROD)).toBe(false);
    expect(isOnOrigin(`${PROD}.evil.test/cart`, PROD)).toBe(false);
  });

  it("accepts the origin itself and its query and fragment forms", () => {
    for (const t of [PROD, `${PROD}/`, `${PROD}/cart`, `${PROD}?a=1`, `${PROD}#top`]) {
      expect(isOnOrigin(t, PROD)).toBe(true);
    }
  });

  it("ignores text that merely mentions the address mid-sentence", () => {
    expect(isOnOrigin(`Go to ${PROD} now`, PROD)).toBe(false);
  });

  it("rejects a non-http scheme", () => {
    expect(originOf("file:///etc/passwd")).toBeNull();
    expect(originOf("javascript:alert(1)")).toBeNull();
  });
});

describe("finding what a test refers to", () => {
  it("counts FIELDS and orders by use, so the number matches the edits", () => {
    const steps = [
      goto(`${PROD}/`, "a"),
      goto(`${PROD}/cart`, "b"),
      goto("https://other.test/x", "c"),
    ];
    expect(originsIn(steps)).toEqual([
      { origin: PROD, count: 2 },
      { origin: "https://other.test", count: 1 },
    ]);
  });

  it("puts the test's OWN site first, even when another host is mentioned more", () => {
    // Found by looking at a real test in the preview: a docs site that calls an
    // API twice offered to re-point the API. "The site address" means the site
    // the test is about, and re-pointing the wrong one is a rewrite the user
    // then has to undo.
    const steps = [
      goto("https://docs.example.com/", "a"),
      { id: "b", type: "api", url: "https://api.example.com/v1" } as Step,
      { id: "c", type: "api", url: "https://api.example.com/v2" } as Step,
    ];
    expect(originsIn(steps).map((o) => o.origin)).toEqual([
      "https://api.example.com",
      "https://docs.example.com",
    ]);
    expect(originsIn(steps, "https://docs.example.com").map((o) => o.origin)).toEqual([
      "https://docs.example.com",
      "https://api.example.com",
    ]);
  });

  it("ignores a preferred origin the steps never mention", () => {
    const steps = [goto("https://docs.example.com/", "a")];
    expect(originsIn(steps, "https://nowhere.test").map((o) => o.origin)).toEqual([
      "https://docs.example.com",
    ]);
  });

  it("finds a URL that is not on a goto", () => {
    // The whole reason this goes through `mapInterpolatable`: a URL assertion
    // left pinned to production fails in the confusing direction — the run
    // reaches the preview and then asserts it is somewhere else.
    const assertStep = { id: "s2", type: "assert", value: `${PROD}/cart` } as Step;
    expect(originsIn([assertStep])).toEqual([{ origin: PROD, count: 1 }]);
  });
});

describe("parameterising", () => {
  const steps = [goto(`${PROD}/`, "a"), goto(`${PROD}/cart`, "b"), goto("https://other.test/x", "c")];

  it("points every URL on the chosen origin at the variable, and leaves others alone", () => {
    const out = parameteriseOrigin(steps, [], PROD);
    expect(out.rewritten).toBe(2);
    expect(out.steps[0].url).toBe("${SITE_URL}/");
    expect(out.steps[1].url).toBe("${SITE_URL}/cart");
    expect(out.steps[2].url).toBe("https://other.test/x");
  });

  it("declares the variable holding the origin, so a plain run is unchanged", () => {
    // The property that makes this safe to click: with the default in place the
    // generated spec resolves to exactly the URL it had before.
    const out = parameteriseOrigin(steps, [], PROD);
    expect(out.variables).toHaveLength(1);
    expect(out.variables[0]).toMatchObject({ name: DEFAULT_ORIGIN_VARIABLE, kind: "plain", value: PROD });
    expect(out.reusedVariable).toBe(false);
  });

  it("is idempotent — clicking twice does not produce ${SITE}${SITE}/cart", () => {
    const once = parameteriseOrigin(steps, [], PROD);
    const twice = parameteriseOrigin(once.steps, once.variables, PROD);
    expect(twice.rewritten).toBe(0);
    expect(twice.steps[1].url).toBe("${SITE_URL}/cart");
    expect(twice.variables).toHaveLength(1);
  });

  it("reuses an existing variable rather than declaring a second one", () => {
    // Two entries with one name is a spec whose V object silently keeps the
    // last — and the existing value may have been deliberately re-pointed.
    const existing: TestVariable[] = [{ name: DEFAULT_ORIGIN_VARIABLE, kind: "plain", value: "https://staging.test" }];
    const out = parameteriseOrigin(steps, existing, PROD);
    expect(out.variables).toHaveLength(1);
    expect(out.variables[0].value).toBe("https://staging.test");
    expect(out.reusedVariable).toBe(true);
    expect(out.rewritten).toBe(2);
  });

  it("does not rewrite a host that merely shares a prefix", () => {
    // Found by reverting the boundary check and watching NOTHING fail: the
    // prefix test above exercises `isOnOrigin` directly, so the check inside
    // the rewrite was unguarded. Swapping it for a bare `startsWith` silently
    // re-points a DIFFERENT site — a test aimed at shop.example.commerce.test
    // would start hitting the preview.
    const sneaky = [
      goto(`${PROD}/cart`, "a"),
      goto("https://shop.example.commerce.test/cart", "b"),
      goto(`${PROD}.evil.test/x`, "c"),
    ];
    const out = parameteriseOrigin(sneaky, [], PROD);
    expect(out.rewritten).toBe(1);
    expect(out.steps[0].url).toBe("${SITE_URL}/cart");
    expect(out.steps[1].url).toBe("https://shop.example.commerce.test/cart");
    expect(out.steps[2].url).toBe(`${PROD}.evil.test/x`);
  });

  it("reports zero rather than claiming success when nothing matched", () => {
    const out = parameteriseOrigin([goto("https://elsewhere.test/x")], [], PROD);
    expect(out.rewritten).toBe(0);
  });

  it("refuses a name that would not be a valid identifier in the spec", () => {
    // The name lands in generated source as an identifier, so this is a
    // boundary rather than a preference.
    for (const bad of ["2fast", "has space", "with-dash", ""]) {
      expect(() => parameteriseOrigin(steps, [], PROD, bad)).toThrow();
    }
  });

  it("allows `V`, which looks like a collision and is not", () => {
    // Worth pinning because it reads as a bug: the generated header is
    // `const V = { … }`, so a variable called `V` emits `V.V` — legal, and
    // `isValidVariableName` allows it. Rejecting it here would be a rule this
    // module invented on its own, out of step with every other name boundary.
    expect(() => parameteriseOrigin(steps, [], PROD, "V")).not.toThrow();
  });

  it("refuses anything that is not a bare origin", () => {
    for (const bad of [`${PROD}/cart`, "shop.example.com", "javascript:alert(1)"]) {
      expect(() => parameteriseOrigin(steps, [], bad)).toThrow();
    }
  });
});
