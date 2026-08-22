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
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

import type { RecorderState, Step, StepType } from "../lib/recorder-types";
import { RecordingView } from "./recording-view";
import { INSERT_HERE } from "./step-row";
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
  verifyGeneratedSteps: vi.fn(async () => ({ inserted: 0, results: [] })),
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
  addVariable: vi.fn(async () => {}),
  extractFlow: vi.fn(async () => {}),
  enterFlowScope: vi.fn(async () => {}),
  exitFlowScope: vi.fn(async () => {}),
  setFlowCursor: vi.fn(),
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
      history: async () => [],
      record: async (r: unknown) => r,
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
    flowScope: null,
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

describe("the session-state chip", () => {
  // NONE OF THESE STATES IS AN OUTCOME, so none takes a status hue. That is a
  // real change rather than a restyle: `Recording` was the SDK's `error`
  // variant — RED, the colour this palette spends on a failed run — on the one
  // screen where nothing has run yet.
  const chip = () => document.querySelector('[data-gl="status-chip"]') as HTMLElement | null;

  it("draws Recording as in-flight, not as an outcome", () => {
    render(withAiDebug(<RecordingView />));
    expect(chip()?.textContent).toBe("Recording");
    expect(chip()?.dataset.tone).toBe("running");
  });

  it("never paints a session state in a status colour", () => {
    // The rule, stated once over every state this row can be in. `running` is
    // the holo treatment, and `neutral` is the absence of one — a hue here
    // would be claiming a result.
    for (const over of [
      {},
      { paused: true },
      { replaying: true },
      { pageReady: false },
      { editing: true },
    ]) {
      const { unmount } = render(withAiDebug(<RecordingView />));
      const tone = chip()?.dataset.tone;
      expect(["running", "neutral"], JSON.stringify(over)).toContain(tone);
      unmount();
      setStore({ state: state(over) });
    }
  });

  it("draws Paused as neutral — real, but not live and not a result", () => {
    setStore({ state: state({ paused: true }) });
    render(withAiDebug(<RecordingView />));
    expect(chip()?.textContent).toBe("Paused");
    expect(chip()?.dataset.tone).toBe("neutral");
  });
});

describe("the hard/soft assertion choice", () => {
  it("can be driven by a plain click", () => {
    // WORTH ITS OWN TEST because it could not be done before B6. This was the
    // SDK's `SegmentedControl`, a Radix control that activates on pointer-down
    // — `fireEvent.click` left it untouched and the assertion then reported
    // "0 calls", which reads as a dead handler rather than the wrong event
    // (CLAUDE.md). The theme's `Segmented` is plain buttons with
    // `aria-pressed`, so the choice is finally assertable at this level
    // instead of only at the IPC layer.
    render(withAiDebug(<RecordingView />));
    fireEvent.click(screen.getByRole("button", { name: "Soft" }));
    expect(screen.getByRole("button", { name: "Soft" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Hard" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("re-arms an active assertion with the new strictness", () => {
    // The choice only reaches the backend while an assertion is being picked —
    // otherwise it is a local default the next pick will use. Pinning the live
    // case because that is the one where getting it wrong records a hard
    // assertion the user asked to be soft.
    setStore({ state: state({ assertMode: "visible" }) });
    render(withAiDebug(<RecordingView />));
    fireEvent.click(screen.getByRole("button", { name: "Soft" }));
    expect(actions.setAssert).toHaveBeenCalledWith("visible", true);
  });

  it("reports the current choice through aria-pressed", () => {
    render(withAiDebug(<RecordingView />));
    expect(screen.getByRole("button", { name: "Hard" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Soft" }).getAttribute("aria-pressed")).toBe("false");
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

describe("continuing an existing test: where a captured step goes", () => {
  // Mirror of the block in trainer-panel-view.test.tsx, and it has to be a
  // mirror: the two trainers are two renderings of one step list, so a fix
  // present in only one of them is a bug that appears or not depending on
  // which window the user happens to be looking at.
  //
  // The report: "I only see the Paused and Editing options in the trainer
  // window, and it doesn't appear to record any manual page interaction."
  // Capture was live throughout. The insert cursor sits where the browser is —
  // just past the navigation for a continued test — so a captured step landed
  // near the TOP of the list while the view scrolled to the bottom.

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
    continuedSession();
    render(withAiDebug(<RecordingView />));
    expect(screen.getByText("Recording")).toBeTruthy();
    // "Editing recording" is the view's TITLE and stays — that is the right
    // place for the distinction. The status chip is not.
    expect(screen.queryByText("Editing")).toBe(null);
  });

  it("names the insert point when it is not at the end of the list", () => {
    continuedSession();
    render(withAiDebug(<RecordingView />));
    expect(screen.getAllByText(INSERT_HERE).length).toBeGreaterThan(0);
  });

  it("says nothing at the end of the list, where steps appear under the last row", () => {
    continuedSession({ state: state({ editing: true, cursor: 4 }) });
    render(withAiDebug(<RecordingView />));
    expect(screen.queryByText(INSERT_HERE)).toBe(null);
  });

  it("scrolls the arriving step into view", () => {
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
      render(withAiDebug(<RecordingView />));
      expect(
        scrolled.some((el) => el.getAttribute("data-just-added") === "true"),
        "the arriving row scrolled itself into view",
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── "Use variable…" from the training browser ─────────────────────────────
//
// The right-click item is a backend menu, so the only half reachable from here
// is the half that matters: a `fill` context action must open the composer on
// the fill kind, with the right-clicked element already the target. If it
// doesn't, the menu item is a click that appears to do nothing at all — the
// browser is a separate window, so there is nowhere else for the user to look.
describe("the fill context action", () => {
  const PICKED = {
    tag: "input",
    description: "input#password",
    candidates: [{ k: "css", v: "#password" } as const],
    css: {},
    attributes: {},
    ambiguous: false,
    contextBaseCount: 1,
    contextSignals: [],
  };

  it("opens the composer on the fill kind, targeting the right-clicked element", async () => {
    setStore({
      state: state({ variables: [{ name: "storePassword", kind: "secret" }] }),
      contextAction: {
        kind: "fill",
        picked: PICKED,
        prefillText: "",
        prefillValue: "",
        target: "main",
      },
    });
    render(withAiDebug(<RecordingView />));
    await waitFor(() =>
      expect(screen.getByRole("form", { name: /fill with a variable/i })).toBeTruthy(),
    );
    expect(screen.getByText("input#password")).toBeTruthy();
    expect(screen.getByText("${storePassword}")).toBeTruthy();
  });

  it("ignores one addressed to the docked panel", () => {
    // Both windows receive the broadcast. Without the address check, one
    // right-click opens two composers.
    setStore({
      contextAction: {
        kind: "fill",
        picked: PICKED,
        prefillText: "",
        prefillValue: "",
        target: "panel",
      },
    });
    render(withAiDebug(<RecordingView />));
    expect(screen.queryByRole("form", { name: /fill with a variable/i })).toBe(null);
  });

  it("inserts a fill step carrying the reference", async () => {
    setStore({
      state: state({ variables: [{ name: "storePassword", kind: "secret" }] }),
      contextAction: {
        kind: "fill",
        picked: PICKED,
        prefillText: "",
        prefillValue: "",
        target: "main",
      },
    });
    render(withAiDebug(<RecordingView />));
    const form = await waitFor(() =>
      screen.getByRole("form", { name: /fill with a variable/i }),
    );
    fireEvent.click(screen.getByText("${storePassword}"));
    // Scoped to the composer: the toolbar has an "Add step" button too, and an
    // ambiguous query reports as "never rendered".
    fireEvent.click(within(form).getByRole("button", { name: /add step/i }));
    expect(actions.insertStep).toHaveBeenCalledWith({
      type: "fill",
      locator: { k: "css", v: "#password" },
      value: "${storePassword}",
    });
  });
});

describe("multi-select and Create flow", () => {
  const CLICK = { k: "testid" as const, v: "go" };
  const fourSteps = () => [
    step("a", { type: "goto", url: "https://example.com" }),
    step("b", { type: "click", locator: CLICK }),
    step("c", { type: "fill", locator: { k: "label", v: "Email" }, value: "x" }),
    step("d", { type: "assert", assert: "visible", locator: CLICK }),
  ];

  it("shift-click selects the whole run and surfaces the Create flow button", () => {
    setStore({ liveSteps: fourSteps() });
    render(withAiDebug(<RecordingView />));
    const rows = screen.getAllByRole("option");
    fireEvent.click(rows[1]);
    // No button for a single selection? One step is a legal flow — the button
    // appears from the first selected row.
    expect(screen.getByRole("button", { name: /create flow \(1\)/i })).toBeTruthy();
    fireEvent.click(rows[3], { shiftKey: true });
    expect(screen.getByRole("button", { name: /create flow \(3\)/i })).toBeTruthy();
  });

  it("⌘-click toggles a row in and out of the selection", () => {
    setStore({ liveSteps: fourSteps() });
    render(withAiDebug(<RecordingView />));
    const rows = screen.getAllByRole("option");
    fireEvent.click(rows[0]);
    fireEvent.click(rows[2], { metaKey: true });
    expect(screen.getByRole("button", { name: /create flow \(2\)/i })).toBeTruthy();
    fireEvent.click(rows[2], { metaKey: true });
    expect(screen.getByRole("button", { name: /create flow \(1\)/i })).toBeTruthy();
  });

  it("refuses a gapped selection with a visible sentence instead of a dead dialog", () => {
    setStore({ liveSteps: fourSteps() });
    render(withAiDebug(<RecordingView />));
    const rows = screen.getAllByRole("option");
    fireEvent.click(rows[0]);
    fireEvent.click(rows[2], { metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: /create flow/i }));
    expect(screen.getByText(/contiguous run of steps/i)).toBeTruthy();
    // And the naming dialog did NOT open.
    expect(screen.queryByLabelText("Flow name")).toBeNull();
  });

  it("creates the flow through the dialog, in list order, and clears the selection", async () => {
    setStore({ liveSteps: fourSteps() });
    render(withAiDebug(<RecordingView />));
    const rows = screen.getAllByRole("option");
    // Click DOWNWARD from row 2 to row 1, so the ids-are-list-ordered rule is
    // what the assertion below is actually about.
    fireEvent.click(rows[2]);
    fireEvent.click(rows[1], { metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: /create flow \(2\)/i }));
    fireEvent.change(await screen.findByLabelText("Flow name"), { target: { value: "Sign in" } });
    fireEvent.click(screen.getByRole("button", { name: "Create flow" }));
    await waitFor(() =>
      expect(actions.extractFlow).toHaveBeenCalledWith(["b", "c"], "Sign in"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /create flow/i })).toBeNull(),
    );
  });

  it("shows the backend's refusal beside the name field", async () => {
    actions.extractFlow.mockRejectedValueOnce(new Error("A test named “Sign in” already exists — pick another name."));
    setStore({ liveSteps: fourSteps() });
    render(withAiDebug(<RecordingView />));
    fireEvent.click(screen.getAllByRole("option")[1]);
    fireEvent.click(screen.getByRole("button", { name: /create flow \(1\)/i }));
    fireEvent.change(await screen.findByLabelText("Flow name"), { target: { value: "Sign in" } });
    fireEvent.click(screen.getByRole("button", { name: "Create flow" }));
    expect(await screen.findByText(/already exists/)).toBeTruthy();
  });

  it("expands a runFlow row into a read-only preview of the flow's steps", async () => {
    setStore({
      liveSteps: [
        step("a", { type: "goto", url: "https://example.com" }),
        step("f", { type: "runFlow", flowId: "flow-1", label: "Sign in" }),
      ],
    });
    render(withAiDebug(<RecordingView />));
    fireEvent.click(screen.getByRole("button", { name: /show the flow's steps/i }));
    // The api mock has no tests.get, so the preview reports the flow missing —
    // which is itself the state worth pinning: a fetch failure says so rather
    // than rendering nothing.
    expect(await screen.findByText(/can't be found/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /collapse flow steps/i }));
    expect(screen.queryByText(/can't be found/i)).toBeNull();
  });
});

describe("inline flow editing (the open scope)", () => {
  const callRow = () =>
    step("f", { type: "runFlow", flowId: "flow-1", label: "Sign in" });

  it("offers Edit from the expanded read-only preview and enters the scope", async () => {
    setStore({ liveSteps: [callRow()] });
    render(withAiDebug(<RecordingView />));
    fireEvent.click(screen.getByRole("button", { name: /show the flow's steps/i }));
    // The api mock has no tests.get, so the preview reports the flow missing —
    // and a missing flow must NOT offer editing.
    await screen.findByText(/can't be found/i);
    expect(screen.queryByText(/Edit “/)).toBeNull();
  });

  it("renders the scope editor with the banner and routes Done to exitFlowScope", async () => {
    setStore({
      liveSteps: [callRow()],
      flowScope: {
        flowId: "flow-1",
        callStepId: "f",
        name: "Sign in",
        cursor: 1,
        steps: [step("fs1", { type: "click", locator: { k: "testid", v: "go" } })],
      },
    });
    render(withAiDebug(<RecordingView />));
    fireEvent.click(screen.getByRole("button", { name: /show the flow's steps/i }));
    expect(await screen.findByText(/Recording into/)).toBeTruthy();
    // The flow's steps render as rows inside the editor.
    expect(screen.getByText(/getByTestId\("go"\)\.click/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /done editing flow/i }));
    await waitFor(() => expect(actions.exitFlowScope).toHaveBeenCalled());
  });

  it("moves the SCOPE cursor from the editor's gaps, not the session's", async () => {
    setStore({
      liveSteps: [callRow()],
      flowScope: {
        flowId: "flow-1",
        callStepId: "f",
        name: "Sign in",
        cursor: 1,
        steps: [step("fs1", { type: "click", locator: { k: "testid", v: "go" } })],
      },
    });
    render(withAiDebug(<RecordingView />));
    fireEvent.click(screen.getByRole("button", { name: /show the flow's steps/i }));
    await screen.findByText(/Recording into/);
    // The editor's first gap is index 0 within the SCOPE.
    const gaps = screen.getAllByLabelText("Move insert point here");
    fireEvent.click(gaps[gaps.length - 2]); // the scope's first gap sits after the session's
    await waitFor(() => expect(actions.setFlowCursor).toHaveBeenCalled());
    expect(actions.setCursor).not.toHaveBeenCalled();
  });
});
