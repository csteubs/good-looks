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
import { TooltipProvider } from "@ui";

import type { ContextAction, RecorderState, Step, StepType } from "../lib/recorder-types";
import { DOCK_TOOLTIP, TrainerPanelView } from "./trainer-panel-view";
import { INSERT_HERE } from "../main/step-row";
import { viewportNarrowedNotice } from "../main/viewport-narrowed-notice";
import { toastTexts, clearToastCalls } from "../__tests__/sonner-stub";

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
  verifyGeneratedSteps: vi.fn(async () => ({ inserted: 0, results: [] })),
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
  addVariable: vi.fn(async () => {}),
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
/** What the backend answers when the panel asks how it opened. Docked is the
 *  ordinary case; a test that cares sets this before rendering. */
let dockState: { docked: boolean; reason: string | null } = { docked: true, reason: null };
const getState = vi.fn(async () => dockState);

vi.mock("../lib/api", () => ({
  api: {
    trainerPanel: {
      dock: (...args: unknown[]) => dock(...(args as [])),
      undock: (...args: unknown[]) => undock(...(args as [])),
      getState: (...args: unknown[]) => getState(...(args as [])),
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
    replayFlash: {},
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
  clearToastCalls();
  dockState = { docked: true, reason: null };
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
  // THE CHIP IS THE PAUSE TOGGLE — same correction as recording-view.tsx, made
  // in both places or the two trainers disagree about what clicking the state
  // word does. The ToolButton it replaced is pinned absent below.
  it("pauses recording through the Recording chip", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Recording" }));
    expect(actions.pause).toHaveBeenCalledTimes(1);
    expect(actions.resume).not.toHaveBeenCalled();
  });

  it("resumes through the Paused chip", () => {
    setStore({ state: state({ paused: true }) });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Paused" }));
    expect(actions.resume).toHaveBeenCalledTimes(1);
    expect(actions.pause).not.toHaveBeenCalled();
  });

  it("offers no separate pause/resume tool button", () => {
    // Its glyph was the whole reason the replay arrow could not be a play
    // triangle; keep the strip clear so the freed space stays freed.
    renderPanel();
    expect(screen.queryByRole("button", { name: /pause recording/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /resume recording/i })).toBeNull();
  });

  it("keeps the chip passive while a replay owns the window", () => {
    setStore({ state: state({ replaying: true }) });
    renderPanel();
    expect(screen.queryByRole("button", { name: /replaying/i })).toBeNull();
    expect(screen.getByText("Replaying")).toBeTruthy();
  });

  it("⌘P replays the selected step, resolved against THIS window's selection", () => {
    setStore({
      liveSteps: [step("a", { type: "click" }), step("b", { type: "click" })],
    });
    renderPanel();
    fireEvent.click(screen.getAllByRole("option")[1]);
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    expect(actions.replayStep).toHaveBeenCalledWith("b");
  });

  it("⌘P is inert with nothing selected — there is nothing to play", () => {
    setStore({ liveSteps: [step("a", { type: "click" })] });
    renderPanel();
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    expect(actions.replayStep).not.toHaveBeenCalled();
  });

  it("renders the Paused chip passive while the Refine picker is armed", () => {
    // Refine owns the pause (startRefine pauses, endRefine restores) — a
    // resume from the chip would run capture live behind the pick. Mirrors
    // recording-view and the ⌘R gate's "consume" state.
    setStore({ state: state({ paused: true, refineMode: true }) });
    renderPanel();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Paused" })).toBeNull();
  });

  it("⌘P is inert while the tools are locked, even with a step selected", () => {
    // Selection survives the lock (it is view state), so the gate has to be
    // the shortcut's own — the same `controlsDisabled` the row's ▶ obeys.
    setStore({ liveSteps: [step("a", { type: "click" })] });
    const view = renderPanel();
    fireEvent.click(screen.getAllByRole("option")[0]);
    setStore({ liveSteps: [step("a", { type: "click" })], executing: true });
    view.rerender(
      <TooltipProvider>
        <TrainerPanelView />
      </TooltipProvider>,
    );
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    expect(actions.replayStep).not.toHaveBeenCalled();
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
    for (const name of [/add step/i, /^assert$/i, /replay from the current step/i]) {
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
  // The tiles carry NAMES now (Direction A's folded strip), but the rule
  // outlives the icon-only row that taught it: the glyph is still the fastest
  // read at 360px, and two tiles drawing the same one are, at a glance, the
  // same tool twice. Nothing else catches this: both render fine, both
  // have correct accessible names, and the tests above pass either way.
  //
  // The trap that taught this rule was the pause/resume TOGGLE that used to
  // sit beside replay: paused, it became a play triangle and the two were
  // indistinguishable while doing very different things. That toggle is the
  // Recording/Paused chip in the header now (which draws no glyph), but the
  // rule outlives it — replay must never pick the triangle up, and the next
  // tool added to the row must not reuse a glyph already in it.

  it("does not draw replay as a play triangle", () => {
    renderPanel();
    expect(glyphOf(screen.getByRole("button", { name: /replay from the current step/i })))
      .not.toBe("play");
  });

  it("gives every tool-row control its own glyph", () => {
    // Generalises the rule rather than pinning today's four buttons: any future
    // tool that reuses a glyph already in the row fails here. Paused, because
    // that is the state that used to produce the collision.
    setStore({ state: state({ paused: true }) });
    renderPanel();
    const labels = [
      /^assert$/i,
      /^add step$/i,
      /^ai$/i,
      /replay from the current step/i,
    ];
    const glyphs = labels.map((l) => glyphOf(screen.getByRole("button", { name: l })));
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});

describe("the context band", () => {
  // The 2026-09-01 reorganisation: every transient this panel used to spread
  // over three conditional bands lives in one reserved-height band now, and
  // two things become reachable from this surface for the first time — the
  // Hard/Soft choice, and a Create flow control that is always mounted.

  it("mounts the strictness toggle only while an assertion is armed", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: "Soft" })).toBeNull();
  });

  it("re-arms a live assertion with the new strictness — soft is reachable here at last", () => {
    // This view hard-coded `soft: false` into its assert handler for its
    // whole life; the shared context band is what fixed it.
    setStore({ state: state({ assertMode: "visible" }) });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Soft" }));
    expect(actions.setAssert).toHaveBeenCalledWith("visible", true);
  });

  it("keeps Create flow mounted and disabled with no selection, the hint as its title", () => {
    renderPanel();
    const btn = screen.getByRole("button", { name: /^flow$/i });
    expect(btn.hasAttribute("disabled")).toBe(true);
    expect(btn.getAttribute("title")).toMatch(/select two or more adjacent steps/i);
  });

  it("enables Create flow for a contiguous selection, count in the label", () => {
    setStore({
      liveSteps: [step("a", { type: "click" }), step("b", { type: "click" })],
    });
    renderPanel();
    const rows = screen.getAllByRole("option");
    fireEvent.click(rows[0]);
    fireEvent.click(rows[1], { shiftKey: true });
    const btn = screen.getByRole("button", { name: /^flow \(2\)$/i });
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  // The next-action chip fires on this surface too — same hook, same rules as
  // the main trainer (lib/next-action.ts), resolved against this window's own
  // dismissal state. The full rule matrix is the main suite's and the node
  // tests'; what this pins is that the PANEL is wired at all.
  const FILLED = step("f1", {
    type: "fill",
    locator: { k: "label", v: "Email" },
    value: "chris@example.com",
    fingerprint: {
      tag: "input",
      description: 'input "Email"',
      candidates: [{ k: "testid", v: "email" }],
      attributes: { type: "email" },
      depth: 3,
    },
  });

  it("offers the next-action chip after a fill, dismissible", () => {
    setStore({ liveSteps: [FILLED], state: state({ cursor: 1 }) });
    renderPanel();
    expect(screen.getByRole("button", { name: /assert this field/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /dismiss suggestion/i }));
    expect(screen.queryByRole("button", { name: /assert this field/i })).toBeNull();
  });

  it("accepting the chip opens the composer prefilled", async () => {
    setStore({ liveSteps: [FILLED], state: state({ cursor: 1 }) });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /assert this field/i }));
    await waitFor(() =>
      expect(document.querySelector('[data-gl="step-composer"]')).toBeTruthy(),
    );
    expect(screen.getByDisplayValue("chris@example.com")).toBeTruthy();
  });
});

describe("context actions are addressed", () => {
  // The regression this whole mechanism exists for: one right-click in the
  // training browser reaching two windows and opening two composers.
  //
  // Queried by `data-gl` since C §6.2: the Add-step surface is an inline panel
  // in the step list now, not a dialog. What is being pinned is unchanged —
  // WHICH WINDOW acts on a right-click — so these moved rather than went.
  const composer = () => document.querySelector('[data-gl="step-composer"]');

  it("acts on an action addressed to the panel", async () => {
    setStore({ contextAction: ctx({ target: "panel" }) });
    renderPanel();
    // The composer opened, prefilled as an assertion.
    await waitFor(() => expect(composer()).toBeTruthy());
  });

  it("ignores an action addressed to the main window", async () => {
    setStore({ contextAction: ctx({ target: "main" }) });
    renderPanel();
    await waitFor(() => expect(actions.clearContextAction).toHaveBeenCalled());
    expect(composer()).toBeNull();
  });

  it("acts on an unaddressed action, so older payloads still work", async () => {
    setStore({ contextAction: ctx({ target: undefined }) });
    renderPanel();
    await waitFor(() => expect(composer()).toBeTruthy());
  });
});

describe("filling a field with a variable, from the panel", () => {
  // The panel is the trainer that sits BESIDE the training browser, so it is
  // the one that receives a right-click "Use variable…" whenever it is open.
  // Both halves are pinned: that the composer opens on the fill kind, and that
  // the variables it offers are the SESSION's — the panel has no test record to
  // read them from, and a picker with nothing in it makes the feature look
  // unavailable exactly where it is most reachable.
  const ctxFill = () => ({
    kind: "fill" as const,
    picked: {
      tag: "input",
      description: "input#password",
      candidates: [{ k: "css" as const, v: "#password" }],
      css: {},
      attributes: {},
      ambiguous: false,
      contextBaseCount: 1,
      contextSignals: [],
    },
    prefillText: "",
    prefillValue: "",
    target: "panel" as const,
  });

  it("opens on the fill kind and offers the session's variables", async () => {
    setStore({
      state: state({ variables: [{ name: "storePassword", kind: "secret" }] }),
      contextAction: ctxFill(),
    });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole("form", { name: /fill with a variable/i })).toBeTruthy(),
    );
    expect(screen.getByText("${storePassword}")).toBeTruthy();
  });

  it("offers to declare one, since the panel cannot reach the Variables tab", async () => {
    setStore({ state: state({ variables: [] }), contextAction: ctxFill() });
    renderPanel();
    await waitFor(() => screen.getByRole("form", { name: /fill with a variable/i }));
    expect(screen.getByRole("button", { name: /new variable/i })).toBeTruthy();
  });

  it("declares through the store, so both trainers see the new variable", async () => {
    setStore({ state: state({ variables: [] }), contextAction: ctxFill() });
    renderPanel();
    await waitFor(() => screen.getByRole("form", { name: /fill with a variable/i }));
    fireEvent.click(screen.getByRole("button", { name: /new variable/i }));
    fireEvent.change(screen.getByLabelText(/new variable name/i), {
      target: { value: "storePassword" },
    });
    fireEvent.change(screen.getByLabelText(/new variable value/i), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create variable/i }));
    await waitFor(() =>
      expect(actions.addVariable).toHaveBeenCalledWith({
        name: "storePassword",
        kind: "secret",
        value: "hunter2",
      }),
    );
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

  it("asks how it opened, because the answer predates this window", async () => {
    // The panel that opens UNDOCKED is the one that cannot be told: the backend
    // decides before this renderer exists, so its `trainerPanel:undocked` push
    // goes nowhere and the button keeps its optimistic "docked" default. It then
    // reads "Undock" beside a panel that is not docked, and pressing it calls
    // undock() on an already-undocked panel — a control that does nothing, on
    // the exact arrangement the user wants fixed.
    dockState = { docked: false, reason: "no-room" };
    renderPanel();
    await waitFor(() => expect(getState).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /dock panel to the browser/i })).toBeTruthy(),
    );
  });

  it("does not let a slow answer undo a push that overtook it", async () => {
    // The ask is answered in the backend before it resolves here, so a dock
    // change that happens in between is the NEWER fact. A reply that overwrote
    // it would roll the button back to a state that is no longer true — and
    // only on the timings where the IPC round trip is slow, which is the shape
    // of bug that never reproduces for the person who has to fix it.
    let answer: (s: { docked: boolean; reason: string | null }) => void = () => {};
    getState.mockImplementationOnce(
      () => new Promise<{ docked: boolean; reason: string | null }>((resolve) => { answer = resolve; }),
    );
    renderPanel();
    emit("trainerPanel:undocked", { reason: "no-room" });
    answer({ docked: true, reason: null });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /dock panel to the browser/i })).toBeTruthy(),
    );
  });

  it("says WHY it could not dock, not just that it did not", async () => {
    // The tooltip cannot be opened in jsdom (Radix tracks pointers with APIs
    // jsdom lacks), so the copy is asserted at its source. It has to be
    // distinct: "no room on this display at this window size" is a thing the
    // user can act on — pick a smaller size, or move to a bigger screen —
    // and an undocked panel with no explanation is indistinguishable from the
    // feature being broken.
    expect(DOCK_TOOLTIP.noRoom).not.toBe(DOCK_TOOLTIP.undocked);
    expect(DOCK_TOOLTIP.noRoom).toMatch(/room/i);
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

  it("says the training viewport narrowed, and by how much", async () => {
    // The push has existed since the panel landed and nothing consumed it, so
    // the training browser lost 360pt at dock time and the user was told
    // nothing. That is the silent divergence the notice exists to break: a
    // responsive site re-lays-out at the new width while the generated spec
    // still runs at whatever viewport it sets.
    //
    // Asserted through the sonner stub rather than the DOM because a toast is
    // recorded as a CALL here, not rendered — same reason `DOCK_TOOLTIP` is
    // asserted at its source.
    renderPanel();
    emit("trainerPanel:viewportNarrowed", { width: 1080 });
    await waitFor(() => {
      const t = toastTexts().find((x) => x.title.includes("Training viewport narrowed"));
      expect(t).toBeTruthy();
      // The WIDTH is the point. A notice that says "something changed" without
      // the number leaves the user unable to tell whether it crossed a
      // breakpoint that matters to their site.
      expect(t?.title).toContain("1080");
      expect(t?.description).toMatch(/responsive/i);
    });
  });

  it("does not warn about a narrowing that never happened", async () => {
    // Nothing is emitted here, which is the case that matters: the backend
    // withholds this push when the browser's width was PRESERVED (a recording
    // at a viewport preset), and a notice appearing anyway would send the user
    // hunting for a layout problem in the one arrangement whose geometry is
    // guaranteed correct.
    renderPanel();
    emit("trainerPanel:docked", { width: 840 });
    await waitFor(() => expect(dock).not.toHaveBeenCalled());
    expect(toastTexts().some((x) => x.title.includes("Training viewport narrowed"))).toBe(false);
  });
});

describe("the viewport notice copy", () => {
  it("names the width it was given", () => {
    expect(viewportNarrowedNotice(1080).title).toContain("1080pt");
  });

  it("stays a sentence when the payload carries no usable width", () => {
    // `api.on` hands back whatever was on the channel with no runtime check, so
    // a missing or broken width must not render as "narrowed to NaNpt" — that
    // reads as a bug in the feature rather than a bad payload, and it is the
    // notice's own credibility that pays for it.
    for (const bad of [undefined, Number.NaN, Infinity]) {
      const { title } = viewportNarrowedNotice(bad as number | undefined);
      expect(title).toBe("Training viewport narrowed");
      expect(title).not.toMatch(/nan|infinity/i);
    }
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

describe("a replay started in the OTHER trainer window", () => {
  // The panel and the main window render one session. `executing` and
  // `replayRun` are both set by whichever window called the store, so a replay
  // launched from the main window is invisible here — this panel would sit on
  // "Recording" with live controls while the browser beside it is being driven
  // by that replay, and an Add step pressed here lands mid-run in a session
  // whose whole premise at that moment is that capture is suspended.
  //
  // `state.replaying` is broadcast by the backend precisely so both windows
  // agree. These tests drive it the way the backend does: through state alone,
  // with the local flags left false.

  beforeEach(() => setStore({ state: state({ replaying: true }) }));

  it("says Replaying rather than Recording", () => {
    renderPanel();
    expect(screen.getByText("Replaying")).toBeTruthy();
    expect(screen.queryByText("Recording")).toBe(null);
  });

  it("disables the controls that would act into the run", () => {
    renderPanel();
    for (const name of [/^assert$/i, /^add step$/i, /^ai$/i, /replay from the current step/i]) {
      expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    }
  });

  // The "hides the pause/resume toggle while replaying" test that used to sit
  // here went vacuous when the labelled ToolButtons it queried were removed —
  // those labels now exist in NO state, so it could never fail again. Its
  // property is pinned by "keeps the chip passive while a replay owns the
  // window" above: the toggle IS the chip now, and Replaying renders it as a
  // passive span.

  it("goes back to Recording when the replay ends", () => {
    const { rerender } = renderPanel();
    expect(screen.getByText("Replaying")).toBeTruthy();

    setStore({ state: state({ replaying: false }) });
    rerender(
      <TooltipProvider>
        <TrainerPanelView />
      </TooltipProvider>,
    );

    expect(screen.getByText("Recording")).toBeTruthy();
    expect(screen.getByLabelText("Add step").hasAttribute("disabled")).toBe(false);
  });
});

describe("continuing an existing test: where a captured step goes", () => {
  // The report this was written against: "I only see the Paused and Editing
  // options in the trainer window, and it doesn't appear to record any manual
  // page interaction." Capture was live the whole time. What was true is that
  // the insert cursor sits where the browser is — just past the navigation for
  // a continued test — so a captured step landed at the TOP of the list while
  // this panel scrolled to the bottom, unhighlighted, with a chip reading
  // "Editing" beside it.

  /** Four steps and a cursor just past the navigation, as `initialCursor` sets
   *  it: the ordinary state of a session opened on an existing test. */
  function continuedSession(over: Record<string, unknown> = {}) {
    setStore({
      state: state({ editing: true, cursor: 1 }),
      liveSteps: [
        step("s0", { type: "goto", url: "https://example.com" }),
        step("s1", { type: "click", locator: { k: "text", v: "One" } }),
        step("s2", { type: "click", locator: { k: "text", v: "Two" } }),
        step("s3", { type: "click", locator: { k: "text", v: "Three" } }),
      ],
      ...over,
    });
  }

  it("says Recording, because capture is live", () => {
    // "Editing" here said the opposite of what was true, on the one indicator
    // whose entire job is whether the trainer is listening.
    continuedSession();
    renderPanel();
    expect(screen.getByText("Recording")).toBeTruthy();
    expect(screen.queryByText("Editing")).toBe(null);
  });

  it("names the insert point when it is not at the end of the list", () => {
    continuedSession();
    renderPanel();
    expect(screen.getByText(INSERT_HERE)).toBeTruthy();
  });

  it("says nothing at the end of the list, where steps appear under the last row", () => {
    continuedSession({ state: state({ editing: true, cursor: 4 }) });
    renderPanel();
    expect(screen.queryByText(INSERT_HERE)).toBe(null);
  });

  it("scrolls the arriving step into view", () => {
    // The half of the fix jsdom CAN see. Without it the row that changed is
    // off-screen at the top of the list while the view follows the bottom,
    // which is indistinguishable from nothing having been recorded.
    const scrolled: Element[] = [];
    const spy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function (this: Element) {
        scrolled.push(this);
      });
    try {
      continuedSession({
        liveSteps: [
          step("s0", { type: "goto", url: "https://example.com" }),
          step("new", { type: "click", locator: { k: "text", v: "Just captured" } }),
          step("s1", { type: "click", locator: { k: "text", v: "One" } }),
          step("s2", { type: "click", locator: { k: "text", v: "Two" } }),
        ],
        lastAddedStepId: "new",
      });
      renderPanel();
      expect(
        scrolled.some((el) => el.getAttribute("data-just-added") === "true"),
        "the arriving row scrolled itself into view",
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("scrolls nothing when no step has arrived", () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    try {
      continuedSession({ lastAddedStepId: null });
      renderPanel();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// ── The panel wears the app's theme ────────────────────────────────────────
//
// This window was the last surface in the app still drawn in the component
// library's stock classes — `bg-background`, `border-separator`, `bg-accent/5`,
// the SDK's `Status` and `Badge` — while every screen it mirrors had moved to
// the `--gl-*` theme layer. That is not a cosmetic gap: the panel docks EDGE TO
// EDGE with the main window's trainer, so the two were rendering the same live
// session in two different designs, one hairline apart.
//
// `check:renderer-classes` proves a `gl-*` class RESOLVES to CSS; it cannot
// know whether this view uses one. Nothing else would notice the stock classes
// coming back, because they resolve too — they just belong to the other design.
describe("theme", () => {
  /** Class names from the pre-reskin surface. Each one still emits valid CSS,
   *  which is exactly why their return would be silent. */
  const STOCK = ["bg-background", "border-separator", "bg-accent/5", "text-accent"];

  function classSoup(): string {
    return [...document.querySelectorAll<HTMLElement>("[class]")]
      .map((el) => el.getAttribute("class") ?? "")
      .join(" ");
  }

  it("draws its own chrome from the theme layer", () => {
    setStore();
    renderPanel();
    // The frame: root, header, URL band, list, tool row, footer. Asserted as a
    // set rather than one at a time — a panel missing its footer rule is a
    // panel whose Save button has no separator, which reads as a rendering bug.
    for (const cls of [
      "gl-panelwin",
      "gl-panelwin-head",
      "gl-panelwin-url",
      "gl-panelwin-tiles",
      "gl-panelwin-context",
      "gl-panelwin-list",
      "gl-panelwin-foot",
    ]) {
      expect(document.querySelector(`.${cls}`), `${cls} is rendered`).not.toBeNull();
    }
  });

  it("uses none of the stock classes it was built from", () => {
    setStore();
    renderPanel();
    const soup = classSoup();
    for (const cls of STOCK) {
      expect(soup.split(/\s+/), `${cls} came back`).not.toContain(cls);
    }
  });

  it("keeps the status chip neutral rather than reusing the failed-run colour", () => {
    // "Recording" was the SDK's `error` variant — i.e. RED, the colour this
    // palette spends on a failed run — on a surface where nothing has run. The
    // main window's trainer was corrected for this; the panel is docked beside
    // it, so it has to agree or red means two things at once on one screen.
    setStore();
    renderPanel();
    const chip = document.querySelector('[data-gl="status-chip"], .gl-status-chip');
    expect(chip, "a status chip is rendered").not.toBeNull();
    expect(chip?.className).not.toMatch(/destructive|error|danger/);
  });
});
