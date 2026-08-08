// Component tests for the test detail view's run controls.
//
// This is where per-test preferences (browser, headless, capture, timeout) turn
// into an actual run. Each is stored per test with a fall-back to a global
// default, and each is persisted on change — so the failure modes are "my
// setting didn't stick" and, worse, "it ran with different settings than the
// ones on screen". The second is silent, which is why the run arguments are
// asserted rather than just the controls' appearance.

import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { RecorderSettings, RunRecord, Step, StepType, TestRecord } from "../lib/recorder-types";
import { TestDetailView, persistRunBrowser } from "./test-detail-view";
import { runSessionKey, useAiDebug, type AiDebugRunContext } from "./ai-debug-store";
import { withAiDebug } from "../__tests__/ai-debug-harness";

let test_: TestRecord | null = null;
let settings: Partial<RecorderSettings> = {};
let runs: RunRecord[] = [];
// The route param, mutable so a test can model the sidebar switching tests.
// The router does NOT remount a route component when only its params change
// (no `remountDeps` on the route), so that switch is a re-render of the SAME
// component instance under a new id — which is where per-test state leaks.
let routeId = "t1";
// Records reachable by id, for those navigation tests. `test_` still answers
// for any id the map doesn't hold, so single-test suites are unaffected.
let library: Record<string, TestRecord> = {};

const run = vi.fn();
const setHeadless = vi.fn(async () => ({}) as TestRecord);
const setBrowser = vi.fn(async () => ({}) as TestRecord);
const setCaptureArtifacts = vi.fn(async () => ({}) as TestRecord);
const setTestTimeout = vi.fn(async () => ({}) as TestRecord);
// Typed with the real signature, unlike the setters above: these assertions
// read the third argument, and a zero-arg mock makes indexing it a type error.
const updateSteps = vi.fn(
  async (_id: string, _steps: Step[], _opts?: { regenerate?: boolean }) => ({}) as TestRecord,
);
// The real `tests:updateScript` handler re-parses the spec and returns the
// record with a WHOLLY REBUILT step list — new ids and all. Tests that exercise
// the AI-apply path override this to model that; everything else keeps the
// inert default.
const updateScript = vi.fn(async (_id: string, _source: string) => ({}) as TestRecord);

vi.mock("./recorder-store", () => ({
  // Mirrors the real store's contract: calling run() bumps runEpoch, which the
  // view watches to retire the new-step glow the moment a run starts.
  useRecorder: () => {
    const [epoch, setEpoch] = React.useState(0);
    return {
      runs: {},
      run: (...a: unknown[]) => {
        run(...(a as []));
        setEpoch((e) => e + 1);
      },
      stopRun: vi.fn(),
      start: vi.fn(),
      runEpoch: epoch,
    };
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: routeId }),
}));

vi.mock("../lib/api", () => ({
  api: {
    tests: {
      get: async (id: string) => library[id] ?? test_,
      getScript: async () => "import { test } from '@playwright/test';",
      setHeadless: (...a: unknown[]) => setHeadless(...(a as [])),
      setBrowser: (...a: unknown[]) => setBrowser(...(a as [])),
      setCaptureArtifacts: (...a: unknown[]) => setCaptureArtifacts(...(a as [])),
      setTestTimeout: (...a: unknown[]) => setTestTimeout(...(a as [])),
      remove: async () => {},
      rename: async () => ({}) as TestRecord,
      updateScript: (...a: Parameters<typeof updateScript>) => updateScript(...a),
      updateSteps: (...a: Parameters<typeof updateSteps>) => updateSteps(...a),
    },
    recorder: { getSettings: async () => settings as RecorderSettings },
    runs: {
      // Returns a REAL summary on purpose: the toolbar must not render the old
      // "(adds ~…)" hint even when overhead data exists to show. With a null
      // here, the absence assertion below would pass vacuously.
      captureOverhead: async () => ({
        capturedRuns: 3,
        meanCaptureMs: 1400,
        meanMsPerShot: 200,
        meanCapturedDurationMs: 9000,
        meanUncapturedDurationMs: 7600,
        captureShareOfRun: 0.18,
      }),
      list: async () => runs,
    },
    heals: { list: async () => [] },
    artifacts: { getReplay: async () => null },
    aiDebug: {
      list: async () => [],
      save: async (s: unknown) => s,
      remove: async () => ({ removed: 0 }),
      clear: async () => ({ removed: 0 }),
      notifyDone: async () => ({ ok: true }),
    },
    llm: {
      getConfig: async () => ({ provider: "ollama", model: null, baseUrls: {} }),
      status: async () => ({ online: false, models: [] }),
      setConfig: async () => ({}),
      chat: async () => ({ requestId: "req-test" }),
      cancel: async () => {},
      isActive: async () => ({ active: false }),
    },
    on: () => () => {},
  },
}));

function record(over: Partial<TestRecord> = {}): TestRecord {
  return {
    id: "t1",
    name: "Checkout",
    url: "https://example.com",
    createdAt: 1,
    updatedAt: 1,
    steps: [],
    scriptPath: "/tmp/t1.spec.ts",
    ...over,
  } as TestRecord;
}

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={qc}>{withAiDebug(<TestDetailView />)}</QueryClientProvider>
  );
  const result = render(tree());
  return {
    ...result,
    /** What clicking another test in the sidebar does: same component instance,
     *  new route param. Deliberately NOT a fresh render — remounting would hide
     *  exactly the state-leak this models. */
    renavigate(id: string) {
      routeId = id;
      result.rerender(tree());
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  test_ = record();
  routeId = "t1";
  library = {};
  runs = [];
  settings = {
    defaultRunBrowser: "chromium",
    defaultRunHeadless: false,
    defaultCaptureArtifacts: false,
    defaultTestTimeoutMs: 60_000,
  };
});

describe("the Accessibility tab", () => {
  it("sits after Heals, so the run-related tabs stay together", async () => {
    // Placement is the whole request: it belongs beside Heals, not buried at
    // the front where it would push Steps and Script along.
    renderView();
    const tabs = await screen.findAllByRole("tab");
    const names = tabs.map((t) => t.textContent);
    expect(names[names.length - 1]).toMatch(/Accessibility/);
    expect(names[names.length - 2]).toMatch(/Heals/);
  });

  it("badges the unaccepted count from the most recent CHECKED run", async () => {
    // A later run with the toggle off must not clear the badge — the user
    // would read a cleared badge as the issues having been fixed.
    runs = [
      { id: "r2", testId: "t1", startedAt: 2_000 } as RunRecord,
      { id: "r1", testId: "t1", startedAt: 1_000, a11yChecks: 4, a11yNewSteps: 3 } as RunRecord,
    ];
    renderView();
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Accessibility \(3\)/ })).toBeTruthy(),
    );
  });

  it("carries no count when nothing is unaccepted", async () => {
    runs = [{ id: "r1", testId: "t1", startedAt: 1_000, a11yChecks: 4 } as RunRecord];
    renderView();
    const tab = await screen.findByRole("tab", { name: /Accessibility/ });
    expect(tab.textContent).toBe("Accessibility");
  });

  it("is not offered for an imported test", async () => {
    // The check runs from the capture fixture, which an imported spec never
    // loads — the tab could only ever be empty.
    test_ = record({ sourceDir: "/imported/project" });
    renderView();
    await screen.findByText("Checkout");
    expect(screen.queryByRole("tab", { name: /Accessibility/ })).toBeNull();
  });
});

describe("run controls", () => {
  it("shows the test name", async () => {
    renderView();
    expect(await screen.findByText("Checkout")).toBeTruthy();
  });

  it("falls back to the global default browser for a test with no preference", async () => {
    settings = { ...settings, defaultRunBrowser: "webkit" };
    renderView();
    await screen.findByText("Checkout");
    expect(await screen.findByText("WebKit")).toBeTruthy();
  });

  it("prefers the test's own saved browser over the global default", async () => {
    test_ = record({ runBrowser: "firefox" });
    settings = { ...settings, defaultRunBrowser: "webkit" };
    renderView();
    await screen.findByText("Checkout");
    expect(await screen.findByText("Firefox")).toBeTruthy();
  });

  it("leaves the trigger's glyph to the Select, so only one icon shows", async () => {
    // SelectValue already draws the selected item's `icon` — the SF Symbol on
    // the SelectItem. Drawing our own lucide glyph beside it put TWO browser
    // icons on a control whose whole job is to name one engine.
    test_ = record({ runBrowser: "firefox" });
    renderView();
    await screen.findByText("Checkout");
    const trigger = screen.getByRole("combobox", { name: /browser engine for this test/i });
    expect(trigger.querySelectorAll("[data-browser]").length).toBe(0);
    expect(trigger.textContent).toContain("Firefox");
  });

  it("re-seeds the controls when the route moves to another test", async () => {
    // The bug this pins: the picker kept the engine of the test viewed BEFORE
    // this one, so the sidebar row said Chromium while the picker said Firefox
    // — for the same test. The route component is never remounted on an id
    // change, so a one-shot "already initialised" latch never fires again.
    library = {
      t1: record({ runBrowser: "firefox", testTimeoutMs: 120_000 }),
      t2: record({ id: "t2", name: "Search", runBrowser: "chromium" }),
    };
    const view = renderView();
    await screen.findByText("Firefox");

    view.renavigate("t2");

    await screen.findByText("Search");
    const trigger = screen.getByRole("combobox", { name: /browser engine for this test/i });
    await waitFor(() => expect(trigger.textContent).toContain("Chromium"));
    expect(trigger.textContent).not.toContain("Firefox");
    // Every per-test control seeds from the same latch, so they all leaked.
    expect((screen.getByLabelText(/per-test timeout/i) as HTMLInputElement).value).toBe("");
  });

  it("persists a headless change", async () => {
    renderView();
    await screen.findByText("Checkout");
    fireEvent.click(screen.getByLabelText(/run this test headless/i));
    await waitFor(() => expect(setHeadless).toHaveBeenCalledWith("t1", true));
  });

  it("persists a capture change", async () => {
    renderView();
    await screen.findByText("Checkout");
    fireEvent.click(screen.getByLabelText(/capture screenshots/i));
    await waitFor(() => expect(setCaptureArtifacts).toHaveBeenCalledWith("t1", true));
  });

  it("persists a per-test timeout override in milliseconds", async () => {
    renderView();
    await screen.findByText("Checkout");
    const input = screen.getByLabelText(/per-test timeout/i) as HTMLInputElement;
    // Empty = use Settings default; placeholder shows that default in seconds.
    expect(input.placeholder).toBe("60");
    fireEvent.change(input, { target: { value: "180" } });
    await waitFor(() => expect(setTestTimeout).toHaveBeenCalledWith("t1", 180_000));
  });

  it("clears the timeout override when the field is emptied", async () => {
    test_ = record({ testTimeoutMs: 120_000 });
    renderView();
    await screen.findByText("Checkout");
    const input = screen.getByLabelText(/per-test timeout/i) as HTMLInputElement;
    expect(input.value).toBe("120");
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(setTestTimeout).toHaveBeenCalledWith("t1", null));
  });

  it("steps the timeout in single seconds", async () => {
    // A 5-second stepper made "47s" unreachable from the arrows; the input
    // now moves one second at a time.
    renderView();
    await screen.findByText("Checkout");
    const input = screen.getByLabelText(/per-test timeout/i) as HTMLInputElement;
    expect(input.step).toBe("1");
  });

  it("persists a timeout that is not a multiple of five", async () => {
    // Pins that loosening the stepper wasn't undone by re-rounding in the
    // change handler: 7 must persist as 7000, not snap to 5 or 10.
    renderView();
    await screen.findByText("Checkout");
    const input = screen.getByLabelText(/per-test timeout/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "7" } });
    await waitFor(() => expect(setTestTimeout).toHaveBeenCalledWith("t1", 7_000));
  });

  it("still clamps a sub-floor timeout up to 5 seconds", async () => {
    // The finer stepper must not have loosened the floor from run-pacing.
    renderView();
    await screen.findByText("Checkout");
    const input = screen.getByLabelText(/per-test timeout/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "3" } });
    await waitFor(() => expect(setTestTimeout).toHaveBeenCalledWith("t1", 5_000));
  });

  it("never shows the capture-overhead hint, even when overhead data exists", async () => {
    // The api mock above returns a real overhead summary, so this fails
    // against any code that renders the old "(adds ~1.4 s, 18%)" label.
    renderView();
    await screen.findByText("Checkout");
    await screen.findByLabelText(/capture screenshots/i);
    expect(screen.queryByText(/adds ~/)).toBeNull();
  });

  it("stacks the four run toggles as one two-column block", async () => {
    renderView();
    await screen.findByText("Checkout");
    const block = screen
      .getByLabelText(/run this test headless/i)
      .closest("div.grid") as HTMLElement | null;
    expect(block).not.toBeNull();
    expect(block!.className).toContain("grid-cols-2");
    // All four toggles live in the same block — a checkbox that escapes the
    // grid silently breaks the gang-of-four layout without failing anything.
    for (const label of [
      /capture screenshots on this run/i,
      /record console and network/i,
      /check accessibility/i,
    ]) {
      expect(block!.contains(screen.getByLabelText(label))).toBe(true);
    }
  });
});

describe("persisting the browser choice", () => {
  // The Select is native-menu-backed — its options are drawn by AppKit and
  // never enter the DOM — so the change cannot be driven through the trigger
  // in jsdom. The handler behind it is exported and called directly instead.

  it("refreshes every cached copy of the record it just changed", async () => {
    // The ["tests"] list holds its own copy of the record and nothing else in
    // this flow refetches it, so without this the cache keeps the engine the
    // test USED to run on until something unrelated happens to refresh it.
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    await persistRunBrowser(qc, "t1", "firefox");
    expect(setBrowser).toHaveBeenCalledWith("t1", "firefox");
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["tests"]));
    expect(keys).toContain(JSON.stringify(["test", "t1"]));
  });

  it("refreshes nothing when the write failed", async () => {
    // Nothing on disk changed, so there is nothing to re-read — and the run
    // still uses the on-screen choice, which is why this stays best-effort.
    setBrowser.mockRejectedValueOnce(new Error("read-only volume"));
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    await persistRunBrowser(qc, "t1", "firefox");
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("running", () => {
  it("runs with the settings shown on screen", async () => {
    // The silent failure this guards: controls say one thing, the run uses
    // another. run(id, captureArtifacts, headless, browser).
    test_ = record({ runBrowser: "firefox", runHeadless: true });
    renderView();
    await screen.findByText("Checkout");
    await screen.findByText("Firefox");

    fireEvent.click(screen.getByRole("button", { name: /run test/i }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const [id, , headless, browser] = run.mock.calls[0];
    expect(id).toBe("t1");
    expect(headless).toBe(true);
    expect(browser).toBe("firefox");
  });

  it("passes the capture flag through", async () => {
    test_ = record({ captureArtifacts: true });
    renderView();
    await screen.findByText("Checkout");

    fireEvent.click(screen.getByRole("button", { name: /run test/i }));

    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(run.mock.calls[0][1]).toBe(true);
  });

  /** The capture checkbox, once the view has finished seeding its toggles from
   *  the record. Without waiting for that, an assertion races the one-shot init
   *  effect and passes against the pre-initialised state — which is exactly how
   *  the first version of these tests passed with the bug still in place. */
  async function captureBoxAfterInit() {
    await screen.findByText("Checkout");
    const headless = screen.getByLabelText(/run this test headless/i);
    await waitFor(() => expect(headless.getAttribute("data-state")).toBe("checked"));
    return screen.getByLabelText(/capture screenshots/i);
  }

  it("leaves capture enabled while headless is on", async () => {
    // These used to be coupled, on the assumption that screenshots of an
    // invisible browser aren't useful. They are: headless Chromium renders to
    // an offscreen surface and page.screenshot() works identically — it's how
    // visual regression testing is normally done, and headless avoids the
    // window chrome and focus rings that make headed baselines noisy.
    test_ = record({ runHeadless: true });
    renderView();
    const capture = await captureBoxAfterInit();
    expect(capture.getAttribute("data-disabled") ?? capture.getAttribute("disabled")).toBeNull();
  });

  it("shows capture as ticked while headless is on, rather than lying about it", async () => {
    // The old UI forced the box to render unticked under headless while still
    // passing the SAVED value to the run — so a test with both flags captured
    // anyway and the checkbox said otherwise. Displayed state has to match what
    // actually runs.
    test_ = record({ runHeadless: true, captureArtifacts: true });
    renderView();
    const capture = await captureBoxAfterInit();
    expect(capture.getAttribute("data-state")).toBe("checked");
  });

  it("can toggle capture on while headless is on", async () => {
    // Guards the third part of the old coupling: a click handler that returned
    // early under headless, so the box could not be ticked at all.
    test_ = record({ runHeadless: true, captureArtifacts: false });
    renderView();
    const capture = await captureBoxAfterInit();
    fireEvent.click(capture);
    await waitFor(() => expect(setCaptureArtifacts).toHaveBeenCalledWith("t1", true));
  });

});

describe("diverged steps warning", () => {
  it("warns when the script has statements the parser couldn't map", async () => {
    test_ = record({ stepsDiverged: true });
    renderView();
    expect(await screen.findByText(/may not reflect the script/i)).toBeTruthy();
  });

  it("stays quiet when steps and script agree", async () => {
    renderView();
    await screen.findByText("Checkout");
    expect(screen.queryByText(/may not reflect the script/i)).toBeNull();
  });

  it("says so plainly when the saved steps were never put into the script", async () => {
    // Different cause, different fix: this one is undone by regenerating, and
    // the parse-failure wording ("couldn't be parsed back into steps") would
    // send the user looking for a problem in their script instead.
    test_ = record({ stepsDiverged: true, stepsDivergedReason: "unapplied" });
    renderView();
    expect(await screen.findByText(/saved without regenerating/i)).toBeTruthy();
    expect(screen.queryByText(/couldn't be parsed back into steps/i)).toBeNull();
  });

  it("doesn't tell an imported test to regenerate, which it can never do", async () => {
    // The fix the warning names has to exist. "Choose Regenerate script" sends
    // the user to a button this path never shows.
    test_ = record({
      stepsDiverged: true,
      stepsDivergedReason: "unapplied",
      sourceDir: "/imported/project",
    });
    renderView();
    expect(await screen.findByText(/never regenerated from steps/i)).toBeTruthy();
    expect(screen.queryByText(/Regenerate script/i)).toBeNull();
  });
});

// "Edit Steps" against a script that is NOT generated from the steps.
//
// The bug this covers was a total silent no-op: the steps saved, the Steps tab
// updated, and the .spec.ts that runs was untouched with nothing on screen
// saying so. The fix is a question at save time, so what's asserted is that the
// question is asked AND that each answer reaches the backend intact — a dialog
// whose buttons both send the same flag looks right and changes nothing.
describe("editing steps when the script isn't generated from them", () => {
  /** Open "Edit Test" → "Edit Steps" and hand back the editor's Save button.
   *
   *  The SDK's DropdownMenu is native-menu-backed, like its Select: the items
   *  render to `null` and are handed to `glazeAPI.Menu.popup`, which answers
   *  with the chosen commandId. So the menu is driven by standing in for the
   *  native popup, not by clicking a DOM node that never exists. */
  async function openStepEditor() {
    (window as unknown as { glazeAPI: { Menu: { popup: unknown } } }).glazeAPI.Menu.popup = vi.fn(
      async (opts: { items: { label?: string; commandId?: number }[] }) => {
        const item = opts.items.find((i) => i.label === "Edit Steps");
        // Not found means the entry was renamed or dropped — answer "nothing
        // chosen" rather than a wrong commandId, so the test fails on the
        // missing editor instead of silently invoking another menu entry.
        return item?.commandId === undefined ? {} : { commandId: item.commandId };
      },
    );
    renderView();
    await screen.findByText("Checkout");
    fireEvent.click(screen.getByRole("button", { name: /edit test/i }));
    return await screen.findByRole("button", { name: "Save" });
  }

  it("saves and regenerates without a question when the script is generated from steps", async () => {
    test_ = record();
    fireEvent.click(await openStepEditor());

    await waitFor(() => expect(updateSteps).toHaveBeenCalledTimes(1));
    expect(updateSteps.mock.calls[0][2]).toEqual({ regenerate: false });
    expect(screen.queryByText(/Apply these steps to the script/i)).toBeNull();
  });

  it("asks instead of quietly saving steps the script will never run", async () => {
    test_ = record({ scriptEdited: true });
    fireEvent.click(await openStepEditor());

    expect(await screen.findByText(/Apply these steps to the script/i)).toBeTruthy();
    // Nothing is written until the question is answered — the old behaviour
    // saved here and returned as if the edit had taken effect.
    expect(updateSteps).not.toHaveBeenCalled();
  });

  it("applies the steps to the script when the user asks for that", async () => {
    test_ = record({ scriptEdited: true });
    fireEvent.click(await openStepEditor());
    fireEvent.click(await screen.findByRole("button", { name: /regenerate script/i }));

    await waitFor(() => expect(updateSteps).toHaveBeenCalledTimes(1));
    expect(updateSteps.mock.calls[0][2]).toEqual({ regenerate: true });
  });

  it("leaves the script alone when the user asks for that", async () => {
    test_ = record({ scriptEdited: true });
    fireEvent.click(await openStepEditor());
    fireEvent.click(await screen.findByRole("button", { name: /save steps only/i }));

    await waitFor(() => expect(updateSteps).toHaveBeenCalledTimes(1));
    expect(updateSteps.mock.calls[0][2]).toEqual({ regenerate: false });
  });

  it("never offers to regenerate an imported test's spec", async () => {
    // Offering it would be a lie twice over: the backend refuses, and doing it
    // would replace a file whose sibling imports a generated spec can't carry.
    test_ = record({ scriptEdited: true, sourceDir: "/imported/project" });
    fireEvent.click(await openStepEditor());

    expect(await screen.findByText(/Save steps without changing the script/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /regenerate script/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^save steps$/i }));
    await waitFor(() => expect(updateSteps).toHaveBeenCalledTimes(1));
    expect(updateSteps.mock.calls[0][2]).toEqual({ regenerate: false });
  });
});

// --------------------------------------------------------------------------
// Applying an AI-debug fix, seen from the Steps tab.
//
// The failure this whole block exists for is silent by construction. Applying
// a fix goes through `tests:updateScript`, which re-parses the spec and swaps
// the step list out underneath the view — and the parser mints a fresh id for
// EVERY step each time it runs. So "which steps did that change?" cannot be
// answered by id, the step rows all remount, and a view that got this wrong
// would look completely normal: right steps, right order, no error, just no
// indication that anything happened. The user walks away from a change they
// asked for without seeing it.
// --------------------------------------------------------------------------

let stepSeq = 0;
/** A step carrying a deliberately throwaway id, the way the spec parser emits
 *  them — never reused across a re-parse. */
function mkStep(partial: Partial<Step> & { type: StepType }): Step {
  stepSeq += 1;
  return { id: `s${stepSeq}`, timestamp: stepSeq, ...partial } as Step;
}

const BTN = { k: "role", role: "button", name: "Submit" } as const;
const ALT = { k: "role", role: "button", name: "Continue" } as const;

/** Re-mint ids, as the backend re-parse does. Anything comparing by id sees a
 *  wholly different list; anything comparing by content sees no change. */
function reparsed(steps: Step[]): Step[] {
  return steps.map((s) => ({ ...s, id: `p${(stepSeq += 1)}` }));
}

/** Reaches the same `onApplyScript` the AI debug panel's Apply button calls.
 *
 *  The panel route would need a streamed model response carrying a fenced code
 *  block to get there, which tests the LLM plumbing rather than this view. The
 *  context object is the actual seam between the two, so the test grabs that
 *  and leaves the panel out of it. */
function renderWithApply() {
  const aiKey = runSessionKey("t1");
  let apply: ((source: string) => Promise<void>) | null = null;

  function Probe() {
    const aiDebug = useAiDebug();
    React.useEffect(() => {
      // A session must exist for the view to attach its context to — that is
      // the real precondition in the app, where Apply is only reachable from
      // an open session.
      aiDebug.openSession({
        key: aiKey,
        kind: "run",
        testId: "t1",
        label: "Checkout",
        testName: "Checkout",
        runKey: null,
        context: { kind: "run", testName: "Checkout", testUrl: "https://example.com" } as AiDebugRunContext,
      });
      // Once only: re-opening on every render would churn the store.
    }, []);
    apply = (source: string) => {
      const ctx = aiDebug.getContext(aiKey) as AiDebugRunContext | null;
      if (!ctx?.onApplyScript) throw new Error("the view never attached an apply handler");
      return ctx.onApplyScript(source);
    };
    return null;
  }

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      {withAiDebug(
        <>
          <TestDetailView />
          <Probe />
        </>,
      )}
    </QueryClientProvider>,
  );
  return {
    ...utils,
    apply: async (source: string) => {
      if (!apply) throw new Error("probe never rendered");
      await act(async () => {
        await apply!(source);
      });
    },
  };
}

/** Switch tabs. Radix's TabsTrigger activates on pointer-down/focus rather
 *  than a bare click, so fireEvent.click alone leaves the tab unchanged — and
 *  the test then asserts against the PREVIOUS tab's content. */
function selectTab(name: RegExp) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab);
  fireEvent.focus(tab);
  fireEvent.click(tab);
  return tab;
}

/** The rows currently claiming to be newly added. */
function glowingRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-new-step="true"]'));
}

/** Row text for each glowing row, so assertions name steps rather than indexes. */
function glowingText(): string[] {
  return glowingRows().map((r) => r.textContent ?? "");
}

/** Wire updateScript to hand back `after`, and make subsequent refetches agree. */
function applyYields(after: Step[]) {
  updateScript.mockImplementation(async () => {
    test_ = record({ ...(test_ ?? {}), steps: after });
    return test_;
  });
}

async function stepsTab(): Promise<HTMLElement> {
  return screen.findByRole("tab", { name: /^Steps/ });
}

describe("applying an AI-debug fix, in the Steps tab", () => {
  beforeEach(() => {
    stepSeq = 0;
    updateScript.mockReset();
    updateScript.mockImplementation(async () => ({}) as TestRecord);
  });

  it("glows a step the fix added, and only that step", async () => {
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    const click = mkStep({ type: "click", locator: BTN });
    test_ = record({ steps: [goto, click] });

    const view = renderWithApply();
    await screen.findByText("Checkout");

    const added = mkStep({ type: "wait", waitMs: 500 });
    applyYields([...reparsed([goto, click]), added]);
    await view.apply("// corrected spec");

    await waitFor(() => expect(glowingRows()).toHaveLength(1));
    expect(glowingText()[0]).toMatch(/500/);
  });

  it("retires the glow the moment Run test is clicked", async () => {
    // The glow means "look what the AI changed". Once a run starts, the run's
    // verdict is the story — stale green outlines over failing steps would
    // read as the AI's work being fine.
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    test_ = record({ steps: [goto] });

    const view = renderWithApply();
    await screen.findByText("Checkout");

    applyYields([...reparsed([goto]), mkStep({ type: "wait", waitMs: 500 })]);
    await view.apply("// corrected spec");
    await waitFor(() => expect(glowingRows()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /run test/i }));
    await waitFor(() => expect(glowingRows()).toHaveLength(0));
    expect(run).toHaveBeenCalled();
  });

  it("glows every step of a multi-step addition", async () => {
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    test_ = record({ steps: [goto] });

    const view = renderWithApply();
    await screen.findByText("Checkout");

    applyYields([
      ...reparsed([goto]),
      mkStep({ type: "click", locator: BTN }),
      mkStep({ type: "assert", assert: "visible", locator: BTN }),
    ]);
    await view.apply("// corrected spec");

    await waitFor(() => expect(glowingRows()).toHaveLength(2));
  });

  it("updates the step count when steps are added", async () => {
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    test_ = record({ steps: [goto] });

    const view = renderWithApply();
    expect((await stepsTab()).textContent).toBe("Steps (1)");

    applyYields([...reparsed([goto]), mkStep({ type: "click", locator: BTN })]);
    await view.apply("// corrected spec");

    await waitFor(async () => expect((await stepsTab()).textContent).toBe("Steps (2)"));
  });

  it("glows nothing when the fix only DELETED steps", async () => {
    // Explicitly part of the spec: a removal has no row left to decorate, and
    // decorating its neighbours would point at the wrong step.
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    const click = mkStep({ type: "click", locator: BTN });
    test_ = record({ steps: [goto, click] });

    const view = renderWithApply();
    await screen.findByText("Checkout");

    applyYields(reparsed([goto]));
    await view.apply("// corrected spec");

    await waitFor(async () => expect((await stepsTab()).textContent).toBe("Steps (1)"));
    expect(glowingRows()).toHaveLength(0);
  });

  it("glows only the replacement in a substitution, and holds the count", async () => {
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    const click = mkStep({ type: "click", locator: BTN });
    test_ = record({ steps: [goto, click] });

    const view = renderWithApply();
    expect((await stepsTab()).textContent).toBe("Steps (2)");

    applyYields([...reparsed([goto]), mkStep({ type: "click", locator: ALT })]);
    await view.apply("// corrected spec");

    await waitFor(() => expect(glowingRows()).toHaveLength(1));
    expect(glowingText()[0]).toMatch(/Continue/);
    expect((await stepsTab()).textContent).toBe("Steps (2)");
  });

  it("glows nothing when the fix only reordered steps", async () => {
    // The LCS alone reports a move as a remove plus an add. Without the move
    // suppression this lights up a step the AI did not write.
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    const click = mkStep({ type: "click", locator: BTN });
    const wait = mkStep({ type: "wait", waitMs: 250 });
    test_ = record({ steps: [goto, click, wait] });

    const view = renderWithApply();
    await screen.findByText("Checkout");

    applyYields(reparsed([goto, wait, click]));
    await view.apply("// corrected spec");

    await waitFor(async () => expect((await stepsTab()).textContent).toBe("Steps (3)"));
    expect(glowingRows()).toHaveLength(0);
  });

  it("glows nothing when the fix changed no steps at all", async () => {
    // A whitespace- or comment-only correction re-parses to the same steps
    // with entirely new ids. Comparing by id would glow the whole list here.
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    const click = mkStep({ type: "click", locator: BTN });
    test_ = record({ steps: [goto, click] });

    const view = renderWithApply();
    await screen.findByText("Checkout");

    applyYields(reparsed([goto, click]));
    await view.apply("// corrected spec");

    await waitFor(() => expect(updateScript).toHaveBeenCalledTimes(1));
    expect(glowingRows()).toHaveLength(0);
  });

  it("replaces the previous highlight when a second fix is applied", async () => {
    // Highlights must not accumulate: the question is "what did the change I
    // just applied do", not "what has ever been added to this test".
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    test_ = record({ steps: [goto] });

    const view = renderWithApply();
    await screen.findByText("Checkout");

    const first = mkStep({ type: "click", locator: BTN });
    applyYields([...reparsed([goto]), first]);
    await view.apply("// fix one");
    await waitFor(() => expect(glowingRows()).toHaveLength(1));

    const second = mkStep({ type: "wait", waitMs: 750 });
    applyYields([...reparsed([goto, first]), second]);
    await view.apply("// fix two");

    await waitFor(() => expect(glowingText()).toEqual([expect.stringMatching(/750/)]));
  });

  it("stops glowing once the user saves their own step edits", async () => {
    // Once the user has had their hands in the list, "the AI added these" is
    // no longer a claim this view can make about it — and the ids it was
    // tracking may not even be in the list any more.
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    test_ = record({ steps: [goto] });

    // Stand in for the native menu, the way the Edit Steps suite below does —
    // the SDK's DropdownMenu items never reach the DOM.
    (window as unknown as { glazeAPI: { Menu: { popup: unknown } } }).glazeAPI.Menu.popup = vi.fn(
      async (opts: { items: { label?: string; commandId?: number }[] }) => {
        const item = opts.items.find((i) => i.label === "Edit Steps");
        return item?.commandId === undefined ? {} : { commandId: item.commandId };
      },
    );

    const view = renderWithApply();
    await screen.findByText("Checkout");

    applyYields([...reparsed([goto]), mkStep({ type: "click", locator: BTN })]);
    await view.apply("// corrected spec");
    await waitFor(() => expect(glowingRows()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /edit test/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateSteps).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(glowingRows()).toHaveLength(0));
  });

  it("moves off the Steps tab when a fix deletes the last step", async () => {
    // The trigger is gated on there being steps. Left uncontrolled, the tab
    // value stayed "steps" after the trigger vanished and the user was looking
    // at an empty pane with nothing selected in the tab bar.
    const goto = mkStep({ type: "goto", url: "https://example.com" });
    test_ = record({ steps: [goto] });

    const view = renderWithApply();
    expect((await stepsTab()).textContent).toBe("Steps (1)");

    // The user has to have PICKED the tab for this to bite. Steps is already
    // the default, and the default arm recomputes from the current step list,
    // so it copes on its own — it is the explicitly-chosen value that gets
    // stranded. Round-tripping through Script is what makes "steps" an actual
    // choice rather than the fallback.
    selectTab(/Script/);
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Script/ }).getAttribute("data-state")).toBe("active"),
    );
    selectTab(/^Steps/);
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /^Steps/ }).getAttribute("data-state")).toBe("active"),
    );

    applyYields([]);
    await view.apply("// corrected spec");

    await waitFor(() => expect(screen.queryByRole("tab", { name: /^Steps/ })).toBeNull());
    const selected = screen.getAllByRole("tab").filter((t) => t.getAttribute("data-state") === "active");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toMatch(/Script/);
  });
});
