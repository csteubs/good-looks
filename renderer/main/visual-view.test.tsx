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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { ReplayStep, RunReplay, RunReplaySummary, VisualDiff } from "../lib/recorder-types";
import { DiffBadge, VisualView } from "./visual-view";

let replays: RunReplaySummary[] = [];
let replay: RunReplay | null = null;

vi.mock("../lib/api", () => ({
  api: {
    artifacts: {
      list: async () => replays,
      getReplay: async () => replay,
      readShot: async () => null,
    },
    runs: { list: async () => [] },
    visual: {
      getThreshold: async () => 0.1,
      setThreshold: async () => 0.1,
      getMasks: async () => [],
      setMasks: async () => [],
      listBaselines: async () => [],
      baselineShot: async () => null,
      clearBaseline: async () => null,
      acceptStep: async () => null,
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
  replay = null;
});

function replayStep(over: Partial<ReplayStep> & { index: number }): ReplayStep {
  return {
    stepId: `s${over.index}`,
    label: `Step ${over.index}`,
    type: "click",
    status: "passed",
    screenshot: `${over.index}.png`,
    ...over,
  } as ReplayStep;
}

function fullReplay(steps: ReplayStep[]): RunReplay {
  return {
    testId: "t1",
    runId: "r1",
    testName: "Checkout",
    status: "passed",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    failedIndex: null,
    visualThreshold: 0.1,
    steps,
  };
}

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

describe("steps that never compared", () => {
  // The failure this suite exists for is a gap, not a wrong answer: a step
  // whose comparison degraded to "unable" is neither passing nor failing its
  // visual check, and the run still reports "0 visual changes". Without a
  // count and a reason on screen, a run where every step silently stopped
  // comparing looks exactly like a clean one.

  async function renderRunWith(steps: ReplayStep[]) {
    replays = [summary({ runId: "r1" })];
    replay = fullReplay(steps);
    renderVisual();
    // Wait for CONTENT, not the container: the viewer renders before its query
    // resolves, so asserting too early passes against an empty pane.
    await screen.findByText("Step 0");
  }

  it("counts and explains steps that could not be compared", async () => {
    await renderRunWith([
      replayStep({ index: 0, diff: { state: "match", ratio: 0 } }),
      replayStep({
        index: 1,
        diff: { state: "unable", reason: "size mismatch (baseline 800×600, new 800×640)" },
      }),
      replayStep({ index: 2, diff: { state: "unable", reason: "screenshot unreadable" } }),
    ]);

    expect(await screen.findByText("2 not compared")).toBeTruthy();
    const callout = await screen.findByText(/could not be compared to a baseline/i);
    expect(callout.textContent).toMatch(/2 steps/);
    // Both distinct reasons are named — "2 steps couldn't compare" without
    // saying why is a dead end for whoever has to fix it.
    expect(callout.textContent).toMatch(/size mismatch/);
    expect(callout.textContent).toMatch(/screenshot unreadable/);
  });

  it("says it in the singular for one step", async () => {
    await renderRunWith([
      replayStep({ index: 0, diff: { state: "unable", reason: "empty image" } }),
    ]);
    expect(await screen.findByText("1 not compared")).toBeTruthy();
    expect((await screen.findByText(/could not be compared/i)).textContent).toMatch(/1 step\b/);
  });

  it("does not repeat a reason shared by several steps", async () => {
    await renderRunWith([
      replayStep({ index: 0, diff: { state: "unable", reason: "size mismatch" } }),
      replayStep({ index: 1, diff: { state: "unable", reason: "size mismatch" } }),
    ]);
    const callout = await screen.findByText(/could not be compared/i);
    expect(callout.textContent?.match(/size mismatch/g)).toHaveLength(1);
  });

  it("stays quiet when every step compared", async () => {
    await renderRunWith([
      replayStep({ index: 0, diff: { state: "match", ratio: 0 } }),
      replayStep({ index: 1, diff: { state: "changed", ratio: 0.02 } }),
    ]);
    // The orange "changed" banner is the one that should show here.
    expect(await screen.findByText(/Visual change detected/i)).toBeTruthy();
    expect(screen.queryByText(/not compared/i)).toBeNull();
    expect(screen.queryByText(/could not be compared/i)).toBeNull();
  });

  it("puts the reason in the step row, not only in a hover", async () => {
    // The badge's title attribute is invisible to anyone who isn't already
    // suspicious, and for this state the reason IS the result.
    await renderRunWith([
      replayStep({ index: 0, diff: { state: "unable", reason: "size mismatch" } }),
    ]);
    expect(await screen.findByText(/Not compared: size mismatch/)).toBeTruthy();
  });
});
