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
import { withAiDebug } from "../__tests__/ai-debug-harness";
import { toastCalls, toastTexts, clearToastCalls } from "../__tests__/sonner-stub";

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
  insertGeneratedSteps: vi.fn(async () => {}),
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

/** Backend push listeners, keyed by channel, so a test can deliver an event the
 *  way the backend would. Mirrors the panel's suite. */
const listeners: Record<string, ((payload: unknown) => void)[]> = {};

/** Deliver a backend push to whatever the view subscribed. */
function emit(channel: string, payload: unknown = {}) {
  for (const cb of listeners[channel] ?? []) cb(payload);
}

vi.mock("../lib/api", () => ({
  api: {
    recorder: { listCookies: async () => [], getSettings: async () => ({}) },
    // Inlined rather than pulled from the shared harness: a vi.mock factory is
    // hoisted above the imports, so it cannot reference one.
    aiDebug: {
      list: async () => [],
      save: async (session: unknown) => session,
      remove: async () => ({ removed: 0 }),
      clear: async () => ({ removed: 0 }),
      notifyDone: async () => ({ ok: true }),
    },
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
  for (const key of Object.keys(listeners)) delete listeners[key];
  clearToastCalls();
  setStore();
});

/**
 * The lucide glyph a control renders, e.g. "rotate-ccw". Every lucide icon
 * ships a `lucide-<kebab-name>` class, which is the only thing in the DOM
 * identifying the SHAPE the user sees — accessible names cannot distinguish two
 * controls that draw the same picture. Mirrored in the panel's suite.
 */
function glyphOf(button: HTMLElement): string {
  const svg = button.querySelector("svg");
  if (!svg) throw new Error("control renders no icon");
  const cls = [...svg.classList].find((c) => c.startsWith("lucide-") && c !== "lucide-icon");
  if (!cls) throw new Error(`no lucide glyph class on: ${svg.getAttribute("class")}`);
  return cls.replace(/^lucide-/, "");
}

describe("nothing is usable until the steps have arrived", () => {
  // The step list arrives as a PUSH (`recorder:steps`). Until this window holds
  // it, every control acts relative to a list it does not have — and the insert
  // cursor the backend sent means nothing without the rows it points between.
  // Both failure modes are silent: the step lands in the wrong place, or the
  // click does nothing.

  it("disables the tools while the steps are still in flight", () => {
    setStore({ stepsLoaded: false });
    render(withAiDebug(<RecordingView />));
    for (const name of [/add step/i, /replay from the current step/i]) {
      expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    }
  });

  it("says what it is waiting for", () => {
    setStore({ stepsLoaded: false });
    render(withAiDebug(<RecordingView />));
    expect(screen.getByText(/loading steps/i)).toBeTruthy();
  });

  it("enables them once the steps are here", () => {
    setStore({ stepsLoaded: true });
    render(withAiDebug(<RecordingView />));
    expect(screen.getByRole("button", { name: /add step/i }).hasAttribute("disabled")).toBe(false);
  });
});

describe("replay and pause stay visually distinct", () => {
  // Here the two controls carry TEXT labels, so today nothing is ambiguous.
  // The guard exists anyway for two reasons: the docked panel renders the same
  // action icon-only (where the collision is real and this suite's sibling
  // pins it), and the same glyph must not mean two things across the two
  // trainers. If this view ever tightens to icon-only, the bug arrives silently.
  it("does not draw replay as a play triangle", () => {
    render(withAiDebug(<RecordingView />));
    const replay = screen.getByRole("button", { name: /replay from the current step/i });
    expect(glyphOf(replay)).not.toBe("play");
  });

  it("keeps replay distinct from resume once paused", () => {
    setStore({ state: state({ paused: true }) });
    render(withAiDebug(<RecordingView />));
    const replay = glyphOf(screen.getByRole("button", { name: /replay from the current step/i }));
    const resume = glyphOf(screen.getByRole("button", { name: /resume/i }));
    expect(replay).not.toBe(resume);
  });
});

describe("recording state", () => {
  it("shows the URL being recorded", () => {
    // The trainer header identifies the session by URL, not by test name.
    render(withAiDebug(<RecordingView />));
    expect(screen.getByText(/https:\/\/example\.com/)).toBeTruthy();
  });

  it("offers Pause while recording", () => {
    render(withAiDebug(<RecordingView />));
    fireEvent.click(screen.getByRole("button", { name: /pause/i }));
    expect(actions.pause).toHaveBeenCalledTimes(1);
    expect(actions.resume).not.toHaveBeenCalled();
  });

  it("offers Resume while paused", () => {
    setStore({ state: state({ paused: true }) });
    render(withAiDebug(<RecordingView />));
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
    render(withAiDebug(<RecordingView />));
    // Asserted on each step's own description — the header also shows the URL,
    // so matching on that would be ambiguous rather than meaningful.
    expect(screen.getByText(/getByRole\("button", \{ name: "Submit" \}\)\.click\(\)/)).toBeTruthy();
    expect(screen.getByText(/getByLabel\("Email"\)\.fill/)).toBeTruthy();
  });

  it("deletes a step through the store", () => {
    setStore({ liveSteps: [step("a", { type: "click", locator: { k: "testid", v: "go" } })] });
    render(withAiDebug(<RecordingView />));
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
    render(withAiDebug(<RecordingView />));
    const grips = screen.getAllByLabelText(/drag to reorder/i);
    fireEvent.dragStart(grips[1]);
    fireEvent.dragEnter(grips[0]);
    fireEvent.dragEnd(grips[1]);
    expect(actions.reorderStep).toHaveBeenCalled();
  });

  it("tells a new user what to do when nothing is captured yet", () => {
    render(withAiDebug(<RecordingView />));
    expect(screen.getByText(/Interact with the site/i)).toBeTruthy();
  });
});

describe("assertion mode", () => {
  it("reflects an active assertion mode from state", () => {
    setStore({ state: state({ assertMode: "visible" }) });
    render(withAiDebug(<RecordingView />));
    expect(document.body.textContent).toMatch(/visible/i);
  });
});

describe("replay console", () => {
  it("prompts for a run before one exists", () => {
    // Asserted on the CONSOLE's own empty state — "Replay from current step"
    // is also a always-present toolbar button, so matching /replay/ anywhere
    // would pass no matter what the console showed.
    render(withAiDebug(<RecordingView />));
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
    render(withAiDebug(<RecordingView />));
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
    render(withAiDebug(<RecordingView />));
    selectTab(/console/i);
    expect(screen.getByText(/Element not found/)).toBeTruthy();
  });
});

describe("cookies tab", () => {
  it("is reachable from the trainer", async () => {
    render(withAiDebug(<RecordingView />));
    selectTab(/cookies/i);
    // The panel loads its list on mount; the empty state is enough to prove it
    // mounted rather than erroring.
    await waitFor(() => expect(document.body.textContent).toMatch(/cookie/i));
  });
});

// ── Per-step AI debugging (Console) ──────────────────────────────────
// Each failed console step gets its own AI debug session, keyed by step index.
// Two failure modes are silent: the icon showing a colour that belongs to a
// DIFFERENT step's job, and a session dying because the trainer re-rendered.

describe("per-step AI debug icons", () => {
  function failedRun(indices: number[]) {
    return {
      running: false,
      startIndex: 0,
      total: indices.length,
      ran: indices.length,
      passed: 0,
      failedAtIndex: indices[0],
      startedAt: 0,
      finishedAt: 1,
      steps: indices.map((index) => ({
        index,
        stepLabel: `click Submit ${index}`,
        ok: false,
        error: `Element not found ${index}`,
        logs: [],
      })),
    };
  }

  const stepIcons = () =>
    screen.queryAllByRole("button").filter((b) => /Debug|AI/.test(b.getAttribute("aria-label") ?? ""));

  it("offers a plain debug icon on each failed step before anything is asked", () => {
    setStore({ state: state({ testId: "t1" }), replayRun: failedRun([0, 2]) });
    render(withAiDebug(<RecordingView />));
    selectTab(/console/i);

    const icons = screen.getAllByLabelText("Debug this step with AI");
    expect(icons).toHaveLength(2);
  });

  it("opens a session for the step that was clicked, and colours only that step", async () => {
    setStore({ state: state({ testId: "t1" }), replayRun: failedRun([0, 2]) });
    render(withAiDebug(<RecordingView />));
    selectTab(/console/i);

    fireEvent.click(screen.getAllByLabelText("Debug this step with AI")[1]);

    // The dialog is rendered by AiDebugHost (mounted above the router in the
    // real app), so here we assert on what this view owns: exactly one icon
    // now carries a session's status, and the other is untouched.
    await waitFor(() => {
      expect(screen.queryAllByLabelText("Debug this step with AI")).toHaveLength(1);
    });
    expect(stepIcons()).toHaveLength(2);
    expect(screen.getByLabelText(/ready|thinking/i)).toBeTruthy();
  });

  it("keeps a step's session distinct from another step's", async () => {
    setStore({ state: state({ testId: "t1" }), replayRun: failedRun([0, 1]) });
    render(withAiDebug(<RecordingView />));
    selectTab(/console/i);

    fireEvent.click(screen.getAllByLabelText("Debug this step with AI")[0]);
    await waitFor(() =>
      expect(screen.queryAllByLabelText("Debug this step with AI")).toHaveLength(1),
    );
    fireEvent.click(screen.getByLabelText("Debug this step with AI"));

    // Both steps now have their own session — one click must not re-key or
    // overwrite the other step's job.
    await waitFor(() => expect(screen.queryAllByLabelText("Debug this step with AI")).toHaveLength(0));
    expect(stepIcons()).toHaveLength(2);
  });
});

describe("steps the AI generated are marked as new", () => {
  // The trainer's other route to "steps appeared that I didn't record": the
  // Generate Steps dialog inserts a whole flow at once. Same silent failure as
  // the detail view's Apply — the list grows with nothing saying which rows are
  // the new ones, and in the trainer the list is often long enough that the
  // additions scroll off.

  const CLICK = { k: "text", v: "Sign in" } as const;

  function glowingRows(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('[data-new-step="true"]'));
  }

  it("glows the rows the store reports as new", () => {
    setStore({
      liveSteps: [
        step("a", { type: "click", locator: CLICK }),
        step("b", { type: "wait", waitMs: 500 }),
        step("c", { type: "click", locator: CLICK }),
      ],
      newStepIds: new Set(["b"]),
    });
    render(withAiDebug(<RecordingView />));

    expect(glowingRows()).toHaveLength(1);
    expect(glowingRows()[0].textContent).toMatch(/500/);
  });

  it("glows nothing when the store reports nothing new", () => {
    // The ordinary case — steps the user recorded by interacting with the page
    // must never light up, or the highlight stops meaning anything.
    setStore({
      liveSteps: [step("a", { type: "click", locator: CLICK })],
      newStepIds: new Set<string>(),
    });
    render(withAiDebug(<RecordingView />));

    expect(glowingRows()).toHaveLength(0);
  });

});

describe("a replay started in the docked panel", () => {
  // The mirror of the panel's suite. `executing` and `replayRun` only ever get
  // set in the window that called the store, so a replay launched from the
  // docked panel leaves this window on "Recording" with every tool live — and
  // an Add step here inserts into a session that is mid-replay with capture
  // suspended. `state.replaying` is the backend's broadcast that makes both
  // windows agree; these tests set it alone, exactly as the backend does.

  it("says Replaying rather than Recording", () => {
    setStore({ state: state({ replaying: true }) });
    render(withAiDebug(<RecordingView />));
    expect(screen.getByText("Replaying")).toBeTruthy();
    // Deliberately not `queryByText("Recording")`: the window's TOOLBAR TITLE
    // reads "Recording" for the whole session and is not the status. Asserting
    // its absence would pass only while the title happened to say something
    // else, which is a test of the wrong element.
    expect(screen.queryByText("Replaying")).not.toBe(null);
  });

  it("still says Running for a real Playwright run", () => {
    // "Replaying" is specifically the in-window preview. A runner execution is
    // a different thing with different semantics (a real browser, real
    // actionability), and collapsing the two labels would hide which one the
    // user is looking at.
    setStore({ executing: true });
    render(withAiDebug(<RecordingView />));
    expect(screen.getByText("Running")).toBeTruthy();
  });

  it("disables the tools that would act into the run", () => {
    setStore({ state: state({ replaying: true }) });
    render(withAiDebug(<RecordingView />));
    // Queried by ROLE + accessible name, as the rest of this suite does: the
    // main window's tools are text-labelled buttons, not the icon-only ones the
    // narrow docked panel uses.
    for (const name of [/add step/i, /replay from the current step/i]) {
      expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    }
  });
});

describe("the training viewport narrowing is not allowed to be silent", () => {
  it("tells the user when the backend says the browser got narrower", async () => {
    // THIS is the window that has to carry the notice. `noteViewportChange`
    // fires while the trainer panel is still being created — before
    // `panelWindow.loadURL` — so on the ordinary path (a panel that opens
    // already docked) the panel's page does not exist yet and the push reaches
    // a window with no listeners. The main window has been loaded since the
    // session started, so a subscription only in the panel would be one that
    // never fires in the real app while its own test passed.
    render(withAiDebug(<RecordingView />));
    emit("trainerPanel:viewportNarrowed", { width: 1080 });
    await waitFor(() => {
      const t = toastTexts().find((x) => x.title.includes("Training viewport narrowed"));
      expect(t).toBeTruthy();
      expect(t?.title).toContain("1080");
    });
  });

  it("leaves the notice up instead of expiring it behind the training browser", async () => {
    // Docking moves focus to the training browser and the panel beside it, so
    // this toast is raised in a window the user is, at that exact moment, not
    // looking at. A few seconds of auto-dismiss would run out behind another
    // window and the warning would be gone before anyone saw it — which is the
    // same silence the notice was added to end.
    render(withAiDebug(<RecordingView />));
    emit("trainerPanel:viewportNarrowed", { width: 1080 });
    await waitFor(() => expect(toastCalls.length).toBeGreaterThan(0));
    const opts = toastCalls[toastCalls.length - 1].options as { duration?: unknown };
    expect(opts?.duration).toBe(Infinity);
  });

  it("stays quiet until the backend actually reports a narrowing", () => {
    // The one-per-session guarantee and the "not when the width was preserved"
    // rule both live in the backend. The renderer must not manufacture a notice
    // on its own — mounting the view is not evidence anything narrowed.
    render(withAiDebug(<RecordingView />));
    expect(toastTexts().some((x) => x.title.includes("Training viewport narrowed"))).toBe(false);
  });
});
