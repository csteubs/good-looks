// Tests for the injected step replayer, executed against a real DOM.
//
// `buildReplayScript(step)` returns a self-contained IIFE string that the app
// evaluates inside the training page. Until now it had no coverage at all,
// because testing it needs a document — which is exactly what jsdom provides.
// Running the emitted script for real also exercises DOM_HELPERS from
// capture-script.ts (locator resolution, accessible-name computation, css
// paths), the other large untested module, and pins the two together: the
// capture script generates locators, the replayer resolves them, and a drift
// between them is invisible in either file alone.

/* This file runs in the "dom" Vitest project (jsdom), but it lives under main/
   which the shared lint config treats as Node-only — so the browser globals it
   legitimately uses have to be declared. Flat config doesn't support
   `eslint-env`, hence `global`. */
/* global document, Element, DOMRect, HTMLButtonElement, HTMLInputElement, HTMLSelectElement */

import { beforeEach, describe, expect, it } from "vitest";

import { buildReplayScript } from "../step-replayer.js";
import type { AssertKind, Locator, Step, StepType } from "../../recorder/types.js";

interface ReplayResult {
  ok: boolean;
  error?: string;
  met?: boolean;
  logs: { i: number; t: number; level: string; m: string }[];
}

function step(partial: Partial<Step> & { type: StepType }): Step {
  return { id: "s1", timestamp: 0, ...partial } as Step;
}

/** Evaluate the injected script exactly as the app does. */
function run(s: Step): ReplayResult {
  return eval(buildReplayScript(s)) as ReplayResult;
}

// jsdom has no layout engine: getBoundingClientRect() returns all zeros for
// every element. The replayer's visible() treats a zero-sized box as invisible
// (correct in a real browser), so without this shim EVERY element reads as
// hidden — which silently turns "hidden → passes" into a test that proves
// nothing, and fails every visibility assertion for the wrong reason.
//
// Giving elements a nominal box models the one thing jsdom lacks and leaves the
// real logic under test: visible() still consults computed style afterwards, so
// display:none / visibility:hidden / opacity:0 are still honored.
beforeEach(() => {
  document.body.innerHTML = "";
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      width: 100,
      height: 20,
      top: 0,
      left: 0,
      right: 100,
      bottom: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

describe("locator resolution", () => {
  it("resolves a testid locator and clicks it", () => {
    document.body.innerHTML = `<button data-testid="go">Go</button>`;
    let clicked = false;
    document.querySelector("button")!.addEventListener("click", () => {
      clicked = true;
    });

    const res = run(step({ type: "click", locator: { k: "testid", v: "go" } }));

    expect(res.ok).toBe(true);
    expect(clicked).toBe(true);
  });

  it("resolves a role locator by accessible name", () => {
    document.body.innerHTML = `
      <button>Cancel</button>
      <button>Submit</button>`;
    let submitted = false;
    document.querySelectorAll("button")[1].addEventListener("click", () => {
      submitted = true;
    });

    const res = run(
      step({ type: "click", locator: { k: "role", role: "button", name: "Submit" } }),
    );

    expect(res.ok).toBe(true);
    expect(submitted).toBe(true);
  });

  it("resolves a label locator and fills the field it labels", () => {
    document.body.innerHTML = `
      <label for="email">Email</label>
      <input id="email" />`;

    const res = run(
      step({ type: "fill", locator: { k: "label", v: "Email" }, value: "a@b.test" }),
    );

    expect(res.ok).toBe(true);
    expect(document.querySelector<HTMLInputElement>("#email")!.value).toBe("a@b.test");
  });

  it("resolves a css locator", () => {
    document.body.innerHTML = `<input class="q" />`;
    const res = run(step({ type: "fill", locator: { k: "css", v: ".q" }, value: "hello" }));
    expect(res.ok).toBe(true);
    expect(document.querySelector<HTMLInputElement>(".q")!.value).toBe("hello");
  });

  it("resolves an xpath locator", () => {
    document.body.innerHTML = `<div><span id="t">hi</span></div>`;
    const res = run(
      step({ type: "assert", assert: "visible", locator: { k: "xpath", v: "//span[@id='t']" } }),
    );
    expect(res.ok).toBe(true);
  });
});

describe("actions", () => {
  it("checks and unchecks a checkbox", () => {
    document.body.innerHTML = `<input type="checkbox" data-testid="c" />`;
    const box = document.querySelector<HTMLInputElement>("[data-testid=c]")!;

    expect(run(step({ type: "check", locator: { k: "testid", v: "c" } })).ok).toBe(true);
    expect(box.checked).toBe(true);

    expect(run(step({ type: "uncheck", locator: { k: "testid", v: "c" } })).ok).toBe(true);
    expect(box.checked).toBe(false);
  });

  it("selects an option", () => {
    document.body.innerHTML = `
      <select data-testid="s"><option value="a">A</option><option value="b">B</option></select>`;
    const res = run(step({ type: "select", locator: { k: "testid", v: "s" }, value: "b" }));
    expect(res.ok).toBe(true);
    expect(document.querySelector<HTMLSelectElement>("[data-testid=s]")!.value).toBe("b");
  });

  it("sets the viewport without a locator", () => {
    const res = run(step({ type: "viewport", width: 800, height: 600 }));
    expect(res.ok).toBe(true);
  });
});

describe("assertions", () => {
  const cases: { assert: AssertKind; html: string; locator: Locator; value?: string; text?: string; ok: boolean }[] = [
    {
      assert: "visible",
      html: `<div data-testid="x">hi</div>`,
      locator: { k: "testid", v: "x" },
      ok: true,
    },
    {
      assert: "hidden",
      html: `<div data-testid="x" style="display:none">hi</div>`,
      locator: { k: "testid", v: "x" },
      ok: true,
    },
    {
      assert: "text",
      html: `<div data-testid="x">hello world</div>`,
      locator: { k: "testid", v: "x" },
      text: "hello",
      ok: true,
    },
    {
      assert: "text",
      html: `<div data-testid="x">hello world</div>`,
      locator: { k: "testid", v: "x" },
      text: "goodbye",
      ok: false,
    },
    {
      assert: "checked",
      html: `<input type="checkbox" data-testid="x" checked />`,
      locator: { k: "testid", v: "x" },
      ok: true,
    },
    {
      assert: "disabled",
      html: `<button data-testid="x" disabled>x</button>`,
      locator: { k: "testid", v: "x" },
      ok: true,
    },
  ];

  for (const c of cases) {
    it(`${c.assert} → ${c.ok ? "passes" : "fails"}`, () => {
      document.body.innerHTML = c.html;
      const res = run(
        step({ type: "assert", assert: c.assert, locator: c.locator, value: c.value, text: c.text }),
      );
      expect(res.ok).toBe(c.ok);
    });
  }

  it("reports the actual value when a text assertion fails", () => {
    document.body.innerHTML = `<div data-testid="x">actual text</div>`;
    const res = run(
      step({ type: "assert", assert: "text", locator: { k: "testid", v: "x" }, text: "expected" }),
    );
    expect(res.ok).toBe(false);
    // The whole point of the verbose logs is telling you what it saw.
    expect(JSON.stringify(res.logs)).toContain("actual text");
  });
});

describe("conditions (if steps)", () => {
  it("reports met=true when the element is visible", () => {
    document.body.innerHTML = `<div data-testid="x">hi</div>`;
    const res = run(step({ type: "if", cond: "visible", locator: { k: "testid", v: "x" } }));
    expect(res.ok).toBe(true);
    expect(res.met).toBe(true);
  });

  it("reports met=false when the element is absent", () => {
    const res = run(step({ type: "if", cond: "visible", locator: { k: "testid", v: "nope" } }));
    expect(res.met).toBe(false);
  });

  it("evaluates a page-level condition", () => {
    const res = run(step({ type: "if", cond: "urlContains", value: "localhost" }));
    expect(res.ok).toBe(true);
    expect(typeof res.met).toBe("boolean");
  });
});

describe("conditional waits (wait until)", () => {
  /** The polling path returns a Promise; the already-met path returns the
   *  result directly. Callers in the app await either, so tests do too. */
  async function runWait(s: Step): Promise<ReplayResult> {
    return await (eval(buildReplayScript(s)) as ReplayResult | Promise<ReplayResult>);
  }

  it("passes immediately when the condition already holds", async () => {
    document.body.innerHTML = `<button data-testid="go">Go</button>`;
    const res = await runWait(
      step({ type: "wait", waitUntil: "visible", locator: { k: "testid", v: "go" }, timeoutMs: 300 }),
    );
    expect(res.ok).toBe(true);
    expect(res.logs.some((l) => l.m.includes("already met"))).toBe(true);
  });

  it("keeps waiting and passes once the condition becomes true", async () => {
    document.body.innerHTML = `<button data-testid="go" disabled>Go</button>`;
    const btn = document.querySelector("button") as HTMLButtonElement;
    setTimeout(() => {
      btn.disabled = false;
    }, 150);

    const res = await runWait(
      step({ type: "wait", waitUntil: "enabled", locator: { k: "testid", v: "go" }, timeoutMs: 2000 }),
    );

    // The whole point of a conditional wait: it did NOT pass on the first look.
    expect(res.ok).toBe(true);
    expect(res.logs.some((l) => l.m.includes("condition met after"))).toBe(true);
    expect(res.logs.some((l) => l.m.includes("already met"))).toBe(false);
  });

  it("fails with a diagnosable error when the condition never holds", async () => {
    document.body.innerHTML = `<button data-testid="go" disabled>Go</button>`;
    const res = await runWait(
      step({ type: "wait", waitUntil: "enabled", locator: { k: "testid", v: "go" }, timeoutMs: 200 }),
    );
    expect(res.ok).toBe(false);
    // The error has to say what was actually observed — "timed out" alone
    // leaves the user with no idea which half was wrong.
    expect(res.error).toContain("Timed out");
    expect(res.error).toContain("enabled");
    expect(res.error).toContain("element is disabled");
  });

  it("reports a missing element rather than claiming the condition failed", async () => {
    const res = await runWait(
      step({ type: "wait", waitUntil: "enabled", locator: { k: "testid", v: "nope" }, timeoutMs: 150 }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("element not found");
  });

  it("waits for an element to disappear", async () => {
    document.body.innerHTML = `<div data-testid="spinner">loading</div>`;
    setTimeout(() => {
      document.querySelector("[data-testid=spinner]")?.remove();
    }, 120);
    const res = await runWait(
      step({ type: "wait", waitUntil: "hidden", locator: { k: "testid", v: "spinner" }, timeoutMs: 2000 }),
    );
    expect(res.ok).toBe(true);
  });

  it("evaluates the predicates an if-condition has no counterpart for", async () => {
    document.body.innerHTML = `
      <div data-testid="msg">All done</div>
      <input data-testid="qty" value="7" />
      <ul><li class="row">a</li><li class="row">b</li></ul>`;

    const text = await runWait(
      step({ type: "wait", waitUntil: "text", locator: { k: "testid", v: "msg" }, text: "done", timeoutMs: 200 }),
    );
    expect(text.ok).toBe(true);

    const value = await runWait(
      step({ type: "wait", waitUntil: "value", locator: { k: "testid", v: "qty" }, value: "7", timeoutMs: 200 }),
    );
    expect(value.ok).toBe(true);

    const count = await runWait(
      step({ type: "wait", waitUntil: "count", locator: { k: "css", v: ".row" }, count: 2, timeoutMs: 200 }),
    );
    expect(count.ok).toBe(true);

    const wrongCount = await runWait(
      step({ type: "wait", waitUntil: "count", locator: { k: "css", v: ".row" }, count: 5, timeoutMs: 150 }),
    );
    expect(wrongCount.ok).toBe(false);
    expect(wrongCount.error).toContain("count is 2");
  });

  it("evaluates a page-level predicate with no element", async () => {
    const res = await runWait(
      step({ type: "wait", waitUntil: "urlContains", value: "localhost", timeoutMs: 200 }),
    );
    expect(typeof res.ok).toBe("boolean");
  });

  it("caps the preview wait and says so, rather than freezing the trainer", async () => {
    document.body.innerHTML = `<button data-testid="go">Go</button>`;
    // A ten-minute timeout is legitimate in a real run. The preview must not
    // honour it — the trainer's UI is waiting on this call.
    const res = await runWait(
      step({ type: "wait", waitUntil: "visible", locator: { k: "testid", v: "go" }, timeoutMs: 600_000 }),
    );
    const opening = res.logs.find((l) => l.m.includes("waiting until"));
    expect(opening?.m).toContain("up to 5000ms");
    expect(opening?.m).toContain("capped for preview");
  });

  it("leaves a plain duration wait and a bare element wait alone", async () => {
    document.body.innerHTML = `<div data-testid="x">hi</div>`;
    const bare = await runWait(step({ type: "wait", locator: { k: "testid", v: "x" } }));
    expect(bare.ok).toBe(true);
    expect(bare.logs.some((l) => l.m.includes("wait-for-element resolved"))).toBe(true);

    const timed = await runWait(step({ type: "wait", waitMs: 1 }));
    expect(timed.ok).toBe(true);
    expect(timed.logs.some((l) => l.m.includes("waiting 1ms"))).toBe(true);
  });
});

describe("failure reporting", () => {
  it("fails when the locator matches nothing", () => {
    document.body.innerHTML = `<div>nothing here</div>`;
    const res = run(step({ type: "click", locator: { k: "testid", v: "missing" } }));
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it("always returns ordered logs", () => {
    document.body.innerHTML = `<button data-testid="b">B</button>`;
    const res = run(step({ type: "click", locator: { k: "testid", v: "b" } }));
    expect(res.logs.length).toBeGreaterThan(0);
    expect(res.logs.map((l) => l.i)).toEqual(res.logs.map((_, i) => i));
  });
});

// ── Cross-module invariant: replayer errors must trigger Auto-Heal ────────
// recorder-service decides whether to run Auto-Heal by MATCHING THE ERROR TEXT
// the replayer produced (isLocatorFailure). That's a coupling between two files
// with nothing enforcing it: reword the replayer's "not found" message and
// Auto-Heal silently stops firing — no error, no failing test, the feature just
// quietly does nothing. This pins the two together.
describe("replayer errors are classified for Auto-Heal", () => {
  it("an unresolved locator produces an error isLocatorFailure recognizes", async () => {
    const { isLocatorFailure } = await import("../recorder-service.js");
    document.body.innerHTML = `<div>nothing here</div>`;
    const s = step({ type: "click", locator: { k: "testid", v: "missing" } });

    const res = run(s);

    expect(res.ok).toBe(false);
    expect(isLocatorFailure(res.error, s)).toBe(true);
  });

  it("a value mismatch is NOT treated as a locator failure", async () => {
    const { isLocatorFailure } = await import("../recorder-service.js");
    document.body.innerHTML = `<div data-testid="x">actual</div>`;
    const s = step({
      type: "assert",
      assert: "text",
      locator: { k: "testid", v: "x" },
      text: "expected",
    });

    const res = run(s);

    // The element WAS found; healing the locator wouldn't help, and running the
    // heal engine here would be wasted work on every failed assertion.
    expect(res.ok).toBe(false);
    expect(isLocatorFailure(res.error, s)).toBe(false);
  });
});
