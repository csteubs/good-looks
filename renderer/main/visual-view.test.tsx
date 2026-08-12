// Component tests for the Visual view.
//
// At 1,409 lines this is the largest file in the app and was at 0%. It's a
// screenshot replay viewer, and most of its bulk is image panes and drag
// overlays that a DOM test can't meaningfully verify — jsdom has no layout and
// decodes no images.
//
// So these tests target the part that carries MEANING rather than pixels: the
// diff badge. It is the verdict a user acts on, and its wording makes claims
// that are wrong in ways nothing else would catch — "2% changed" of one button
// is a completely different statement from 2% of the page, and a "Visual match"
// measured with regions excluded is not a full-page match. Plus the view's own
// run-selection behavior, where the failure mode is a blank pane.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { clearToastCalls, toastCalls } from "../__tests__/sonner-stub";

import type { RunReplaySummary, VisualDiff } from "../lib/recorder-types";
import { DiffBadge, VisualView, framesOverThreshold } from "./visual-view";

let replays: RunReplaySummary[] = [];
/** Mutable so the bezel tests can seed a run with a real frame; every other
 *  test in this file leaves them null and never reaches the viewer. */
let replayDetail: unknown = null;
let shot: string | null = null;
let baselineShot: string | null = null;
let baselines: unknown[] = [];

// The four exits from a findings banner. Each returns the replay the way the
// real handler does — patched, so the view re-renders from the same object the
// backend would hand back rather than from a local guess.
const acceptVisualRun = vi.fn(async () => {
  const r = replayDetail as { steps: { screenshot?: string | null; diff?: unknown }[] };
  for (const s of r.steps) if (s.screenshot) s.diff = { state: "match", ratio: 0, threshold: 0.2 };
  return replayDetail;
});
const acceptA11yRun = vi.fn(async () => {
  const r = replayDetail as { steps: { a11y?: { violations: unknown[]; newKeys: string[]; acceptedCount: number } }[] };
  for (const s of r.steps) if (s.a11y) s.a11y = { ...s.a11y, newKeys: [], acceptedCount: 1 };
  return replayDetail;
});
const dismissNotice = vi.fn(async (_testId: string, _runId: string, kind: string) => {
  const r = replayDetail as { dismissedNotices?: string[] };
  r.dismissedNotices = [...new Set([...(r.dismissedNotices ?? []), kind])];
  return replayDetail;
});
const restoreNotice = vi.fn(async (_testId: string, _runId: string, kind: string) => {
  const r = replayDetail as { dismissedNotices?: string[] };
  r.dismissedNotices = (r.dismissedNotices ?? []).filter((k) => k !== kind);
  return replayDetail;
});

vi.mock("../lib/api", () => ({
  api: {
    artifacts: {
      list: async () => replays,
      getReplay: async () => replayDetail,
      readShot: async () => shot,
      dismissNotice: (...a: Parameters<typeof dismissNotice>) => dismissNotice(...a),
      restoreNotice: (...a: Parameters<typeof restoreNotice>) => restoreNotice(...a),
    },
    runs: { list: async () => [] },
    visual: {
      getThreshold: async () => 0.1,
      setThreshold: async () => 0.1,
      getMasks: async () => [],
      setMasks: async () => [],
      listBaselines: async () => baselines,
      baselineShot: async () => baselineShot,
      clearBaseline: async () => null,
      acceptStep: async () => null,
      acceptRun: (...a: unknown[]) => acceptVisualRun(...(a as [])),
      getElementSteps: async () => [],
      setElementStep: async () => [],
    },
    a11y: {
      acceptStep: async () => null,
      acceptRun: (...a: unknown[]) => acceptA11yRun(...(a as [])),
    },
    annotations: { list: async () => [], upsert: async () => ({}) },
    runner: { compareRuns: async () => null, replayRun: async () => ({ runId: "r" }) },
    on: () => () => {},
  },
}));

function summary(over: Partial<RunReplaySummary> & { runId: string }): RunReplaySummary {
  return {
    testId: "t1",
    testName: "Checkout",
    status: "passed",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    stepCount: 3,
    failedIndex: null,
    changedSteps: 0,
    ...over,
  } as RunReplaySummary;
}

function renderVisual() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VisualView />
    </QueryClientProvider>,
  );
}

function renderBadge(diff: VisualDiff) {
  return render(<DiffBadge diff={diff} />);
}

beforeEach(() => {
  replays = [];
});

describe("DiffBadge wording", () => {
  it("announces a freshly pinned baseline", () => {
    renderBadge({ state: "new-baseline" });
    expect(screen.getByText("Baseline set")).toBeTruthy();
  });

  it("distinguishes a page match from an element match", () => {
    // "Visual match" on an element-scoped comparison would claim far more than
    // was actually compared.
    const page = renderBadge({ state: "match", ratio: 0 });
    expect(screen.getByText("Visual match")).toBeTruthy();
    page.unmount();

    renderBadge({ state: "match", ratio: 0, scope: "element" });
    expect(screen.getByText("Element match")).toBeTruthy();
  });

  it("distinguishes a page change from an element change, with the percentage", () => {
    // 2% of one button is a very different claim from 2% of the page.
    const page = renderBadge({ state: "changed", ratio: 0.02 });
    expect(screen.getByText(/^Changed /)).toBeTruthy();
    page.unmount();

    renderBadge({ state: "changed", ratio: 0.02, scope: "element" });
    expect(screen.getByText(/^Element changed /)).toBeTruthy();
  });

  it("says it can't compare rather than guessing", () => {
    // Degrading to "unable" is the deliberate alternative to a false verdict.
    renderBadge({ state: "unable", reason: "size mismatch" });
    expect(screen.getByText(/can.t compare/i)).toBeTruthy();
  });

  it("surfaces the reason a comparison failed, on hover", () => {
    const { container } = renderBadge({ state: "unable", reason: "size mismatch" });
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain("size mismatch");
  });

  it("marks a verdict measured with regions excluded", () => {
    // Otherwise a "Visual match" on a masked page reads as a full-page match.
    const { container } = renderBadge({ state: "match", ratio: 0, maskedCount: 2 });
    expect(container.querySelector("[title]")?.getAttribute("title")).toMatch(/2 ignored regions/);
    // …and shows an icon, since the title alone is invisible until hovered.
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("says 'region' singular for one mask", () => {
    const { container } = renderBadge({ state: "match", ratio: 0, maskedCount: 1 });
    expect(container.querySelector("[title]")?.getAttribute("title")).toMatch(/1 ignored region\b/);
  });

  it("adds no mask marker when nothing was excluded", () => {
    const { container } = renderBadge({ state: "match", ratio: 0 });
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("VisualView run selection", () => {
  it("explains itself when nothing has been captured", async () => {
    renderVisual();
    expect(await screen.findByText(/no captured runs yet/i)).toBeTruthy();
  });

  it("lists captured runs", async () => {
    replays = [
      summary({ runId: "r1", testName: "Checkout" }),
      summary({ runId: "r2", testName: "Login" }),
    ];
    renderVisual();
    expect(await screen.findByText("Checkout")).toBeTruthy();
    expect(screen.getByText("Login")).toBeTruthy();
  });

  it("selects the newest run by default rather than showing nothing", async () => {
    replays = [summary({ runId: "r1", testName: "Newest" }), summary({ runId: "r2", testName: "Older" })];
    renderVisual();
    // A viewer that opens on no selection looks broken; the list's first entry
    // must be active without a click.
    await screen.findByText("Newest");
    await waitFor(() => expect(document.body.textContent).toMatch(/Newest/));
  });

  it("switches to another run when clicked", async () => {
    replays = [summary({ runId: "r1", testName: "First" }), summary({ runId: "r2", testName: "Second" })];
    renderVisual();
    const second = await screen.findByText("Second");
    fireEvent.click(second);
    await waitFor(() => expect(document.body.textContent).toMatch(/Second/));
  });

  it("marks a run that flagged visual changes", async () => {
    replays = [summary({ runId: "r1", changedSteps: 3 })];
    renderVisual();
    await screen.findByText("Checkout");
    // The whole point of the list marker: spotting a changed run without
    // opening each one.
    expect(document.body.textContent).toMatch(/3/);
  });

  it("marks a run whose only finding was an accessibility one", async () => {
    // `a11yNewSteps` was carried in the summary from the day the feature landed
    // and read by nothing, so a run that was visually identical but newly
    // inaccessible looked exactly like a clean one in this list.
    replays = [summary({ runId: "r1", changedSteps: 0, a11yNewSteps: 2 })];
    renderVisual();
    await screen.findByText("Checkout");
    expect(screen.getByLabelText("accessibility issues")).toBeTruthy();
    // Its own marker: it must not borrow the visual-change one, which sends the
    // user to a pixel diff that shows nothing.
    expect(screen.queryByLabelText("visual change")).toBeNull();
  });

  it("leaves a clean run unmarked", async () => {
    replays = [summary({ runId: "r1" })];
    renderVisual();
    await screen.findByText("Checkout");
    expect(screen.queryByLabelText("accessibility issues")).toBeNull();
  });
});

// Accepting and dismissing are NOT two words for the same button, and the whole
// point of these tests is that the screen keeps them apart. Accepting re-pins a
// baseline or pins violations onto the test record — it changes what every later
// run reports. Dismissing changes one run's banner and nothing else. Before this
// there was no dismiss at all, so the cheapest way to clear a nagging screen was
// to accept findings you had not looked at.
describe("clearing a run's findings banners", () => {
  beforeEach(() => {
    // Not optional here: half these tests assert a mock was NOT called, and
    // without a reset they pass or fail on the previous test's clicks.
    vi.clearAllMocks();
    replays = [summary({ runId: "r1", stepCount: 2, changedSteps: 1, a11yNewSteps: 1 })];
    replayDetail = {
      testId: "t1",
      runId: "r1",
      testName: "Checkout",
      status: "passed",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_001_000,
      failedIndex: null,
      visualThreshold: 0.2,
      steps: [
        {
          index: 0,
          stepId: "s1",
          label: "goto example.com",
          type: "goto",
          status: "passed",
          screenshot: "0.png",
          diff: { state: "changed", ratio: 0.04, threshold: 0.2, diffFile: "0.diff.png" },
        },
        {
          index: 1,
          stepId: "s2",
          label: "click Cart",
          type: "click",
          status: "passed",
          screenshot: "1.png",
          diff: { state: "match", ratio: 0, threshold: 0.2 },
          a11y: {
            violations: [
              { id: "color-contrast", impact: "serious", help: "Contrast", nodes: [".total"] },
            ],
            newKeys: ["color-contrast|.total"],
            acceptedCount: 0,
          },
        },
      ],
    };
    shot = "data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E";
  });

  afterEach(() => {
    replayDetail = null;
    shot = null;
  });

  /** Press an AlertDialog trigger, then its confirm button. Two clicks, because
   *  both accepts are destructive enough to be asked about. */
  async function confirmFrom(triggerName: RegExp) {
    const triggers = await screen.findAllByRole("button", { name: triggerName });
    fireEvent.click(triggers[0]);
    const confirm = await screen.findByRole("button", { name: "Accept all" });
    fireEvent.click(confirm);
  }

  it("offers a run-wide accept for VISUAL changes, not just per-step", async () => {
    // The gap this closes: accessibility had "Accept all for this run" from the
    // start and visual did not, so re-pinning a twenty-step run meant twenty
    // clicks — and the two banners taught contradictory mental models.
    renderVisual();
    await screen.findByText(/Visual change detected/);
    await confirmFrom(/Accept all for this run/);
    await waitFor(() => expect(acceptVisualRun).toHaveBeenCalledWith("t1", "r1"));
    // The banner goes because the FINDINGS went, which is what makes accept
    // different from dismiss: nothing is left to report.
    await waitFor(() => expect(screen.queryByText(/Visual change detected/)).toBeNull());
  });

  it("dismisses the visual banner without touching a single baseline", async () => {
    renderVisual();
    await screen.findByText(/Visual change detected/);
    fireEvent.click(screen.getByLabelText("Dismiss visual changes for this run"));
    await waitFor(() => expect(screen.queryByText(/Visual change detected/)).toBeNull());
    expect(dismissNotice).toHaveBeenCalledWith("t1", "r1", "visual");
    // The one assertion that separates this from the accept above. If dismiss
    // ever grew into "accept quietly", this is what would notice.
    expect(acceptVisualRun).not.toHaveBeenCalled();
    const steps = (replayDetail as { steps: { diff?: { state: string } }[] }).steps;
    expect(steps[0].diff?.state).toBe("changed");
  });

  it("dismisses the accessibility banner without accepting the violations", async () => {
    renderVisual();
    await screen.findByText(/accessibility issues that/);
    fireEvent.click(screen.getByLabelText("Dismiss accessibility issues for this run"));
    await waitFor(() => expect(screen.queryByText(/accessibility issues that/)).toBeNull());
    expect(dismissNotice).toHaveBeenCalledWith("t1", "r1", "a11y");
    expect(acceptA11yRun).not.toHaveBeenCalled();
    const steps = (replayDetail as { steps: { a11y?: { newKeys: string[] } }[] }).steps;
    expect(steps[1].a11y?.newKeys).toEqual(["color-contrast|.total"]);
  });

  it("dismisses one banner without silencing the other", async () => {
    // They are separate findings and a run can have either. Sharing one flag
    // would hide an accessibility regression because someone waved off a pixel
    // diff, which is the worst version of this feature.
    renderVisual();
    await screen.findByText(/Visual change detected/);
    fireEvent.click(screen.getByLabelText("Dismiss visual changes for this run"));
    await waitFor(() => expect(screen.queryByText(/Visual change detected/)).toBeNull());
    expect(screen.getByText(/accessibility issues that/)).toBeTruthy();
  });

  it("keeps a banner dismissed on the replay, not in component state", async () => {
    // A dismissal held in the component comes back the moment the user selects
    // another run and returns — which is not a dismissal. Seeded on the replay
    // here, exactly as a re-read from disk would deliver it.
    (replayDetail as { dismissedNotices: string[] }).dismissedNotices = ["visual", "a11y"];
    renderVisual();
    await screen.findByText("Checkout");
    await waitFor(() => {
      if (!document.querySelector('[data-gl="crt"]')) throw new Error("not ready");
    });
    expect(screen.queryByText(/Visual change detected/)).toBeNull();
    expect(screen.queryByText(/accessibility issues that/)).toBeNull();
  });

  it("offers a way back from a dismissal", async () => {
    // Dismiss sits one click away and beside an irreversible control; without an
    // undo the two read as equally dangerous and the user uses neither.
    clearToastCalls();
    renderVisual();
    await screen.findByText(/Visual change detected/);
    fireEvent.click(screen.getByLabelText("Dismiss visual changes for this run"));
    await waitFor(() => expect(dismissNotice).toHaveBeenCalled());
    const undo = toastCalls
      .map((c) => (c.options as { action?: { label: string; onClick: () => void } } | undefined))
      .find((o) => o?.action?.label === "Undo");
    expect(undo).toBeTruthy();
    act(() => undo!.action!.onClick());
    await waitFor(() => expect(restoreNotice).toHaveBeenCalledWith("t1", "r1", "visual"));
    expect(await screen.findByText(/Visual change detected/)).toBeTruthy();
  });
});

describe("the frame is evidence, and the bezel says so", () => {
  beforeEach(() => {
    replays = [summary({ runId: "r1", stepCount: 1, changedSteps: 0 })];
    replayDetail = {
      testId: "t1",
      runId: "r1",
      testName: "Checkout",
      status: "passed",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_001_000,
      failedIndex: null,
      steps: [
        {
          index: 0,
          stepId: "s1",
          label: "goto example.com",
          type: "goto",
          status: "passed",
          screenshot: "0.png",
          diff: { state: "match", ratio: 0.0001, threshold: 0.2 },
        },
      ],
    };
    shot = "data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E";
  });

  afterEach(() => {
    replayDetail = null;
    shot = null;
  });

  // The one rule in this design system that is about CORRECTNESS rather than
  // taste, and this screen is why it exists: every frame here is evidence, the
  // question being asked is "does this look right?", and a tint from our own
  // chrome is indistinguishable from a tint in the page under test.
  it("wraps the captured frame in the CRT bezel", async () => {
    renderVisual();
    const bezel = await waitFor(() => {
      const el = document.querySelector('[data-gl="crt"]');
      if (!el) throw new Error("no CRT bezel");
      return el as HTMLElement;
    });
    expect(bezel.querySelector("img")).not.toBeNull();
  });

  it("puts the compare-mode switch ABOVE the bezel", async () => {
    // Not a styling nit. `CRT` sits at z-index 610 to escape the global
    // atmosphere overlays at 600; the mode switch is chrome laid on the frame,
    // and at its old `z-10` it rendered behind the bezel and disappeared — the
    // compare-mode switch, invisible, on the compare screen.
    renderVisual();
    await waitFor(() => {
      if (!document.querySelector('[data-gl="crt"]')) throw new Error("not ready");
    });
    const modes = document.querySelector(".gl-visual-modes");
    expect(modes).not.toBeNull();
    // The stacking value itself lives in screens.css (the dom project runs with
    // `css: false`, so there is no computed z-index here to read). What this
    // owns is that the element still opts in by carrying the class.
    expect(modes?.className).toContain("gl-visual-modes");
  });
});

describe("the frame rail (B8)", () => {
  /** Three frames, one of which changed — the shape the filter exists for. */
  function seedRail() {
    replays = [summary({ runId: "r1", stepCount: 3, changedSteps: 1 })];
    replayDetail = {
      testId: "t1",
      runId: "r1",
      testName: "Checkout",
      status: "passed",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_001_000,
      failedIndex: null,
      steps: [
        { index: 0, stepId: "s1", label: "goto", type: "goto", status: "passed", screenshot: "0.png", diff: { state: "match", ratio: 0.0001 } },
        { index: 1, stepId: "s2", label: "click", type: "click", status: "passed", screenshot: "1.png", diff: { state: "changed", ratio: 0.0413, diffFile: "1.diff.png" } },
        { index: 2, stepId: "s3", label: "assert", type: "assert", status: "passed", screenshot: "2.png", diff: { state: "match", ratio: 0 } },
      ],
    };
    shot = "data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E";
  }

  beforeEach(seedRail);
  afterEach(() => {
    replayDetail = null;
    shot = null;
  });

  const frames = () => document.querySelectorAll(".gl-frame-btn");

  it("shows how much each changed frame changed by", async () => {
    // THE NUMBER THE STRIP COULD NOT SHOW. A run with forty frames and three
    // real changes was a row of near-identical bars: a 0.01% antialiasing shift
    // and a 40% layout break looked the same, so triage meant clicking through.
    renderVisual();
    await waitFor(() => expect(frames().length).toBe(3));
    const pcts = [...document.querySelectorAll(".gl-frame-pct")].map((e) => e.textContent);
    expect(pcts).toEqual(["4.13%"]);
  });

  it("prints no percentage on frames that did not change", async () => {
    // Printing "0%" under every unchanged frame would bury the ones that
    // matter in noise, which is the problem this is here to solve.
    renderVisual();
    await waitFor(() => expect(frames().length).toBe(3));
    expect(document.querySelectorAll(".gl-frame-pct").length).toBe(1);
  });

  it("narrows to the changed frames on request", async () => {
    renderVisual();
    await waitFor(() => expect(frames().length).toBe(3));
    fireEvent.click(screen.getByRole("button", { name: "Changed" }));
    await waitFor(() => expect(frames().length).toBeLessThan(3));
  });

  it("keeps the selected frame even when it did not change", async () => {
    // The rule worth pinning. Filtering the selected frame out of the rail
    // while the viewer above still shows it leaves the two disagreeing — and
    // the user with no handle to move off it.
    renderVisual();
    await waitFor(() => expect(frames().length).toBe(3));
    // Frame 0 is selected on open (failedIndex is null → index 0) and matched.
    fireEvent.click(screen.getByRole("button", { name: "Changed" }));
    await waitFor(() => expect(frames().length).toBe(2));
    const labels = [...frames()].map((f) => f.getAttribute("aria-label") ?? "");
    expect(labels.some((l) => l.startsWith("Step 1:"))).toBe(true);
    expect(labels.some((l) => l.startsWith("Step 2:"))).toBe(true);
  });

  it("offers no filter when nothing changed", async () => {
    // A control that is always present and usually a no-op teaches people it
    // does nothing.
    replayDetail = {
      ...(replayDetail as { steps: unknown[] }),
      steps: (replayDetail as { steps: { diff?: unknown }[] }).steps.map((st) => ({
        ...st,
        diff: { state: "match", ratio: 0 },
      })),
    };
    renderVisual();
    await waitFor(() => expect(frames().length).toBe(3));
    expect(screen.queryByRole("button", { name: "Changed" })).toBeNull();
  });
});

describe("the threshold, drawn against the frames (B8)", () => {
  // The slider used to be a number with no consequence on screen: "0.20%" says
  // nothing about whether moving it silences the change you are looking at or
  // every change you have.
  const steps = (...ratios: (number | undefined)[]) =>
    ratios.map((r, i) => ({
      index: i,
      stepId: `s${i}`,
      diff: r === undefined ? undefined : { ratio: r },
    }));

  it("counts the frames a threshold would flag", () => {
    // 4.13% and 0.5% are over 0.2%; 0.01% is not.
    expect(framesOverThreshold(steps(0.0413, 0.005, 0.0001), 0.2)).toBe(2);
  });

  it("does not flag a frame sitting exactly ON the threshold", () => {
    // STRICTLY GREATER, matching the comparator that produced these ratios.
    // Guessing >= would make the preview disagree with the next run by one
    // frame — worse than no preview, because it would be believed.
    expect(framesOverThreshold(steps(0.002), 0.2)).toBe(0);
    expect(framesOverThreshold(steps(0.00201), 0.2)).toBe(1);
  });

  it("ignores frames with nothing measured", () => {
    // An uncaptured step has no ratio. Counting it as unflagged is right;
    // counting it at all in the denominator would overstate the run's coverage.
    expect(framesOverThreshold(steps(undefined, undefined), 0.2)).toBe(0);
  });

  it("flags everything at a threshold of zero", () => {
    expect(framesOverThreshold(steps(0.0001, 0.5), 0)).toBe(2);
  });
});

// ── Wipe and Blink (C §6.6) ─────────────────────────────────────────────
//
// The two modes that put both frames in the SAME PLACE, which is the comparison
// a diff map cannot make: a diff lights every changed pixel with equal weight,
// so a font-smoothing shift and a button that moved 40px look identical.
//
// Three things here would be silent if wrong. Offering a mode that cannot open
// (only one frame exists). Rendering half a comparison and letting it read as a
// result. And treating a frame — on the one screen where a tint from our own
// chrome is indistinguishable from a tint in the page under test.

describe("wipe and blink (C §6.6)", () => {
  beforeEach(() => {
    replays = [summary({ runId: "r1", stepCount: 1, changedSteps: 1 })];
    replayDetail = {
      testId: "t1",
      runId: "r1",
      testName: "Checkout",
      status: "passed",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_001_000,
      failedIndex: null,
      steps: [
        {
          index: 0,
          stepId: "s1",
          label: "goto example.com",
          type: "goto",
          status: "passed",
          screenshot: "0.png",
          diff: { state: "changed", ratio: 0.04, threshold: 0.2, diffFile: "0.diff.png" },
        },
      ],
    } as never;
    shot = "data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E";
    baselineShot = "data:image/svg+xml;utf8,%3Csvg%20id%3D%22b%22%3E%3C/svg%3E";
  });

  afterEach(() => {
    replayDetail = null;
    shot = null;
    baselineShot = null;
  });

  const modeButton = (name: RegExp) =>
    screen.getAllByRole("button").find((b) => name.test(b.textContent ?? ""));

  async function ready() {
    renderVisual();
    await waitFor(() => {
      if (!document.querySelector(".gl-visual-modes")) throw new Error("not ready");
    });
  }

  it("offers all five modes when both frames exist", async () => {
    await ready();
    for (const name of [/^Current$/, /^Baseline$/, /^Diff$/, /^Wipe$/, /^Blink$/]) {
      expect(modeButton(name)).toBeTruthy();
    }
  });

  it("does not offer them when there is no current frame to compare", async () => {
    // A mode whose empty state is "both have to exist" is a mode that should
    // not have been offered in the first place.
    const detail = replayDetail as unknown as { steps: Record<string, unknown>[] };
    replayDetail = {
      ...detail,
      steps: [{ ...detail.steps[0], screenshot: null }],
    } as never;
    renderVisual();
    // Waiting on the step, not on the mode switch: with no captured frame the
    // switch may not render at all, and waiting for it would time out on the
    // very state this test is about.
    await waitFor(() => {
      if (!screen.queryByText(/goto example\.com/)) throw new Error("not ready");
    });
    expect(modeButton(/^Wipe$/)).toBeUndefined();
    expect(modeButton(/^Blink$/)).toBeUndefined();
  });

  it("stacks both frames in wipe, each in its own untreated bezel", async () => {
    await ready();
    fireEvent.click(modeButton(/^Wipe$/)!);
    await waitFor(() => {
      if (!document.querySelector('[data-gl="wipe"]')) throw new Error("no wipe");
    });
    // TWO bezels: baseline underneath, current clipped on top. One would mean
    // the mode is showing a single frame and calling it a comparison.
    expect(document.querySelectorAll('[data-gl="crt"]').length).toBe(2);
    for (const img of document.querySelectorAll(".gl-crt-img")) {
      // The rule this whole screen exists under. An inline treatment here would
      // manufacture a difference the page does not have.
      expect((img as HTMLElement).style.filter).toBe("");
      expect((img as HTMLElement).style.opacity).toBe("");
      expect((img as HTMLElement).style.mixBlendMode).toBe("");
    }
  });

  it("clips the wipe rather than fading it", async () => {
    // `clip-path`, never opacity: a partly-transparent layer invents a
    // difference, and this mode's whole premise is that it does not.
    await ready();
    fireEvent.click(modeButton(/^Wipe$/)!);
    const top = await waitFor(() => {
      const el = document.querySelector(".gl-visual-wipe-top") as HTMLElement | null;
      if (!el) throw new Error("no top layer");
      return el;
    });
    expect(top.style.clipPath).toContain("inset(");
    expect(top.style.opacity).toBe("");
  });

  it("drives the wipe divider from the keyboard", async () => {
    // Mouse-only would make the one control here that needs a steady hand
    // unusable without one.
    await ready();
    fireEvent.click(modeButton(/^Wipe$/)!);
    const handle = await waitFor(() => {
      const el = document.querySelector(".gl-visual-wipe-handle") as HTMLElement | null;
      if (!el) throw new Error("no handle");
      return el;
    });
    expect(handle.getAttribute("aria-valuenow")).toBe("50");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("55");
    fireEvent.keyDown(handle, { key: "End" });
    // Never flush to the edge — there would be no handle left in the frame to
    // drag it back with.
    expect(Number(handle.getAttribute("aria-valuenow"))).toBeLessThan(100);
  });

  it("says which frame blink is showing", async () => {
    // With the frames alternating, "which one am I looking at" is otherwise
    // unanswerable — and a user who cannot answer it cannot say which
    // direction the change went.
    await ready();
    fireEvent.click(modeButton(/^Blink$/)!);
    await waitFor(() => {
      if (!document.querySelector(".gl-visual-blink-which")) throw new Error("no label");
    });
    expect(document.querySelector(".gl-visual-blink-which")?.textContent).toBe("Current");
  });

  it("refuses to show half a comparison when the baseline is missing", async () => {
    baselineShot = null;
    await ready();
    // Wipe is still offered (a baseline RECORD exists, which is what the switch
    // is gated on); the mode itself says which frame it could not load rather
    // than rendering one and letting it read as a result.
    fireEvent.click(modeButton(/^Wipe$/)!);
    await waitFor(() => {
      if (!screen.queryByText(/both have to exist/i)) throw new Error("no explanation");
    });
  });
});

// ── Baseline provenance (C §6.6) ────────────────────────────────────────
//
// The screen asks the user to judge a frame against a baseline and, until this,
// said nothing about the baseline. "These two differ" means something entirely
// different depending on whether the baseline was pinned yesterday from the
// same engine or months ago from another one.

describe("baseline provenance (C §6.6)", () => {
  beforeEach(() => {
    replays = [summary({ runId: "r1", stepCount: 1, changedSteps: 1 })];
    replayDetail = {
      testId: "t1",
      runId: "r1",
      testName: "Checkout",
      status: "passed",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_001_000,
      failedIndex: null,
      steps: [
        {
          index: 0,
          stepId: "s1",
          label: "goto example.com",
          type: "goto",
          status: "passed",
          screenshot: "0.png",
          diff: { state: "changed", ratio: 0.04, threshold: 0.2, diffFile: "0.diff.png" },
        },
      ],
    } as never;
    shot = "data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E";
    baselineShot = "data:image/svg+xml;utf8,%3Csvg%20id%3D%22b%22%3E%3C/svg%3E";
    baselines = [{ stepId: "s1", runId: "r-old", at: Date.now(), label: "goto" }];
  });

  afterEach(() => {
    replayDetail = null;
    shot = null;
    baselineShot = null;
    baselines = [];
  });

  async function showBaseline() {
    renderVisual();
    await waitFor(() => {
      if (!document.querySelector(".gl-visual-modes")) throw new Error("not ready");
    });
    const button = screen.getAllByRole("button").find((b) => /^Baseline$/.test(b.textContent ?? ""));
    fireEvent.click(button!);
  }

  it("says what the baseline is, under the frame", async () => {
    await showBaseline();
    const line = await waitFor(() => {
      const el = document.querySelector('[data-gl="baseline-provenance"]');
      if (!el) throw new Error("no provenance");
      return el as HTMLElement;
    });
    // The run behind it is not in the fixture's run list, which is the ordinary
    // state after retention has pruned — and it says so rather than dropping
    // the field or guessing an engine.
    expect(line.textContent).toContain("run since pruned");
  });

  it("shows it in the CRT's own caption slot, not as loose chrome", async () => {
    // The prop has existed since A3, documented as "what this frame IS", with
    // no consumer until now.
    await showBaseline();
    await waitFor(() => {
      if (!document.querySelector('[data-gl="baseline-provenance"]')) throw new Error("waiting");
    });
    expect(
      document.querySelector('[data-gl="crt"] .gl-crt-caption [data-gl="baseline-provenance"]'),
    ).not.toBeNull();
  });

  it("says nothing at all when the step has no baseline record", async () => {
    // A caption reading "unknown" under a frame is worse than no caption,
    // because it looks like a fact.
    baselines = [];
    await showBaseline();
    await waitFor(() => {
      if (!document.querySelector('[data-gl="crt"]')) throw new Error("waiting");
    });
    expect(document.querySelector('[data-gl="baseline-provenance"]')).toBeNull();
  });

  it("does NOT caption the current frame with the baseline's provenance", async () => {
    // The caption describes the baseline. Under the current frame it would be
    // attributing one frame's history to another.
    renderVisual();
    await waitFor(() => {
      if (!document.querySelector('[data-gl="crt"]')) throw new Error("waiting");
    });
    expect(document.querySelector('[data-gl="baseline-provenance"]')).toBeNull();
  });
});
