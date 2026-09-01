// The suggestion strip's engine, pinned against stubbed deps — no page, no
// model, no timer longer than a millisecond. The row that matters most is
// the first one: with the flag off, completeJson is NEVER reached, whatever
// else happens. check:agent-egress pins the same fact at source; this is
// the behavioural half, and the one a refactor of the debounce would break
// first.

import { describe, expect, it, vi } from "vitest";

import type { TryStepOutcome } from "../recorder-service.js";
import {
  createTrainerSuggestionService,
  type SuggestionDeps,
  type SuggestionsPayload,
} from "./suggestion-service.js";

const CLICK = { type: "click", locator: { k: "testid", v: "go" } };
const ASSERT = { type: "assert", assert: "visible", locator: { k: "text", v: "Thanks" } };
const FILL = { type: "fill", locator: { k: "testid", v: "email" }, value: "x@y.z" };

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function harness(overrides: Partial<SuggestionDeps> = {}) {
  const pushed: SuggestionsPayload[] = [];
  // Mutable mid-test: the service must read these at SEND time, so a test
  // flips them between scheduling and firing.
  const state = {
    enabled: true,
    agent: false,
    live: true,
  };
  const deps: SuggestionDeps = {
    completeJson: vi.fn(async () => ({ value: { suggestions: [CLICK, ASSERT] } })),
    refreshRedaction: vi.fn(async () => {}),
    redact: (t) => t,
    suggestionsEnabled: () => state.enabled,
    session: () => (state.live ? { steps: [], liveUrl: "https://shop.test/" } : null),
    agentRunning: () => state.agent,
    pageSummary: vi.fn(async () => null),
    describeStep: () => "a step",
    normalizeStep: vi.fn((raw) => ({ raw: raw as never, label: `do ${(raw as { type: string }).type}` })),
    tryStep: vi.fn(async (): Promise<TryStepOutcome> => ({
      status: "inserted",
      result: { label: "click go", status: "ran" },
    })),
    push: (p) => pushed.push(p),
    debounceMs: 1,
    ...overrides,
  };
  const svc = createTrainerSuggestionService(deps);
  const latest = () => pushed[pushed.length - 1];
  const untilOffers = () =>
    vi.waitFor(() => expect(svc.current().suggestions.length).toBeGreaterThan(0), { timeout: 2000 });
  return { svc, deps, state, pushed, latest, untilOffers };
}

describe("the flag is the send gate", () => {
  it("never calls the model while the setting is off", async () => {
    const h = harness();
    h.state.enabled = false;
    h.svc.noteCapture();
    await settle();
    expect(h.deps.completeJson).not.toHaveBeenCalled();
    expect(h.svc.current().suggestions).toEqual([]);
  });

  it("a flag flipped off mid-debounce wins — the setting is read at send time", async () => {
    const h = harness({ debounceMs: 15 });
    h.svc.noteCapture();
    h.state.enabled = false;
    await settle(60);
    expect(h.deps.completeJson).not.toHaveBeenCalled();
  });

  it("a flag flipped off while the model was answering discards the answer", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      completeJson: vi.fn(async () => {
        await gate;
        return { value: { suggestions: [CLICK] } };
      }),
    });
    h.svc.noteCapture();
    await vi.waitFor(() => expect(h.deps.completeJson).toHaveBeenCalled(), { timeout: 2000 });
    h.state.enabled = false;
    release();
    await settle();
    expect(h.svc.current().suggestions).toEqual([]);
  });
});

describe("who else silences it", () => {
  it("offers nothing while the agent drives the same page", async () => {
    const h = harness();
    h.state.agent = true;
    h.svc.noteCapture();
    await settle();
    expect(h.deps.completeJson).not.toHaveBeenCalled();
  });

  it("offers nothing when the session has ended", async () => {
    const h = harness();
    h.state.live = false;
    h.svc.noteCapture();
    await settle();
    expect(h.deps.completeJson).not.toHaveBeenCalled();
  });

  it("a model error offers nothing and throws nothing", async () => {
    const h = harness({
      completeJson: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    });
    h.svc.noteCapture();
    await vi.waitFor(() => expect(h.deps.completeJson).toHaveBeenCalled(), { timeout: 2000 });
    await settle();
    expect(h.svc.current().suggestions).toEqual([]);
  });
});

describe("the debounce and staleness", () => {
  it("a capture burst costs one request", async () => {
    const h = harness({ debounceMs: 10 });
    h.svc.noteCapture();
    h.svc.noteCapture();
    h.svc.noteCapture();
    await vi.waitFor(() => expect(h.deps.completeJson).toHaveBeenCalled(), { timeout: 2000 });
    await settle();
    expect(h.deps.completeJson).toHaveBeenCalledTimes(1);
  });

  it("a capture during a pending generation makes its answer stale", async () => {
    const answers: Array<() => void> = [];
    let calls = 0;
    const h = harness({
      completeJson: vi.fn(async () => {
        const mine = calls++;
        await new Promise<void>((r) => answers.push(r));
        return {
          value: {
            suggestions: [mine === 0 ? { ...CLICK, locator: { k: "testid", v: "stale" } } : CLICK],
          },
        };
      }),
    });
    h.svc.noteCapture();
    await vi.waitFor(() => expect(answers.length).toBe(1), { timeout: 2000 });
    // The page moves on while the first answer is still being written.
    h.svc.noteCapture();
    await vi.waitFor(() => expect(answers.length).toBe(2), { timeout: 2000 });
    answers[0]();
    answers[1]();
    await h.untilOffers();
    // Only the second generation's offer stands; the first was dropped.
    expect(h.svc.current().suggestions.length).toBe(1);
    const raws = (h.deps.normalizeStep as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(raws).toEqual([CLICK]);
  });

  it("a fresh capture clears standing offers immediately", async () => {
    const h = harness();
    h.svc.noteCapture();
    await h.untilOffers();
    h.svc.noteCapture();
    // Before any new answer: the strip is already empty.
    expect(h.pushed.some((p) => p.suggestions.length === 0)).toBe(true);
  });

  it("clear() drops offers and the pending timer", async () => {
    const h = harness({ debounceMs: 15 });
    h.svc.noteCapture();
    h.svc.clear();
    await settle(60);
    expect(h.deps.completeJson).not.toHaveBeenCalled();
  });
});

describe("what may be offered", () => {
  it("refuses fill and press whatever the model says — the allowlist is here, not in the prompt", async () => {
    const h = harness({
      completeJson: vi.fn(async () => ({
        value: { suggestions: [FILL, CLICK] },
      })),
    });
    h.svc.noteCapture();
    await h.untilOffers();
    const raws = (h.deps.normalizeStep as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(raws).toEqual([CLICK]);
  });

  it("drops a suggestion the normalizer refuses", async () => {
    const h = harness({
      normalizeStep: vi.fn((raw) =>
        (raw as { type: string }).type === "assert" ? null : { raw: raw as never, label: "do click" },
      ),
    });
    h.svc.noteCapture();
    await h.untilOffers();
    expect(h.svc.current().suggestions.length).toBe(1);
    expect(h.svc.current().suggestions[0].label).toBe("do click");
  });

  it("hands the renderer labels and ids only — never the raw step", async () => {
    const h = harness();
    h.svc.noteCapture();
    await h.untilOffers();
    for (const s of h.latest().suggestions) {
      expect(Object.keys(s).sort()).toEqual(["id", "label"]);
    }
  });
});

describe("taking and dismissing", () => {
  it("accept runs the step through the verify gate and clears every offer", async () => {
    const h = harness();
    h.svc.noteCapture();
    await h.untilOffers();
    const id = h.svc.current().suggestions[0].id;
    const res = await h.svc.accept(id);
    expect(res).toEqual({ ok: true });
    expect(h.deps.tryStep).toHaveBeenCalledWith(CLICK);
    expect(h.svc.current().suggestions).toEqual([]);
  });

  it("accept reports the gate's failure detail", async () => {
    const h = harness({
      tryStep: vi.fn(async (): Promise<TryStepOutcome> => ({
        status: "failed",
        result: { label: "click go", status: "failed", detail: "matched nothing" },
      })),
    });
    h.svc.noteCapture();
    await h.untilOffers();
    const res = await h.svc.accept(h.svc.current().suggestions[0].id);
    expect(res.ok).toBe(false);
    expect(res.detail).toBe("matched nothing");
  });

  it("accept still works with the flag off — the flag gates the send, not the user's choice", async () => {
    const h = harness();
    h.svc.noteCapture();
    await h.untilOffers();
    const id = h.svc.current().suggestions[0].id;
    h.state.enabled = false;
    const res = await h.svc.accept(id);
    expect(res).toEqual({ ok: true });
  });

  it("refuses an id it never offered", async () => {
    const h = harness();
    const res = await h.svc.accept("nope");
    expect(res.ok).toBe(false);
    expect(h.deps.tryStep).not.toHaveBeenCalled();
  });

  it("dismiss removes one chip and leaves the rest standing", async () => {
    const h = harness();
    h.svc.noteCapture();
    await h.untilOffers();
    const [first, second] = h.svc.current().suggestions;
    expect(h.svc.dismiss(first.id)).toBe(true);
    expect(h.svc.current().suggestions).toEqual([second]);
    expect(h.svc.dismiss(first.id)).toBe(false);
  });
});
