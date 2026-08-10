// The run Output panel's "Debug with AI" icon.
//
// Two things here are easy to get wrong and silent when wrong. First, the icon
// used to render ONLY for a failed run — which meant a minimized job vanished
// the moment the test was re-run and passed, stranding it. Second, the colour
// is the status: a wrong one tells the user to walk away from a finished answer
// or to keep waiting on one that already failed.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { toneFor } from "../lib/ai-debug-status";
import type { AiDebugStatus } from "../lib/recorder-types";
import { RunOutput } from "./run-output";
import type { RunInfo } from "./recorder-store";

// The panel now carries a triage line, which queries on mount. Mocked to "no
// verdict" so these tests stay about the AI debug icon — run-triage.test.tsx
// covers the line itself.
vi.mock("../lib/api", () => ({
  api: { runs: { triage: async () => null } },
}));

function info(over: Partial<RunInfo> = {}): RunInfo {
  return { lines: ["output line\n"], running: false, code: 1, stepStatus: {}, startedAt: 1, ...over };
}

const debugButton = () =>
  screen
    .queryAllByRole("button")
    .find((b) => (b.getAttribute("aria-label") ?? "").match(/Debug with AI|AI /)) ?? null;

describe("the AI debug icon", () => {
  it("appears for a failed run with no session yet", () => {
    render(<RunOutput info={info({ code: 1 })} onDebug={vi.fn()} />);
    expect(screen.getByLabelText("Debug with AI")).toBeTruthy();
  });

  it("stays hidden for a passing run with no session", () => {
    render(<RunOutput info={info({ code: 0 })} onDebug={vi.fn()} />);
    expect(debugButton()).toBeNull();
  });

  it("stays visible on a passing run once a session exists", () => {
    // The regression this pins: re-running a test successfully must not hide
    // the only way back to a job that is still running.
    render(<RunOutput info={info({ code: 0 })} onDebug={vi.fn()} aiStatus="streaming" />);
    expect(screen.getByLabelText(toneFor("streaming").label)).toBeTruthy();
  });

  it("stays hidden while a run is still going and nothing has been asked yet", () => {
    render(<RunOutput info={info({ running: true, code: null })} onDebug={vi.fn()} />);
    expect(debugButton()).toBeNull();
  });

  it("is absent entirely when the view supplies no handler", () => {
    render(<RunOutput info={info({ code: 1 })} />);
    expect(debugButton()).toBeNull();
  });

  it("carries each status's colour and label", () => {
    const cases: AiDebugStatus[] = ["idle", "streaming", "done", "error", "cancelled", "interrupted"];
    for (const status of cases) {
      const tone = toneFor(status);
      const { unmount } = render(
        <RunOutput info={info({ code: 1 })} onDebug={vi.fn()} aiStatus={status} />,
      );
      const button = screen.getByLabelText(tone.label);
      // The icon, not the button, carries the colour class.
      expect(button.querySelector("svg")?.getAttribute("class") ?? "").toContain(tone.className);
      unmount();
    }
  });

  it("pulses only while the model is thinking", () => {
    const { unmount } = render(
      <RunOutput info={info({ code: 1 })} onDebug={vi.fn()} aiStatus="streaming" />,
    );
    expect(
      screen.getByLabelText(toneFor("streaming").label).querySelector("svg")?.getAttribute("class"),
    ).toContain("animate-pulse");
    unmount();

    render(<RunOutput info={info({ code: 1 })} onDebug={vi.fn()} aiStatus="done" />);
    expect(
      screen.getByLabelText(toneFor("done").label).querySelector("svg")?.getAttribute("class"),
    ).not.toContain("animate-pulse");
  });

  it("restores the session when clicked", () => {
    const onDebug = vi.fn();
    render(<RunOutput info={info({ code: 1 })} onDebug={onDebug} aiStatus="done" />);
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
    render(<RunOutput info={info({ code: 0 })} />);
    expect(chip()?.dataset.tone).toBe("phos");
    expect(chip()?.textContent).toBe("Passed");
  });

  it("reports a failure in the fail tone", () => {
    render(<RunOutput info={info({ code: 1 })} />);
    expect(chip()?.dataset.tone).toBe("red");
    expect(chip()?.textContent).toBe("Failed");
  });

  it("shows a run still in flight as running, which is NOT one of the tones", () => {
    // Running is the absence of an outcome. Give it a status hue and a run
    // still in flight looks like one that finished and reported something —
    // which is the single most misleading thing this panel could do.
    render(<RunOutput info={info({ running: true, code: null })} />);
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
    render(<RunOutput info={info()} />);
    expect(expander().getAttribute("aria-expanded")).toBe("false");
    expect(panel().className).not.toContain("gl-run-panel-expanded");
  });

  it("expands to take the pane", () => {
    // 224px is about eight lines of console: enough to see that something
    // failed, never enough to read the stack that says why.
    render(<RunOutput info={info()} />);
    fireEvent.click(expander());
    expect(expander().getAttribute("aria-expanded")).toBe("true");
    expect(panel().className).toContain("gl-run-panel-expanded");
  });

  it("offers the control even when there is nothing to expand yet", () => {
    // Deliberately not gated on the output being long. A control that appears
    // only once the log happens to overflow is one nobody learns is there.
    render(<RunOutput info={info({ lines: [], running: true, code: null })} />);
    expect(expander()).toBeTruthy();
  });
});
