// Component tests for the docked trainer panel.
//
// The panel is a SECOND live rendering of a session the main window is also
// showing, which is where its distinctive failure modes come from. Two matter
// enough to be the reason this file exists:
//
//   1. A right-click in the training browser is BROADCAST to both windows. Only
//      the addressed one may act, or a single right-click opens two prefilled
//      Add-step dialogs and the user resolves the same choice twice.
//   2. The dock button reflects BACKEND state, not an optimistic local guess —
//      docking is legitimately refused on a display too small to hold both
//      windows, and a button that lies about it leaves the user pressing a
//      control that appears to do nothing.
//
// Neither is caught by lint, type-check, or the backend's own tests: both are
// silent, and both look like the panel "just being buggy".
//
// The store is mocked wholesale, as in recording-view.test.tsx — every field is
// consumed, and a partial mock fails at render with an unrelated TypeError.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@glaze/core/components";

import type { ContextAction, RecorderState, Step, StepType } from "../lib/recorder-types";
import { TrainerPanelView } from "./trainer-panel-view";

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

const actions = {
  pause: vi.fn(),
  resume: vi.fn(),
  stop: vi.fn(),
  discardExit: vi.fn(),
  setAssert: vi.fn(),
  deleteStep: vi.fn(),
  insertStep: vi.fn(),
  insertGeneratedSteps: vi.fn(async () => {}),
  reorderStep: vi.fn(),
  updateStep: vi.fn(),
  applyHeal: vi.fn(),
  setCursor: vi.fn(),
  replayStep: vi.fn(async () => ({ ok: true }) as never),
  replayFromCurrent: vi.fn(async () => ({ ok: true, ranCount: 0, passedCount: 0 }) as never),
  startRefine: vi.fn(),
  endRefine: vi.fn(),
  clearPicked: vi.fn(),
  clearDebugEntry: vi.fn(),
  clearContextAction: vi.fn(),
};

let store: Record<string, unknown> = {};

vi.mock("../main/recorder-store", () => ({
  useRecorder: () => store,
}));

/** Backend push listeners, keyed by channel, so a test can deliver an event
 *  the way the backend would. */
const listeners: Record<string, ((payload: unknown) => void)[]> = {};

const dock = vi.fn(async () => ({ docked: true }));
const undock = vi.fn(async () => ({ docked: false }));

vi.mock("../lib/api", () => ({
  api: {
    trainerPanel: {
      dock: (...args: unknown[]) => dock(...(args as [])),
      undock: (...args: unknown[]) => undock(...(args as [])),
    },
    recorder: { listCookies: async () => [], getSettings: async () => ({}) },
    llm: {
      getConfig: async () => ({ provider: "ollama", model: "" }),
      status: async () => ({ online: false, models: [] }),
      setConfig: async () => ({}),
      chat: async () => ({ requestId: "req-test" }),
      cancel: async () => {},
      isActive: async () => ({ active: false }),
    },
    on: (channel: string, cb: (payload: unknown) => void) => {
      (listeners[channel] ??= []).push(cb);
      return () => {
        listeners[channel] = (listeners[channel] ?? []).filter((f) => f !== cb);
      };
    },
  },
}));

/** Deliver a backend push to whatever the view subscribed. */
function emit(channel: string, payload: unknown = {}) {
  for (const cb of listeners[channel] ?? []) cb(payload);
}

function setStore(over: Record<string, unknown> = {}) {
  store = {
    state: state(),
    liveSteps: [] as Step[],
    stepsLoaded: true,
    newStepIds: new Set<string>(),
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

function renderPanel() {
  return render(
    <TooltipProvider>
      <TrainerPanelView />
    </TooltipProvider>,
  );
}

/**
 * The lucide glyph a control renders, e.g. "rotate-ccw".
 *
 * Every lucide icon ships a `lucide-<kebab-name>` class (see
 * `createLucideIcon`), which is the only thing in the DOM that identifies the
 * SHAPE the user actually sees. Accessible names are no help here — the whole
 * class of bug below is two controls with different labels drawing the same
 * picture.
 */
function glyphOf(button: HTMLElement): string {
  const svg = button.querySelector("svg");
  if (!svg) throw new Error("control renders no icon");
  const cls = [...svg.classList].find((c) => c.startsWith("lucide-") && c !== "lucide-icon");
  if (!cls) throw new Error(`no lucide glyph class on: ${svg.getAttribute("class")}`);
  return cls.replace(/^lucide-/, "");
}

function ctx(over: Partial<ContextAction> = {}): ContextAction {
  return {
    kind: "assertion",
    assert: "visible",
    picked: null,
    prefillText: "",
    prefillValue: "",
    ...over,
  } as ContextAction;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(listeners)) delete listeners[key];
  setStore();
});

describe("session state", () => {
  it("shows the URL being trained", () => {
    renderPanel();
    expect(screen.getByText(/https:\/\/example\.com/)).toBeTruthy();
  });

  it("renders each recorded step", () => {
    setStore({
      liveSteps: [
        step("a", { type: "goto", url: "https://example.com/login" }),
        // A locator, not just a label: `describeStep` renders the step from its
        // locator, so a label-only step shows no target text at all.
        step("b", { type: "click", locator: { k: "text", v: "Sign in" } }),
      ],
    });
    renderPanel();
    // Wait for rows, not for a container — the list renders before content.
    expect(screen.getAllByRole("button", { name: /move insert point here/i }).length).toBe(3);
    expect(screen.getByText(/Sign in/)).toBeTruthy();
  });

  it("locks the tools until the page is ready", () => {
    // Same rule as the main trainer: acting on a page that has not loaded
    // records steps against nothing.
    setStore({ state: state({ pageReady: false }) });
    renderPanel();
    expect(screen.getByRole("button", { name: /add step/i }).hasAttribute("disabled")).toBe(true);
  });

  it("locks the tools while a replay is running", () => {
    setStore({ executing: true });
    renderPanel();
    expect(screen.getByRole("button", { name: /add step/i }).hasAttribute("disabled")).toBe(true);
  });
});

describe("tools reach their actions", () => {
  it("pauses recording", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /pause recording/i }));
    expect(actions.pause).toHaveBeenCalledTimes(1);
  });

  it("resumes when paused", () => {
    setStore({ state: state({ paused: true }) });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /resume recording/i }));
    expect(actions.resume).toHaveBeenCalledTimes(1);
  });

  it("replays from the first step when nothing is selected", async () => {
    setStore({ liveSteps: [step("a", { type: "click" })] });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /replay from the current step/i }));
    await waitFor(() => expect(actions.replayFromCurrent).toHaveBeenCalledWith(0));
  });

  it("moves the insert cursor", () => {
    setStore({ liveSteps: [step("a", { type: "click" })] });
    renderPanel();
    const gaps = screen.getAllByRole("button", { name: /move insert point here/i });
    fireEvent.click(gaps[1]);
    expect(actions.setCursor).toHaveBeenCalledWith(1);
  });

  it("saves directly when there is nothing to lose", () => {
    // No steps means no unsaved work, so the confirmation would be noise.
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /generate test/i }));
    expect(actions.stop).toHaveBeenCalledTimes(1);
  });

  it("confirms before saving when steps would be written", () => {
    setStore({ liveSteps: [step("a", { type: "click" })] });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /generate test/i }));
    expect(actions.stop).not.toHaveBeenCalled();
    expect(screen.getByText(/1 step will be saved/i)).toBeTruthy();
  });
});

describe("nothing is usable until the steps have arrived", () => {
  // The panel window is created AFTER `recorder:start` has already broadcast
  // the step list, so it never sees that push — it has to ask for the steps,
  // and until they arrive it holds a list it knows nothing about. Every control
  // here acts relative to that list (the insert cursor decides where the next
  // captured step lands), so acting early edits the wrong position or nothing
  // at all. Silent both ways.

  it("disables the tools while the steps are still in flight", () => {
    setStore({ stepsLoaded: false });
    renderPanel();
    for (const name of [/add step/i, /add assertion/i, /replay from the current step/i]) {
      expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    }
  });

  it("says what it is waiting for", () => {
    // Disabled controls under a "Recording" badge reads as a broken trainer.
    setStore({ stepsLoaded: false });
    renderPanel();
    expect(screen.getByText(/loading steps/i)).toBeTruthy();
  });

  it("enables them once the steps are here", () => {
    setStore({ stepsLoaded: true });
    renderPanel();
    expect(screen.getByRole("button", { name: /add step/i }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps them disabled if the page is not ready either", () => {
    setStore({ stepsLoaded: true, state: state({ pageReady: false }) });
    renderPanel();
    expect(screen.getByRole("button", { name: /add step/i }).hasAttribute("disabled")).toBe(true);
  });
});

describe("tool icons stay distinguishable", () => {
  // Every control in the tool row is ICON-ONLY — the label is a tooltip you get
  // after hovering. So two controls drawing the same glyph are, in practice,
  // the same button twice. Nothing else catches this: both render fine, both
  // have correct accessible names, and the tests above pass either way.
  //
  // The specific trap is that Pause/Resume is a TOGGLE. Replay looked fine
  // beside a pause bar; the moment the user pauses, the neighbour becomes a
  // play triangle and the two are indistinguishable — while doing very
  // different things (replay the recorded steps vs. carry on recording).

  it("does not draw replay as a play triangle", () => {
    renderPanel();
    expect(glyphOf(screen.getByRole("button", { name: /replay from the current step/i })))
      .not.toBe("play");
  });

  it("keeps replay distinct from resume once paused", () => {
    // The regression, exactly: pause, then look at the two neighbours.
    setStore({ state: state({ paused: true }) });
    renderPanel();
    const replay = glyphOf(screen.getByRole("button", { name: /replay from the current step/i }));
    const resume = glyphOf(screen.getByRole("button", { name: /resume recording/i }));
    expect(replay).not.toBe(resume);
  });

  it("keeps replay distinct from pause while recording", () => {
    renderPanel();
    const replay = glyphOf(screen.getByRole("button", { name: /replay from the current step/i }));
    const pause = glyphOf(screen.getByRole("button", { name: /pause recording/i }));
    expect(replay).not.toBe(pause);
  });

  it("gives every tool-row control its own glyph", () => {
    // Generalises the rule rather than pinning today's four buttons: any future
    // tool that reuses a glyph already in the row fails here.
    setStore({ state: state({ paused: true }) });
    renderPanel();
    const labels = [
      /add assertion/i,
      /add step/i,
      /generate steps with ai/i,
      /replay from the current step/i,
      /resume recording/i,
    ];
    const glyphs = labels.map((l) => glyphOf(screen.getByRole("button", { name: l })));
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});

describe("context actions are addressed", () => {
  // The regression this whole mechanism exists for: one right-click in the
  // training browser reaching two windows and opening two dialogs.
  it("acts on an action addressed to the panel", async () => {
    setStore({ contextAction: ctx({ target: "panel" }) });
    renderPanel();
    // The Add-step dialog opened, prefilled as an assertion.
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  });

  it("ignores an action addressed to the main window", async () => {
    setStore({ contextAction: ctx({ target: "main" }) });
    renderPanel();
    await waitFor(() => expect(actions.clearContextAction).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("acts on an unaddressed action, so older payloads still work", async () => {
    setStore({ contextAction: ctx({ target: undefined }) });
    renderPanel();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  });
});

describe("dock control", () => {
  it("undocks when docked", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /undock panel/i }));
    await waitFor(() => expect(undock).toHaveBeenCalledTimes(1));
  });

  it("does not change state on click alone", async () => {
    // The contract: the button moves when the BACKEND says the windows moved,
    // never on the click itself. Clicking undock and flipping immediately would
    // be right most of the time and wrong exactly when it matters — a dock the
    // backend refuses leaves the label inverted, and the control then appears
    // dead because pressing it asks for the state it is already in.
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /undock panel/i }));
    await waitFor(() => expect(undock).toHaveBeenCalledTimes(1));
    // No push delivered yet, so nothing has actually moved.
    expect(screen.getByRole("button", { name: /undock panel/i })).toBeTruthy();
  });

  it("follows the backend when docking is REFUSED", async () => {
    // A display too small to hold both windows refuses the dock. If the button
    // flipped optimistically it would now read "Undock" while the panel floats
    // free, and pressing it would do nothing.
    renderPanel();
    emit("trainerPanel:undocked", { reason: "no-room" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /dock panel to the browser/i })).toBeTruthy(),
    );
  });

  it("re-docks after the backend reports a successful dock", async () => {
    renderPanel();
    emit("trainerPanel:undocked", { reason: "user" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /dock panel to the browser/i })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /dock panel to the browser/i }));
    await waitFor(() => expect(dock).toHaveBeenCalledTimes(1));
    emit("trainerPanel:docked", { width: 840 });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /undock panel/i })).toBeTruthy(),
    );
  });
});

describe("refine selector belongs to the window that started it", () => {
  it("shows the dialog when THIS window is refining", () => {
    setStore({
      refiningStepId: "a",
      liveSteps: [step("a", { type: "click", locator: { k: "text", v: "Sign in" } })],
      picked: { tag: "button", candidates: [{ k: "text", v: "Sign in" }], css: {}, attributes: {} },
    });
    renderPanel();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("stays out of the way when the OTHER window is refining", () => {
    // `picked` is broadcast to both windows; `refiningStepId` is per-window
    // state. That asymmetry is the whole reason a refine started in the main
    // window does not also open a dialog here.
    setStore({
      refiningStepId: null,
      liveSteps: [step("a", { type: "click", locator: { k: "text", v: "Sign in" } })],
      picked: { tag: "button", candidates: [{ k: "text", v: "Sign in" }], css: {}, attributes: {} },
    });
    renderPanel();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
