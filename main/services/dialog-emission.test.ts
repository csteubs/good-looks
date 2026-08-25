// Dialog-arming steps: the one-shot handler line, its allowlisted action,
// variable-aware prompt text, round-trips — and the runtime helper driven
// against a fake page, because "one-shot, races safely" is behavior.

import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

import { describe, expect, it } from "vitest";

import { generateSpec } from "./script-generator.js";
import { parseSpec } from "./spec-parser.js";
import { glazeRuntimeSource } from "../../shared/glaze-runtime-source.mjs";
import { normalizeRawStep } from "../recorder/types.js";
import type { Step, TestVariable } from "../recorder/types.js";

let seq = 0;
function step(partial: Partial<Step> & Pick<Step, "type">): Step {
  return { id: `s${seq++}`, timestamp: 0, ...partial } as Step;
}

function gen(steps: Step[], variables: TestVariable[] = []): string {
  return generateSpec({ name: "t", url: "https://x.test", steps, variables } as Parameters<
    typeof generateSpec
  >[0]);
}

function shape(steps: Step[]): unknown[] {
  return steps.map(({ id: _i, timestamp: _t, ...rest }) => rest);
}

describe("emission", () => {
  it("emits accept with text, accept bare, and dismiss without a second argument", () => {
    const src = gen([
      step({ type: "dialog", dialogAction: "accept", value: "Jane" }),
      step({ type: "dialog", dialogAction: "accept" }),
      step({ type: "dialog", dialogAction: "dismiss" }),
    ]);
    expect(src).toContain('await glazeArmDialog(page, "accept", "Jane");');
    expect(src).toContain('await glazeArmDialog(page, "accept");');
    expect(src).toContain('await glazeArmDialog(page, "dismiss");');
    expect(src).toContain('import { glazeArmDialog } from "./glaze-runtime.mjs";');
  });

  it("interpolates a ${var} prompt through V", () => {
    const src = gen(
      [step({ type: "dialog", dialogAction: "accept", value: "${name}" })],
      [{ name: "name", kind: "plain", value: "Ada" }],
    );
    expect(src).toContain('await glazeArmDialog(page, "accept", V.name);');
  });

  it("never interpolates a forged action — allowlisted independently", () => {
    const forged = step({ type: "dialog" });
    (forged as unknown as Record<string, unknown>).dialogAction = '"); evil(); ("';
    const src = gen([forged]);
    expect(src).toContain('glazeArmDialog(page, "accept")');
    expect(src).not.toContain("evil");
  });
});

describe("the boundary", () => {
  it("allowlists the action", () => {
    expect(normalizeRawStep({ type: "dialog", dialogAction: "accept" })?.dialogAction).toBe(
      "accept",
    );
    expect(
      normalizeRawStep({ type: "dialog", dialogAction: "acceptAll" })?.dialogAction,
    ).toBeUndefined();
  });
});

describe("round-trip", () => {
  it("reads all three forms back", () => {
    const steps = [
      step({ type: "dialog", dialogAction: "accept", value: "Jane" }),
      step({ type: "dialog", dialogAction: "accept" }),
      step({ type: "dialog", dialogAction: "dismiss" }),
    ];
    expect(shape(parseSpec(gen(steps)))).toEqual(shape(steps));
  });

  it("regeneration is a fixed point, disabled and wrapped included", () => {
    const steps = [
      step({ type: "dialog", dialogAction: "dismiss", disabled: true }),
      step({ type: "dialog", dialogAction: "accept", continueOnFailure: true }),
    ];
    const once = gen(steps);
    expect(gen(parseSpec(once))).toBe(once);
    expect(shape(parseSpec(once))).toEqual(shape(steps));
  });
});

describe("the runtime helper", () => {
  async function loadRuntime(): Promise<{
    glazeArmDialog: (page: unknown, action: string, text?: string) => Promise<void>;
  }> {
    const dir = mkdtempSync(join(tmpdir(), "gl-runtime-"));
    const file = join(dir, "glaze-runtime.mjs");
    writeFileSync(file, glazeRuntimeSource);
    return (await import(pathToFileURL(file).href)) as never;
  }

  function fakePage() {
    const handlers: Array<(d: unknown) => void> = [];
    const accepted: Array<string | undefined> = [];
    let dismissed = 0;
    return {
      accepted,
      dismissedCount: () => dismissed,
      fire() {
        const h = handlers.shift();
        if (h)
          h({
            accept: async (t?: string) => void accepted.push(t),
            dismiss: async () => void dismissed++,
          });
        return handlers.length;
      },
      page: {
        once: (_ev: string, cb: (d: unknown) => void) => handlers.push(cb),
      },
    };
  }

  it("accepts the next dialog with the text, one-shot", async () => {
    const rt = await loadRuntime();
    const fp = fakePage();
    await rt.glazeArmDialog(fp.page, "accept", "Jane");
    expect(fp.fire()).toBe(0);
    expect(fp.accepted).toEqual(["Jane"]);
  });

  it("dismisses, and a lost race never throws", async () => {
    const rt = await loadRuntime();
    const fp = fakePage();
    await rt.glazeArmDialog(fp.page, "dismiss");
    fp.fire();
    expect(fp.dismissedCount()).toBe(1);

    // A handler whose accept rejects (dialog already handled) must swallow.
    const rejecting = {
      once: (_ev: string, cb: (d: unknown) => void) =>
        cb({ accept: () => Promise.reject(new Error("already handled")), dismiss: () => Promise.reject(new Error("x")) }),
    };
    await rt.glazeArmDialog(rejecting, "accept", "x");
    await new Promise((r) => setTimeout(r, 0));
  });
});
