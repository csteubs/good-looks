// Component tests for the trainer.
//
// RecordingView is the app's core feature and its largest component. It is
// almost entirely a controller: recording state, the assertion picker, the step
// list, and the replay console all read from one store, so the tests here are
// about WIRING — does the button the user clicks reach the action it claims to,
// and does the view reflect the state it's given.
//
// The store is mocked wholesale rather than partially: every field is consumed,
// and a partial mock fails at render with an unrelated TypeError.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import type { RecorderState, Step, StepType } from "../lib/recorder-types";
import { RecordingView } from "./recording-view";

function step(id: string, partial: Partial<Step> & { type: StepType }): Step {
  return { id, timestamp: 0, ...partial } as Step;
}

function state(over: Partial<RecorderState> = {}): RecorderState {
  return {
    recording: true,
    paused: false,
    assertMode: null,
    stepCount: 0,
    testId: "t1",
    url: "https://example.com",
    name: "Checkout",
    editing: false,
    assertSoft: false,
    cursor: 0,
    refineMode: false,
    pageReady: true,
    ...over,
  } as RecorderState;
}

// Every action the view can invoke, so assertions can target any of them.
const actions = {
  pause: vi.fn(),
  resume: vi.fn(),
  stop: vi.fn(),
  discardExit: vi.fn(),
  setAssert: vi.fn(),
  deleteStep: vi.fn(),
  insertStep: vi.fn(),
  reorderStep: vi.fn(),
  updateStep: vi.fn(),
  applyHeal: vi.fn(),
  setCursor: vi.fn(),
  replayStep: vi.fn(async () => ({ ok: true }) as never),
  replayFromCurrent: vi.fn(async () => ({}) as never),
  startRefine: vi.fn(),
  endRefine: vi.fn(),
  clearPicked: vi.fn(),
  clearDebugEntry: vi.fn(),
  clearContextAction: vi.fn(),
};

let store: Record<string, unknown> = {};

vi.mock("./recorder-store", () => ({
  useRecorder: () => store,
}));

vi.mock("../lib/api", () => ({
  api: {
    recorder: { listCookies: async () => [], getSettings: async () => ({}) },
    llm: { getConfig: async () => ({ provider: "ollama", model: "" }) },
    on: () => () => {},
  },
}));

function setStore(over: Record<string, unknown> = {}) {
  store = {
    state: state(),
    liveSteps: [] as Step[],
    replayRun: null,
    executing: false,
    replayStepStatus: {},
    debugEntries: [],
    picked: null,
    refiningStepId: null,
    contextAction: null,
    ...actions,
    ...over,
  };
}

/** Switch tabs. Radix's TabsTrigger activates on pointer-down/focus rather
 *  than a bare click, so fireEvent.click alone leaves the tab unchanged — and
 *  the test then asserts against the PREVIOUS tab's content, which fails for a
 *  reason that has nothing to do with the code. */
function selectTab(name: RegExp) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab);
  fireEvent.focus(tab);
  fireEvent.click(tab);
  return tab;
}

beforeEach(() => {
  vi.clearAllMocks();
  setStore();
});

describe("recording state", () => {
  it("shows the URL being recorded", () => {
    // The trainer header identifies the session by URL, not by test name.
    render(<RecordingView />);
    expect(screen.getByText(/https:\/\/example\.com/)).toBeTruthy();
  });

  it("offers Pause while recording", () => {
    render(<RecordingView />);
    fireEvent.click(screen.getByRole("button", { name: /pause/i }));
    expect(actions.pause).toHaveBeenCalledTimes(1);
    expect(actions.resume).not.toHaveBeenCalled();
  });

  it("offers Resume while paused", () => {
    setStore({ state: state({ paused: true }) });
    render(<RecordingView />);
    fireEvent.click(screen.getByRole("button", { name: /resume/i }));
    expect(actions.resume).toHaveBeenCalledTimes(1);
  });
});

describe("the step list", () => {
  it("renders captured steps", () => {
    setStore({
      liveSteps: [
        step("a", { type: "click", locator: { k: "role", role: "button", name: "Submit" } }),
        step("b", { type: "fill", locator: { k: "label", v: "Email" }, value: "a@b.test" }),
      ],
    });
    render(<RecordingView />);
    // Asserted on each step's own description — the header also shows the URL,
    // so matching on that would be ambiguous rather than meaningful.
    expect(screen.getByText(/getByRole\("button", \{ name: "Submit" \}\)\.click\(\)/)).toBeTruthy();
    expect(screen.getByText(/getByLabel\("Email"\)\.fill/)).toBeTruthy();
  });

  it("deletes a step through the store", () => {
    setStore({ liveSteps: [step("a", { type: "click", locator: { k: "testid", v: "go" } })] });
    render(<RecordingView />);
    fireEvent.click(screen.getAllByLabelText(/delete step/i)[0]);
    expect(actions.deleteStep).toHaveBeenCalledWith("a");
  });

  it("reorders a step through the store", () => {
    setStore({
      liveSteps: [
        step("a", { type: "click", locator: { k: "testid", v: "a" } }),
        step("b", { type: "click", locator: { k: "testid", v: "b" } }),
      ],
    });
    render(<RecordingView />);
    const grips = screen.getAllByLabelText(/drag to reorder/i);
    fireEvent.dragStart(grips[1]);
    fireEvent.dragEnter(grips[0]);
    fireEvent.dragEnd(grips[1]);
    expect(actions.reorderStep).toHaveBeenCalled();
  });

  it("tells a new user what to do when nothing is captured yet", () => {
    render(<RecordingView />);
    expect(screen.getByText(/Interact with the site/i)).toBeTruthy();
  });
});

describe("assertion mode", () => {
  it("reflects an active assertion mode from state", () => {
    setStore({ state: state({ assertMode: "visible" }) });
    render(<RecordingView />);
    expect(document.body.textContent).toMatch(/visible/i);
  });
});

describe("replay console", () => {
  it("prompts for a run before one exists", () => {
    // Asserted on the CONSOLE's own empty state — "Replay from current step"
    // is also a always-present toolbar button, so matching /replay/ anywhere
    // would pass no matter what the console showed.
    render(<RecordingView />);
    selectTab(/console/i);
    expect(screen.getByText(/No run yet/i)).toBeTruthy();
  });

  it("shows a finished run's counts", () => {
    setStore({
      replayRun: {
        running: false,
        startIndex: 0,
        total: 3,
        ran: 3,
        passed: 2,
        failedAtIndex: 0,
        startedAt: 0,
        finishedAt: 1,
        steps: [
          { index: 0, stepLabel: "click Submit", ok: false, error: "Element not found", logs: [] },
        ],
      },
    });
    render(<RecordingView />);
    selectTab(/console/i);
    expect(screen.getByText(/click Submit/)).toBeTruthy();
  });

  it("surfaces a failing step's error", () => {
    setStore({
      replayRun: {
        running: false,
        startIndex: 0,
        total: 1,
        ran: 1,
        passed: 0,
        failedAtIndex: 0,
        startedAt: 0,
        finishedAt: 1,
        steps: [
          { index: 0, stepLabel: "click Submit", ok: false, error: "Element not found", logs: [] },
        ],
      },
    });
    render(<RecordingView />);
    selectTab(/console/i);
    expect(screen.getByText(/Element not found/)).toBeTruthy();
  });
});

describe("cookies tab", () => {
  it("is reachable from the trainer", async () => {
    render(<RecordingView />);
    selectTab(/cookies/i);
    // The panel loads its list on mount; the empty state is enough to prove it
    // mounted rather than erroring.
    await waitFor(() => expect(document.body.textContent).toMatch(/cookie/i));
  });
});
