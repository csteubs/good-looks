// The iframe ENGINE: a locator can carry a frame path, the generator emits it
// as a `frameLocator` chain, the normalizer bounds it, and the parts that only
// work in the top document (per-step replay, Auto-Heal) decline a framed step
// out loud rather than acting on the wrong document.
//
// Generation↔parse round-trips are held by check:locator-roundtrip (frame rows);
// this covers the normalizer's bounds, the emission shape, and the refusals.
// The real Playwright proof — that the emitted `frameLocator` chain resolves the
// element the recorder meant — is e2e/frame-parity.spec.ts. See docs/IFRAMES.md.

import { describe, expect, it } from "vitest";

import { generateSpec } from "./script-generator.js";
import { buildHealMap } from "./playwright-runner.js";
import { healStep } from "./auto-heal.js";
import { buildReplayScript } from "./step-replayer.js";
import { normalizeStep, MAX_FRAME_DEPTH } from "../recorder/types.js";
import type { Locator, Step } from "../recorder/types.js";

function step(locator: Locator, extra: Partial<Step> = {}): Step {
  return normalizeStep({ id: "s1", timestamp: 0, type: "click", locator, ...extra }) as Step;
}
/** The `.click()` line of a one-step spec. */
function clickLine(s: Step): string {
  const src = generateSpec({ name: "t", url: "https://x.test", steps: [s] });
  return src.split("\n").find((l) => l.includes(".click(")) ?? "";
}

describe("normalizeFrameRefs — the boundary", () => {
  it("keeps a well-formed frame path", () => {
    const s = step({ k: "role", role: "button", name: "Pay", frame: [{ k: "name", v: "checkout" }] });
    expect(s.locator?.frame).toEqual([{ k: "name", v: "checkout" }]);
  });

  it("drops an unknown ref kind but keeps the array", () => {
    const s = step({
      k: "css",
      v: ".x",
      frame: [{ k: "name", v: "a" }, { k: "evil", v: "b" } as never, { k: "css", v: ".c" }],
    });
    expect(s.locator?.frame).toEqual([{ k: "name", v: "a" }, { k: "css", v: ".c" }]);
  });

  it("caps depth at MAX_FRAME_DEPTH", () => {
    const deep = Array.from({ length: MAX_FRAME_DEPTH + 3 }, (_, i) => ({ k: "name", v: `f${i}` }));
    const s = step({ k: "css", v: ".x", frame: deep as never });
    expect(s.locator?.frame?.length).toBe(MAX_FRAME_DEPTH);
  });

  it("drops a ref with an empty or non-string value", () => {
    const s = step({
      k: "css",
      v: ".x",
      frame: [{ k: "name", v: "" }, { k: "name", v: 7 } as never, { k: "name", v: "ok" }],
    });
    expect(s.locator?.frame).toEqual([{ k: "name", v: "ok" }]);
  });

  it("treats an empty array and a non-array as absent", () => {
    expect(step({ k: "css", v: ".x", frame: [] }).locator?.frame).toBeUndefined();
    expect(step({ k: "css", v: ".x", frame: "nope" as never }).locator?.frame).toBeUndefined();
  });

  it("never reads a frame off a container or an `and` predicate", () => {
    // A framed within/and would emit a second frameLocator the run resolves in
    // the wrong place. The frame lives only on the target.
    const s = step({
      k: "role",
      role: "button",
      name: "Edit",
      frame: [{ k: "name", v: "outer" }],
      ctx: {
        within: { k: "testid", v: "card", frame: [{ k: "name", v: "sneaky" }] } as never,
        and: [{ k: "css", v: ".p", frame: [{ k: "name", v: "sneaky" }] } as never],
      },
    });
    expect(s.locator?.frame).toEqual([{ k: "name", v: "outer" }]);
    expect((s.locator?.ctx?.within as Locator)?.frame).toBeUndefined();
    expect((s.locator?.ctx?.and?.[0] as Locator)?.frame).toBeUndefined();
  });
});

describe("generation", () => {
  it("emits one frameLocator per hop before the builder", () => {
    expect(clickLine(step({ k: "role", role: "button", name: "Pay", frame: [{ k: "name", v: "checkout" }] })))
      .toContain('page.frameLocator("iframe[name=\\"checkout\\"]").getByRole("button", { name: "Pay" }).click()');
  });

  it("nests frameLocator calls outermost first", () => {
    const line = clickLine(step({ k: "testid", v: "go", frame: [{ k: "name", v: "outer" }, { k: "testid", v: "inner" }] }));
    expect(line).toContain('frameLocator("iframe[name=\\"outer\\"]").frameLocator("iframe[data-testid=\\"inner\\"]").getByTestId("go")');
  });

  it("gives an `and` predicate the SAME frame as the target", () => {
    const line = clickLine(step({
      k: "role", role: "button", name: "Edit",
      frame: [{ k: "name", v: "f" }],
      ctx: { and: [{ k: "css", v: "[data-qa=x]" }] },
    }));
    // Both the target and the predicate resolve inside iframe[name="f"].
    expect(line).toContain('.and(page.frameLocator("iframe[name=\\"f\\"]").locator("[data-qa=x]"))');
  });

  it("a frame value is quoted, not interpolated raw", () => {
    // The frame ref is on the capture boundary the moment the trainer can
    // produce one; a quote in the value must be escaped by q(), not break out
    // of the selector into executable source. The payload text survives INSIDE
    // the quoted string (harmless); what matters is that the quote is escaped
    // and the line still parses as one statement.
    const line = clickLine(step({ k: "css", v: ".x", frame: [{ k: "css", v: 'iframe[title="a"]); evil();//' }] }));
    expect(line).toContain('frameLocator("iframe[title=\\"a\\"]); evil();//")');
    // Proof it is a single valid statement rather than two: the whole line
    // parses without throwing, and the payload never becomes a call.
    expect(() => new Function("page", "return " + line.trim().replace(/^await\s+/, "").replace(/;$/, ""))).not.toThrow();
  });

  it("is byte-identical for a locator with no frame", () => {
    const plain = generateSpec({ name: "t", url: "https://x.test", steps: [step({ k: "testid", v: "go" })] });
    expect(plain).toContain('page.getByTestId("go").click()');
    expect(plain).not.toContain("frameLocator");
  });
});

describe("the top-document-only parts decline a framed step", () => {
  const framed = step({ k: "role", role: "button", name: "Pay", frame: [{ k: "name", v: "f" }] });

  it("the run-time heal map skips it — no probe is built for a frame", () => {
    const map = buildHealMap([framed, step({ k: "testid", v: "plain" })]);
    const keys = Object.keys(map);
    expect(keys.length).toBe(1);
    // The one entry is the un-framed step.
    expect(JSON.stringify(map)).toContain("plain");
    expect(JSON.stringify(map)).not.toContain("frameLocator");
  });

  it("healStep refuses with a stated reason, without probing", async () => {
    let probed = false;
    const wc = { executeJavaScript: async () => { probed = true; return []; } };
    const result = await healStep(wc, framed, 0, [], { autoHealRetries: 3, autoHealAttemptTimeoutMs: 1000 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/iframe/i);
    expect(probed, "the probe was not even run").toBe(false);
  });

  it("the injected replayer refuses a framed step out loud", () => {
    // buildReplayScript returns a self-contained IIFE; evaluated, a framed step
    // returns ok:false with an iframe reason rather than resolving against the
    // top document. Evaluated in Node here (no DOM touched on this path — the
    // frame guard returns before any document access).
    const script = buildReplayScript(framed);
    const out = eval(script) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/iframe/i);
  });
});
