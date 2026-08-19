// Flow parameter binding — the contract the flows UI is built on.
//
// `expandSteps` binds a caller's `flowArgs` over the flow's own defaults, and
// the rule with teeth is the SUPPLIED-VS-ABSENT distinction: any supplied
// string wins, including "", and only an absent key falls back to the flow's
// declared variable value. The composer and the args dialog encode "blank
// means absent" on the strength of that rule (collectFlowArgs), so if it
// drifts here, their blank fields silently start overriding defaults with
// empty strings. These tests pin the rule from the generated source itself.

import { describe, expect, it } from "vitest";

import { describeFlow, generateSpec, type FlowSource } from "./script-generator.js";
import type { Step } from "../recorder/types.js";

let seq = 0;
function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: `s${seq++}`, timestamp: 0, ...partial } as Step;
}

/** A one-parameter Login flow whose fill references `${email}`. */
const LOGIN: FlowSource = {
  id: "f1",
  name: "Login",
  flowParams: ["email"],
  variables: [{ name: "email", kind: "plain", value: "default@example.com" }],
  steps: [step({ type: "fill", locator: { k: "label", v: "Email" }, value: "${email}" })],
};

function specFor(runFlow: Partial<Step>): string {
  return generateSpec(
    {
      name: "t",
      url: "https://example.com",
      steps: [step({ type: "runFlow", flowId: "f1", label: "Login", ...runFlow })],
    } as Parameters<typeof generateSpec>[0],
    { resolveFlow: (id) => (id === "f1" ? LOGIN : null) },
  );
}

describe("flow parameter binding", () => {
  it("binds a supplied argument over the flow's default", () => {
    const src = specFor({ flowArgs: { email: "caller@example.com" } });
    expect(src).toContain('fill("caller@example.com")');
    expect(src).not.toContain("default@example.com");
  });

  it("falls back to the flow's own variable default when the key is absent", () => {
    const src = specFor({});
    expect(src).toContain('fill("default@example.com")');
  });

  it("treats a supplied empty string as the caller's answer, not as absence", () => {
    // The distinction the UI's blank-means-absent rule depends on: if "" ever
    // started falling back to the default, collectFlowArgs's pruning would be
    // pointless; if absence ever stopped falling back, blank fields would
    // erase defaults. Both directions are pinned.
    const src = specFor({ flowArgs: { email: "" } });
    expect(src).toContain('fill("")');
    expect(src).not.toContain("default@example.com");
  });

  it("lets an argument reference the caller's own variables", () => {
    // Binding is textual, so "${callerEmail}" lands in the flow step's value
    // and then resolves against the CALLER's V like any other reference.
    const src = generateSpec(
      {
        name: "t",
        url: "https://example.com",
        variables: [{ name: "callerEmail", kind: "plain", value: "x@y.z" }],
        steps: [
          step({
            type: "runFlow",
            flowId: "f1",
            label: "Login",
            flowArgs: { email: "${callerEmail}" },
          }),
        ],
      } as Parameters<typeof generateSpec>[0],
      { resolveFlow: (id) => (id === "f1" ? LOGIN : null) },
    );
    expect(src).toContain("fill(V.callerEmail)");
  });

  it("ignores a non-string argument value and keys the flow does not declare", () => {
    // `recorder:updateStep` re-normalizes flowArgs, but the generator must not
    // depend on that (check:step-ingest's rule: the boundary AND the generator
    // guard independently). A poisoned shape reaching here binds nothing: a
    // non-string value falls back to the default, and a key outside
    // `flowParams` is never read at all.
    const src = specFor({
      flowArgs: { email: { evil: 1 }, "]; evil(); [": "boom" } as unknown as Record<
        string,
        string
      >,
    });
    expect(src).toContain('fill("default@example.com")');
    expect(src).not.toContain("evil(");
  });

  it("keeps a hostile argument value inside its quoted string", () => {
    // An argument is page-adjacent input (flowArgs cross the same normalize
    // boundary every step field does), so a value shaped like a string-breakout
    // must emit as data. `q()` owns the escaping; this pins that flow args
    // actually go through it after binding.
    const payload = '"); await globalThis.__pwned("';
    const src = specFor({ flowArgs: { email: payload } });
    const evil = src
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("await globalThis.__pwned"));
    expect(evil).toEqual([]);
    expect(src).toContain("__pwned"); // present — as escaped text inside the fill
  });
});

describe("describeFlow", () => {
  it("names the flow alone when there are no arguments", () => {
    expect(describeFlow(step({ type: "runFlow", flowId: "f1", label: "Login" }))).toBe(
      "run flow Login",
    );
  });

  it("shows name=value pairs, clipping long values", () => {
    const s = step({
      type: "runFlow",
      flowId: "f1",
      label: "Login",
      flowArgs: { user: "admin", note: "abcdefghijklmnopqrstuvwxyz" },
    });
    expect(describeFlow(s)).toBe("run flow Login (user=admin, note=abcdefghijklmnopq…)");
  });
});
