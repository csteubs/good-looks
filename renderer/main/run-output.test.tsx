// The run Output panel's "Debug with AI" icon.
//
// Two things here are easy to get wrong and silent when wrong. First, the icon
// used to render ONLY for a failed run — which meant a minimized job vanished
// the moment the test was re-run and passed, stranding it. Second, the colour
// is the status: a wrong one tells the user to walk away from a finished answer
// or to keep waiting on one that already failed.

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { toneFor } from "../lib/ai-debug-status";
import type { AiDebugStatus } from "../lib/recorder-types";
import { RunOutput } from "./run-output";
import { summariseRun } from "../lib/run-summary";
import type { RunInfo } from "./recorder-store";

// The panel now carries a triage line and a failure-reason row, both of which
// query on mount. Mocked to "no verdict" and an empty history so these tests
// stay about the AI debug icon — run-triage.test.tsx covers the line and
// run-failure-reason.test.tsx the row.
vi.mock("../lib/api", () => ({
  api: {
    runs: { triage: async () => null, list: async () => [] },
    failureReasons: { list: async () => ({ builtin: [], custom: [] }) },
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
