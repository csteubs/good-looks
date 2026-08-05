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

import type { RecorderSettings, TestRecord } from "../lib/recorder-types";
import { TestDetailView } from "./test-detail-view";
import { withAiDebug } from "../__tests__/ai-debug-harness";

let test_: TestRecord | null = null;
let settings: Partial<RecorderSettings> = {};

const run = vi.fn();
const setHeadless = vi.fn(async () => ({}) as TestRecord);
const setBrowser = vi.fn(async () => ({}) as TestRecord);
const setCaptureArtifacts = vi.fn(async () => ({}) as TestRecord);

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
      updateSteps: async () => ({}) as TestRecord,
    },
    recorder: { getSettings: async () => settings as RecorderSettings },
    runs: { captureOverhead: async () => null },
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
  settings = { defaultRunBrowser: "chromium", defaultRunHeadless: false, defaultCaptureArtifacts: false };
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
});
