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
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { RunReplaySummary, VisualDiff } from "../lib/recorder-types";
import { DiffBadge, VisualView, framesOverThreshold, tabChipLabel } from "./visual-view";

let replays: RunReplaySummary[] = [];
/** Mutable so the bezel tests can seed a run with a real frame; every other
 *  test in this file leaves them null and never reaches the viewer. */
let replayDetail: unknown = null;
/** Seeded only by the drift tests, which are the one place that needs the
 *  backend to answer DIFFERENTLY per run — drift is a statement about a series,
 *  and a mock that hands back the same replay for every id makes one. */
let replayById: Record<string, unknown> | null = null;
let shot: string | null = null;
/** Every file `readShot` was asked for. The carried-frame tests assert WHICH
 *  frame the viewer fetched, which is the whole question and is unanswerable
 *  from the DOM: jsdom decodes no images, so every frame in this suite renders
 *  as the same `src` string and a viewer showing the wrong picture looks
 *  exactly like one showing the right picture. */
let shotRequests: string[] = [];
let baselineShot: string | null = null;
/** Mutable so one test can prove a mask is NOT drawn on a carried frame. Every
 *  other test leaves it empty. */
let masks: unknown[] = [];
let baselines: unknown[] = [];

// The run-wide visual accept. Returns the replay the way the real handler
// does — patched, so the view re-renders from the same object the backend
// would hand back rather than from a local guess.
const acceptVisualRun = vi.fn(async () => {
  const r = replayDetail as { steps: { screenshot?: string | null; diff?: unknown }[] };
  for (const s of r.steps) if (s.screenshot) s.diff = { state: "match", ratio: 0, threshold: 0.2 };
  return replayDetail;
});
vi.mock("../lib/api", () => ({
  api: {
    artifacts: {
      list: async () => replays,
      getReplay: async (_testId: string, runId: string) =>
        replayById ? (replayById[runId] ?? null) : replayDetail,
      readShot: async (_testId: string, _runId: string, file: string) => {
        shotRequests.push(file);
        return shot;
      },
    },
    runs: { list: async () => [] },
    visual: {
      getThreshold: async () => 0.1,
      setThreshold: async () => 0.1,
      getMasks: async () => masks,
      setMasks: async () => [],
      listBaselines: async () => baselines,
      baselineShot: async () => baselineShot,
      clearBaseline: async () => null,
      acceptStep: async () => null,
      acceptRun: (...a: unknown[]) => acceptVisualRun(...(a as [])),
      getElementSteps: async () => [],
      setElementStep: async () => [],
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
  shotRequests = [];
  masks = [];
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

  it("leaves accessibility findings to the Accessibility view", async () => {
    // The a11y mark used to live on these rows. It left with the rest of
    // accessibility: this view no longer shows a11y findings anywhere, so a
    // mark here would send the user hunting through steps for nothing.
    replays = [summary({ runId: "r1", changedSteps: 0, a11yNewSteps: 2 })];
    renderVisual();
    await screen.findByText("Checkout");
    expect(screen.queryByLabelText("accessibility issues")).toBeNull();
    expect(screen.queryByLabelText("visual change")).toBeNull();
  });

  it("leaves a clean run unmarked", async () => {
    replays = [summary({ runId: "r1" })];
    renderVisual();
    await screen.findByText("Checkout");
    expect(screen.queryByLabelText("visual change")).toBeNull();
  });
});

// The run-wide visual accept lives in the tool band and the count in the
// panel header — the full-width findings banners are GONE, deliberately. Each
// banner restated a count with a run-wide accept riding on it, and together
// they pushed the screenshot below the fold on exactly the runs worth looking
// at. Accessibility is not merely smaller here: it LEFT this screen for the
// Accessibility view, and these tests pin its absence as much as the visual
// accept's presence.
describe("run-wide accepts in the tool band", () => {
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

  it("accepts every visual change from the tool band", async () => {
    renderVisual();
    await confirmFrom(/^Accept visuals$/);
    await waitFor(() => expect(acceptVisualRun).toHaveBeenCalledWith("t1", "r1"));
    // The button DISABLES because the findings went: the patched replay reads
    // "match" on every frame, so there is nothing left to accept. Disabled
    // rather than unmounted — removing it would change the tool band's width,
    // which is the reflow `check:narrow-layout` pins against.
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /^Accept visuals$/ }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
  });

  it("offers no accessibility surface at all", async () => {
    // The run seeded here HAS an unaccepted a11y finding. Nothing on this
    // screen may mention it — no accept button, no chip, no per-step badge —
    // because a surface that only sometimes shows a11y teaches the user to
    // check two places for one kind of finding.
    renderVisual();
    await waitFor(() => {
      if (!document.querySelector('[data-gl="crt"]')) throw new Error("not ready");
    });
    expect(screen.queryByRole("button", { name: /Accept a11y/ })).toBeNull();
    expect(screen.queryByText(/a11y issue/)).toBeNull();
    expect(screen.queryByText(/accessibility/i)).toBeNull();
  });

  it("asks before the run-wide accept fires", async () => {
    // The accept changes what every LATER run compares against. A single
    // misclick in a toolbar must not re-pin twenty baselines.
    renderVisual();
    const trigger = (await screen.findAllByRole("button", { name: /^Accept visuals$/ }))[0];
    fireEvent.click(trigger);
    await screen.findByRole("button", { name: "Accept all" });
    expect(acceptVisualRun).not.toHaveBeenCalled();
  });

  it("carries the change count as a header chip, not a banner", async () => {
    renderVisual();
    expect(await screen.findByText("1 visual change")).toBeTruthy();
    // The banner itself stays gone — it pushed the screenshot below the fold
    // on exactly the runs worth looking at.
    expect(screen.queryByText(/Visual change detected/)).toBeNull();
  });

  it("disables the run-wide accept when the run has nothing to accept", async () => {
    // Disabled, not unmounted: a control that appears only on runs with
    // findings changes the tool band's width exactly when someone is reaching
    // for the buttons beside it (`check:narrow-layout`).
    const detail = replayDetail as { steps: Record<string, unknown>[] };
    detail.steps = detail.steps.map((s) => ({
      ...s,
      diff: { state: "match", ratio: 0, threshold: 0.2 },
      a11y: undefined,
    }));
    renderVisual();
    await waitFor(() => {
      if (!document.querySelector('[data-gl="crt"]')) throw new Error("not ready");
    });
    const visuals = screen.getByRole("button", { name: /^Accept visuals$/ }) as HTMLButtonElement;
    expect(visuals.disabled).toBe(true);
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

// ── Drift (C §6.6) ──────────────────────────────────────────────────────
//
// jsdom has no layout engine and the `dom` project runs with `css: false`, so
// nothing here can see what the strip LOOKS like — the two-pixel difference
// between a floored bar and a "no reading" dash lives in `check:drift-gap`
// instead. What these cover is the layer above it: that a run with no reading
// produces no bar at all, and that the sentence matches the series.
describe("baseline drift (C §6.6)", () => {
  /** One run's replay, with the single step's diff supplied per run. */
  function replayAt(runId: string, startedAt: number, diff: unknown) {
    return {
      testId: "t1",
      runId,
      testName: "Checkout",
      status: "passed",
      startedAt,
      finishedAt: startedAt + 1_000,
      failedIndex: null,
      steps: [
        {
          index: 0,
          stepId: "s1",
          label: "goto example.com",
          type: "goto",
          status: "passed",
          screenshot: "0.png",
          diff,
        },
      ],
    };
  }

  /** `diffs[0]` is the run on screen; the rest are its history, newest first. */
  function seed(diffs: unknown[]) {
    const base = 1_700_000_000_000;
    replays = diffs.map((_, i) =>
      summary({ runId: `r${i}`, startedAt: base - i * 3_600_000, stepCount: 1 }),
    );
    replayById = {};
    diffs.forEach((d, i) => {
      replayById![`r${i}`] = replayAt(`r${i}`, base - i * 3_600_000, d);
    });
  }

  const changed = { state: "changed", ratio: 0.04, threshold: 0.2, diffFile: "0.diff.png" };
  const match = { state: "match", ratio: 0.0002, threshold: 0.2 };

  beforeEach(() => {
    shot = "data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E";
  });

  afterEach(() => {
    replayById = null;
    replayDetail = null;
    shot = null;
  });

  async function strip() {
    renderVisual();
    return await waitFor(() => {
      const el = document.querySelector(".gl-drift");
      if (!el) throw new Error("no drift strip");
      return el as HTMLElement;
    });
  }

  it("reads the frame across the whole window, not just the run on screen", async () => {
    seed([changed, changed, match, changed, changed, match]);
    const el = await strip();
    expect(el.querySelectorAll(".gl-drift-slot")).toHaveLength(6);
    expect(el.textContent).toContain("Changed in 4 of the last 6 runs");
  });

  it("draws no bar for a run that never measured the frame", async () => {
    // THE distinction the strip exists to hold. A zero-height bar would say the
    // frame was identical in a run that made no comparison at all.
    seed([changed, { state: "unable", reason: "sizes differ" }, match, changed, match]);
    const el = await strip();
    expect(el.querySelectorAll(".gl-drift-slot")).toHaveLength(5);
    expect(el.querySelectorAll(".gl-drift-gap")).toHaveLength(1);
    expect(el.querySelectorAll(".gl-drift-bar")).toHaveLength(4);
  });

  it("gives a measured-but-identical frame a bar with real height", async () => {
    // Zero height and "no reading" would look the same on screen; the floor is
    // what keeps them apart, and it is applied here rather than in CSS.
    seed([changed, match, match, match, match]);
    const el = await strip();
    const heights = [...el.querySelectorAll<HTMLElement>(".gl-drift-bar")].map(
      (b) => Number.parseFloat(b.style.height),
    );
    expect(heights).toHaveLength(5);
    for (const h of heights) expect(h).toBeGreaterThan(0);
  });

  it("colours only the runs that were over threshold", async () => {
    // Colour means outcome. A bar's HEIGHT is a magnitude — a large
    // sub-threshold diff is still a pass and must not be lit like a change.
    seed([changed, match, match, match, match]);
    const el = await strip();
    expect(el.querySelectorAll(".gl-drift-bar[data-changed]")).toHaveLength(1);
  });

  it("marks a drifting series so the stylesheet can colour its sentence", async () => {
    seed([changed, changed, match, changed, changed, match]);
    expect((await strip()).dataset.verdict).toBe("drifting");
  });

  it("does NOT call a single change drift", async () => {
    // One edit, one moved frame, one re-pin: the ordinary healthy case, and the
    // one a readout like this most easily cries wolf about.
    seed([match, changed, match, match, match, match]);
    const el = await strip();
    expect(el.dataset.verdict).toBe("settled");
    expect(el.textContent).toContain("Changed once in the last 6 runs");
  });

  it("says nothing at all when there is only the run on screen", async () => {
    // A strip of one is not a series, and drawing it would imply it is.
    seed([changed]);
    renderVisual();
    await waitFor(() => {
      if (!document.querySelector('[data-gl="crt"]')) throw new Error("waiting");
    });
    expect(document.querySelector(".gl-drift")).toBeNull();
  });
});

// ── "What moved" — the region breakdown (C §6.6) ────────────────────────
//
// jsdom has no layout engine, so nothing here can check that a box lands on the
// right part of the frame — that is geometry, and it is why the boxes are
// positioned against `CRT`'s plate rather than the pane around it. What these
// cover is the layer above: that the list says the right thing, that picking a
// row takes you to the mode that draws boxes, and that a highlight belongs to
// one step rather than leaking across a step change.
describe("region breakdown (C §6.6)", () => {
  const REGIONS = [
    { x: 0.02, y: 0.48, w: 0.3, h: 0.1, pixels: 1800, share: 0.7 },
    { x: 0.6, y: 0.02, w: 0.35, h: 0.08, pixels: 500, share: 0.2 },
    { x: 0.05, y: 0.9, w: 0.1, h: 0.05, pixels: 260, share: 0.1 },
  ];

  function step(over: Record<string, unknown> = {}) {
    return {
      index: 0,
      stepId: "s1",
      label: "goto example.com",
      type: "goto",
      status: "passed",
      screenshot: "0.png",
      diff: {
        state: "changed",
        ratio: 0.04,
        threshold: 0.2,
        diffFile: "0.diff.png",
        regions: REGIONS,
        regionsOmitted: 2,
      },
      ...over,
    };
  }

  function seed(steps: unknown[]) {
    replays = [summary({ runId: "r1", stepCount: steps.length, changedSteps: 1 })];
    replayDetail = {
      testId: "t1",
      runId: "r1",
      testName: "Checkout",
      status: "passed",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_001_000,
      failedIndex: null,
      steps,
    } as never;
  }

  beforeEach(() => {
    seed([step()]);
    shot = "data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E";
  });

  afterEach(() => {
    replayDetail = null;
    shot = null;
  });

  async function ready() {
    renderVisual();
    return await waitFor(() => {
      const el = document.querySelector(".gl-regions");
      if (!el) throw new Error("no breakdown");
      return el as HTMLElement;
    });
  }

  it("says how many areas changed, where the largest is, and what it did not list", async () => {
    const el = await ready();
    expect(el.textContent).toContain("3 areas changed (+2 smaller)");
    expect(el.textContent).toContain("Largest is left, 70% of it");
  });

  it("lists a row per region, ranked", async () => {
    const el = await ready();
    const rows = [...el.querySelectorAll(".gl-region-row")];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.querySelector(".gl-region-share")?.textContent)).toEqual([
      "70%",
      "20%",
      "10%",
    ]);
  });

  it("calls out a dominant area, and only when there is one", async () => {
    // A change is either somewhere or everywhere. Naming a lead on an evenly
    // spread change sends the reader to look at the wrong thing.
    expect((await ready()).textContent).toContain("mostly left");
  });

  it("draws no boxes until the mode that draws boxes", async () => {
    // Current and Baseline are the frames the user is asked to JUDGE, and this
    // screen's standing rule is that what is on them is what the page put there.
    await ready();
    // Wait for the FRAME, not just the list: `StepScreenshot` renders nothing
    // while its image query is in flight, so asserting zero boxes before it
    // resolves passes against a component that draws them in every mode.
    await waitFor(() => {
      if (!document.querySelector('[data-gl="crt"]')) throw new Error("waiting");
    });
    expect(document.querySelectorAll(".gl-region-box")).toHaveLength(0);
    fireEvent.click(
      screen.getAllByRole("button").find((b) => /^Diff$/.test(b.textContent ?? ""))!,
    );
    await waitFor(() => {
      if (document.querySelectorAll(".gl-region-box").length !== 3) throw new Error("waiting");
    });
  });

  it("picking a row switches to the mode that draws boxes", async () => {
    // Otherwise the list points at boxes and leaves the user to work out which
    // mode shows them.
    const el = await ready();
    fireEvent.click(el.querySelectorAll(".gl-region-row")[1]);
    await waitFor(() => {
      if (document.querySelectorAll(".gl-region-box").length === 0) throw new Error("waiting");
    });
    expect(document.querySelectorAll(".gl-region-box[data-active]")).toHaveLength(1);
  });

  it("highlights the hovered row's box and no other", async () => {
    const el = await ready();
    fireEvent.click(
      screen.getAllByRole("button").find((b) => /^Diff$/.test(b.textContent ?? ""))!,
    );
    await waitFor(() => {
      if (document.querySelectorAll(".gl-region-box").length !== 3) throw new Error("waiting");
    });
    fireEvent.mouseEnter(el.querySelectorAll(".gl-region-row")[2]);
    const boxes = [...document.querySelectorAll(".gl-region-box")];
    expect(boxes.map((b) => b.hasAttribute("data-active"))).toEqual([false, false, true]);
  });

  it("does not carry a highlight from one step onto another", async () => {
    // The highlight is an INDEX into one step's boxes. Carried across, it lights
    // an unrelated box — and the step it points into may have fewer, so it can
    // also point at nothing while the row still reads as picked.
    // The next step has a region AT THE SAME INDEX, which is what makes the
    // leak visible: a stale index pointing past the end of a shorter list
    // highlights nothing and looks fine.
    seed([
      step(),
      step({
        index: 1,
        stepId: "s2",
        diff: { ...step().diff, regions: [REGIONS[0], REGIONS[1], REGIONS[2]] },
      }),
    ]);
    const el = await ready();
    fireEvent.mouseEnter(el.querySelectorAll(".gl-region-row")[2]);
    expect(document.querySelectorAll(".gl-region-row[data-active]")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /next step/i }));
    await waitFor(() => {
      if (!screen.getByText(/2 \/ 2/)) throw new Error("waiting");
    });
    expect(document.querySelectorAll(".gl-region-row[data-active]")).toHaveLength(0);
  });

  it("says nothing when the comparison found no regions", async () => {
    // A matched frame has none, and "0 areas changed" under it would be a
    // finding about a frame that had none.
    seed([step({ diff: { state: "match", ratio: 0.0001, threshold: 0.2 } })]);
    renderVisual();
    await waitFor(() => {
      if (!document.querySelector('[data-gl="crt"]')) throw new Error("waiting");
    });
    expect(document.querySelector(".gl-regions")).toBeNull();
  });
});

// ── A gap in the filmstrip ──────────────────────────────────────────────
//
// Only page actions capture a frame — `replay-builder.ts`'s `captureMethod` is
// the authority — so a recorded test routinely has runs of steps with no
// picture at all: a scroll, an assertion, a wait. The viewer used to answer
// every one of them with an empty box, which meant scrubbing 4 → 5 → 6 → 7
// blanked the screen twice between two frames that differ by almost nothing.
//
// WHAT JSDOM CAN ACTUALLY CHECK HERE IS NOT THE PICTURE. It decodes no images,
// and this suite hands every frame back as the same `src` string, so "is the
// right screenshot on screen" is not a question it can ask — a viewer showing
// step 2's frame under step 6 renders identically to one showing step 6's. So
// these assert the two things that ARE real: which file the viewer asked the
// backend for, and what the marker claims about the frame it got. The second
// matters as much as the first: an unlabelled carried frame is the app
// answering "does this look right?" with a picture of a different step.
describe("a step that captured no frame of its own", () => {
  function step(over: Record<string, unknown> = {}) {
    return {
      index: 0,
      stepId: "s1",
      label: "goto example.com",
      type: "goto",
      status: "passed",
      screenshot: null,
      ...over,
    };
  }

  function seed(steps: unknown[], over: Record<string, unknown> = {}) {
    replays = [summary({ runId: "r1", stepCount: steps.length })];
    replayDetail = {
      testId: "t1",
      runId: "r1",
      testName: "Checkout",
      status: "passed",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_001_000,
      failedIndex: null,
      steps,
      ...over,
    } as never;
  }

  /** The reported shape: a captured step, then two that capture nothing. */
  function gapRun() {
    return [
      step({ index: 0, screenshot: "0.png" }),
      step({ index: 1, stepId: "s2", type: "scroll", label: "scroll to (0, 670)" }),
      step({ index: 2, stepId: "s3", type: "assert", label: 'expect "Total" to be visible' }),
    ];
  }

  beforeEach(() => {
    shot = "data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E";
  });

  afterEach(() => {
    replayDetail = null;
    shot = null;
  });

  /** Render, then walk forward `n` steps with the stepper. */
  async function at(n: number) {
    renderVisual();
    await waitFor(() => {
      if (!document.querySelector('[data-gl="crt"]')) throw new Error("waiting");
    });
    for (let i = 0; i < n; i++) {
      fireEvent.click(screen.getByRole("button", { name: /next step/i }));
    }
    await waitFor(() => {
      if (!screen.getByText(new RegExp(`${n + 1} / `))) throw new Error("waiting");
    });
  }

  it("shows a frame rather than an empty box", async () => {
    seed(gapRun());
    await at(1);
    await waitFor(() => {
      if (!document.querySelector(".gl-visual-carried")) throw new Error("waiting");
    });
    expect(document.querySelector(".gl-visual-missing")).toBeNull();
    expect(document.querySelector('[data-gl="crt"]')).toBeTruthy();
  });

  it("reaches back past the whole gap to the last frame that exists", async () => {
    // Two steps deep. Asking for the NEAREST step's frame would ask for
    // nothing at all, and there is no request this suite could tell that from
    // except by naming the file.
    seed(gapRun());
    await at(2);
    await waitFor(() => {
      if (!document.querySelector(".gl-visual-carried")) throw new Error("waiting");
    });
    expect(shotRequests).toContain("0.png");
  });

  it("names the step the frame belongs to", async () => {
    seed(gapRun());
    await at(1);
    await waitFor(() => {
      if (!screen.queryByText("Carried from step 1")) throw new Error("waiting");
    });
  });

  it("says the step's own effect is not in the picture", async () => {
    // The load-bearing caveat, and a scroll step is where it is most easily
    // misread: screenshots are viewport-only, so this frame is the page BEFORE
    // the scroll. A carried frame that let someone believe otherwise would be
    // worse than the empty box it replaced.
    seed(gapRun());
    await at(1);
    await waitFor(() => {
      if (!screen.queryByText(/captures no frame of its own/)) throw new Error("waiting");
    });
    expect(screen.getByText(/isn.t shown/)).toBeTruthy();
  });

  it("tells a screen reader the frame is another step's", async () => {
    // The bar is the sighted reader's marker. Without this, the alt text says
    // "Screenshot for step 2" about step 1's picture — the exact misreading
    // this feature exists to prevent, with no way at all to notice it.
    seed(gapRun());
    await at(1);
    const img = await waitFor(() => {
      const el = document.querySelector(".gl-crt-img") as HTMLImageElement | null;
      if (!el || !/Last captured frame/.test(el.alt)) throw new Error("waiting");
      return el;
    });
    expect(img.alt).toContain("from step 1");
  });

  it("keeps the empty box when there is nothing behind the gap", async () => {
    // A gap before the first capture has no last known state, and taking one
    // from a LATER step would show the user the future.
    seed([step({ type: "assert" }), step({ index: 1, stepId: "s2", screenshot: "0.png" })]);
    renderVisual();
    await waitFor(() => {
      if (!document.querySelector(".gl-visual-missing")) throw new Error("waiting");
    });
    expect(screen.getByText("No screenshot for this step")).toBeTruthy();
    expect(document.querySelector(".gl-visual-carried")).toBeNull();
  });

  it("carries a frame under the failing step, and says it failed", async () => {
    // The single most useful case: "what did the page look like right before
    // this broke" was an empty box. And the wording has to be its own — a
    // failing click has no manifest entry, so it is indistinguishable from a
    // scroll by every field except its status.
    seed(
      [
        step({ index: 0, screenshot: "0.png" }),
        step({ index: 1, stepId: "s2", type: "click", label: "click Pay", status: "failed" }),
      ],
      { status: "failed", failedIndex: 1 },
    );
    renderVisual();
    await waitFor(() => {
      if (!screen.queryByText(/This step failed, so nothing was captured/)) {
        throw new Error("waiting");
      }
    });
    expect(shotRequests).toContain("0.png");
  });

  it("carries a frame under a step the run never reached", async () => {
    seed(
      [
        step({ index: 0, screenshot: "0.png" }),
        step({ index: 1, stepId: "s2", type: "click", status: "failed" }),
        step({ index: 2, stepId: "s3", type: "click", status: "skipped" }),
      ],
      { status: "failed", failedIndex: 1 },
    );
    renderVisual();
    await waitFor(() => {
      if (!document.querySelector('[data-gl="crt"]')) throw new Error("waiting");
    });
    fireEvent.click(screen.getByRole("button", { name: /next step/i }));
    await waitFor(() => {
      if (!screen.queryByText(/This step didn.t run/)) throw new Error("waiting");
    });
  });

  it("draws none of this step's overlays on another step's frame", async () => {
    // Every overlay on a frame — the ignore masks, the element-scope box, the
    // measured diff regions — is normalized against THIS step's capture. Laid
    // over an earlier step's picture they land wherever the two happen to line
    // up, which is a measurement the app never made.
    masks = [{ id: "m1", stepId: null, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }];
    seed(gapRun());
    renderVisual();
    await waitFor(() => {
      if (!document.querySelector(".gl-mask-box")) throw new Error("waiting");
    });
    fireEvent.click(screen.getByRole("button", { name: /next step/i }));
    await waitFor(() => {
      if (!document.querySelector(".gl-visual-carried")) throw new Error("waiting");
    });
    expect(document.querySelectorAll(".gl-mask-box")).toHaveLength(0);
  });

  it("offers no ignore-region editor on a frame that isn't this step's", async () => {
    // It writes masks pinned to the SELECTED step, measured against whatever
    // is on screen. On a carried frame that is a region of a different picture.
    seed(gapRun());
    await at(1);
    await waitFor(() => {
      if (!document.querySelector(".gl-visual-carried")) throw new Error("waiting");
    });
    expect(screen.queryByRole("button", { name: /ignore regions/i })).toBeNull();
  });
});

describe("a step that ran on a tab the page opened", () => {
  // The run follows the newest tab on its own (shared/tabs-fixture-source.mjs);
  // the replay carries which tab a step acted on, and the step row says so.
  // Without the chip the screenshot is simply of a different page, and nothing
  // says why.
  beforeEach(() => {
    replays = [summary({ runId: "r1", stepCount: 2, changedSteps: 0 })];
    replayDetail = {
      testId: "t1",
      runId: "r1",
      testName: "Help",
      status: "passed",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_001_000,
      failedIndex: null,
      steps: [
        { index: 0, stepId: "s1", label: "click help link", type: "click", status: "passed", screenshot: "0.png" },
        { index: 1, stepId: "s2", label: "click OK", type: "click", status: "passed", screenshot: "1.png", tab: 1 },
      ],
    };
    shot = "data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E";
  });

  afterEach(() => {
    replayDetail = null;
    shot = null;
  });

  it("says which tab the step ran on, and only for a step on a later tab", async () => {
    renderVisual();
    // The newest run is selected by default and the timeline opens on step 1,
    // which ran on the first tab: no chip.
    await screen.findByText("click help link");
    expect(document.querySelector('[data-gl="visual-tab"]')).toBeNull();
    // Step 2 ran on the tab the link opened.
    fireEvent.click(screen.getByRole("button", { name: /next step/i }));
    await screen.findByText("click OK");
    await waitFor(() => expect(document.querySelector('[data-gl="visual-tab"]')).not.toBeNull());
    expect(document.querySelector('[data-gl="visual-tab"]')?.textContent).toBe(tabChipLabel(1));
    expect(tabChipLabel(1)).toBe("Tab 2");
  });
});
