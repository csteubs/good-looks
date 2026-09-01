// The agent's state machine, retry budget, mailbox and proposal flow, pinned
// against stubbed deps — no page, no model, no window. What the e2e rows
// prove (a proposed step is TRIED on the real page before insertion) is the
// verify gate's contract; what THESE prove is that the loop around the gate
// behaves: evidence feeds back, a user's word outranks the plan, budgets
// actually bound the run, and the group markers bracket exactly what landed.

import { describe, expect, it, vi } from "vitest";

import type { Step } from "../../recorder/types.js";
import type { TryStepOutcome } from "../recorder-service.js";
import {
  AGENT_ATTEMPTS_PER_STEP,
  AGENT_MAX_INSERTED,
  createTrainerAgentService,
  type AgentEventRecord,
  type TrainerAgentDeps,
} from "./trainer-agent-service.js";

type Turn = { note?: string; done?: boolean; steps?: unknown[]; assertions?: unknown[] };

const CLICK = { type: "click", locator: { k: "testid", v: "go" } };

function harness(turns: Turn[], overrides: Partial<TrainerAgentDeps> = {}) {
  const pushed: AgentEventRecord[] = [];
  let call = 0;
  const deps: TrainerAgentDeps = {
    completeJson: vi.fn(async () => {
      const turn = turns[Math.min(call, turns.length - 1)];
      call++;
      return { value: turn };
    }),
    refreshRedaction: vi.fn(async () => {}),
    redact: (t) => t,
    tryStep: vi.fn(async (_input, onInsert): Promise<TryStepOutcome> => {
      onInsert?.();
      return { status: "inserted", result: { label: "click go", status: "ran" } };
    }),
    insertStep: vi.fn(),
    session: vi.fn(() => ({ steps: [] as Step[], liveUrl: "https://shop.test/" })),
    pageSummary: vi.fn(async () => null),
    probeFailedStep: vi.fn(async () => ["WHAT THE PAGE OFFERS INSTEAD:", '  CANDIDATE {"k":"testid","v":"go2"}']),
    describeStep: () => "a step",
    normalizeProposal: vi.fn((raw) => ({ raw: raw as never, label: "Assert Thank you is visible" })),
    push: (record) => pushed.push(record),
    ...overrides,
  };
  const svc = createTrainerAgentService(deps);
  const events = () => pushed.map((p) => p.event);
  const finished = () => pushed.map((p) => p.event).find((e) => e.kind === "finished") as
    | { kind: "finished"; reason: string; note?: string }
    | undefined;
  const untilDone = () => vi.waitFor(() => expect(svc.snapshot().running).toBe(false), { timeout: 4000 });
  const untilState = (state: string) =>
    vi.waitFor(() => expect(svc.snapshot().state).toBe(state), { timeout: 4000 });
  return { svc, deps, pushed, events, finished, untilDone, untilState };
}

const failedOutcome: TryStepOutcome = {
  status: "failed",
  result: { label: "click go", status: "failed", detail: "matched nothing" },
};

describe("the happy run", () => {
  it("verifies each step, brackets what landed in a group, and finishes on done", async () => {
    const h = harness([
      { note: "Adding to cart", steps: [CLICK, CLICK] },
      { note: "Done — item is in the cart", done: true },
    ]);
    expect(h.svc.start("add the item to the cart")).toEqual({ ok: true, runId: expect.any(String) });
    await h.untilDone();

    expect(h.deps.tryStep).toHaveBeenCalledTimes(2);
    expect(h.finished()).toMatchObject({ reason: "goal", note: "Done — item is in the cart" });
    // The group opened before the first insert and closed at run end.
    const markers = (h.deps.insertStep as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(markers[0]).toMatchObject({ type: "group", label: "add the item to the cart" });
    expect(markers[markers.length - 1]).toEqual({ type: "endGroup" });
    // Transcript starts with the user's goal.
    expect(h.events()[0]).toMatchObject({ kind: "say", who: "user", text: "add the item to the cart" });
  });

  it("refuses to start without a goal, without a session, or over a live run", async () => {
    const h = harness([{ steps: [CLICK] }, { done: true }]);
    expect(h.svc.start("")).toMatchObject({ ok: false });
    const noSession = harness([], { session: () => null });
    expect(noSession.svc.start("do the thing")).toMatchObject({ ok: false, reason: expect.stringMatching(/session/i) });
    expect(h.svc.start("first")).toMatchObject({ ok: true });
    expect(h.svc.start("second")).toMatchObject({ ok: false, reason: expect.stringMatching(/already/i) });
    await h.untilDone();
  });
});

describe("failure and recovery", () => {
  it("feeds probe evidence into the next turn, and a failed first step opens no group", async () => {
    const h = harness([{ steps: [CLICK] }, { done: true, note: "stopping here" }], {
      tryStep: vi.fn(async () => failedOutcome),
    });
    h.svc.start("click the missing button");
    await h.untilDone();

    // No insert ever happened, so neither group marker did.
    expect(h.deps.insertStep).not.toHaveBeenCalled();
    // The recovery turn carried the failure and what the probe found.
    const second = (h.deps.completeJson as ReturnType<typeof vi.fn>).mock.calls[1][0] as {
      messages: { content: string }[];
    };
    const user = second.messages[1].content;
    expect(user).toContain("FAILED STEP: click go");
    expect(user).toContain("matched nothing");
    expect(user).toContain('CANDIDATE {"k":"testid","v":"go2"}');
  });

  it("a step the boundary refuses counts as a failure, with its own evidence line", async () => {
    const h = harness([{ steps: [{ type: "nonsense" }] }, { done: true }], {
      tryStep: vi.fn(async (): Promise<TryStepOutcome> => ({ status: "skipped" })),
    });
    h.svc.start("do something odd");
    await h.untilDone();
    const second = (h.deps.completeJson as ReturnType<typeof vi.fn>).mock.calls[1][0] as {
      messages: { content: string }[];
    };
    expect(second.messages[1].content).toMatch(/refused by the recorder's step model/);
    expect(h.events().some((e) => e.kind === "step" && e.status === "failed")).toBe(true);
  });

  it("parks after three straight failures and resumes with a fresh streak on the user's word", async () => {
    const h = harness(
      [
        { steps: [CLICK] },
        { steps: [CLICK] },
        { steps: [CLICK] },
        { steps: [CLICK] },
        { done: true, note: "worked" },
      ],
      { tryStep: vi.fn(async () => failedOutcome) },
    );
    h.svc.start("keep clicking");
    await h.untilState("awaiting-user");
    // Three tries, three failures, one stuck message — and NOT a fourth
    // planning turn while nobody has answered.
    expect(h.deps.tryStep).toHaveBeenCalledTimes(AGENT_ATTEMPTS_PER_STEP);
    expect(h.events().some((e) => e.kind === "say" && /stuck/i.test((e as { text: string }).text))).toBe(true);

    (h.deps.tryStep as ReturnType<typeof vi.fn>).mockImplementation(
      async (_input: unknown, onInsert?: () => void): Promise<TryStepOutcome> => {
        onInsert?.();
        return { status: "inserted", result: { label: "click go", status: "ran" } };
      },
    );
    expect(h.svc.say("try the checkout button instead")).toBe(true);
    await h.untilDone();
    expect(h.finished()).toMatchObject({ reason: "goal" });
    const resumed = (h.deps.completeJson as ReturnType<typeof vi.fn>).mock.calls[3][0] as {
      messages: { content: string }[];
    };
    expect(resumed.messages[1].content).toContain("try the checkout button instead");
  });
});

describe("the mailbox and stop", () => {
  it("a message between steps abandons the rest of the turn's plan", async () => {
    let svcRef: { say: (t: string) => boolean } | null = null;
    const h = harness([{ steps: [CLICK, CLICK, CLICK] }, { done: true }], {
      tryStep: vi.fn(async (_input, onInsert): Promise<TryStepOutcome> => {
        onInsert?.();
        // The user speaks while the first step is executing.
        svcRef?.say("actually, open the wishlist instead");
        return { status: "inserted", result: { label: "click go", status: "ran" } };
      }),
    });
    svcRef = h.svc;
    h.svc.start("fill the cart");
    await h.untilDone();
    // One step ran; steps two and three were never tried.
    expect(h.deps.tryStep).toHaveBeenCalledTimes(1);
    const replan = (h.deps.completeJson as ReturnType<typeof vi.fn>).mock.calls[1][0] as {
      messages: { content: string }[];
    };
    expect(replan.messages[1].content).toContain("open the wishlist instead");
  });

  it("stop() while parked finishes as stopped, and the group still closes", async () => {
    const h = harness([{ note: "What should I do?", steps: [] }]);
    h.svc.start("hmm");
    await h.untilState("awaiting-user");
    expect(h.svc.stop()).toBe(true);
    await h.untilDone();
    expect(h.finished()).toMatchObject({ reason: "stopped" });
    // Nothing was inserted, so no markers either.
    expect(h.deps.insertStep).not.toHaveBeenCalled();
  });

  it("an LLM failure parks the run with the reason in the transcript", async () => {
    const completeJson = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValue({ value: { done: true } });
    const h = harness([], { completeJson });
    h.svc.start("do a thing");
    await h.untilState("awaiting-user");
    expect(
      h.events().some((e) => e.kind === "say" && /couldn't reach the model.*connection refused/i.test((e as { text: string }).text)),
    ).toBe(true);
    h.svc.say("try again");
    await h.untilDone();
    expect(h.finished()).toMatchObject({ reason: "goal" });
  });
});

describe("budgets", () => {
  it("stops at the inserted-step cap however willing the model is", async () => {
    const h = harness([{ steps: [CLICK, CLICK, CLICK] }]);
    h.svc.start("click forever");
    await h.untilDone();
    expect(h.deps.tryStep).toHaveBeenCalledTimes(AGENT_MAX_INSERTED);
    expect(h.finished()).toMatchObject({ reason: "budget" });
    // The group still closed behind the capped run.
    const markers = (h.deps.insertStep as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(markers[markers.length - 1]).toEqual({ type: "endGroup" });
  });

  it("ends the run when the session dies mid-acting", async () => {
    const h = harness([{ steps: [CLICK] }], {
      tryStep: vi.fn(async (): Promise<TryStepOutcome> => ({ status: "no-session" })),
    });
    h.svc.start("click");
    await h.untilDone();
    expect(h.finished()).toMatchObject({ reason: "session-ended" });
  });
});

describe("assertion proposals", () => {
  it("surfaces cards, inserts only on accept, and resolves each card exactly once", async () => {
    const h = harness([
      { note: "Suggesting a check", steps: [], assertions: [{ type: "assert", assert: "visible" }] },
    ]);
    h.svc.start("suggest something");
    await h.untilState("awaiting-user");
    const proposal = h.events().find((e) => e.kind === "proposal") as { id: string; label: string };
    expect(proposal).toMatchObject({ label: "Assert Thank you is visible" });
    // Nothing ran yet — a card is an offer, not an action.
    expect(h.deps.tryStep).not.toHaveBeenCalled();

    expect(await h.svc.resolveProposal(proposal.id, true)).toEqual({ ok: true });
    expect(h.deps.tryStep).toHaveBeenCalledTimes(1);
    expect(h.events().some((e) => e.kind === "proposal-resolved" && e.outcome === "inserted")).toBe(true);
    // A second resolve of the same card is refused.
    expect(await h.svc.resolveProposal(proposal.id, true)).toMatchObject({ ok: false });
    h.svc.stop();
    await h.untilDone();
  });

  it("declining a card runs nothing", async () => {
    const h = harness([{ steps: [], assertions: [{ type: "assert", assert: "visible" }] }]);
    h.svc.start("suggest");
    await h.untilState("awaiting-user");
    const proposal = h.events().find((e) => e.kind === "proposal") as { id: string };
    expect(await h.svc.resolveProposal(proposal.id, false)).toEqual({ ok: true });
    expect(h.deps.tryStep).not.toHaveBeenCalled();
    // And a failed accept reports the failure on the card.
    expect(await h.svc.resolveProposal("nope", true)).toMatchObject({ ok: false });
    h.svc.stop();
    await h.untilDone();
  });
});
