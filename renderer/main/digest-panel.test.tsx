// The weekly read, at the top of Stats. REDESIGN §6.5.
//
// The sentences are decided and tested in `renderer/lib/weekly-digest.ts`. What
// is here is the part that file cannot see: that an app with no history renders
// NOTHING rather than a paragraph explaining it is empty, and that the headline
// is weighted differently from the clauses qualifying it.

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import type { RunRecord } from "../lib/recorder-types";
import { DigestPanel } from "./digest-panel";

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "r1",
    testId: "t1",
    testName: "Checkout",
    url: "https://example.com",
    status: "passed",
    exitCode: 0,
    startedAt: Date.now() - 3_600_000,
    finishedAt: Date.now(),
    durationMs: 1_000,
    logFile: "/x.log",
    logBytes: 1,
    ...over,
  } as RunRecord;
}

describe("an app with no history", () => {
  it("renders nothing at all", () => {
    // A digest of an app that has never run anything is a paragraph explaining
    // it is empty, printed above six panels that also say so.
    const { container } = render(<DigestPanel runs={[]} />);
    expect(container.querySelector(".gl-digest")).toBeNull();
  });
});

describe("a week with runs", () => {
  it("reads out the digest's sentences, in order", () => {
    const runs = [run(), run({ id: "r2", status: "failed", exitCode: 1 })];
    const { container } = render(<DigestPanel runs={runs} />);
    const lines = [...container.querySelectorAll(".gl-digest-line")].map((n) => n.textContent);
    expect(lines[0]).toBe("2 runs, 1 failed.");
    expect(lines.join(" ")).toContain("Checkout failed 1 time.");
  });

  it("weights the headline differently from what qualifies it", () => {
    // Rendering every clause at one weight makes the reader find the subject
    // themselves, every time they look.
    const runs = [run(), run({ id: "r2", status: "failed", exitCode: 1 })];
    const { container } = render(<DigestPanel runs={runs} />);
    const nodes = [...container.querySelectorAll(".gl-digest-line")];
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes[0].className).not.toBe(nodes[1].className);
  });

  it("still renders for a suite whose whole history is older than a week", () => {
    // There IS history, so the panel belongs — and "nothing ran this week" is
    // the single most useful thing it can say about a suite that has gone
    // quiet. Hiding it here would hide exactly that.
    const stale = [run({ startedAt: Date.now() - 30 * 86_400_000 })];
    const { container } = render(<DigestPanel runs={stale} />);
    expect(container.querySelector(".gl-digest")).not.toBeNull();
    expect(container.textContent).toContain("Nothing ran this week.");
  });
});
