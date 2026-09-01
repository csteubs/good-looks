// Tests for the generated spec's line→step map.
//
// This map decides which step the UI highlights while a run is executing, and
// which step each captured screenshot is attributed to. Both failures are
// silent: nothing errors, the run still passes or fails correctly, and the user
// simply sees the wrong row lit up and a screenshot filed under the wrong step.
// It cost real debugging time before, which is why the generator now emits the
// map instead of the runner inferring it by counting `await` lines.
//
// The cases below are exactly the ones a counting heuristic gets wrong.

import { describe, expect, it } from "vitest";

import { generateSpecDetailed, stepTitle, type FlowSource } from "./script-generator.js";
import type { Step, StepType, TestVariable } from "../recorder/types.js";

let seq = 0;
function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: `s${seq++}`, timestamp: 0, ...partial } as Step;
}

/** The step index each 1-based spec line maps to, as an ordered list of
 *  [lineText, stepIndex] pairs — easier to read in a failure than raw numbers. */
function mappedLines(source: string, lineMap: Record<number, number>): [string, number][] {
  const lines = source.split("\n");
  return Object.entries(lineMap)
    .map(([line, index]) => [lines[Number(line) - 1].trim(), index] as [string, number])
    .sort((a, b) => a[1] - b[1]);
}

describe("generateSpecDetailed line map", () => {
  it("maps each plain step's line to its own index", () => {
    const steps = [
      step({ type: "goto", url: "https://example.com" }),
      step({ type: "click", locator: { k: "testid", v: "a" } }),
      step({ type: "click", locator: { k: "testid", v: "b" } }),
    ];
    const { source, lineMap } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(mappedLines(source, lineMap)).toEqual([
      ['await page.goto("https://example.com");', 0],
      ['await page.getByTestId("a").click();', 1],
      ['await page.getByTestId("b").click();', 2],
    ]);
  });

  it("keeps steps after an `if` block aligned", () => {
    // An `if` emits `if (...) {`, which has no leading `await` — a counting
    // heuristic skips it and shifts every following step down by one.
    const steps = [
      step({ type: "if", cond: "visible", locator: { k: "testid", v: "banner" } }),
      step({ type: "click", locator: { k: "testid", v: "dismiss" } }),
      step({ type: "endif" }),
      step({ type: "click", locator: { k: "testid", v: "checkout" } }),
    ];
    const { source, lineMap } = generateSpecDetailed({ name: "t", url: "u", steps });
    const mapped = mappedLines(source, lineMap);
    expect(mapped).toContainEqual(['await page.getByTestId("dismiss").click();', 1]);
    // The step AFTER the block is index 3, not 2.
    expect(mapped).toContainEqual(['await page.getByTestId("checkout").click();', 3]);
  });

  it("keeps steps after a variable header aligned", () => {
    // The `const V = {...}` header adds lines above the body. An off-by-one in
    // the preamble arithmetic mis-attributes every step in the test.
    const variables: TestVariable[] = [
      { name: "email", kind: "plain", value: "a@b.com" },
      { name: "password", kind: "secret" },
    ];
    const steps = [
      step({ type: "goto", url: "https://example.com" }),
      step({ type: "fill", locator: { k: "label", v: "Email" }, value: "${email}" }),
    ];
    const { source, lineMap } = generateSpecDetailed({ name: "t", url: "u", steps, variables });
    expect(mappedLines(source, lineMap)).toEqual([
      ['await page.goto("https://example.com");', 0],
      ["await page.getByLabel(\"Email\").fill(V.email);", 1],
    ]);
  });

  it("attributes every line of an inlined flow to the runFlow step", () => {
    // One step produces several lines. A counting heuristic would treat each as
    // its own step and shift everything after the flow by the flow's length.
    const flow: FlowSource = {
      id: "f1",
      name: "Login",
      flowParams: [],
      steps: [
        step({ type: "fill", locator: { k: "label", v: "Email" }, value: "a@b.com" }),
        step({ type: "click", locator: { k: "role", role: "button", name: "Log in" } }),
      ],
    };
    const steps = [
      step({ type: "goto", url: "https://example.com" }),
      step({ type: "runFlow", flowId: "f1", label: "Login" }),
      step({ type: "click", locator: { k: "testid", v: "checkout" } }),
    ];
    const { source, lineMap } = generateSpecDetailed(
      { name: "t", url: "u", steps },
      { resolveFlow: (id) => (id === "f1" ? flow : null) },
    );
    const mapped = mappedLines(source, lineMap);
    // Both inlined lines point at the runFlow step the user can actually see.
    expect(mapped.filter(([, index]) => index === 1)).toHaveLength(2);
    // And the step after the flow keeps its own index.
    expect(mapped).toContainEqual(['await page.getByTestId("checkout").click();', 2]);
  });

  it("keeps steps after a capture step aligned", () => {
    // A capture step adds an import line to the preamble AND emits a call that
    // isn't a page/locator action. Both shift the body.
    const steps = [
      step({ type: "goto", url: "https://example.com" }),
      step({
        type: "capture",
        locator: { k: "testid", v: "order" },
        captureVar: "orderId",
        captureFrom: "text",
      }),
      step({ type: "click", locator: { k: "testid", v: "done" } }),
    ];
    const { source, lineMap } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(mappedLines(source, lineMap)).toEqual([
      ['await page.goto("https://example.com");', 0],
      ['await glazeCapture(V, "orderId", page.getByTestId("order"), "text");', 1],
      ['await page.getByTestId("done").click();', 2],
    ]);
    // This record declares NO variables, but glazeCapture writes into `V` —
    // without the header the emitted spec is a ReferenceError at run time.
    expect(source).toContain("const V = {");
  });

  it("emits exactly one V header when a capture step meets declared variables", () => {
    // The zero-variable path above must not stack a second declaration on top
    // of the normal one — `const V` twice in one scope doesn't parse.
    const steps = [
      step({
        type: "capture",
        locator: { k: "testid", v: "order" },
        captureVar: "orderId",
        captureFrom: "text",
      }),
    ];
    const { source } = generateSpecDetailed({
      name: "t",
      url: "u",
      steps,
      variables: [{ name: "region", kind: "plain", value: "eu" }],
    });
    expect(source.split("const V = {").length - 1).toBe(1);
    expect(source).toContain('region: "eu",');
  });

  it("does not map a disabled step's commented-out line", () => {
    // A disabled step never executes, so no reporter marker ever arrives for
    // it. Mapping its line would be harmless but misleading; leaving it out
    // keeps the map to lines that can actually run.
    const steps = [
      step({ type: "click", locator: { k: "testid", v: "a" }, disabled: true }),
      step({ type: "click", locator: { k: "testid", v: "b" } }),
    ];
    const { source, lineMap } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(mappedLines(source, lineMap)).toEqual([
      ['await page.getByTestId("b").click();', 1],
    ]);
  });

  it("maps a continue-on-failure step to the line inside its try block", () => {
    const steps = [
      step({ type: "click", locator: { k: "testid", v: "a" }, continueOnFailure: true }),
      step({ type: "click", locator: { k: "testid", v: "b" } }),
    ];
    const { source, lineMap } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(mappedLines(source, lineMap)).toEqual([
      ['await page.getByTestId("a").click();', 0],
      ['await page.getByTestId("b").click();', 1],
    ]);
  });

  it("bounds a continue-on-failure step's patience, and restores it after the wrapper", () => {
    // The catch is only reachable if the wrapped step's failure THROWS: with
    // no actionTimeout in the emitted config, an action on a missing element
    // retries until the TEST timeout kills the run — an abort no catch can
    // swallow, which read as "Continue on Failure is ignored". The bracket
    // (10s in, 0 = the config's own unlimited posture out) is the fix; the
    // run-time proof is e2e/continue-on-failure.spec.ts.
    const steps = [
      step({ type: "click", locator: { k: "testid", v: "a" }, continueOnFailure: true }),
      step({ type: "click", locator: { k: "testid", v: "b" } }),
    ];
    const { source } = generateSpecDetailed({ name: "t", url: "u", steps });
    const lines = source.split("\n").map((l) => l.trim());
    const tryAt = lines.indexOf("try {");
    expect(lines[tryAt - 1]).toBe("page.setDefaultTimeout(10000);");
    const catchAt = lines.findIndex((l) => l.startsWith("} catch { /* continue on failure */ }"));
    expect(lines[catchAt + 1]).toBe("page.setDefaultTimeout(0);");
    // The UNWRAPPED step gets no bracket — the default posture is the
    // config's, and only the step that is allowed to fail pays for a bound.
    expect(lines.filter((l) => l.startsWith("page.setDefaultTimeout"))).toHaveLength(2);
  });
});

describe("flow variable binding", () => {
  // What a flow's `${x}` MEANS is decided here: a flow is written against its
  // own variable scope, so its plain variables bind to its own values, its
  // declared parameters can be overridden per call, and only its runtime-only
  // variables (secrets, captured values) travel as live `V.x` references. Each
  // failure below shipped or nearly shipped: a non-param `${x}` used to fall
  // through to the CALLER's scope, which is dynamic scoping nobody asked for.

  const resolve = (flow: FlowSource) => (id: string) => (id === flow.id ? flow : null);

  it("binds a caller-supplied argument over the parameter's default", () => {
    const flow: FlowSource = {
      id: "f1",
      name: "Login",
      flowParams: ["email"],
      variables: [{ name: "email", kind: "plain", value: "default@example.com" }],
      steps: [step({ type: "fill", locator: { k: "label", v: "Email" }, value: "${email}" })],
    };
    const { source } = generateSpecDetailed(
      {
        name: "t",
        url: "u",
        steps: [step({ type: "runFlow", flowId: "f1", flowArgs: { email: "override@x.com" } })],
      },
      { resolveFlow: resolve(flow) },
    );
    expect(source).toContain('fill("override@x.com")');
    expect(source).not.toContain("default@example.com");
  });

  it("falls back to the flow's own default for an unsupplied parameter", () => {
    const flow: FlowSource = {
      id: "f1",
      name: "Login",
      flowParams: ["email"],
      variables: [{ name: "email", kind: "plain", value: "default@example.com" }],
      steps: [step({ type: "fill", locator: { k: "label", v: "Email" }, value: "${email}" })],
    };
    const { source } = generateSpecDetailed(
      { name: "t", url: "u", steps: [step({ type: "runFlow", flowId: "f1" })] },
      { resolveFlow: resolve(flow) },
    );
    expect(source).toContain('fill("default@example.com")');
  });

  it("binds a NON-parameter plain variable to the flow's own value, never the caller's", () => {
    const flow: FlowSource = {
      id: "f1",
      name: "Login",
      flowParams: [],
      variables: [{ name: "region", kind: "plain", value: "eu" }],
      steps: [step({ type: "fill", locator: { k: "label", v: "Region" }, value: "${region}" })],
    };
    const { source } = generateSpecDetailed(
      {
        name: "t",
        url: "u",
        steps: [step({ type: "runFlow", flowId: "f1" })],
        // The caller declares the SAME name with a different value — before the
        // fix the flow's step silently read this one.
        variables: [{ name: "region", kind: "plain", value: "us" }],
      },
      { resolveFlow: resolve(flow) },
    );
    expect(source).toContain('fill("eu")');
    expect(source).not.toContain("fill(V.region)");
  });

  it("keeps a flow's captured variable a live V reference and declares it in the caller's header", () => {
    const flow: FlowSource = {
      id: "f1",
      name: "Order",
      flowParams: [],
      variables: [{ name: "orderId", kind: "captured", value: "fallback-1" }],
      steps: [
        step({
          type: "capture",
          locator: { k: "testid", v: "order" },
          captureVar: "orderId",
          captureFrom: "text",
        }),
        step({ type: "fill", locator: { k: "label", v: "Order" }, value: "${orderId}" }),
      ],
    };
    const { source } = generateSpecDetailed(
      { name: "t", url: "u", steps: [step({ type: "runFlow", flowId: "f1" })] },
      { resolveFlow: resolve(flow) },
    );
    // The read stays runtime — a textual binding would freeze the fallback and
    // the capture step's write would go unread.
    expect(source).toContain("fill(V.orderId)");
    // And the declaration (with the flow's fallback) reaches the caller's header.
    expect(source).toContain('orderId: "fallback-1",');
  });

  it("routes a flow's secret through the caller's header as an env reference", () => {
    const flow: FlowSource = {
      id: "f1",
      name: "Login",
      flowParams: [],
      variables: [{ name: "password", kind: "secret" }],
      steps: [step({ type: "fill", locator: { k: "label", v: "Password" }, value: "${password}" })],
    };
    const { source } = generateSpecDetailed(
      { name: "t", url: "u", steps: [step({ type: "runFlow", flowId: "f1" })] },
      { resolveFlow: resolve(flow) },
    );
    expect(source).toContain("fill(V.password)");
    expect(source).toContain('password: process.env.GLAZE_SECRET_password ?? "",');
  });

  it("lets the caller's own declaration of a name win over a flow's runtime one", () => {
    const flow: FlowSource = {
      id: "f1",
      name: "Order",
      flowParams: [],
      variables: [{ name: "orderId", kind: "captured", value: "flow-fallback" }],
      steps: [step({ type: "fill", locator: { k: "label", v: "Order" }, value: "${orderId}" })],
    };
    const { source } = generateSpecDetailed(
      {
        name: "t",
        url: "u",
        steps: [step({ type: "runFlow", flowId: "f1" })],
        variables: [{ name: "orderId", kind: "plain", value: "caller-value" }],
      },
      { resolveFlow: resolve(flow) },
    );
    // Exactly one declaration — a duplicate key in `const V` would be a spec
    // that lies about which value applies.
    expect(source.match(/^\s*orderId:/gm)).toHaveLength(1);
    expect(source).toContain('orderId: "caller-value",');
  });

  it("a caller-supplied argument may reference the caller's own variables", () => {
    const flow: FlowSource = {
      id: "f1",
      name: "Login",
      flowParams: ["email"],
      variables: [{ name: "email", kind: "plain", value: "default@example.com" }],
      steps: [step({ type: "fill", locator: { k: "label", v: "Email" }, value: "${email}" })],
    };
    const { source } = generateSpecDetailed(
      {
        name: "t",
        url: "u",
        steps: [step({ type: "runFlow", flowId: "f1", flowArgs: { email: "${user}" } })],
        variables: [{ name: "user", kind: "plain", value: "row@example.com" }],
      },
      { resolveFlow: resolve(flow) },
    );
    // The argument's `${user}` resolves against the caller's V — that is the
    // whole point of textual binding at generation time.
    expect(source).toContain("fill(V.user)");
  });
});

describe("flow loops", () => {
  // A repeated flow call emits a real `for` loop rather than unrolling: a
  // variable-driven count CANNOT be unrolled (its value arrives via
  // GLAZE_VARS at run time), so the loop emitter must exist anyway, and two
  // code paths for one feature is how they drift. The emitted clamp is the
  // load-bearing line — a dataset value is user input, and an unclamped
  // `Number(V.n)` bound is an unbounded loop in executed code.

  const loginFlow: FlowSource = {
    id: "f1",
    name: "Login",
    flowParams: [],
    steps: [step({ type: "click", locator: { k: "testid", v: "go" } })],
  };
  const resolve = (id: string) => (id === "f1" ? loginFlow : null);

  it("wraps a fixed repeat in a for loop and attributes body lines to the call row", () => {
    const steps = [
      step({ type: "goto", url: "https://example.com" }),
      step({ type: "runFlow", flowId: "f1", label: "Login", repeat: 3 }),
      step({ type: "click", locator: { k: "testid", v: "after" } }),
    ];
    const { source, lineMap } = generateSpecDetailed(
      { name: "t", url: "u", steps },
      { resolveFlow: resolve },
    );
    expect(source).toContain("for (let gl_i0 = 0; gl_i0 < 3; gl_i0++) {");
    const mapped = mappedLines(source, lineMap);
    // The body line inside the loop still points at the visible runFlow row...
    expect(mapped).toContainEqual(['await page.getByTestId("go").click();', 1]);
    // ...and the step after the loop keeps its own index.
    expect(mapped).toContainEqual(['await page.getByTestId("after").click();', 2]);
    // The loop's own lines are not mapped — no reporter marker ever names them.
    expect(source.split("\n").filter((l) => l.includes("for (let"))).toHaveLength(1);
  });

  it("emits a clamped run-time bound for a variable-driven repeat", () => {
    const steps = [step({ type: "runFlow", flowId: "f1", repeatVar: "n" })];
    const { source } = generateSpecDetailed(
      {
        name: "t",
        url: "u",
        steps,
        variables: [{ name: "n", kind: "plain", value: "2" }],
      },
      { resolveFlow: resolve },
    );
    expect(source).toContain(
      "for (let gl_i0 = 0, gl_n0 = Math.max(0, Math.min(100, Number(V.n) || 0)); gl_i0 < gl_n0; gl_i0++) {",
    );
  });

  it("a variable repeat wins over a fixed one", () => {
    const steps = [step({ type: "runFlow", flowId: "f1", repeat: 7, repeatVar: "n" })];
    const { source } = generateSpecDetailed(
      { name: "t", url: "u", steps, variables: [{ name: "n", kind: "plain", value: "2" }] },
      { resolveFlow: resolve },
    );
    expect(source).toContain("Number(V.n)");
    expect(source).not.toContain("gl_i0 < 7");
  });

  it("runs once with a visible sentence when the repeat variable is not declared", () => {
    const steps = [step({ type: "runFlow", flowId: "f1", label: "Login", repeatVar: "ghost" })];
    const { source } = generateSpecDetailed(
      { name: "t", url: "u", steps },
      { resolveFlow: resolve },
    );
    expect(source).not.toContain("for (let");
    // The flow still runs — degrading to zero runs would be worse than once.
    expect(source).toContain('await page.getByTestId("go").click();');
    expect(source).toContain("repeat count ${ghost} is not a declared variable — running once");
    // And the refused loop's close marker is skipped too: braces stay balanced.
    expect(source.split("{").length).toBe(source.split("}").length);
  });

  it("gives nested repeated flows distinct counters", () => {
    const inner: FlowSource = {
      id: "f2",
      name: "Inner",
      flowParams: [],
      steps: [step({ type: "click", locator: { k: "testid", v: "in" } })],
    };
    const outer: FlowSource = {
      id: "f1",
      name: "Outer",
      flowParams: [],
      steps: [step({ type: "runFlow", flowId: "f2", repeat: 2 })],
    };
    const steps = [step({ type: "runFlow", flowId: "f1", repeat: 3 })];
    const { source } = generateSpecDetailed(
      { name: "t", url: "u", steps },
      { resolveFlow: (id) => (id === "f1" ? outer : id === "f2" ? inner : null) },
    );
    expect(source).toContain("gl_i0 = 0; gl_i0 < 3");
    expect(source).toContain("gl_i1 = 0; gl_i1 < 2");
  });

  it("clamps a hostile fixed count instead of emitting it", () => {
    // Records written before the boundary learned these fields regenerate from
    // stored JSON — the TypeScript type is not a runtime check, same argument
    // as num().
    const steps = [
      { id: "s", timestamp: 0, type: "runFlow", flowId: "f1", repeat: "3); evil(); (" },
    ] as unknown as Step[];
    const { source } = generateSpecDetailed(
      { name: "t", url: "u", steps },
      { resolveFlow: resolve },
    );
    expect(source).not.toContain("evil(");
    // An unparseable count degrades to once — no loop at all.
    expect(source).not.toContain("for (let");
  });

  it("refuses a hostile repeat variable rather than emitting it", () => {
    const steps = [
      { id: "s", timestamp: 0, type: "runFlow", flowId: "f1", repeatVar: "x); evil(); (" },
    ] as unknown as Step[];
    const { source } = generateSpecDetailed(
      { name: "t", url: "u", steps },
      { resolveFlow: resolve },
    );
    expect(source).not.toContain("evil(");
    expect(source).not.toContain("for (let");
  });

  it("emits no loop around a disabled call's commented-out steps", () => {
    const steps = [step({ type: "runFlow", flowId: "f1", repeat: 3, disabled: true })];
    const { source } = generateSpecDetailed(
      { name: "t", url: "u", steps },
      { resolveFlow: resolve },
    );
    expect(source).not.toContain("for (let");
    expect(source).toContain("// disabled — skipped:");
  });
});

describe("viewport steps log the resize", () => {
  // A resize is the only recorded action with no visible effect in the run
  // output — every other step names its target ("click getByRole(...)"). Without
  // a log line, a run that fails at a responsive breakpoint gives no evidence
  // that the page was resized at all, let alone to what.

  /** Body lines of the generated spec, trimmed, in order. */
  function bodyLines(source: string): string[] {
    return source
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  it("emits a log statement after the resize", () => {
    const steps = [step({ type: "viewport", width: 390, height: 844 })];
    const { source } = generateSpecDetailed({ name: "t", url: "u", steps });
    const lines = bodyLines(source);
    const at = lines.indexOf("await page.setViewportSize({ width: 390, height: 844 });");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toContain("console.log(");
    expect(lines[at + 1]).toContain("390x844");
  });

  it("reports the APPLIED viewport, not an echo of the requested one", () => {
    // page.viewportSize() is read back after the call. An echo of the numbers
    // already on the line above would assert the very thing worth checking.
    const steps = [step({ type: "viewport", width: 390, height: 844 })];
    const { source } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(source).toContain("page.viewportSize()");
  });

  it("does not await the log line", () => {
    // `buildStepLineMap` (the fallback for hand-edited specs) classifies steps
    // by counting leading-`await` lines. An awaited log line would shift every
    // later step's highlight and screenshot attribution by one.
    const steps = [step({ type: "viewport", width: 390, height: 844 })];
    const { source } = generateSpecDetailed({ name: "t", url: "u", steps });
    const log = bodyLines(source).find((l) => l.includes("console.log("));
    expect(log?.startsWith("await ")).toBe(false);
  });

  it("keeps the step mapped to its setViewportSize line, not the log line", () => {
    const steps = [
      step({ type: "viewport", width: 390, height: 844 }),
      step({ type: "goto", url: "https://example.com" }),
      step({ type: "click", locator: { k: "testid", v: "a" } }),
    ];
    const { source, lineMap } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(mappedLines(source, lineMap)).toEqual([
      ["await page.setViewportSize({ width: 390, height: 844 });", 0],
      ['await page.goto("https://example.com");', 1],
      ['await page.getByTestId("a").click();', 2],
    ]);
  });

  it("comments out the log line too when the step is disabled", () => {
    // A disabled resize that still logged would report a size change that
    // never happened — the most misleading line the run could produce.
    const steps = [step({ type: "viewport", width: 390, height: 844, disabled: true })];
    const { source } = generateSpecDetailed({ name: "t", url: "u", steps });
    const log = bodyLines(source).find((l) => l.includes("console.log("));
    expect(log).toMatch(/^\/\/ disabled/);
  });

  it("puts the log line inside the try when the step continues on failure", () => {
    // Outside the try, a resize that THREW would still log the size it never
    // reached, because page.viewportSize() reports the old one.
    const steps = [step({ type: "viewport", width: 390, height: 844, continueOnFailure: true })];
    const { source } = generateSpecDetailed({ name: "t", url: "u", steps });
    const lines = bodyLines(source);
    const log = lines.findIndex((l) => l.includes("console.log("));
    const close = lines.findIndex((l) => l.startsWith("} catch"));
    expect(log).toBeGreaterThan(lines.findIndex((l) => l === "try {"));
    expect(log).toBeLessThan(close);
  });

  it("emits no log line for steps that aren't resizes", () => {
    const steps = [
      step({ type: "goto", url: "https://example.com" }),
      step({ type: "click", locator: { k: "testid", v: "a" } }),
      step({ type: "wait", waitMs: 500 }),
    ];
    const { source } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(source).not.toContain("console.log(");
  });

  it("cannot be poisoned into running code from the log line either", () => {
    // The same hole the numeric fields had: the log line concatenates width and
    // height into source text, so it goes through num() like everything else.
    const steps = [
      { id: "s", timestamp: 0, type: "viewport", width: "0}); evil(); ({", height: 800 },
    ] as unknown as Step[];
    const { source } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(source).not.toContain("evil(");
    expect(source).toContain("1280x800");
  });
});

describe("scroll steps", () => {
  it("emits scrollIntoViewIfNeeded for the element form", () => {
    const steps = [step({ type: "scroll", locator: { k: "testid", v: "reviews" } })];
    const { source, lineMap } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(source).toContain('await page.getByTestId("reviews").scrollIntoViewIfNeeded();');
    expect(Object.values(lineMap)).toEqual([0]);
  });

  it("emits a glazeScrollTo call — and its import — for the position form", () => {
    const steps = [step({ type: "scroll", scrollX: 0, scrollY: 1240 })];
    const { source, lineMap } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(source).toContain("await glazeScrollTo(page, 0, 1240);");
    expect(source).toContain('import { glazeScrollTo } from "./glaze-runtime.mjs";');
    // The helper import must not drag the variable header in: only capture
    // steps write into V.
    expect(source).not.toContain("const V = {");
    expect(Object.values(lineMap)).toEqual([0]);
  });

  it("does not import the runtime for element scrolls, and keeps capture-only imports byte-stable", () => {
    const elementOnly = generateSpecDetailed({
      name: "t",
      url: "u",
      steps: [step({ type: "scroll", locator: { k: "testid", v: "a" } })],
    });
    expect(elementOnly.source).not.toContain("glaze-runtime.mjs");
    // A capture-only spec must keep the exact import it has always had — tests
    // already on disk regenerate from stored steps and must stay byte-identical.
    const captureOnly = generateSpecDetailed({
      name: "t",
      url: "u",
      steps: [step({ type: "capture", captureVar: "x", captureFrom: "url" })],
    });
    expect(captureOnly.source).toContain('import { glazeCapture } from "./glaze-runtime.mjs";');
  });

  it("cannot be poisoned through the scroll offsets", () => {
    // Same boundary as count/width: tests recorded before the fix are already
    // on disk and regenerate from stored steps, so the generator guards on its
    // own, independent of normalizeRawStep.
    const steps = [
      { id: "s", timestamp: 0, type: "scroll", scrollX: '0); require("child_process"); (', scrollY: 10 },
    ] as unknown as Step[];
    const { source } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(source).not.toContain("child_process");
    expect(source).toContain("await glazeScrollTo(page, 0, 10);");
  });

  it("a scroll with neither an element nor a position is an UNGENERATABLE comment, not a vanished step", () => {
    const steps = [step({ type: "scroll" })];
    const { source } = generateSpecDetailed({ name: "t", url: "u", steps });
    expect(source).toContain("UNGENERATABLE STEP");
    expect(source).toContain("neither an element nor a position");
  });
});

describe("test.step wrapper titles", () => {
  it("never carry code, whatever the step type", () => {
    const cases: Partial<Step>[] = [
      { type: "click", locator: { k: "testid", v: "go" } },
      { type: "fill", locator: { k: "label", v: "Email" }, value: "a@b.c" },
      { type: "assert", assert: "url", value: "/cart" },
      { type: "scroll", locator: { k: "testid", v: "deep" } },
      { type: "scroll", scrollX: 0, scrollY: 120 },
      { type: "state", locator: { k: "testid", v: "x" }, value: "hover" },
      { type: "capture", locator: { k: "testid", v: "total" }, captureVar: "t" },
      { type: "press", value: "Enter" },
      { type: "goto", url: "https://example.com/a?b=1" },
      { type: "wait", locator: { k: "testid", v: "x" } },
    ];
    for (const c of cases) {
      const title = stepTitle(step(c as Partial<Step> & { type: StepType }));
      expect(title, c.type).not.toMatch(/\bpage\.|\bexpect\(|\bglaze[A-Z]|await /);
      expect(title.length, c.type).toBeGreaterThan(0);
    }
  });
});
