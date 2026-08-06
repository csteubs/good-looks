// Component tests for the test detail view's run controls.
//
// This is where three per-test preferences (browser, headless, capture) turn
// into an actual run. Each is stored per test with a fall-back to a global
// default, and each is persisted on change — so the failure modes are "my
// setting didn't stick" and, worse, "it ran with different settings than the
// ones on screen". The second is silent, which is why the run arguments are
// asserted rather than just the controls' appearance.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { RecorderSettings, RunRecord, Step, TestRecord } from "../lib/recorder-types";
import { TestDetailView } from "./test-detail-view";
import { withAiDebug } from "../__tests__/ai-debug-harness";

let test_: TestRecord | null = null;
let settings: Partial<RecorderSettings> = {};
let runs: RunRecord[] = [];

const run = vi.fn();
const setHeadless = vi.fn(async () => ({}) as TestRecord);
const setBrowser = vi.fn(async () => ({}) as TestRecord);
const setCaptureArtifacts = vi.fn(async () => ({}) as TestRecord);
// Typed with the real signature, unlike the setters above: these assertions
// read the third argument, and a zero-arg mock makes indexing it a type error.
const updateSteps = vi.fn(
  async (_id: string, _steps: Step[], _opts?: { regenerate?: boolean }) => ({}) as TestRecord,
);

vi.mock("./recorder-store", () => ({
  useRecorder: () => ({ runs: {}, run, stopRun: vi.fn(), start: vi.fn() }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: "t1" }),
}));

vi.mock("../lib/api", () => ({
  api: {
    tests: {
      get: async () => test_,
      getScript: async () => "import { test } from '@playwright/test';",
      setHeadless: (...a: unknown[]) => setHeadless(...(a as [])),
      setBrowser: (...a: unknown[]) => setBrowser(...(a as [])),
      setCaptureArtifacts: (...a: unknown[]) => setCaptureArtifacts(...(a as [])),
      remove: async () => {},
      rename: async () => ({}) as TestRecord,
      updateScript: async () => ({}) as TestRecord,
      updateSteps: (...a: Parameters<typeof updateSteps>) => updateSteps(...a),
    },
    recorder: { getSettings: async () => settings as RecorderSettings },
    runs: { captureOverhead: async () => null, list: async () => runs },
    heals: { list: async () => [] },
    artifacts: { getReplay: async () => null },
    aiDebug: {
      list: async () => [],
      save: async (s: unknown) => s,
      remove: async () => ({ removed: 0 }),
      clear: async () => ({ removed: 0 }),
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
  return render(
    <QueryClientProvider client={qc}>{withAiDebug(<TestDetailView />)}</QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  test_ = record();
  runs = [];
  settings = { defaultRunBrowser: "chromium", defaultRunHeadless: false, defaultCaptureArtifacts: false };
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
