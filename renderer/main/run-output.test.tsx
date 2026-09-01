// The run Output panel's "Debug with AI" icon, and the tabbed console it
// became.
//
// Two things here are easy to get wrong and silent when wrong. First, the icon
// used to render ONLY for a failed run — which meant a minimized job vanished
// the moment the test was re-run and passed, stranding it. Second, the colour
// is the status: a wrong one tells the user to walk away from a finished answer
// or to keep waiting on one that already failed.

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { toneFor } from "../lib/ai-debug-status";
import type { AiDebugStatus, Step } from "../lib/recorder-types";
import { RunOutput } from "./run-output";
import { summariseRun } from "../lib/run-summary";
import type { RunInfo } from "./recorder-store";

// The panel now carries a triage line and a failure-reason row, both of which
// query on mount. Mocked to "no verdict" and an empty history so these tests
// stay about the AI debug icon — run-triage.test.tsx covers the line and
// run-failure-reason.test.tsx the row. The artifacts arm feeds the History
// tab, whose own behaviour lives in run-history-panel.test.tsx.
vi.mock("../lib/api", () => ({
  api: {
    runs: { triage: async () => null, list: async () => [] },
    failureReasons: { list: async () => ({ builtin: [], custom: [] }) },
    artifacts: {
      list: async () => [],
      getReplay: async () => null,
      readShot: async () => null,
    },
  },
}));

function info(over: Partial<RunInfo> = {}): RunInfo {
  return { lines: ["output line\n"], running: false, code: 1, stepStatus: {}, startedAt: 1, ...over };
}

// The summary the view would compute for this run, from the real function
// rather than a hand-written literal — these tests are about the panel, and a
// literal here would keep passing after the mapping it depends on changed.
// No history, so a passing run is a plain `passed` and a failing one `failed`.
// One shared client — every query here resolves to the same empty fixtures.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Panel({ info: live, ...rest }: { info: RunInfo } & Omit<React.ComponentProps<typeof RunOutput>, "info" | "summary">) {
  return (
    <QueryClientProvider client={queryClient}>
      <RunOutput
        info={live}
        summary={summariseRun({ testId: "t1", runs: [], heals: [], stepCount: 3, live, now: 0 })}
        {...rest}
      />
    </QueryClientProvider>
  );
}

const debugButton = () =>
  screen
    .queryAllByRole("button")
    .find((b) => (b.getAttribute("aria-label") ?? "").match(/Debug with AI|AI /)) ?? null;

// A dragged height persists in localStorage (the SplitView idiom), and jsdom's
// localStorage persists across tests in a file — so a resize in one test would
// silently reseed every panel rendered after it.
beforeEach(() => {
  window.localStorage.removeItem("runpanel:height");
});

describe("the AI debug icon", () => {
  it("appears for a failed run with no session yet", () => {
    render(<Panel info={info({ code: 1 })} onDebug={vi.fn()} />);
    expect(screen.getByLabelText("Debug with AI")).toBeTruthy();
  });

  it("stays hidden for a passing run with no session", () => {
    render(<Panel info={info({ code: 0 })} onDebug={vi.fn()} />);
    expect(debugButton()).toBeNull();
  });

  it("stays visible on a passing run once a session exists", () => {
    // The regression this pins: re-running a test successfully must not hide
    // the only way back to a job that is still running.
    render(<Panel info={info({ code: 0 })} onDebug={vi.fn()} aiStatus="streaming" />);
    expect(screen.getByLabelText(toneFor("streaming").label)).toBeTruthy();
  });

  it("stays hidden while a run is still going and nothing has been asked yet", () => {
    render(<Panel info={info({ running: true, code: null })} onDebug={vi.fn()} />);
    expect(debugButton()).toBeNull();
  });

  it("is absent entirely when the view supplies no handler", () => {
    render(<Panel info={info({ code: 1 })} />);
    expect(debugButton()).toBeNull();
  });

  it("carries each status's colour and label", () => {
    const cases: AiDebugStatus[] = ["idle", "streaming", "done", "error", "cancelled", "interrupted"];
    for (const status of cases) {
      const tone = toneFor(status);
      const { unmount } = render(
        <Panel info={info({ code: 1 })} onDebug={vi.fn()} aiStatus={status} />,
      );
      const button = screen.getByLabelText(tone.label);
      // The icon, not the button, carries the colour class.
      expect(button.querySelector("svg")?.getAttribute("class") ?? "").toContain(tone.className);
      unmount();
    }
  });

  it("pulses only while the model is thinking", () => {
    const { unmount } = render(
      <Panel info={info({ code: 1 })} onDebug={vi.fn()} aiStatus="streaming" />,
    );
    expect(
      screen.getByLabelText(toneFor("streaming").label).querySelector("svg")?.getAttribute("class"),
    ).toContain("animate-pulse");
    unmount();

    render(<Panel info={info({ code: 1 })} onDebug={vi.fn()} aiStatus="done" />);
    expect(
      screen.getByLabelText(toneFor("done").label).querySelector("svg")?.getAttribute("class"),
    ).not.toContain("animate-pulse");
  });

  it("restores the session when clicked", () => {
    const onDebug = vi.fn();
    render(<Panel info={info({ code: 1 })} onDebug={onDebug} aiStatus="done" />);
    screen.getByLabelText(toneFor("done").label).click();
    expect(onDebug).toHaveBeenCalledTimes(1);
  });
});

describe("the verdict chip", () => {
  // One shape, one width, the palette's tones — `StatusChip`, not the SDK
  // `Status` badge this replaced. The width is the point: a chip sized to its
  // own word gives a column of runs a ragged edge, which fails one row at a
  // time and looks fine in isolation.
  const chip = () => document.querySelector('[data-gl="status-chip"]') as HTMLElement | null;

  it("reports a pass in the pass tone", () => {
    render(<Panel info={info({ code: 0 })} />);
    expect(chip()?.dataset.tone).toBe("phos");
    expect(chip()?.textContent).toBe("Passed");
  });

  it("reports a failure in the fail tone", () => {
    render(<Panel info={info({ code: 1 })} />);
    expect(chip()?.dataset.tone).toBe("red");
    expect(chip()?.textContent).toBe("Failed");
  });

  it("shows a run still in flight as running, which is NOT one of the tones", () => {
    // Running is the absence of an outcome. Give it a status hue and a run
    // still in flight looks like one that finished and reported something —
    // which is the single most misleading thing this panel could do.
    render(<Panel info={info({ running: true, code: null })} />);
    expect(chip()?.dataset.tone).toBe("running");
    for (const tone of ["phos", "red", "amber", "cyan"]) {
      expect(chip()?.dataset.tone).not.toBe(tone);
    }
  });
});

describe("the log drawer", () => {
  const expander = () => screen.getByRole("button", { name: /the run output/i });
  const panel = () => document.querySelector('[data-gl="run-panel"]') as HTMLElement;

  it("starts collapsed", () => {
    render(<Panel info={info()} />);
    expect(expander().getAttribute("aria-expanded")).toBe("false");
    expect(panel().className).not.toContain("gl-run-panel-expanded");
  });

  it("expands to take the pane", () => {
    // 224px is about eight lines of console: enough to see that something
    // failed, never enough to read the stack that says why.
    render(<Panel info={info()} />);
    fireEvent.click(expander());
    expect(expander().getAttribute("aria-expanded")).toBe("true");
    expect(panel().className).toContain("gl-run-panel-expanded");
  });

  it("offers the control even when there is nothing to expand yet", () => {
    // Deliberately not gated on the output being long. A control that appears
    // only once the log happens to overflow is one nobody learns is there.
    render(<Panel info={info({ lines: [], running: true, code: null })} />);
    expect(expander()).toBeTruthy();
  });
});

// ── The tabbed console (2026-09-01) ───────────────────────────────────
//
// The panel now wears the trainer console's clothes: a tab strip in the head
// (Console / Step details / History), a status bar over the log with the same
// "Done — N/M passed" reading and hit-rate pill, and the auto-scroll toggle.
// What these pin is the parts that would fail silently: a bar that counts
// wrong, a step row that reports the wrong verdict, and the compact-panel rule
// that used to key on `:has(.gl-run-log)` and would collapse the strip under
// the other tabs now that the log unmounts with its tab.

/** Switch tabs. Radix's TabsTrigger activates on pointer-down/focus rather
 *  than a bare click — fireEvent.click alone leaves the tab unchanged and the
 *  assertions silently run against the previous tab's content. */
function selectTab(name: RegExp | string) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab);
  fireEvent.focus(tab);
  fireEvent.click(tab);
  return tab;
}

let stepSeq = 0;
function step(over: Partial<Step> = {}): Step {
  stepSeq += 1;
  return {
    id: `s${stepSeq}`,
    timestamp: stepSeq,
    type: "click",
    locator: { k: "role", role: "button", name: "Submit" },
    ...over,
  } as Step;
}

describe("the console tabs", () => {
  it("carries the trainer console's strip: Console, Step details, and History", () => {
    render(<Panel info={info()} />);
    expect(screen.getByRole("tab", { name: "Console" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Step details" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "History" })).toBeTruthy();
  });

  it("reads a finished run over the log the way the trainer does", () => {
    render(
      <Panel
        info={info({ code: 0, stepStatus: { 0: "passed", 1: "passed" } })}
        steps={[step(), step()]}
      />,
    );
    expect(screen.getByText("Done — 2/2 passed")).toBeTruthy();
    expect(screen.getByText("100% hit rate").className).toContain("text-support-green");
  });

  it("names the step a failed run stopped at, and grades the hit rate", () => {
    render(
      <Panel
        info={info({ code: 1, stepStatus: { 0: "passed", 1: "failed" } })}
        steps={[step(), step()]}
      />,
    );
    expect(screen.getByText("Stopped at step 2 — 1/2 passed")).toBeTruthy();
    expect(screen.getByText("50% hit rate").className).toContain("text-support-yellow");
  });

  it("says so when a run reported no steps at all, instead of 0/0", () => {
    // A spec that failed to load settles nothing; "Done — 0/0 passed" would
    // read as an empty suite that passed.
    render(<Panel info={info({ code: 1, stepStatus: {} })} steps={[step()]} />);
    expect(screen.getByText(/No per-step results/)).toBeTruthy();
  });

  it("offers Auto-scroll on the Console tab only", () => {
    render(<Panel info={info()} />);
    expect(screen.getByLabelText("Auto-scroll console")).toBeTruthy();
    selectTab("Step details");
    expect(screen.queryByLabelText("Auto-scroll console")).toBeNull();
  });
});

describe("the Step details tab", () => {
  const rows = () => document.querySelectorAll('[data-gl="step-detail"]');

  it("reports each step's outcome beside its locator", () => {
    render(
      <Panel
        info={info({ code: 1, stepStatus: { 0: "passed", 1: "failed" } })}
        steps={[step(), step()]}
      />,
    );
    selectTab("Step details");
    expect(rows()).toHaveLength(2);
    expect(rows()[0].getAttribute("data-status")).toBe("passed");
    expect(rows()[1].getAttribute("data-status")).toBe("failed");
    expect(rows()[0].textContent).toContain("Step 1");
    // The locator the step stands on, in the app's own spelling.
    expect(rows()[0].textContent).toContain('getByRole("button"');
  });

  it("shows a dash, not a verdict, for steps the run never reached", () => {
    render(<Panel info={info({ code: 1, stepStatus: { 0: "passed" } })} steps={[step(), step()]} />);
    selectTab("Step details");
    expect(rows()[1].getAttribute("data-status")).toBe("idle");
  });
});

describe("the panel without a live run", () => {
  function ColdPanel({ testId }: { testId?: string }) {
    return (
      <QueryClientProvider client={queryClient}>
        <RunOutput
          summary={summariseRun({ testId: "t1", runs: [], heals: [], stepCount: 3, live: null, now: 0 })}
          testId={testId}
          runs={[]}
        />
      </QueryClientProvider>
    );
  }
  const panel = () => document.querySelector('[data-gl="run-panel"]') as HTMLElement;

  it("keeps the console surface: a bar saying why it is empty, over the log area", () => {
    render(<ColdPanel />);
    expect(screen.getByText(/output streams here/i)).toBeTruthy();
    expect(document.querySelector(".gl-run-log")).toBeTruthy();
    // The expand drawer stays too — every tab has the strip to hand over now.
    expect(screen.getByRole("button", { name: /the run output/i })).toBeTruthy();
  });

  it("holds ONE height across all three tabs", () => {
    // The first cut shrank the Console tab to its summary when nothing was
    // live, which made the three tabs three different panels — and the
    // console the cramped one. The panel must not change size under the
    // pointer when a tab is clicked.
    render(<ColdPanel testId="t1" />);
    expect(panel().hasAttribute("data-compact")).toBe(false);
    const resting = panel().style.flexBasis;
    expect(resting).toBe("224px");
    selectTab("History");
    expect(panel().style.flexBasis).toBe(resting);
    expect(screen.getByText("No runs recorded yet")).toBeTruthy();
    selectTab("Step details");
    expect(panel().style.flexBasis).toBe(resting);
    selectTab("Console");
    expect(panel().style.flexBasis).toBe(resting);
  });
});

describe("resizing the console", () => {
  const handle = () => screen.getByRole("separator", { name: /resize the console/i });
  const panel = () => document.querySelector('[data-gl="run-panel"]') as HTMLElement;

  function drag(fromY: number, toY: number) {
    fireEvent.pointerDown(handle(), { clientY: fromY, pointerId: 1 });
    fireEvent.pointerMove(window, { clientY: toY });
    fireEvent.pointerUp(window, { clientY: toY });
  }

  it("drags the top edge, and remembers where it was dropped", () => {
    render(<Panel info={info()} />);
    // jsdom has no layout, so the drag starts from the state height (224).
    drag(500, 440);
    expect(panel().style.flexBasis).toBe("284px");
    expect(window.localStorage.getItem("runpanel:height")).toBe("284");
  });

  it("restores the remembered height on the next mount", () => {
    window.localStorage.setItem("runpanel:height", "300");
    render(<Panel info={info()} />);
    expect(panel().style.flexBasis).toBe("300px");
  });

  it("cannot be dragged away entirely, nor over the step list", () => {
    render(<Panel info={info()} />);
    drag(100, 5000);
    expect(panel().style.flexBasis).toBe("140px");
    drag(500, -5000);
    // The ceiling leaves the toolbar and tab strip their room, whatever the
    // window height is — jsdom's included.
    expect(panel().style.flexBasis).toBe(`${Math.max(140, window.innerHeight - 220)}px`);
  });

  it("resizes from the keyboard", () => {
    render(<Panel info={info()} />);
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(panel().style.flexBasis).toBe("248px");
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    expect(panel().style.flexBasis).toBe("224px");
  });

  it("double-click puts the resting height back", () => {
    window.localStorage.setItem("runpanel:height", "400");
    render(<Panel info={info()} />);
    expect(panel().style.flexBasis).toBe("400px");
    fireEvent.doubleClick(handle());
    expect(panel().style.flexBasis).toBe("224px");
    expect(window.localStorage.getItem("runpanel:height")).toBe("224");
  });

  it("a drag from the expanded panel leaves expanded and lands where dropped", () => {
    // Grabbing an edge means "put it where I drop it" — staying expanded
    // would make the drag a no-op and the handle a lie.
    render(<Panel info={info()} />);
    fireEvent.click(screen.getByRole("button", { name: /expand the run output/i }));
    expect(panel().className).toContain("gl-run-panel-expanded");
    drag(300, 320);
    expect(panel().className).not.toContain("gl-run-panel-expanded");
    expect(panel().style.flexBasis).toBe("204px");
  });
});

describe("the Open Trace icon", () => {
  const failedRun = {
    id: "r-1",
    testId: "t1",
    testName: "T",
    url: "https://x.test",
    status: "failed" as const,
    exitCode: 1,
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    logFile: "/tmp/r.log",
  };
  function HistoryPanel(props: Partial<React.ComponentProps<typeof RunOutput>>) {
    return (
      <QueryClientProvider client={queryClient}>
        <RunOutput
          summary={summariseRun({
            testId: "t1",
            runs: [failedRun as never],
            heals: [],
            stepCount: 3,
            live: null,
            now: 10,
          })}
          {...props}
        />
      </QueryClientProvider>
    );
  }

  it("opens the salvaged trace for the failed run that has one", () => {
    const onOpenTrace = vi.fn();
    render(<HistoryPanel hasTrace onOpenTrace={onOpenTrace} />);
    fireEvent.click(screen.getByLabelText(/open this failure's playwright trace/i));
    expect(onOpenTrace).toHaveBeenCalledWith("r-1");
  });

  it("offers nothing when the run kept no trace", () => {
    render(<HistoryPanel hasTrace={false} onOpenTrace={vi.fn()} />);
    expect(screen.queryByLabelText(/playwright trace/i)).toBeNull();
  });
});
