// The five panels render the facts they were given, and — the part that would
// be silent if wrong — the right TONE.
//
// The state decision itself is tested in renderer/lib/run-summary.test.ts. What
// is here is everything a wrong render would say out loud: a healed pass shown
// as an ordinary pass, an unreviewed heal with no way to reach the review, a
// flaky recovery presented as a fix.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import type { HealEntry, RunRecord } from "../lib/recorder-types";
import { summariseRun } from "../lib/run-summary";
import type { RunSummary } from "../lib/run-summary";
import { chipFor } from "./run-output";
import { RunSummaryPanel } from "./run-summary-panel";

const T = "t1";

function run(over: Partial<RunRecord> & { id: string; startedAt: number }): RunRecord {
  return {
    testId: T,
    testName: "Login",
    url: "https://example.com",
    status: "passed",
    exitCode: 0,
    finishedAt: over.startedAt + 1000,
    durationMs: 1000,
    logFile: "/tmp/x.log",
    logBytes: 1,
    ...over,
  };
}

function summarise(over: {
  runs?: RunRecord[];
  heals?: HealEntry[];
  stepCount?: number;
  live?: Parameters<typeof summariseRun>[0]["live"];
  now?: number;
}): RunSummary {
  return summariseRun({
    testId: T,
    runs: over.runs ?? [],
    heals: over.heals ?? [],
    stepCount: over.stepCount ?? 4,
    live: over.live ?? null,
    now: over.now ?? 0,
  });
}

const panel = () => document.querySelector('[data-gl="run-summary"]') as HTMLElement | null;

describe("never", () => {
  it("says so, and says what running it would do", () => {
    render(<RunSummaryPanel summary={summarise({ stepCount: 4 })} />);
    expect(panel()?.dataset.state).toBe("never");
    expect(screen.getByText(/never run/i)).toBeTruthy();
    expect(screen.getByText(/executes 4 steps/i)).toBeTruthy();
  });

  it("does not promise a run when there are no steps", () => {
    render(<RunSummaryPanel summary={summarise({ stepCount: 0 })} />);
    expect(screen.getByText(/no steps to run yet/i)).toBeTruthy();
  });

  it("is not a result, so it carries no tone", () => {
    // Same contract `Verdict` uses for "not enough evidence": a state that is
    // real and is not an outcome gets the neutral dot.
    expect(chipFor(summarise({})).tone).toBeUndefined();
  });
});

describe("running", () => {
  const live = summarise({
    stepCount: 5,
    live: {
      running: true,
      code: null,
      startedAt: 1_000,
      stepStatus: { 0: "passed", 1: "passed", 2: "running" },
    },
    now: 13_000,
  });

  it("answers how far in, not that it is still going", () => {
    render(<RunSummaryPanel summary={live} />);
    expect(screen.getByText(/Step 3 of 5/)).toBeTruthy();
    expect(screen.getByText(/12s elapsed/i)).toBeTruthy();
  });

  it("fills the bar in proportion to the steps that reported", () => {
    render(<RunSummaryPanel summary={live} />);
    const fill = document.querySelector(".gl-run-progress-fill") as HTMLElement;
    expect(fill.style.width).toBe("40%");
  });

  it("never divides by a step count of zero", () => {
    // A test whose steps were deleted mid-run. NaN width renders as full, which
    // reads as finished — the one thing a progress bar must never say wrongly.
    render(
      <RunSummaryPanel
        summary={summarise({
          stepCount: 0,
          live: { running: true, code: null, startedAt: 0, stepStatus: {} },
          now: 1_000,
        })}
      />,
    );
    const fill = document.querySelector(".gl-run-progress-fill") as HTMLElement;
    expect(fill.style.width).toBe("0%");
  });

  it("says when steps have already failed under soft assertions", () => {
    render(
      <RunSummaryPanel
        summary={summarise({
          stepCount: 5,
          live: { running: true, code: null, startedAt: 0, stepStatus: { 0: "failed" } },
          now: 0,
        })}
      />,
    );
    expect(screen.getByText(/1 step has already failed/i)).toBeTruthy();
  });
});

describe("passed", () => {
  const withHistory = summarise({
    runs: [
      run({ id: "r1", startedAt: 1, durationMs: 2_000 }),
      run({ id: "r2", startedAt: 2, durationMs: 4_000, captureArtifacts: true }),
    ],
    stepCount: 6,
    live: { running: false, code: 0, startedAt: 0, stepStatus: {}, recordId: "r2" },
  });

  it("says what held, and measures the duration against the median", () => {
    render(<RunSummaryPanel summary={withHistory} />);
    expect(panel()?.dataset.state).toBe("passed");
    expect(screen.getByText(/6 steps held/i)).toBeTruthy();
    const temp = document.querySelector('[data-gl="temp"]') as HTMLElement;
    expect(temp.getAttribute("title")).toContain("vs median");
  });

  it("turns the temp off on a first run rather than colouring a fabricated median", () => {
    render(
      <RunSummaryPanel
        summary={summarise({
          runs: [run({ id: "r1", startedAt: 1, durationMs: 2_000 })],
          live: { running: false, code: 0, startedAt: 0, stepStatus: {}, recordId: "r1" },
        })}
      />,
    );
    expect((document.querySelector('[data-gl="temp"]') as HTMLElement).dataset.mode).toBe("off");
    expect(screen.getByText(/nothing to compare its timing against/i)).toBeTruthy();
  });

  it("surfaces new accessibility violations, which never fail a run", () => {
    render(
      <RunSummaryPanel
        summary={summarise({
          runs: [run({ id: "r1", startedAt: 1, a11yChecks: 6, a11yNewSteps: 2 })],
          live: { running: false, code: 0, startedAt: 0, stepStatus: {}, recordId: "r1" },
        })}
      />,
    );
    expect(screen.getByText(/2 steps found accessibility violations/i)).toBeTruthy();
  });

  it("is the only one of the five that earns the pass tone", () => {
    expect(chipFor(withHistory)).toEqual({ label: "Passed", tone: "phos" });
  });
});

describe("healed", () => {
  const heals: HealEntry[] = [
    {
      id: "h1",
      testId: T,
      stepId: "s1",
      stepIndex: 0,
      stepLabel: "click Sign in",
      source: "run",
      runId: "r1",
      originalLocator: { k: "css", v: "#signin" },
      appliedLocator: { k: "testid", v: "signin" },
      candidates: [],
      applied: true,
      status: "pending",
      at: 5,
    },
  ];
  const healed = summarise({
    runs: [run({ id: "r1", startedAt: 1, healedSteps: 1, healFailedSteps: 0 })],
    heals,
    live: { running: false, code: 0, startedAt: 0, stepStatus: {}, recordId: "r1" },
  });

  it("is AMBER even though the run passed", () => {
    // The load-bearing claim of this whole feature. A mis-heal usually
    // succeeds — clicking the wrong button rarely throws — so a healed pass is
    // the run most worth distrusting and the one that looks most trustworthy.
    // Reporting it as a plain pass is the app agreeing with the mis-heal.
    expect(chipFor(healed)).toEqual({ label: "Healed", tone: "amber" });
    render(<RunSummaryPanel summary={healed} />);
    expect(panel()?.dataset.state).toBe("healed");
  });

  it("shows what was substituted, both sides, in the app's one locator spelling", () => {
    render(<RunSummaryPanel summary={healed} />);
    expect(screen.getByText('getByTestId("signin")')).toBeTruthy();
    expect(screen.getByText('locator("#signin")')).toBeTruthy();
  });

  it("says Unknown, not 0, when the run predates healFailedSteps", () => {
    render(
      <RunSummaryPanel
        summary={summarise({
          runs: [run({ id: "r1", startedAt: 1, healedSteps: 1 })],
          heals,
          live: { running: false, code: 0, startedAt: 0, stepStatus: {}, recordId: "r1" },
        })}
      />,
    );
    expect(screen.getByText("Unknown")).toBeTruthy();
  });

  it("offers the review, and only while something is unreviewed", () => {
    const onReview = vi.fn();
    const { unmount } = render(<RunSummaryPanel summary={healed} onReview={onReview} />);
    fireEvent.click(screen.getByRole("button", { name: /review 1 change/i }));
    expect(onReview).toHaveBeenCalledTimes(1);
    unmount();

    const reviewed = summarise({
      runs: [run({ id: "r1", startedAt: 1, healedSteps: 1 })],
      heals: [{ ...heals[0], status: "accepted" }],
      live: { running: false, code: 0, startedAt: 0, stepStatus: {}, recordId: "r1" },
    });
    render(<RunSummaryPanel summary={reviewed} onReview={onReview} />);
    expect(screen.queryByRole("button", { name: /review/i })).toBeNull();
  });

  it("says the journal is empty rather than rendering an empty list", () => {
    // The counter is on the run record and the rows are in the journal, which
    // retention prunes independently. A bare list reads as "nothing changed".
    render(
      <RunSummaryPanel
        summary={summarise({
          runs: [run({ id: "r1", startedAt: 1, healedSteps: 2 })],
          live: { running: false, code: 0, startedAt: 0, stepStatus: {}, recordId: "r1" },
        })}
      />,
    );
    expect(screen.getByText(/journal has no rows for this run/i)).toBeTruthy();
  });
});

describe("retry", () => {
  const base = [run({ id: "r1", startedAt: 1, status: "failed", exitCode: 1 })];

  it("names what was different, and does not call it flake", () => {
    const s = summarise({
      runs: [...base, run({ id: "r2", startedAt: 2, runBrowser: "firefox" })],
      live: { running: false, code: 0, startedAt: 0, stepStatus: {}, recordId: "r2" },
    });
    render(<RunSummaryPanel summary={s} />);
    expect(panel()?.dataset.state).toBe("retry");
    expect(screen.getByText(/after failing last time/i)).toBeTruthy();
    expect(screen.getByText("Chromium")).toBeTruthy();
    expect(screen.getByText("Firefox")).toBeTruthy();
    expect(chipFor(s)).toEqual({ label: "Recovered", tone: "phos" });
  });

  it("calls it flake, in amber, when nothing this app records changed", () => {
    // The reading a user is least likely to reach on their own, and the one
    // that decides whether they go looking for a fix that does not exist.
    const s = summarise({
      runs: [...base, run({ id: "r2", startedAt: 2 })],
      live: { running: false, code: 0, startedAt: 0, stepStatus: {}, recordId: "r2" },
    });
    render(<RunSummaryPanel summary={s} />);
    expect(screen.getByText(/nothing was different/i)).toBeTruthy();
    expect(screen.getByText(/flake rather than a fix/i)).toBeTruthy();
    expect(chipFor(s)).toEqual({ label: "Recovered", tone: "amber" });
  });
});

describe("failed", () => {
  it("renders nothing — RunTriage is that state's panel", () => {
    // A summary above the diagnosis would put a description of the failure over
    // the explanation OF the failure.
    const { container } = render(
      <RunSummaryPanel summary={{ state: "failed", recordId: "r1" }} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("the chip's six states are six distinct readings", () => {
  it("gives every state its own word", () => {
    const words = [
      chipFor({ state: "never", stepCount: 0 }),
      chipFor({ state: "running", done: 0, total: 1, failedSoFar: 0, elapsedMs: 0 }),
      chipFor({
        state: "passed",
        stepCount: 1,
        durationMs: 1,
        medianMs: null,
        deltaPct: null,
        captured: false,
        a11yChecks: 0,
        a11yNewSteps: 0,
        aiChecksPassed: 0,
        aiChecksFailed: 0,
        aiChecksUnevaluated: 0,
      }),
      chipFor({
        state: "healed",
        healedSteps: 1,
        healFailedSteps: 0,
        entries: [],
        pendingReview: 0,
      }),
      chipFor({
        state: "retry",
        attempt: 0,
        previous: run({ id: "r1", startedAt: 1, status: "failed", exitCode: 1 }),
        differences: [{ label: "Browser", before: "a", after: "b" }],
        durationMs: 1,
        stepCount: 1,
      }),
      chipFor({ state: "failed" }),
    ].map((c) => c.label);
    expect(new Set(words).size).toBe(6);
  });

  it("keeps red for the one state that actually failed", () => {
    const red = [
      chipFor({ state: "never", stepCount: 0 }),
      chipFor({
        state: "healed",
        healedSteps: 1,
        healFailedSteps: 0,
        entries: [],
        pendingReview: 0,
      }),
      chipFor({ state: "failed" }),
    ].filter((c) => c.tone === "red");
    expect(red).toEqual([{ label: "Failed", tone: "red" }]);
  });
});
