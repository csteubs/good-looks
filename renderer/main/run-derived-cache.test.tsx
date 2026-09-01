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
    agent: {
      getRun: async () => ({ runId: null, running: false, state: "idle", events: [] }),
    },
    runs: {
      list: counted("runs", () => []),
      totals: counted("run-totals", () => ({
        runs: 0,
        passed: 0,
        failed: 0,
        retained: 0,
        pruned: 0,
      })),
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
    propagation: {
      listAll: counted("propagations", () => []),
      list: async () => [],
      accept: async () => null,
      dismiss: async () => null,
      revert: async () => null,
      evidence: async () => null,
    },
    artifacts: { list: counted("replays", () => []) },
    a11y: { rollup: counted("a11y-rollup", () => null) },
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
  // The lifetime run counts behind Stats' KPI cards. A separate key from
  // ["runs"] because it answers a question that list cannot — the list is
  // capped — and it moves on exactly the same event.
  useQuery({
    queryKey: ["run-totals"],
    queryFn: counted("run-totals", () => ({
      runs: 0,
      passed: 0,
      failed: 0,
      retained: 0,
      pruned: 0,
    })),
  });
  useQuery({ queryKey: ["flake"], queryFn: counted("flake", () => null) });
  useQuery({ queryKey: ["heals", "all"], queryFn: counted("heals", () => journal) });
  useQuery({ queryKey: ["replays"], queryFn: counted("replays", () => []) });
  useQuery({
    queryKey: ["metrics", "stepHealth"],
    queryFn: counted("metrics", () => ({ available: true, rows: [] })),
  });
  useQuery({ queryKey: ["captureOverhead"], queryFn: counted("captureOverhead", () => null) });
  // The Stats a11y dashboard's rollup. It is read from a ROUTE — mounted only
  // while you stand on that category — which is precisely the shape that made
  // three tiles never refresh, so it belongs in the list and therefore here.
  useQuery({ queryKey: ["a11y-rollup"], queryFn: counted("a11y-rollup", () => null) });
  // Cross-test proposals: the runner sweeps AT TEARDOWN, before runs:changed,
  // so the push that announces the run is also the one that must refresh the
  // proposals every badge counts.
  useQuery({ queryKey: ["propagations", "all"], queryFn: counted("propagations", () => []) });
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
  it("refetches every one of them when a run finishes", async () => {
    renderWith(<Consumers />);
    await waitFor(() => expect(calls.metrics).toBe(1));
    const before = { ...calls };

    emit("runs:changed", {});

    // Named individually rather than looped, so a failure says WHICH cache went
    // stale — "expected 1 to be 2" over an anonymous key is a bug report that
    // costs an hour.
    await waitFor(() => expect(calls.runs).toBe(before.runs + 1));
    await waitFor(() => expect(calls["run-totals"]).toBe(before["run-totals"] + 1));
    await waitFor(() => expect(calls.flake).toBe(before.flake + 1));
    await waitFor(() => expect(calls.heals).toBe(before.heals + 1));
    await waitFor(() => expect(calls.replays).toBe(before.replays + 1));
    await waitFor(() => expect(calls.metrics).toBe(before.metrics + 1));
    await waitFor(() => expect(calls.captureOverhead).toBe(before.captureOverhead + 1));
    await waitFor(() => expect(calls["a11y-rollup"]).toBe(before["a11y-rollup"] + 1));
    await waitFor(() => expect(calls.propagations).toBe(before.propagations + 1));
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

  it("refetches proposals on their own push, without dragging the run caches", async () => {
    // The service's non-run writers (a sweep off a trainer heal, a dismiss in
    // another window) announce themselves on `propagations:changed`. This runs
    // on the same real bus as the rest of the file because the inert-stub trap
    // in the header is exactly how this subscription would rot invisibly.
    renderWith(<Consumers />);
    await waitFor(() => expect(calls.propagations).toBe(1));
    const before = { ...calls };

    emit("propagations:changed", null);

    await waitFor(() => expect(calls.propagations).toBe(before.propagations + 1));
    expect(calls.runs).toBe(before.runs);
    expect(calls.heals).toBe(before.heals);
  });

  it("keeps the list and the exported keys in step", () => {
    // Guards the loop above from rotting: a key added to RUN_DERIVED_KEYS
    // fails this until it has a consumer in this file.
    expect(RUN_DERIVED_KEYS.map((k) => k[0]).sort()).toEqual(
      [
        "a11y-rollup",
        "captureOverhead",
        "flake",
        "heals",
        "metrics",
        "propagations",
        "replays",
        "run-totals",
        "runs",
      ].sort(),
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
