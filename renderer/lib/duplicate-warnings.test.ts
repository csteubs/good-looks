// Tests for what the duplicate dialog says — and, as much, for when it says
// nothing at all.
//
// The empty case is the load-bearing one. `describeDuplicationWarnings`
// returning [] is what makes the sidebar duplicate silently, so a warning that
// fires on an ordinary test turns every duplication into a dialog, and a dialog
// that always appears is one nobody reads. The cost lands on precisely the
// cases this exists for: a copied credential, a run history someone expected to
// come with the copy.

import { describe, expect, it } from "vitest";

import { describeDuplicationWarnings, NOT_COPIED } from "./duplicate-warnings";
import type { Step, TestRecord } from "./recorder-types";

type Subject = Parameters<typeof describeDuplicationWarnings>[0];

function step(type: Step["type"], id: string = type): Step {
  return { id, type, timestamp: 1 } as Step;
}

function test_(over: Partial<Subject> = {}): Subject {
  return { steps: [step("click")], ...over } as Subject;
}

/** The warning ids produced, in order. */
function ids(t: Subject, secrets = 0): string[] {
  return describeDuplicationWarnings(t, secrets).map((w) => w.id);
}

describe("describeDuplicationWarnings", () => {
  it("says nothing about an ordinary recorded test", () => {
    expect(describeDuplicationWarnings(test_())).toEqual([]);
  });

  it("says nothing about a test with no steps at all", () => {
    expect(describeDuplicationWarnings(test_({ steps: [] }))).toEqual([]);
  });

  it("survives a record missing the optional collections entirely", () => {
    // Records written before variables/datasets existed have neither key.
    expect(describeDuplicationWarnings({ steps: [] } as unknown as Subject)).toEqual([]);
  });

  it("flags declared variables", () => {
    const t = test_({ variables: [{ name: "user", kind: "plain", value: "ada" }] });
    expect(ids(t)).toEqual(["variables"]);
  });

  it("flags stored secret values SEPARATELY from the variables that declare them", () => {
    // Two different facts. One is "settings came across"; the other is "a
    // credential now exists in a second place on disk" — which is the reason
    // this dialog exists at all, and would be invisible folded into a count.
    const t = test_({
      variables: [
        { name: "user", kind: "plain", value: "ada" },
        { name: "password", kind: "secret" },
      ],
    });
    expect(ids(t, 1)).toEqual(["variables", "secrets"]);
  });

  it("does not claim a secret was copied when none has a value stored", () => {
    // A declared secret with nothing behind it is not a credential.
    const t = test_({ variables: [{ name: "password", kind: "secret" }] });
    expect(ids(t, 0)).toEqual(["variables"]);
  });

  it("flags cookie steps", () => {
    const t = test_({ steps: [step("click"), step("cookie", "c1")] });
    expect(ids(t)).toEqual(["cookies"]);
  });

  it("flags capture steps", () => {
    const t = test_({ steps: [step("capture", "cap1")] });
    expect(ids(t)).toEqual(["captures"]);
  });

  it("flags dataset rows", () => {
    const t = test_({ datasets: [{ id: "d1", name: "row", values: {} }] });
    expect(ids(t)).toEqual(["datasets"]);
  });

  it("flags steps that call another test as a flow", () => {
    const t = test_({ steps: [step("runFlow", "f1")] });
    expect(ids(t)).toEqual(["flowCalls"]);
  });

  it("flags the test being a flow itself", () => {
    expect(ids(test_({ isFlow: true }))).toEqual(["isFlow"]);
  });

  it("flags a hand-edited script", () => {
    expect(ids(test_({ scriptEdited: true }))).toEqual(["scriptEdited"]);
  });

  it("flags an imported test", () => {
    expect(ids(test_({ sourceDir: "/x" }))).toEqual(["imported"]);
  });

  it("says 'imported' rather than both, since every import is script-edited", () => {
    // Imported records always carry scriptEdited. Emitting both would print two
    // lines making the same point in slightly different words.
    const t = test_({ sourceDir: "/x", scriptEdited: true });
    expect(ids(t)).toEqual(["imported"]);
  });

  it("reports every active feature at once, in a stable order", () => {
    const t = test_({
      steps: [step("cookie", "c1"), step("capture", "cap1"), step("runFlow", "f1")],
      variables: [{ name: "user", kind: "plain" }],
      datasets: [{ id: "d1", name: "row", values: {} }],
      isFlow: true,
      scriptEdited: true,
    });
    expect(ids(t, 2)).toEqual([
      "variables",
      "secrets",
      "cookies",
      "captures",
      "datasets",
      "flowCalls",
      "isFlow",
      "scriptEdited",
    ]);
  });

  it("counts each kind of step rather than reporting one per step", () => {
    const t = test_({ steps: [step("cookie", "c1"), step("cookie", "c2"), step("cookie", "c3")] });
    const [warning] = describeDuplicationWarnings(t);
    expect(warning.title).toContain("3 cookie steps");
  });

  it("says 'step' not 'steps' for one", () => {
    const t = test_({ steps: [step("cookie", "c1")] });
    expect(describeDuplicationWarnings(t)[0].title).toContain("1 cookie step");
  });

  it("gives every warning a detail explaining what it means for the COPY", () => {
    // A title alone ("2 cookie steps") states a fact about the original and
    // leaves the reader to guess what duplicating does with it.
    const t = test_({
      steps: [step("cookie", "c1"), step("capture", "cap1"), step("runFlow", "f1")],
      variables: [{ name: "user", kind: "plain" }],
      datasets: [{ id: "d1", name: "row", values: {} }],
      isFlow: true,
      sourceDir: "/x",
    });
    for (const w of describeDuplicationWarnings(t, 1)) {
      expect(w.detail.length).toBeGreaterThan(20);
      expect(w.title).not.toBe(w.detail);
    }
  });

  it("gives each warning a distinct id, so React keys can't collide", () => {
    const t = test_({
      steps: [step("cookie", "c1"), step("capture", "cap1"), step("runFlow", "f1")],
      variables: [{ name: "user", kind: "plain" }],
      datasets: [{ id: "d1", name: "row", values: {} }],
      isFlow: true,
    });
    const got = ids(t, 1);
    expect(new Set(got).size).toBe(got.length);
  });

  it("reads only the fields it declares, so a full TestRecord works unchanged", () => {
    const full: TestRecord = {
      id: "t1",
      name: "Login",
      url: "https://example.test",
      createdAt: 1,
      updatedAt: 2,
      steps: [step("click")],
      scriptPath: "/tmp/t1.spec.ts",
      a11yBaseline: { s1: ["x"] },
      tags: ["smoke"],
    };
    expect(describeDuplicationWarnings(full)).toEqual([]);
  });
});

describe("NOT_COPIED", () => {
  it("names the run history, which is the absence most likely to read as a bug", () => {
    expect(NOT_COPIED.join(" ").toLowerCase()).toContain("run history");
  });

  it("names the accessibility baseline, which is dropped on purpose", () => {
    expect(NOT_COPIED.join(" ").toLowerCase()).toContain("accessibility");
  });
});
