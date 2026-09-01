import { describe, expect, it } from "vitest";

import {
  agentStateLabel,
  applyAgentEvent,
  reduceAgentEvents,
  type AgentEvent,
  type AgentEventRecord,
} from "./agent-run";

let seq = 0;
function rec(event: AgentEvent, runId = "r1", at = 1): AgentEventRecord {
  return { runId, seq: ++seq, at, event };
}

describe("applyAgentEvent", () => {
  it("builds the feed in arrival order and settles running on finished", () => {
    seq = 0;
    const view = reduceAgentEvents([
      rec({ kind: "say", who: "user", text: "add to cart" }),
      rec({ kind: "state", state: "planning" }),
      rec({ kind: "say", who: "agent", text: "Clicking Add to cart" }),
      rec({ kind: "state", state: "acting" }),
      rec({ kind: "step", label: "Click Add to cart", status: "ran" }),
      rec({ kind: "finished", reason: "goal", note: "In the cart" }),
    ]);
    expect(view).not.toBeNull();
    expect(view!.items.map((i) => i.kind)).toEqual(["say", "say", "step"]);
    expect(view!.running).toBe(false);
    expect(view!.finishedReason).toBe("goal");
    expect(view!.finishedNote).toBe("In the cart");
    expect(agentStateLabel(view!)).toBe("Done");
  });

  it("resolves a proposal card IN PLACE rather than appending", () => {
    seq = 0;
    const view = reduceAgentEvents([
      rec({ kind: "proposal", id: "p1", label: "Assert Thank you is visible" }),
      rec({ kind: "say", who: "agent", text: "worth pinning" }),
      rec({ kind: "proposal-resolved", id: "p1", accepted: true, outcome: "inserted" }),
    ]);
    expect(view!.items).toHaveLength(2);
    expect(view!.items[0]).toMatchObject({ kind: "proposal", resolved: true, accepted: true, outcome: "inserted" });
  });

  it("drops a stale or duplicate seq — the snapshot/push overlap", () => {
    seq = 0;
    const first = rec({ kind: "say", who: "user", text: "go" });
    let view = applyAgentEvent(null, first);
    view = applyAgentEvent(view, first);
    expect(view!.items).toHaveLength(1);
  });

  it("a record for a different run replaces the view", () => {
    seq = 0;
    let view = applyAgentEvent(null, rec({ kind: "say", who: "user", text: "old goal" }, "r1"));
    view = applyAgentEvent(view, rec({ kind: "say", who: "user", text: "new goal" }, "r2"));
    expect(view!.runId).toBe("r2");
    expect(view!.items).toHaveLength(1);
    expect(view!.items[0]).toMatchObject({ text: "new goal" });
  });

  it("labels every live state and every ending", () => {
    seq = 0;
    const base = reduceAgentEvents([rec({ kind: "state", state: "awaiting-user" })])!;
    expect(agentStateLabel(base)).toBe("Waiting for you");
    const stopped = reduceAgentEvents([rec({ kind: "finished", reason: "stopped" })])!;
    expect(agentStateLabel(stopped)).toBe("Stopped");
    const budget = reduceAgentEvents([rec({ kind: "finished", reason: "budget" })])!;
    expect(agentStateLabel(budget)).toMatch(/budget/);
  });
});
