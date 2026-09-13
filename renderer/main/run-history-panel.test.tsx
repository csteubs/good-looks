// The console's History tab: which runs a row is written for, what an amber
// fact looks like on one, and which pictures the strip shows.
//
// The failure modes here are the quiet kind this repo keeps meeting: a list
// that renders oldest-first reads as "it never runs any more"; a bookkeeping
// row counted as a run makes the retry story wrong; and a frame read from the
// WRONG run's directory looks exactly like a frame read from the right one —
// which is why the readShot spy asserts the run id it was handed.
//
// WHICH FRAME is the same shape of failure and the reason this panel changed:
// every frame renders as the same `src` in jsdom, so a panel showing the run's
// FIRST frame — captured before the page has painted, i.e. blank white for
// every test in the library — is indistinguishable from one showing its last
// unless the test asserts the file name and the caption.

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { RunHistoryPanel, whenLabel } from "./run-history-panel";
import { clearVisualFrame, consumeVisualFrame } from "./visual-intents";
import type {
  ReplayStep,
  RunRecord,
  RunReplay,
  RunReplaySummary,
} from "../lib/recorder-types";

const h = vi.hoisted(() => ({
  replays: [] as unknown[],
  replay: null as unknown,
  readShot: vi.fn(async (..._args: string[]) => "data:image/png;base64,frame"),
}));

vi.mock("../lib/api", () => ({
  api: {
    artifacts: {
      list: async () => h.replays,
      getReplay: async () => h.replay,
      readShot: (testId: string, runId: string, file: string) => h.readShot(testId, runId, file),
    },
  },
}));

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "r1",
    testId: "t1",
    testName: "T",
    url: "https://x.test",
    status: "passed",
    exitCode: 0,
    startedAt: 1_000,
    finishedAt: 2_000,
    durationMs: 12_400,
    logFile: "/tmp/r.log",
    logBytes: 1,
    ...over,
  } as RunRecord;
}

function summary(over: Partial<RunReplaySummary> = {}): RunReplaySummary {
  return {
    testId: "t1",
    runId: "r1",
    testName: "T",
    status: "passed",
    startedAt: 1_000,
    finishedAt: 2_000,
    stepCount: 3,
    failedIndex: null,
    changedSteps: 0,
    ...over,
  };
}

function shotStep(i: number, screenshot: string | null = `${i}.png`): ReplayStep {
  return {
    index: i,
    stepId: `s${i}`,
    label: `click thing ${i}`,
    type: "click",
    status: "passed",
    screenshot,
  } as ReplayStep;
}

function replay(steps: ReplayStep[], over: Partial<RunReplay> = {}): RunReplay {
  return {
    testId: "t1",
    runId: "r9",
    testName: "T",
    status: "passed",
    startedAt: 9_000,
    finishedAt: 10_000,
    failedIndex: null,
    steps,
    ...over,
  } as RunReplay;
}

function renderPanel(props: Partial<React.ComponentProps<typeof RunHistoryPanel>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RunHistoryPanel testId="t1" runs={[]} {...props} />
    </QueryClientProvider>,
  );
}

const rows = () => [...document.querySelectorAll('[data-gl="history-run"]')];

beforeEach(() => {
  h.replays = [];
  h.replay = null;
  h.readShot.mockClear();
  // Module state outlives a test: a request left behind by one moves the next
  // test's Visual view to a run it never asked for.
  clearVisualFrame();
});

describe("the run list", () => {
  it("lists this test's runs newest first, with the verdict word toned", () => {
    renderPanel({
      runs: [
        run({ id: "r-old", startedAt: 1_000, status: "passed" }),
        run({ id: "r-new", startedAt: 2_000, status: "failed" }),
        run({ id: "r-other", testId: "t2", startedAt: 3_000 }),
      ],
    });
    expect(rows()).toHaveLength(2);
    expect(rows()[0].getAttribute("data-status")).toBe("failed");
    expect(rows()[1].getAttribute("data-status")).toBe("passed");
    expect(screen.getByText("FAIL").className).toContain("text-support-red");
    expect(screen.getByText("PASS").className).toContain("text-support-green");
  });

  it("skips baseline-update bookkeeping rows, same rule as the summary", () => {
    renderPanel({
      runs: [run({ id: "r-real" }), run({ id: "r-book", kind: "baseline-update" })],
    });
    expect(rows()).toHaveLength(1);
  });

  it("marks the passes that are worth less than they look", () => {
    renderPanel({
      runs: [
        run({ healedSteps: 2, passedOnRetry: true, a11yNewSteps: 1, shotCount: 6 }),
      ],
    });
    const row = rows()[0];
    expect(row.textContent).toContain("healed 2");
    expect(row.textContent).toContain("retry");
    expect(row.textContent).toContain("a11y 1");
    expect(row.textContent).toContain("6");
  });

  it("says what an empty history means instead of rendering nothing", () => {
    renderPanel();
    expect(screen.getByText("No runs recorded yet")).toBeTruthy();
  });
});

describe("the latest screenshot", () => {
  it("shows the latest captured run's LAST frame, read from THAT run's directory", async () => {
    h.replays = [
      summary({ runId: "r-old", startedAt: 1_000 }),
      summary({ runId: "r9", startedAt: 9_000 }),
      summary({ testId: "t2", runId: "r-not-mine", startedAt: 99_000 }),
    ];
    h.replay = replay([shotStep(0), shotStep(1, null), shotStep(2)]);
    renderPanel({ runs: [run()] });
    // One frame, and it is the run's last CAPTURED step — step 2 captured
    // nothing, so the answer is step 3 rather than "the last step".
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(1));
    expect(screen.getByAltText("Step 3 · click thing 2")).toBeTruthy();
    // The wrong run's picture looks identical to the right one — the argument
    // is the only place the difference exists.
    expect(h.readShot).toHaveBeenCalledWith("t1", "r9", "2.png");
    // THE BUG THIS PANEL CHANGED FOR: frame 1 is captured before the page under
    // test has painted, so showing it meant showing a blank rectangle.
    expect(h.readShot).not.toHaveBeenCalledWith("t1", "r9", "0.png");
  });

  it("names the step the frame is of, and how many came before it", async () => {
    h.replays = [summary({ runId: "r9", startedAt: 9_000 })];
    h.replay = replay(Array.from({ length: 10 }, (_, i) => shotStep(i)));
    renderPanel({ runs: [run()] });
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(1));
    expect(screen.getByText("+9 earlier in the Visual view")).toBeTruthy();
    // A picture of the last step only reads as the last step if the panel says
    // which step it is.
    expect(document.body.textContent).toContain("Step 10 · click thing 9");
  });

  it("counts nothing earlier when the run captured one frame", async () => {
    h.replays = [summary({ runId: "r9", startedAt: 9_000 })];
    h.replay = replay([shotStep(0)]);
    renderPanel({ runs: [run()] });
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(1));
    expect(screen.queryByText(/earlier in the Visual view/)).toBeNull();
  });

  it("opens the Visual view from the link, on the run and frame it was showing", async () => {
    const onOpenVisual = vi.fn();
    h.replays = [
      summary({ runId: "r-old", startedAt: 1_000 }),
      summary({ runId: "r9", startedAt: 9_000 }),
    ];
    h.replay = replay([shotStep(0), shotStep(1)]);
    renderPanel({ runs: [run()], onOpenVisual });
    const link = await screen.findByRole("button", { name: "Visual view →" });
    link.click();
    expect(onOpenVisual).toHaveBeenCalledTimes(1);
    // Navigating alone is not enough: the Visual view opens on the NEWEST
    // captured run at its failure, so a click on this test's last frame would
    // otherwise land on some other test's run.
    expect(consumeVisualFrame()).toEqual({ testId: "t1", runId: "r9", stepId: "s1" });
  });

  it("opens the same place when the frame itself is clicked", async () => {
    const onOpenVisual = vi.fn();
    h.replays = [summary({ runId: "r9", startedAt: 9_000 })];
    h.replay = replay([shotStep(0), shotStep(1)]);
    renderPanel({ runs: [run()], onOpenVisual });
    const frame = await screen.findByRole("button", {
      name: "Open this frame in the Visual view",
    });
    frame.click();
    expect(onOpenVisual).toHaveBeenCalledTimes(1);
    expect(consumeVisualFrame()).toEqual({ testId: "t1", runId: "r9", stepId: "s1" });
  });

  it("says how to get screenshots when no run has captured any", () => {
    renderPanel({ runs: [run()] });
    expect(screen.getByText(/No screenshots yet/)).toBeTruthy();
  });
});

describe("whenLabel", () => {
  const now = Date.UTC(2026, 8, 1, 12, 0, 0);

  it("stays relative while the reader can do the arithmetic", () => {
    expect(whenLabel(now - 10_000, now)).toBe("just now");
    expect(whenLabel(now - 12 * 60_000, now)).toBe("12m ago");
    expect(whenLabel(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(whenLabel(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("switches to the date past a week, where 'ago' becomes calendar math", () => {
    expect(whenLabel(now - 40 * 86_400_000, now)).toMatch(/\w{3}/);
    expect(whenLabel(now - 40 * 86_400_000, now)).not.toContain("ago");
  });
});
