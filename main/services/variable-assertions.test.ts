// Asserting on a VARIABLE, branching on one, and writing one to the run log.
//
// Every other half of the variable system was already built — `capture` steps
// write them, `api` steps extract JSON fields into them, datasets sweep them,
// flows bind them — and nothing could ever CHECK one. A test could read an
// order total off the page and carry it to the end without being able to say
// what it should be.
//
// Three properties are pinned here, and the third is the one that decays
// quietly. What the generator EMITS, what the parser READS BACK (an operator
// that emits but does not round-trip disappears on the next hand edit, and the
// step silently becomes `equals`), and what the comparison MEANS — which is
// shared with the trainer's own evaluation, so a rule spelled twice would let a
// step be green in the trainer and impossible to pass in a run.

import { describe, expect, it } from "vitest";

import { generateSpec } from "./script-generator.js";
import { parseSpecDetailed } from "./spec-parser.js";
import { glazeRuntimeSource } from "./glaze-runtime-source.js";
import { normalizeRawStep } from "../recorder/types.js";
import {
  COMPARE_OPS,
  COMPARE_OP_LABEL,
  compareValues,
  NUMERIC_COMPARE_OPS,
} from "../../shared/step-semantics.mjs";
import type { CompareOp } from "../../shared/step-semantics.mjs";
import type { Step, TestVariable } from "../recorder/types.js";

let seq = 0;
function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: `s${seq++}`, timestamp: 0, ...partial } as Step;
}

const VARS: TestVariable[] = [
  { name: "total", kind: "plain", value: "49.99" },
  { name: "role", kind: "plain", value: "admin" },
];

function gen(steps: Step[], variables: TestVariable[] = VARS): string {
  return generateSpec({ name: "t", url: "https://x.test", steps, variables } as Parameters<
    typeof generateSpec
  >[0]);
}

function shape(steps: Step[]): unknown[] {
  return steps.map(({ id: _i, timestamp: _t, ...rest }) => rest);
}

function line(src: string, needle: string): string {
  return (src.split("\n").find((l) => l.includes(needle)) ?? "").trim();
}

const assertStep = (op: CompareOp, value = "49.9"): Step =>
  step({ type: "assert", assert: "variable", captureVar: "total", compareOp: op, value });

describe("what the comparison MEANS", () => {
  // The table itself, before any emission. These are the claims the generator,
  // the trainer and the step list all have to agree on.
  it("compares as raw text: case matters, whitespace is not tidied", () => {
    // Not a preference — a reading of `toBe`/`toContain`/`toMatch`, none of
    // which normalize anything. Kinder semantics here would put the app back
    // where it started: a rule the generated spec does not implement.
    expect(compareValues("Checkout", "eq", "checkout")).toBe(false);
    expect(compareValues(" Checkout ", "eq", "Checkout")).toBe(false);
    expect(compareValues("a  b", "eq", "a b")).toBe(false);
  });

  it("handles every operator", () => {
    expect(compareValues("abc", "eq", "abc")).toBe(true);
    expect(compareValues("abc", "neq", "abd")).toBe(true);
    expect(compareValues("abc", "contains", "b")).toBe(true);
    expect(compareValues("abc", "notContains", "z")).toBe(true);
    expect(compareValues("abc", "startsWith", "ab")).toBe(true);
    expect(compareValues("abc", "notStartsWith", "b")).toBe(true);
    expect(compareValues("abc", "endsWith", "bc")).toBe(true);
    expect(compareValues("abc", "notEndsWith", "ab")).toBe(true);
    expect(compareValues("10", "gt", "9")).toBe(true);
    expect(compareValues("9", "lt", "10")).toBe(true);
    expect(compareValues("10", "gte", "10")).toBe(true);
    expect(compareValues("10", "lte", "10")).toBe(true);
    expect(compareValues("AB-1", "matches", "^AB-\\d+$")).toBe(true);
  });

  it('compares "10" and "9" as NUMBERS, not as text', () => {
    // The trap the numeric operators exist for: as strings, "10" < "9".
    expect(compareValues("10", "gt", "9")).toBe(true);
    expect(compareValues("10", "contains", "9")).toBe(false);
  });

  it("reports every numeric comparison against a non-number as false", () => {
    // Including the ones that look like they should invert. There are no
    // negated numeric operators precisely so there is no "not less than" to
    // read as true when the value is not a number at all.
    for (const op of NUMERIC_COMPARE_OPS) {
      expect(compareValues("abc", op, "3"), op).toBe(false);
      expect(compareValues("3", op, "abc"), op).toBe(false);
    }
  });

  it("treats an empty expectation the way each operator really should", () => {
    // `"".slice(-0)` is the WHOLE string, not "" — the trap `matchesValue`
    // already documents, and the reason both ends are spelled out.
    expect(compareValues("abc", "endsWith", "")).toBe(true);
    expect(compareValues("abc", "notEndsWith", "")).toBe(false);
    expect(compareValues("abc", "startsWith", "")).toBe(true);
    expect(compareValues("abc", "contains", "")).toBe(true);
  });

  it("reports an uncompilable pattern as false rather than throwing", () => {
    // The pattern is a value the user typed. A step that throws a SyntaxError
    // deep inside a run reports as a crash rather than as a check that did not
    // hold.
    expect(compareValues("abc", "matches", "[")).toBe(false);
  });

  it("has a label for every operator", () => {
    // The pickers and both step lists read from this map. A missing entry
    // renders as the raw key, which is the kind of thing nobody notices.
    for (const op of COMPARE_OPS) expect(COMPARE_OP_LABEL[op], op).toBeTruthy();
  });
});

describe("emission", () => {
  it("uses real matchers on the spec line, not a boolean helper", () => {
    // Two reasons, both about the failure. Playwright reports an `expect` step
    // located at the spec line, so the run highlights the step that failed; and
    // these matchers print the actual and expected values, where
    // `expect(helper(...)).toBe(true)` prints "expected false to be true".
    const src = gen([assertStep("eq")]);
    expect(src).toContain('await expect(V.total, "total").toBe("49.9");');
    expect(src).not.toContain("glazeCompare");
  });

  it("names the variable, so the run log does too", () => {
    // `expect(value, message)` makes the message the step's TITLE.
    expect(gen([assertStep("contains")])).toContain('expect(V.total, "total")');
  });

  it("emits each operator's own matcher", () => {
    const src = gen(COMPARE_OPS.map((op) => assertStep(op)));
    expect(line(src, ".toBe(")).toContain('expect(V.total, "total").toBe("49.9")');
    expect(src).toContain('.not.toBe("49.9")');
    expect(src).toContain('.toContain("49.9")');
    expect(src).toContain('.not.toContain("49.9")');
    expect(src).toContain('.toBeGreaterThan(Number("49.9"))');
    expect(src).toContain('.toBeLessThan(Number("49.9"))');
    expect(src).toContain('.toBeGreaterThanOrEqual(Number("49.9"))');
    expect(src).toContain('.toBeLessThanOrEqual(Number("49.9"))');
  });

  it("reads BOTH sides of a numeric comparison as numbers", () => {
    // A `Number()` on only the left would compare a number against a string,
    // which JS coerces silently and inconsistently.
    expect(gen([assertStep("gt")])).toContain(
      'await expect(Number(V.total), "total").toBeGreaterThan(Number("49.9"));',
    );
  });

  it("anchors starts-with and ends-with, over an ESCAPED value", () => {
    // Playwright has no matcher for either, so they compile to a pattern. The
    // value has to be regex-escaped on the way in: an unescaped "." would
    // match any character and the check would pass against a value nobody
    // asked for.
    expect(gen([assertStep("startsWith")])).toContain('.toMatch(new RegExp("^49\\\\.9"));');
    expect(gen([assertStep("endsWith")])).toContain('.toMatch(new RegExp("49\\\\.9$"));');
    expect(gen([assertStep("notStartsWith")])).toContain('.not.toMatch(new RegExp("^49\\\\.9"));');
    expect(gen([assertStep("notEndsWith")])).toContain('.not.toMatch(new RegExp("49\\\\.9$"));');
  });

  it("passes a `matches` pattern through UNescaped — it is already a regex", () => {
    expect(gen([assertStep("matches", "^\\d+\\.\\d\\d$")])).toContain(
      '.toMatch(new RegExp("^\\\\d+\\\\.\\\\d\\\\d$"));',
    );
  });

  it("quotes a `matches` pattern as a STRING argument", () => {
    // Never concatenated into a regex LITERAL, where a `/` would end the
    // pattern early and everything after it would be parsed as code. The
    // property is that the whole thing is ONE quoted argument — the text
    // itself is allowed to look like anything, because it is data.
    const pattern = 'a/) ; require("fs"); //';
    const src = gen([assertStep("matches", pattern)]);
    expect(src).toContain(".toMatch(new RegExp(" + JSON.stringify(pattern) + "));");
  });

  it("interpolates the expected value, so one variable can be checked against another", () => {
    const src = gen([
      step({ type: "assert", assert: "variable", captureVar: "total", value: "${role}" }),
    ]);
    expect(src).toContain('await expect(V.total, "total").toBe(V.role);');
  });

  it("carries soft and a per-step timeout like any other assertion", () => {
    const src = gen([
      step({
        type: "assert",
        assert: "variable",
        captureVar: "total",
        value: "49.9",
        soft: true,
        timeoutMs: 7500,
      }),
    ]);
    expect(src).toContain('await expect.soft(V.total, "total").toBe("49.9", { timeout: 7500 });');
  });
});

describe("the generator's own guards", () => {
  // `recorder:updateStep` copies its allowlisted fields raw, and every test on
  // disk is regenerated from its stored steps, so a value the boundary never
  // saw can still reach these lines.
  it("falls back to `eq` for an operator it does not have", () => {
    const src = gen([
      step({
        type: "assert",
        assert: "variable",
        captureVar: "total",
        compareOp: 'x").toBe(require("fs")) //' as never,
        value: "49.9",
      }),
    ]);
    expect(src).toContain('await expect(V.total, "total").toBe("49.9");');
    expect(src).not.toContain("require(");
  });

  it("refuses a variable name that is not an identifier", () => {
    // The name lands in source as an IDENTIFIER (`V.<name>`), which nothing
    // quotes — so it is re-validated here rather than trusted.
    const src = gen([
      step({
        type: "assert",
        assert: "variable",
        captureVar: 'total; require("fs"); //' as never,
        value: "1",
      }),
    ]);
    // No statement was emitted for it at all.
    expect(src).not.toContain("expect(V.");
    // Refused OUT LOUD, with a reason that names the real problem — not the
    // generic "needs an element", which would send the user looking for a
    // target this kind never required.
    expect(src).toContain("no variable was chosen to compare");
    // The name still appears, inside the refusal COMMENT. That is data on one
    // comment line (`commentSafe` strips every newline), not a statement.
    const comment = line(src, "UNGENERATABLE");
    expect(comment.startsWith("//")).toBe(true);
    expect(comment.split("\n")).toHaveLength(1);
  });

  it("refuses a step with no variable at all", () => {
    const src = gen([step({ type: "assert", assert: "variable", value: "1" })]);
    expect(src).not.toContain("expect(V.");
  });

  it("refuses an unknown operator at the capture boundary too", () => {
    expect(normalizeRawStep({ type: "assert", assert: "variable", compareOp: "nope" })).toEqual({
      type: "assert",
      assert: "variable",
    });
    expect(normalizeRawStep({ type: "assert", assert: "variable", compareOp: "gte" })).toEqual({
      type: "assert",
      assert: "variable",
      compareOp: "gte",
    });
  });
});

describe("the variable condition", () => {
  it("compiles to the SHARED comparison, not a second spelling of it", () => {
    // Thirteen operators inlined into the condition expression would be a
    // second implementation, and the condition and the assertion disagreeing
    // about what "starts with" means is the class of bug shared/ exists to end.
    const src = gen([
      step({ type: "if", cond: "variable", captureVar: "role", compareOp: "contains", value: "adm" }),
      step({ type: "endif" }),
    ]);
    expect(src).toContain('if (glazeCompare(V.role, "contains", "adm")) {');
    expect(src).toContain('import { glazeCompare } from "./glaze-runtime.mjs";');
  });

  it("degrades to a condition that never holds when no variable was chosen", () => {
    // `false`, not `true`: an unusable condition must skip its block rather
    // than run it. The block's contents were written to run under a condition
    // nobody can now evaluate.
    const src = gen([step({ type: "if", cond: "variable", value: "x" }), step({ type: "endif" })]);
    expect(src).toContain("if (false) {");
  });

  it("imports glazeCompare only when a condition actually compiled to one", () => {
    const src = gen([step({ type: "if", cond: "variable", value: "x" }), step({ type: "endif" })]);
    expect(src).not.toContain("glazeCompare");
  });

  it("embeds the SHARED comparison in the runtime rather than retyping it", () => {
    expect(glazeRuntimeSource).toContain("export const glazeCompare =");
    // The embedded copy is the real function's source, so a change to the rule
    // reaches the runtime without anyone remembering to copy it.
    expect(glazeRuntimeSource).toContain('op === "notStartsWith"');
  });
});

describe("echo", () => {
  it("emits one awaited helper line", () => {
    expect(gen([step({ type: "echo", text: "order is ${role}" })])).toContain(
      "await glazeEcho(`order is ${V.role}`);",
    );
  });

  it("never asserts anything", () => {
    // An echo that could fail would be a strange assertion with no expected
    // value. The point is to answer "what IS this here" without making the run
    // depend on the answer.
    expect(glazeRuntimeSource).toContain("export async function glazeEcho(");
    expect(glazeRuntimeSource).not.toContain("throw new Error(\"[echo]");
  });
});

describe("round-trip", () => {
  it("survives every operator, to a fixed point", () => {
    const steps = COMPARE_OPS.map((op) => assertStep(op));
    const src = gen(steps);
    const parsed = parseSpecDetailed(src);
    expect(parsed.skipped).toBe(0);
    expect(parsed.steps).toHaveLength(COMPARE_OPS.length);
    expect(gen(parsed.steps as Step[])).toBe(src);
    // And each one came back as the operator it went out as.
    expect((parsed.steps as Step[]).map((s) => s.compareOp ?? "eq")).toEqual(COMPARE_OPS);
  });

  it("reads `eq` back as ABSENT rather than growing a field", () => {
    const parsed = parseSpecDetailed(gen([assertStep("eq")]));
    expect(shape(parsed.steps)).toEqual([
      { type: "assert", assert: "variable", captureVar: "total", value: "49.9" },
    ]);
  });

  it("un-escapes a starts-with value, so it does not drift on every edit", () => {
    // The generator regex-escaped it on the way out. Leaving it escaped would
    // re-escape it next time, pushing the value one backslash further from what
    // the user typed with every hand edit.
    const parsed = parseSpecDetailed(gen([assertStep("startsWith", "49.9")]));
    expect((parsed.steps[0] as Step).value).toBe("49.9");
  });

  it("survives the condition, the echo and a soft timeout-bearing assert", () => {
    const steps = [
      step({ type: "if", cond: "variable", captureVar: "role", compareOp: "neq", value: "guest" }),
      step({ type: "echo", text: "role is ${role}" }),
      step({ type: "endif" }),
      step({
        type: "assert",
        assert: "variable",
        captureVar: "total",
        compareOp: "gte",
        value: "10",
        soft: true,
        timeoutMs: 7500,
      }),
    ];
    const src = gen(steps);
    const parsed = parseSpecDetailed(src);
    expect(parsed.skipped).toBe(0);
    expect(shape(parsed.steps)).toEqual([
      { type: "if", cond: "variable", captureVar: "role", compareOp: "neq", value: "guest" },
      { type: "echo", text: "role is ${role}" },
      { type: "endif" },
      {
        type: "assert",
        assert: "variable",
        captureVar: "total",
        compareOp: "gte",
        value: "10",
        soft: true,
        timeoutMs: 7500,
      },
    ]);
    expect(gen(parsed.steps as Step[])).toBe(src);
  });

  it("leaves a hand-written expect over a plain value unclassified", () => {
    // `expect(someLocalVariable).toBeDefined()` is not a step, and reading it
    // as one would invent an assertion the user never wrote.
    const src = [
      'import { test, expect } from "@playwright/test";',
      "",
      'test("t", async ({ page }) => {',
      "  await expect(V.total, \"total\").toBeCloseTo(3);",
      "});",
      "",
    ].join("\n");
    const parsed = parseSpecDetailed(src);
    expect(parsed.steps).toEqual([]);
    expect(parsed.skipped).toBe(1);
  });

  it("refuses an operator the app does not have, in a hand-edited condition", () => {
    const src = [
      'import { test, expect } from "@playwright/test";',
      "",
      'test("t", async ({ page }) => {',
      '  if (glazeCompare(V.role, "sortOf", "adm")) {',
      "  }",
      "});",
      "",
    ].join("\n");
    // Unclassified rather than round-tripped into a step the generator would
    // then refuse — which would silently drop the whole `if` body.
    expect(parseSpecDetailed(src).steps.every((s) => s.cond !== "variable")).toBe(true);
  });
});
