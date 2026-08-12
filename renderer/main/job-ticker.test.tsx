// The job ticker in the top strip. REDESIGN §6.8.
//
// The reading itself is decided in `renderer/lib/job-ticker.ts` and tested
// there. What is here is the half that file cannot see: that an idle app renders
// NOTHING (a slot that fills when there is nothing to say is the whole thing
// §6.8 was told not to build), that the held failure actually goes away on its
// own, and that clicking it lands somewhere.
//
// The tick is the part with a real failure mode. Every other transition arrives
// as a push and re-renders on its own; a held failure has to expire on a clock,
// and without one it sits in the strip until some unrelated render happens to
// clear it — which on an idle app is never, and which no test that only checks
// the pure reading would notice.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { BatchState, TestRecord } from "../lib/recorder-types";
import { FAILURE_HOLD_MS } from "../lib/job-ticker";
import type { RunInfo } from "./recorder-store";
import { JobTicker } from "./job-ticker";

let runs: Record<string, RunInfo> = {};
let liveBatch: BatchState | null = null;
const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("../lib/api", () => ({
  api: {
    tests: {
      list: async (): Promise<TestRecord[]> => [
        { id: "t1", name: "Checkout", url: "https://x", createdAt: 0, updatedAt: 0, steps: [] },
        { id: "t2", name: "Login", url: "https://x", createdAt: 0, updatedAt: 0, steps: [] },
      ] as TestRecord[],
    },
  },
}));

vi.mock("./recorder-store", () => ({
  useRecorder: () => ({ runs, liveBatch }),
}));

function runInfo(over: Partial<RunInfo> = {}): RunInfo {
  return { lines: [], running: true, code: null, stepStatus: {}, startedAt: Date.now(), ...over };
}

function renderTicker() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <JobTicker />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  runs = {};
  liveBatch = null;
  navigate.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("an idle app", () => {
  it("renders nothing at all", () => {
    // The empty slot `top-strip.tsx` shipped in A4 was a promise: this fills it
    // only when there is something to say.
    const { container } = renderTicker();
    expect(container.querySelector(".gl-ticker")).toBeNull();
  });
});

describe("a run in flight", () => {
  it("names the test, once the name has loaded", () => {
    runs = { t1: runInfo() };
    renderTicker();
    // Waits for the ["tests"] query — before it resolves the ticker still
    // renders, saying "Running" without a name rather than "Running undefined".
    return waitFor(() => {
      expect(screen.getByRole("button").textContent).toContain("Running Checkout");
    });
  });

  it("takes the cyan 'live' tone rather than an outcome hue", async () => {
    // A run in flight has no outcome yet; green or amber would be the app
    // guessing one.
    runs = { t1: runInfo() };
    renderTicker();
    await waitFor(() => {
      expect(screen.getByRole("button").dataset.tone).toBe("run");
    });
  });

  it("opens the test it names", async () => {
    runs = { t1: runInfo() };
    renderTicker();
    await waitFor(() => screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button"));
    expect(navigate).toHaveBeenCalledWith({ to: "/test/$id", params: { id: "t1" } });
  });

  it("offers no destination for several at once, and says so by being inert", async () => {
    // "3 running" has nowhere single to go, and guessing one would be a lie
    // about what the user is about to look at.
    runs = { t1: runInfo(), t2: runInfo(), t3: runInfo() };
    renderTicker();
    await waitFor(() => {
      expect(screen.getByRole("button").textContent).toContain("3 running");
    });
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
  });
});

describe("a batch", () => {
  it("reports the batch and opens the batch screen", async () => {
    liveBatch = {
      batchId: "b1",
      running: true,
      startedAt: 0,
      currentIndex: 0,
      results: [],
      stopped: false,
      summary: { total: 8, passed: 3, failed: 0, skipped: 0, ok: true, durationMs: 0 },
    };
    renderTicker();
    await waitFor(() => {
      expect(screen.getByRole("button").textContent).toContain("Batch 3/8");
    });
    fireEvent.click(screen.getByRole("button"));
    expect(navigate).toHaveBeenCalledWith({ to: "/batch" });
  });
});

describe("a held failure", () => {
  it("leads with the state, so truncation cannot eat the point", async () => {
    runs = { t2: runInfo({ running: false, code: 1, finishedAt: Date.now() }) };
    renderTicker();
    await waitFor(() => {
      expect(screen.getByRole("button").textContent).toContain("Failed: Login");
    });
    expect(screen.getByRole("button").dataset.tone).toBe("fail");
  });

  it("EXPIRES ON ITS OWN, with nothing else happening", async () => {
    // The reason this component owns an interval at all. Every other transition
    // arrives as a push; a hold ends on a clock, and without a tick it would sit
    // in the strip of an idle app forever.
    vi.useFakeTimers();
    runs = { t2: runInfo({ running: false, code: 1, finishedAt: Date.now() }) };
    const { container } = renderTicker();
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector(".gl-ticker")).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(FAILURE_HOLD_MS + 2_000);
    });
    expect(container.querySelector(".gl-ticker")).toBeNull();
  });
});
