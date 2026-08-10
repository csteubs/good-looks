// The home screen's three readouts, and the two entry points.
//
// The readouts are the risk. They are the first numbers anyone sees when the
// app opens, they are derived rather than fetched, and a wrong one is silent —
// nothing throws, nothing looks broken, and "12% green" reads as a fact about
// the week rather than as a bug in a filter. The empty case is worse still: 0%
// and "nothing ran" are the same pixels, and one of them sends someone looking
// for a failure that never happened.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { HealListEntry, RunRecord, TestRecord } from "../lib/recorder-types";
import { HomeView, greenRate } from "./home-view";

let tests: TestRecord[] = [];
let runs: RunRecord[] = [];
let heals: HealListEntry[] = [];

vi.mock("../lib/api", () => ({
  api: {
    tests: { list: async () => tests },
    runs: { list: async () => runs },
    heals: { listAll: async () => heals },
    recorder: { getSettings: async () => ({ disabledAestheticEnhancements: [] }) },
  },
}));

// The loader draws an SVG with its own animation loop, and neither is what this
// file is about. Its Settings toggle is covered in appearance-pane.test.tsx.
vi.mock("./black-hole-loader", () => ({ BlackHoleLoader: () => null }));
// Both dialogs open their own queries, the recorder store and an LLM chat.
// What matters here is that the button opens the right one.
vi.mock("./new-recording-dialog", () => ({
  NewRecordingDialog: ({ open }: { open: boolean }) => (open ? <div>record dialog</div> : null),
}));
vi.mock("./generate-test-dialog", () => ({
  GenerateTestDialog: ({ open }: { open: boolean }) => (open ? <div>generate dialog</div> : null),
}));

const DAY = 24 * 60 * 60 * 1000;

function run(over: Partial<RunRecord>): RunRecord {
  return {
    id: "r1",
    testId: "t1",
    testName: "Login",
    url: "https://example.test/",
    status: "passed",
    exitCode: 0,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    durationMs: 1,
    logFile: "/tmp/r.log",
    logBytes: 1,
    ...over,
  } as RunRecord;
}

function heal(over: Partial<HealListEntry>): HealListEntry {
  return { id: "h1", status: "pending", testName: "Login", ...over } as HealListEntry;
}

function record(over: Partial<TestRecord> = {}): TestRecord {
  return {
    id: "t1",
    name: "Login",
    url: "https://example.test/",
    createdAt: 1,
    updatedAt: 1,
    steps: [],
    scriptPath: "/tmp/t1.spec.ts",
    ...over,
  } as TestRecord;
}

function renderHome() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <HomeView />
    </QueryClientProvider>,
  );
}

/** The value shown under a readout's label. */
function statValue(label: string): string {
  const el = screen.getByText(label);
  return el.parentElement?.querySelector(".gl-home-stat-value")?.textContent ?? "";
}

beforeEach(() => {
  tests = [];
  runs = [];
  heals = [];
});

describe("greenRate", () => {
  const NOW = 1_000 * DAY;

  it("is null when nothing ran in the window", () => {
    // NOT 0. The whole point: a rate needs a denominator, and "no runs" has
    // none. Rendering 0% there claims every run failed.
    expect(greenRate([], NOW)).toBeNull();
    expect(greenRate([run({ startedAt: NOW - 30 * DAY })], NOW)).toBeNull();
  });

  it("counts only the last seven days", () => {
    expect(
      greenRate(
        [
          run({ status: "passed", startedAt: NOW - 1 * DAY }),
          run({ status: "failed", startedAt: NOW - 20 * DAY }),
        ],
        NOW,
      ),
    ).toBe(100);
  });

  it("includes a run exactly on the boundary", () => {
    // An exclusive bound drops a run at the edge on every render as the clock
    // moves, which makes the number twitch for no reason anyone can see.
    expect(greenRate([run({ status: "failed", startedAt: NOW - 7 * DAY })], NOW)).toBe(0);
  });

  it("rounds rather than truncating", () => {
    const rs = [
      run({ status: "passed", startedAt: NOW }),
      run({ status: "passed", startedAt: NOW }),
      run({ status: "failed", startedAt: NOW }),
    ];
    expect(greenRate(rs, NOW)).toBe(67);
  });

  it("ignores baseline updates", () => {
    // Accepting a new screenshot is not a run and has no verdict. Counted, one
    // afternoon of baseline work would drag the week's number down with no
    // failing test anywhere.
    expect(
      greenRate(
        [
          run({ status: "passed", startedAt: NOW }),
          run({ status: "failed", startedAt: NOW, kind: "baseline-update" }),
        ],
        NOW,
      ),
    ).toBe(100);
  });

  it("reports a genuine zero as zero", () => {
    // The mirror of the null case, and the reason both are pinned: if "no data"
    // and "all red" ever collapse into one rendering, this is the direction
    // that hides a broken suite.
    expect(greenRate([run({ status: "failed", startedAt: NOW })], NOW)).toBe(0);
  });
});

describe("the readouts", () => {
  it("counts the library, the week and the review queue", async () => {
    tests = [record({ id: "a" }), record({ id: "b" })];
    runs = [run({ status: "passed" }), run({ id: "r2", status: "failed" })];
    heals = [heal({ id: "h1" }), heal({ id: "h2", status: "accepted" })];
    renderHome();

    await waitFor(() => expect(statValue("Tests")).toBe("2"));
    expect(statValue("Green · 7d")).toBe("50%");
    // Only the pending one — a heal already accepted is not waiting on anybody.
    expect(statValue("Heals to review")).toBe("1");
  });

  it("shows an em dash rather than a zero before the data arrives", () => {
    // Rendered before any query resolves. Zeroes here would flash "0 tests" at
    // someone with a full library on every navigation home.
    renderHome();
    expect(statValue("Tests")).toBe("—");
    expect(statValue("Green · 7d")).toBe("—");
    expect(statValue("Heals to review")).toBe("—");
  });

  it("shows an em dash for a week with no runs", async () => {
    runs = [run({ startedAt: Date.now() - 30 * DAY })];
    renderHome();
    await waitFor(() => expect(statValue("Tests")).toBe("0"));
    expect(statValue("Green · 7d")).toBe("—");
  });

  it("shows a real zero for a week that was all red", async () => {
    // The mirror of the case above, and the direction that matters more: if
    // "no data" and "everything failed" ever render the same, this is the one
    // that hides a broken suite.
    runs = [run({ status: "failed" })];
    renderHome();
    await waitFor(() => expect(statValue("Green · 7d")).toBe("0%"));
  });
});

describe("the entry points", () => {
  it("opens the recorder", () => {
    renderHome();
    expect(screen.queryByText("record dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Record a test" }));
    expect(screen.getByText("record dialog")).toBeTruthy();
  });

  it("opens the generator", () => {
    renderHome();
    fireEvent.click(screen.getByRole("button", { name: "Generate from prompt" }));
    expect(screen.getByText("generate dialog")).toBeTruthy();
  });

  it("names the app once in the DOM, however many ghosts are drawn", () => {
    // The `echo` treatment draws two more copies of the wordmark, and they are
    // pseudo-elements precisely so a screen reader says it once rather than
    // three times. A refactor to real elements would pass every visual check.
    renderHome();
    expect(screen.getAllByText("GOOD LOOKS!")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "GOOD LOOKS!" }).dataset.text).toBe("GOOD LOOKS!");
  });
});
