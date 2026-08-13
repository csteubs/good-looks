// A finished run refreshes every cache it wrote — from wherever you're standing.
//
// WHY THIS FILE EXISTS RATHER THAN AN ASSERTION IN stats-view.test.tsx. Every
// component test in this repo mocks `../lib/api`, and the natural way to mock
// the push bridge is `on: () => () => {}` — which is exactly what
// stats-view.test.tsx does. That stub makes the subscription INERT, so the
// whole live-refresh path is invisible to the suite: the Stats board shipped
// with three of its six tiles never refreshing after a run, and every test
// passed the entire time. So these tests run a real bus and dispatch a real
// `runs:changed`.
//
// The property is not "invalidateQueries was called". It is "the query function
// ran again" — an invalidation aimed at the wrong key is still a call, and
// counting calls is how you write a test that passes against the bug.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

import type { HealListEntry, RecorderState } from "../lib/recorder-types";
import { RUN_DERIVED_KEYS } from "../lib/run-derived-cache";
import { RecorderProvider } from "./recorder-store";
import { HealsView } from "./heals-view";

// ── A real push bus ───────────────────────────────────────────────────
type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

function emit(channel: string, payload: unknown) {
  act(() => {
    for (const h of handlers.get(channel) ?? []) h(payload);
  });
}

/** How many times each query function has actually run. */
const calls: Record<string, number> = {};
function counted<T>(key: string, value: () => T) {
  return async () => {
    calls[key] = (calls[key] ?? 0) + 1;
    return value();
  };
}

let journal: HealListEntry[] = [];

function baseState(): RecorderState {
  return { recording: false, paused: false, steps: [], testId: null } as unknown as RecorderState;
}

vi.mock("../lib/api", () => ({
  api: {
    on: (channel: string, cb: Handler) => {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel)!.add(cb);
      return () => handlers.get(channel)!.delete(cb);
    },
    runs: {
      list: counted("runs", () => []),
      flake: counted("flake", () => ({
        tests: [],
        analysedTests: 0,
        windowRuns: 0,
        windowCap: 200,
      })),
      captureOverhead: counted("captureOverhead", () => null),
    },
    heals: {
      listAll: counted("heals", () => journal),
      accept: async () => null,
      revert: async () => null,
      remove: async () => ({ removed: 1 }),
      clearAllSettled: async () => ({ removed: 0 }),
    },
    scriptChanges: {
      listAll: counted("script-changes", () => []),
      accept: async () => null,
      revert: async () => null,
      remove: async () => ({ removed: 1 }),
      clearAllSettled: async () => ({ removed: 0 }),
    },
    artifacts: { list: counted("replays", () => []) },
    metrics: {
      stepHealth: counted("metrics", () => ({ available: true, rows: [] })),
      slowness: async () => null,
      divergence: async () => null,
    },
    recorder: {
      getState: async () => baseState(),
      getSteps: async () => [],
      getDebugLogs: async () => [],
    },
    batch: { status: async () => null },
  },
}));

/** One consumer per run-derived key, all mounted at once — the point being that
 *  none of them is the Stats view. A cache is shared across screens, so the
 *  refresh has to reach a reader that is nowhere near the event. */
function Consumers() {
  useQuery({ queryKey: ["runs"], queryFn: counted("runs", () => []) });
  useQuery({ queryKey: ["flake"], queryFn: counted("flake", () => null) });
  useQuery({ queryKey: ["heals", "all"], queryFn: counted("heals", () => journal) });
  useQuery({ queryKey: ["replays"], queryFn: counted("replays", () => []) });
  useQuery({
    queryKey: ["metrics", "stepHealth"],
    queryFn: counted("metrics", () => ({ available: true, rows: [] })),
  });
  useQuery({ queryKey: ["captureOverhead"], queryFn: counted("captureOverhead", () => null) });
  return null;
}

function renderWith(children: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RecorderProvider>{children}</RecorderProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  handlers.clear();
  for (const k of Object.keys(calls)) delete calls[k];
  journal = [];
});

describe("run-derived caches", () => {
  it("refetches all six when a run finishes", async () => {
    renderWith(<Consumers />);
    await waitFor(() => expect(calls.metrics).toBe(1));
    const before = { ...calls };

    emit("runs:changed", {});

    // Named individually rather than looped, so a failure says WHICH cache went
    // stale — "expected 1 to be 2" over an anonymous key is a bug report that
    // costs an hour.
    await waitFor(() => expect(calls.runs).toBe(before.runs + 1));
    await waitFor(() => expect(calls.flake).toBe(before.flake + 1));
    await waitFor(() => expect(calls.heals).toBe(before.heals + 1));
    await waitFor(() => expect(calls.replays).toBe(before.replays + 1));
    await waitFor(() => expect(calls.metrics).toBe(before.metrics + 1));
    await waitFor(() => expect(calls.captureOverhead).toBe(before.captureOverhead + 1));
  });

  it("refetches them when a batch finishes, not only a single run", async () => {
    // A Routine firing on a schedule ends as `batch:done`. Its members each push
    // `runs:changed` too, but a batch that was stopped — or blocked before its
    // first test — ends with no member push at all.
    renderWith(<Consumers />);
    await waitFor(() => expect(calls.flake).toBe(1));

    emit("batch:done", { stopped: true, summary: { total: 0, failed: 0, passed: 0 } });

    await waitFor(() => expect(calls.flake).toBe(2));
    await waitFor(() => expect(calls.heals).toBe(2));
    await waitFor(() => expect(calls.replays).toBe(2));
  });

  it("leaves caches no run writes alone", async () => {
    // The negative half. `["script-changes"]` is only ever written by a user
    // action, and refetching it after every run would be waste dressed up as
    // safety — so the list is a claim about what a run touches, not a catch-all.
    renderWith(<HealsView />);
    await waitFor(() => expect(calls["script-changes"]).toBe(1));

    emit("runs:changed", {});

    await waitFor(() => expect(calls.heals).toBe(2));
    expect(calls["script-changes"]).toBe(1);
  });

  it("keeps the list and the exported keys in step", () => {
    // Guards the loop above from rotting: if a seventh key is added to
    // RUN_DERIVED_KEYS, this fails until it has a consumer in this file.
    expect(RUN_DERIVED_KEYS.map((k) => k[0]).sort()).toEqual(
      ["captureOverhead", "flake", "heals", "metrics", "replays", "runs"].sort(),
    );
  });
});

describe("the Heals view", () => {
  it("shows a heal journalled by a run, without being remounted", async () => {
    // THE BUG THIS PINS. Auto-Heal journals a heal mid-run
    // (playwright-runner.ts, source: "run"), and nothing invalidated ["heals"]
    // except the user's own accept/revert — so the one screen whose job is to
    // show new heals showed nothing until you navigated away and back.
    renderWith(<HealsView />);
    await waitFor(() => expect(calls.heals).toBe(1));
    expect(screen.queryByText(/submit-v1/)).toBeNull();

    journal = [
      {
        id: "h1",
        testId: "t1",
        testName: "Checkout",
        stepId: "s1",
        stepIndex: 0,
        stepLabel: 'getByTestId("submit-v1").click()',
        source: "run",
        runId: "r1",
        originalLocator: { k: "testid", v: "submit-v1" },
        appliedLocator: { k: "testid", v: "submit-v2" },
        candidates: [],
        applied: true,
        status: "pending",
        at: 1_700_000_000_000,
      } as HealListEntry,
    ];

    emit("runs:changed", {});

    expect(await screen.findByText(/submit-v1/)).toBeTruthy();
  });
});
