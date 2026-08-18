// The AI Debug dashboard.
//
// The arithmetic behind this screen is tested in `renderer/lib/
// ai-debug-stats.test.ts`, where it can be exercised without a DOM. What this
// file covers is the half that arithmetic cannot: whether a number that MEANS
// "we have never measured this" reaches the screen as a confident zero, whether
// a money figure appears when the user has never stated a rate, and whether a
// deleted test offers a button that goes nowhere.
//
// It also pins the property the whole category depends on — the tile and its
// dashboard read ONE report. A dashboard computing its own would eventually
// state a different total from the tile that opened it, with no error anywhere.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import type {
  AiDebugHistoryRecord,
  RunRecord,
  ScriptChangeListEntry,
} from "../../lib/recorder-types";
import { buildAiDebugReport } from "../../lib/ai-debug-stats";
import { summariseAiDebug } from "../../lib/stats-categories";
import {
  AiDebugDashboard,
  AiDebugLeaf,
  formatNetMinutes,
  formatTokens,
  formatWait,
} from "./ai-debug-dashboard";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function rec(over: Partial<AiDebugHistoryRecord> & { id: string }): AiDebugHistoryRecord {
  return {
    key: "run:t1",
    kind: "run",
    testId: "t1",
    testName: "Alpha",
    trigger: "manual",
    provider: "ollama",
    model: "qwen",
    status: "done",
    errorKind: null,
    startedAt: NOW - HOUR,
    endedAt: NOW - HOUR + 30_000,
    firstTokenMs: 2_000,
    promptChars: 4_000,
    answerChars: 400,
    runKey: null,
    ...over,
  };
}

function change(over: Partial<ScriptChangeListEntry> & { id: string }): ScriptChangeListEntry {
  return {
    testId: "t1",
    testName: "Alpha",
    origin: "ai-debug",
    reviewed: true,
    before: "old",
    after: "new",
    addedLines: 1,
    removedLines: 1,
    status: "pending",
    at: NOW - HOUR,
    ...over,
  } as ScriptChangeListEntry;
}

function report(
  records: AiDebugHistoryRecord[],
  changes: ScriptChangeListEntry[] = [],
  runs: RunRecord[] = [],
  hourlyRate = 0,
) {
  return buildAiDebugReport({
    records,
    scriptChanges: changes,
    runs,
    assumptions: { minutesPerManualDebug: 15, hourlyRate },
    now: NOW,
  });
}

function renderDashboard(
  built: ReturnType<typeof report>,
  onDrill: (facet: string) => void = () => {},
) {
  return render(
    <AiDebugDashboard
      report={built}
      minutesPerManualDebug={15}
      currency="usd"
      onDrill={onDrill}
    />,
  );
}

describe("formatting", () => {
  it("keeps a negative saving negative", () => {
    // The single most useful thing this screen can say is "this is costing you
    // time". Rendering it as an absolute value would turn that into praise.
    expect(formatNetMinutes(-12)).toBe("−12 min");
    expect(formatNetMinutes(12)).toBe("12 min");
  });

  it("scales a wait to a unit that says something", () => {
    expect(formatWait(400)).toBe("400 ms");
    expect(formatWait(4_000)).toBe("4.0s");
    expect(formatWait(4 * MINUTE)).toBe("4.0 min");
    expect(formatWait(4 * HOUR)).toBe("4.0 h");
  });

  it("quotes tokens in the units people quote them in", () => {
    expect(formatTokens(400)).toBe("400");
    expect(formatTokens(4_200)).toBe("4.2k");
    expect(formatTokens(4_200_000)).toBe("4.2M");
  });
});

describe("AiDebugDashboard", () => {
  it("explains itself rather than drawing zeroes when nothing has been asked", () => {
    renderDashboard(report([]));
    expect(screen.getByText(/nothing has been diagnosed yet/i)).toBeTruthy();
    // The rule the whole category is built on: no number at all, rather than a
    // confident 0 that reads as "the model helped you zero times".
    expect(screen.queryByText("Net time saved")).toBeNull();
  });

  it("breaks the attempts down by how they ended", () => {
    renderDashboard(
      report([
        rec({ id: "a" }),
        rec({ id: "b", status: "error", errorKind: "connection" }),
        rec({ id: "c", status: "cancelled" }),
      ]),
    );
    const answered = screen.getByText("Answered").closest("button")!;
    expect(answered.textContent).toContain("1");
    expect(screen.getByText("Stopped by you")).toBeTruthy();
  });

  it("drills into the outcome that was clicked", () => {
    const onDrill = vi.fn();
    renderDashboard(report([rec({ id: "a" })]), onDrill);
    fireEvent.click(screen.getByText("Failed").closest("button")!);
    expect(onDrill).toHaveBeenCalledWith("error");
  });

  it("says a dash, not a zero, when no fix has been kept", () => {
    renderDashboard(report([rec({ id: "a" })]));
    const card = screen.getByText("Net time saved").closest(".gl-kpi")!;
    expect(card.textContent).toContain("—");
    expect(card.textContent).toContain("no kept fix");
  });

  it("shows no money figure until an hourly rate is stated", () => {
    const built = report(
      [rec({ id: "a" })],
      [change({ id: "c1", status: "accepted" })],
      [],
      0,
    );
    renderDashboard(built);
    expect(screen.queryByText("At your hourly rate")).toBeNull();
  });

  it("shows money once a rate has been stated and there is a kept fix", () => {
    const built = report(
      [rec({ id: "a" })],
      [change({ id: "c1", status: "accepted" })],
      [],
      120,
    );
    renderDashboard(built);
    expect(screen.getByText("At your hourly rate")).toBeTruthy();
  });

  it("does not price a wait when the card beside it refuses to", () => {
    // The contradiction this was written against, found by looking at the
    // screen: with no kept fix, "Net time saved" says "—" while the money card
    // cheerfully rendered the wait as a cost. Side by side, one declining to
    // answer and one answering reads as a bug in whichever the reader trusts
    // less.
    const built = report([rec({ id: "a" })], [], [], 120);
    renderDashboard(built);
    expect(screen.getByText("Net time saved").closest(".gl-kpi")!.textContent).toContain("—");
    expect(screen.queryByText("At your hourly rate")).toBeNull();
  });

  it("states its assumptions under the figures they produced", () => {
    // The Cost panel's rule: a number nobody can check is a number nobody
    // believes. Both assumptions have to be readable without leaving.
    renderDashboard(report([rec({ id: "a" })]));
    const note = screen.getByText(/assuming 15 minutes/i);
    expect(note.textContent).toContain("subtracting");
    expect(note.textContent).toContain("Settings → Cost");
  });

  it("admits which attempts predate provider tracking", () => {
    renderDashboard(report([rec({ id: "a", provider: null })]));
    expect(screen.getByText(/predates provider tracking/i)).toBeTruthy();
  });

  it("names a remedy for every kind of failure it lists", () => {
    renderDashboard(report([rec({ id: "a", status: "error", errorKind: "model-unavailable" })]));
    expect(screen.getByText("Model not available")).toBeTruthy();
    expect(screen.getByText(/pull or load it/i)).toBeTruthy();
  });

  it("does not offer a failure breakdown when nothing failed", () => {
    renderDashboard(report([rec({ id: "a" })]));
    expect(screen.queryByText("Why attempts failed")).toBeNull();
  });

  it("says there is no earlier week rather than comparing against nothing", () => {
    renderDashboard(report([rec({ id: "a", startedAt: NOW - HOUR })]));
    expect(screen.getByText(/no earlier week to compare/i)).toBeTruthy();
  });

  it("agrees with the tile about the same history", () => {
    // The property the shared report exists to hold. If these disagree, the
    // board states one total and the screen it opens states another.
    const built = report([rec({ id: "a" }), rec({ id: "b", status: "error" })]);
    const tile = summariseAiDebug(built);
    renderDashboard(built);
    expect(tile.display).toBe("2");
    const answered = screen.getByText("Answered").closest("button")!;
    expect(answered.textContent).toContain("1");
  });
});

describe("AiDebugLeaf", () => {
  it("lists the tests behind an outcome, and exits to each", () => {
    const onOpen = vi.fn();
    render(
      <AiDebugLeaf
        facet="done"
        report={report([rec({ id: "a", testId: "t1", testName: "Alpha" })])}
        onOpenTest={onOpen}
      />,
    );
    fireEvent.click(screen.getByText("Open test ›"));
    expect(onOpen).toHaveBeenCalledWith("t1");
  });

  it("keeps a deleted test listed, and does not offer to open it", () => {
    // Its attempts are inside every total on the screen above, so dropping the
    // row would make the list disagree with the summary — but there is no page
    // left to open, and a button that silently does nothing is worse than one
    // that says why.
    const onOpen = vi.fn();
    render(
      <AiDebugLeaf
        facet="done"
        report={report([rec({ id: "a", testDeleted: true, testName: "Gone" })])}
        onOpenTest={onOpen}
      />,
    );
    expect(screen.getByText(/Gone \(deleted\)/)).toBeTruthy();
    fireEvent.click(screen.getByText("Test deleted ›"));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("sends the reader to the Heals tab to act on a fix", () => {
    // Stats reports; Heals acts. This screen must not grow an accept button.
    render(
      <AiDebugLeaf
        facet="fixes"
        report={report([rec({ id: "a" })], [change({ id: "c1", status: "accepted" })])}
        onOpenTest={() => {}}
      />,
    );
    expect(screen.getByText(/Heals tab/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /accept/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /revert/i })).toBeNull();
  });

  it("explains an unknown facet rather than rendering blank", () => {
    render(
      <AiDebugLeaf facet="sideways" report={report([rec({ id: "a" })])} onOpenTest={() => {}} />,
    );
    expect(screen.getByText(/is not an AI Debug breakdown/i)).toBeTruthy();
  });
});
