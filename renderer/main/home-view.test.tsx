// The home screen's three readouts, and the two entry points.
//
// The readouts are the risk. They are the first numbers anyone sees when the
// app opens, they are derived rather than fetched, and a wrong one is silent —
// nothing throws, nothing looks broken, and "12% green" reads as a fact about
// the week rather than as a bug in a filter. The empty case is worse still: 0%
// and "nothing ran" are the same pixels, and one of them sends someone looking
// for a failure that never happened.
//
// Their NAVIGATION fails just as quietly. A readout wired to the wrong route
// still renders, still animates, still looks pressed — it simply lands you in
// the wrong view, which reads as "this app is confusing" rather than as a bug.
// And the way it usually breaks is worse: a `<div onClick>` is pixel-identical
// to a `<button>` and silently drops tab order, Enter, Space and the announced
// role, so the mouse test everybody writes passes over an unusable control.
// Hence both halves below — the destination AND the element.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { HealListEntry, RunRecord, TestRecord } from "../lib/recorder-types";
import { HomeView, greenRate } from "./home-view";

let tests: TestRecord[] = [];
let runs: RunRecord[] = [];
let heals: HealListEntry[] = [];

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

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

/** The readout carrying a given label, as the element that is actually pressed.
 *
 *  Found through its visible label rather than its accessible name on purpose:
 *  the accessible name is one of the things under test here, and a helper that
 *  queried by it could not then assert anything about it. */
function stat(label: string): HTMLElement {
  const el = screen.getByText(label).parentElement;
  if (!el) throw new Error(`no readout around the label "${label}"`);
  return el;
}

/** The value shown under a readout's label. */
function statValue(label: string): string {
  return stat(label).querySelector(".gl-home-stat-value")?.textContent ?? "";
}

beforeEach(() => {
  tests = [];
  runs = [];
  heals = [];
  navigate.mockClear();
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

  it("does not navigate on its own", () => {
    // The readouts navigate on press and at no other time. A view that routed
    // during render would bounce off its own home screen on every launch.
    renderHome();
    expect(navigate).not.toHaveBeenCalled();
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

describe("the readouts navigate", () => {
  /** Label as it appears on screen, the view it opens, and that view's route.
   *
   *  Spelled out here rather than imported from the component: a test that
   *  reads the same table the code does agrees with it by construction and
   *  proves nothing. This is the second, independent copy, and disagreement
   *  between the two is exactly the bug worth catching. */
  const READOUTS = [
    { label: "Tests", view: "Batch", to: "/batch" },
    { label: "Green · 7d", view: "Stats", to: "/stats" },
    { label: "Heals to review", view: "Heals", to: "/heals" },
  ] as const;

  it.each(READOUTS)("opens the $view view from $label", async ({ label, to }) => {
    tests = [record({ id: "a" })];
    runs = [run({ status: "passed" })];
    heals = [heal({ id: "h1" })];
    renderHome();
    await waitFor(() => expect(statValue("Tests")).toBe("1"));

    fireEvent.click(stat(label));

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({ to });
  });

  it("sends the three readouts to three different views", () => {
    // Read off the RENDERED screen rather than off the table above, which would
    // only prove the table disagrees with itself. A copy-paste that points two
    // readouts at one route still navigates, still reaches a working view, and
    // is invisible to every other assertion here.
    renderHome();
    const reached = READOUTS.map((r) => {
      navigate.mockClear();
      fireEvent.click(stat(r.label));
      return navigate.mock.calls[0]?.[0]?.to;
    });
    expect(new Set(reached).size).toBe(READOUTS.length);
  });

  it.each(READOUTS)("presses $label with the keyboard, not just the mouse", ({ label }) => {
    // The failure this exists for: a `<div onClick>` renders identically, takes
    // the mouse click above, and is unreachable by tab, Enter or Space. jsdom
    // has no key-to-click synthesis to test with, so the check is the element
    // itself — being a real button IS what supplies the keyboard behaviour —
    // plus the focus it must be able to take to receive a key at all.
    renderHome();
    const el = stat(label);
    expect(el.tagName).toBe("BUTTON");
    // Without this, a button inside a form-shaped ancestor submits instead.
    expect(el.getAttribute("type")).toBe("button");
    el.focus();
    expect(document.activeElement).toBe(el);
  });

  it.each(READOUTS)("tells a screen reader where $label goes", async ({ label, view }) => {
    // "22 Tests" read aloud is a fact, not a control. The accessible name has
    // to carry the destination, because the visible text never will — and it
    // has to carry the value too, or the readout stops being a readout to
    // anyone not looking at it.
    tests = [record({ id: "a" }), record({ id: "b" })];
    runs = [run({ status: "failed" })];
    heals = [heal({ id: "h1" }), heal({ id: "h2" })];
    renderHome();
    await waitFor(() => expect(statValue("Tests")).toBe("2"));

    const expected: Record<string, string> = {
      Tests: "Tests: 2, opens the Batch view",
      "Green · 7d": "Green · 7d: 0%, opens the Stats view",
      "Heals to review": "Heals to review: 2, opens the Heals view",
    };
    expect(screen.getByRole("button", { name: expected[label] })).toBe(stat(label));
    expect(expected[label]).toContain(view);
  });

  it.each(READOUTS)("is still pressable before the data arrives ($label)", ({ label, to }) => {
    // Rendered with every query unresolved, so the value is still "—". A
    // control that appears only once data lands is a control people learn is
    // not there, and there is nothing about a pending query that makes going
    // to the view a worse idea.
    renderHome();
    expect(statValue(label)).toBe("—");

    const el = stat(label);
    expect(el.tagName).toBe("BUTTON");
    expect((el as HTMLButtonElement).disabled).toBe(false);
    expect(el.getAttribute("aria-label")).toBe(
      `${label}: —, opens the ${READOUTS.find((r) => r.label === label)!.view} view`,
    );

    fireEvent.click(el);
    expect(navigate).toHaveBeenCalledWith({ to });
  });

  it("navigates from a genuine zero as readily as from a count", async () => {
    // The empty library is when someone is most likely to press these, and an
    // easy way to break it is to gate the handler on the number being truthy.
    renderHome();
    await waitFor(() => expect(statValue("Tests")).toBe("0"));

    fireEvent.click(stat("Tests"));
    expect(navigate).toHaveBeenCalledWith({ to: "/batch" });
  });

  it("keeps the readouts out of the entry-point buttons' way", () => {
    // The three readouts sit directly above the action row, and `getByRole`
    // does not care about layout. If a readout ever took the name of an action,
    // the entry-point tests above would start passing against the wrong
    // control. Seven: three readouts and four ways in — record, generate, and
    // the two imports, which used to be reachable only from the rail's native
    // `+` menu.
    renderHome();
    expect(screen.getByRole("button", { name: "Record a test" })).not.toBe(stat("Tests"));
    expect(screen.getAllByRole("button")).toHaveLength(7);
  });

  it("offers both import methods, not just the two ways to write a new test", () => {
    // The gap this closes: a user arriving with an existing Playwright suite
    // was shown "Record" and "Generate" and no way to bring in what they
    // already have — both importers lived behind the library rail's `+`, which
    // is a native macOS menu.
    renderHome();
    expect(screen.getByRole("button", { name: "Import from a folder" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import from a git URL" })).toBeTruthy();
  });
});
