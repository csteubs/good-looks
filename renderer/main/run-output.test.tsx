// The run Output panel's "Debug with AI" icon.
//
// Two things here are easy to get wrong and silent when wrong. First, the icon
// used to render ONLY for a failed run — which meant a minimized job vanished
// the moment the test was re-run and passed, stranding it. Second, the colour
// is the status: a wrong one tells the user to walk away from a finished answer
// or to keep waiting on one that already failed.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { toneFor } from "../lib/ai-debug-status";
import type { AiDebugStatus } from "../lib/recorder-types";
import { RunOutput } from "./run-output";
import type { RunInfo } from "./recorder-store";

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
