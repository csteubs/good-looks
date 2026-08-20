// The teardown divider. Four layers, each pinned separately because each can
// fail on its own: EMISSION (the latch's shape), SEMANTICS (which error a run
// actually reports — the reason this is a latch and not a `finally`), REFUSAL
// (a divider that cannot be honoured must never produce a spec that does not
// parse), and ROUND-TRIP (the spec reads back into the same step list).
//
// The semantics layer is the load-bearing one. "Cleanup runs after a failure"
// is a claim about behaviour, not about source text, and the obvious
// implementation — `try { body } finally { cleanup }` — passes every
// source-shape assertion while getting the behaviour wrong: a cleanup step
// that throws inside `finally` REPLACES the body's error, so the run reports
// the cleanup's failure and the failure the user has to see is gone. So the
// emitted body is executed here against a fake page rather than only read.

import { describe, expect, it } from "vitest";

import { generateSpec } from "./script-generator.js";
import { parseSpec } from "./spec-parser.js";
import { normalizeRawStep } from "../recorder/types.js";
import type { Step } from "../recorder/types.js";

let seq = 0;
function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: `s${seq++}`, timestamp: 0, ...partial } as Step;
}

function gen(steps: Step[]): string {
  return generateSpec({ name: "t", url: "https://x.test", steps } as Parameters<
    typeof generateSpec
  >[0]);
}

/** Compile the emitted body, so a syntax error in it fails the test. Wrapped
 *  in an async arrow because the body is full of `await` — a bare
 *  `new Function(body)` is a SyntaxError for that reason alone and would
 *  report every refusal case as broken. */
function compiles(spec: string): () => unknown {
  return () => new Function("page", `return (async () => {${bodyOf(spec)}})();`);
}

/** The test body, pulled out of the emitted spec so it can be run. */
function bodyOf(spec: string): string {
  const head = "async ({ page }) => {";
  return spec.slice(spec.indexOf(head) + head.length, spec.lastIndexOf("});"));
}

/** Run an emitted body against a fake page, reporting what ran and what threw.
 *  `fail` names the test-ids whose click should throw. */
async function runBody(
  spec: string,
  fail: string[],
): Promise<{ ran: string[]; thrown: unknown }> {
  const ran: string[] = [];
  const page = {
    goto: async () => {},
    getByTestId: (id: string) => ({
      click: async () => {
        ran.push(id);
        if (fail.includes(id)) throw new Error(`${id} failed`);
      },
    }),
  };
  const fn = new Function("page", `return (async () => {${bodyOf(spec)}})();`);
  try {
    await fn(page);
    return { ran, thrown: null };
  } catch (e) {
    return { ran, thrown: e };
  }
}

const BODY_AND_CLEANUP = [
  step({ type: "goto", url: "https://x.test" }),
  step({ type: "click", locator: { k: "testid", v: "body" } }),
  step({ type: "teardown" }),
  step({ type: "click", locator: { k: "testid", v: "cleanup" } }),
];

describe("teardown emission", () => {
  it("wraps the body and opens the teardown block on the divider", () => {
    const spec = gen(BODY_AND_CLEANUP);
    expect(spec).toContain("let glTeardownError;");
    expect(spec).toContain("} catch (e) { glTeardownError = e; }");
    expect(spec).toContain("// ── teardown (always runs) ──");
    expect(spec).toContain("if (glTeardownError !== undefined) throw glTeardownError;");
    // The body's steps sit one level deeper than an unwrapped spec's do.
    expect(spec).toContain('    await page.getByTestId("body").click();');
    expect(spec).toContain('    await page.getByTestId("cleanup").click();');
  });

  it("emits nothing at all for a test with no divider", () => {
    // The regression that matters most: every spec already on disk regenerates
    // byte-identically, so adding this feature cannot rewrite the whole library.
    const spec = gen([
      step({ type: "goto", url: "https://x.test" }),
      step({ type: "click", locator: { k: "testid", v: "body" } }),
    ]);
    expect(spec).not.toContain("glTeardownError");
    expect(spec).not.toContain("try {");
    expect(spec).toContain('  await page.getByTestId("body").click();');
  });

  it("is accepted by the step boundary", () => {
    expect(normalizeRawStep({ type: "teardown" })?.type).toBe("teardown");
  });
});

describe("teardown semantics (the emitted body is executed)", () => {
  it("runs the cleanup when the body passed", async () => {
    const { ran, thrown } = await runBody(gen(BODY_AND_CLEANUP), []);
    expect(ran).toEqual(["body", "cleanup"]);
    expect(thrown).toBeNull();
  });

  it("runs the cleanup even though the body failed, and still fails", async () => {
    const { ran, thrown } = await runBody(gen(BODY_AND_CLEANUP), ["body"]);
    expect(ran).toEqual(["body", "cleanup"]);
    expect((thrown as Error).message).toBe("body failed");
  });

  it("reports a cleanup-only failure when the body passed", async () => {
    const { ran, thrown } = await runBody(gen(BODY_AND_CLEANUP), ["cleanup"]);
    expect(ran).toEqual(["body", "cleanup"]);
    expect((thrown as Error).message).toBe("cleanup failed");
  });

  it("keeps the BODY's error when both halves fail", async () => {
    // The whole reason for the latch. Under `try { … } finally { … }` this
    // reports "cleanup failed" and the real failure is unrecoverable — the
    // user is sent to debug their cleanup step instead of their test.
    const { ran, thrown } = await runBody(gen(BODY_AND_CLEANUP), ["body", "cleanup"]);
    expect(ran).toEqual(["body", "cleanup"]);
    expect((thrown as Error).message).toBe("body failed");
  });

  it("still fails when the thrown value is falsy", async () => {
    // `if (glTeardownError)` would read `throw ""` as "nothing failed" and turn
    // a real failure into a green run; the emitted test is `!== undefined`.
    const spec = gen(BODY_AND_CLEANUP);
    const page = {
      goto: async () => {},
      getByTestId: (id: string) => ({
        click: async () => {
          if (id === "body") throw "";
        },
      }),
    };
    const fn = new Function("page", `return (async () => {${bodyOf(spec)}})();`);
    await expect(fn(page)).rejects.toBeDefined();
  });
});

describe("teardown refusals", () => {
  it("refuses a divider inside a block and says why", () => {
    const spec = gen([
      step({ type: "goto", url: "https://x.test" }),
      step({ type: "if", cond: "visible", locator: { k: "testid", v: "banner" } }),
      step({ type: "teardown" }),
      step({ type: "endif" }),
    ]);
    expect(spec).toContain("teardown divider ignored — a divider cannot sit inside an if or repeat block");
    expect(spec).not.toContain("glTeardownError");
    // A refusal that produced an unbalanced brace would be worse than the
    // feature not existing, so the emitted file must still parse.
    expect(compiles(spec)).not.toThrow();
  });

  it("refuses a second divider and keeps the first", () => {
    const spec = gen([
      step({ type: "goto", url: "https://x.test" }),
      step({ type: "teardown" }),
      step({ type: "click", locator: { k: "testid", v: "a" } }),
      step({ type: "teardown" }),
      step({ type: "click", locator: { k: "testid", v: "b" } }),
    ]);
    expect(spec).toContain("teardown divider ignored — this test already has one");
    // One latch, not two.
    expect(spec.match(/let glTeardownError;/g)).toHaveLength(1);
    expect(compiles(spec)).not.toThrow();
  });
});

describe("teardown round-trip", () => {
  const cases: { label: string; steps: Step[] }[] = [
    { label: "plain divider", steps: BODY_AND_CLEANUP },
    {
      label: "continue-on-failure in the body",
      steps: [
        step({ type: "goto", url: "https://x.test" }),
        step({ type: "click", locator: { k: "testid", v: "flaky" }, continueOnFailure: true }),
        step({ type: "teardown" }),
        step({ type: "click", locator: { k: "testid", v: "cleanup" } }),
      ],
    },
    {
      label: "a block in each half",
      steps: [
        step({ type: "goto", url: "https://x.test" }),
        step({ type: "if", cond: "visible", locator: { k: "testid", v: "banner" } }),
        step({ type: "click", locator: { k: "testid", v: "dismiss" } }),
        step({ type: "endif" }),
        step({ type: "teardown" }),
        step({ type: "if", cond: "visible", locator: { k: "testid", v: "modal" } }),
        step({ type: "click", locator: { k: "testid", v: "close" } }),
        step({ type: "endif" }),
      ],
    },
    {
      label: "a refused divider",
      steps: [
        step({ type: "goto", url: "https://x.test" }),
        step({ type: "if", cond: "visible", locator: { k: "testid", v: "x" } }),
        step({ type: "teardown" }),
        step({ type: "endif" }),
      ],
    },
  ];

  for (const { label, steps } of cases) {
    it(`reads back the same step types: ${label}`, () => {
      expect(parseSpec(gen(steps)).map((s) => s.type)).toEqual(steps.map((s) => s.type));
    });

    it(`regenerates byte-identically: ${label}`, () => {
      // A round trip that changes the file would rewrite a user's spec on every
      // hand edit and every applied AI fix.
      const once = gen(steps);
      expect(gen(parseSpec(once))).toBe(once);
    });
  }

  it("does not read the latch's own try as a continue-on-failure wrapper", () => {
    // The generic `try { … } catch { … }` matcher sits directly below the latch
    // matchers in the parser's scan loop. If it won, the whole body would come
    // back as ONE step tagged continueOnFailure.
    const back = parseSpec(gen(BODY_AND_CLEANUP));
    expect(back.map((s) => s.type)).toEqual(["goto", "click", "teardown", "click"]);
    expect(back.some((s) => s.continueOnFailure)).toBe(false);
  });
});
