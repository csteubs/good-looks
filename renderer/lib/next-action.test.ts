import { describe, expect, it } from "vitest";

import { pickedFromStep, suggestFlowName, suggestNextAction } from "./next-action";
import type { Step } from "./recorder-types";

let seq = 0;
function step(partial: Partial<Step> & { type: Step["type"] }): Step {
  seq += 1;
  return { id: `s${seq}`, timestamp: seq, ...partial } as Step;
}

function fillStep(partial: Partial<Step> = {}): Step {
  return step({
    type: "fill",
    locator: { k: "label", v: "Email" },
    value: "chris@example.com",
    fingerprint: {
      tag: "input",
      description: 'input "Email"',
      candidates: [
        { k: "testid", v: "email" },
        { k: "label", v: "Email" },
      ],
      attributes: { type: "email" },
      depth: 4,
    },
    ...partial,
  });
}

function ctx(steps: Step[], over: Partial<Parameters<typeof suggestNextAction>[0]> = {}) {
  return suggestNextAction({
    steps,
    cursor: steps.length,
    liveUrl: "https://shop.test/cart",
    navigatedSinceLastStep: false,
    ...over,
  });
}

describe("suggestNextAction — the fill rule", () => {
  it("offers a value assertion on the field a fill just filled", () => {
    const fill = fillStep();
    const s = ctx([fill]);
    expect(s?.rule).toBe("fill-assert");
    expect(s?.assert).toBe("value");
    expect(s?.prefillValue).toBe("chris@example.com");
    expect(s?.id).toBe(`fill:${fill.id}`);
    // The recorded locator leads the candidates — the assertion must point at
    // what the fill pointed at, not the fingerprint's own first pick.
    expect(s?.picked?.candidates[0]).toEqual({ k: "label", v: "Email" });
    // The fingerprint's candidates follow, deduplicated against the recorded one.
    expect(s?.picked?.candidates).toHaveLength(2);
    expect(s?.picked?.candidates[1]).toEqual({ k: "testid", v: "email" });
  });

  it("stays silent for a password field", () => {
    const fill = fillStep({
      fingerprint: {
        tag: "input",
        description: "password",
        candidates: [{ k: "testid", v: "pw" }],
        attributes: { type: "password" },
        depth: 4,
      },
    });
    expect(ctx([fill])).toBeNull();
  });

  it("stays silent when the value interpolates a variable", () => {
    expect(ctx([fillStep({ value: "${password}" })])).toBeNull();
    expect(ctx([fillStep({ varRefs: ["password"] })])).toBeNull();
  });

  it("prefills EMPTY for a sequential fill, whose recorded value is not what the field holds", () => {
    const s = ctx([fillStep({ typeMode: "sequential" })]);
    expect(s?.rule).toBe("fill-assert");
    expect(s?.prefillValue).toBe("");
  });

  it("stays silent when the step carries nothing to point with", () => {
    expect(ctx([step({ type: "fill", value: "x" })])).toBeNull();
  });

  it("anchors at the cursor, not the array's end", () => {
    const fill = fillStep();
    const later = step({ type: "click", locator: { k: "role", role: "button", name: "Pay" } });
    // Editing session: cursor sits after the fill, mid-list.
    const s = ctx([fill, later], { cursor: 1 });
    expect(s?.id).toBe(`fill:${fill.id}`);
    // And a cursor at the top of the list has no "step that just happened".
    expect(ctx([fill, later], { cursor: 0 })).toBeNull();
  });
});

describe("suggestNextAction — the navigation rules", () => {
  it("offers the live URL's path after an observed navigation, and it beats the fill rule", () => {
    // A fill whose page then moved is a field that is no longer there.
    const fill = fillStep();
    const s = ctx([fill], { navigatedSinceLastStep: true, liveUrl: "https://shop.test/cart?step=2" });
    expect(s?.rule).toBe("url-assert");
    expect(s?.assert).toBe("urlPathIs");
    expect(s?.prefillValue).toBe("/cart");
    expect(s?.picked).toBeNull();
  });

  it("offers the goto step's OWN path — the live page has not executed an inserted goto", () => {
    const nav = step({ type: "goto", url: "https://shop.test/checkout" });
    const s = ctx([nav], { liveUrl: "https://shop.test/cart" });
    expect(s?.rule).toBe("url-assert");
    expect(s?.prefillValue).toBe("/checkout");
  });

  it("stays silent for a baseUrl-relative goto rather than prefilling from the wrong page", () => {
    expect(ctx([step({ type: "goto", url: "/checkout" })])).toBeNull();
  });

  it("offers the live path after a reload", () => {
    const s = ctx([step({ type: "reload" })], { liveUrl: "https://shop.test/cart?x=1" });
    expect(s?.prefillValue).toBe("/cart");
  });

  it("stays silent when the URL is one urlAssertPrefill refuses", () => {
    expect(ctx([step({ type: "reload" })], { liveUrl: "about:blank" })).toBeNull();
    expect(ctx([fillStep()], { navigatedSinceLastStep: true, liveUrl: "" })).toBeNull();
  });

  it("bakes the path into the id, so a dismissal survives a same-path redirect and a new path is a new offer", () => {
    const nav = step({ type: "reload" });
    const a = ctx([nav], { liveUrl: "https://shop.test/cart" });
    const b = ctx([nav], { liveUrl: "https://shop.test/cart?utm=x" });
    const c = ctx([nav], { liveUrl: "https://shop.test/done" });
    expect(a?.id).toBe(b?.id);
    expect(a?.id).not.toBe(c?.id);
  });
});

describe("suggestNextAction — silence is the default", () => {
  it("offers nothing on an empty list, and nothing after a click that did not navigate", () => {
    expect(ctx([])).toBeNull();
    expect(ctx([step({ type: "click", locator: { k: "text", v: "More" } })])).toBeNull();
  });
});

describe("pickedFromStep", () => {
  it("builds from the bare locator when there is no fingerprint", () => {
    const p = pickedFromStep(step({ type: "fill", locator: { k: "css", v: "#q" }, label: "search" }));
    expect(p?.candidates).toEqual([{ k: "css", v: "#q" }]);
    expect(p?.description).toBe("search");
    expect(p?.ambiguous).toBe(false);
  });

  it("answers null with neither locator nor candidates", () => {
    expect(pickedFromStep(step({ type: "fill" }))).toBeNull();
  });
});

describe("suggestFlowName", () => {
  const email = fillStep();
  const password = fillStep({
    locator: { k: "label", v: "Password" },
    fingerprint: {
      tag: "input",
      description: "password",
      candidates: [{ k: "label", v: "Password" }],
      attributes: { type: "password" },
      depth: 4,
    },
  });
  const login = step({ type: "click", locator: { k: "role", role: "button", name: "Log in" } });

  it("names the flow after the LAST named click in the range", () => {
    const first = step({ type: "click", locator: { k: "text", v: "Account" } });
    const steps = [first, email, password, login];
    expect(suggestFlowName(steps, steps.map((s) => s.id))).toBe("Log in");
  });

  it("only reads the SELECTED steps", () => {
    const steps = [email, password, login];
    expect(suggestFlowName(steps, [email.id, password.id])).toBe("Sign in");
  });

  it("falls back to Sign in for a password fill with no named click", () => {
    const steps = [email, password];
    expect(suggestFlowName(steps, steps.map((s) => s.id))).toBe("Sign in");
  });

  it("offers nothing rather than prose", () => {
    const wordy = step({
      type: "click",
      locator: { k: "text", v: "Read the full terms and conditions before you continue to checkout" },
    });
    expect(suggestFlowName([wordy], [wordy.id])).toBe("");
    expect(suggestFlowName([email], [email.id])).toBe("");
  });

  it("collapses whitespace in a name taken from element text", () => {
    const spaced = step({
      type: "dblclick",
      fingerprint: {
        tag: "button",
        description: "button",
        candidates: [{ k: "css", v: ".add" }],
        attributes: {},
        depth: 2,
        text: "  Add to\n  cart ",
      },
    });
    expect(suggestFlowName([spaced], [spaced.id])).toBe("Add to cart");
  });
});
