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
    <QueryClientProvider client={qc}>
      <TestDetailView />
    </QueryClientProvider>,
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

  it("disables capture while headless is on", async () => {
    // Screenshots of an invisible browser aren't useful; the UI reflects that.
    test_ = record({ runHeadless: true });
    renderView();
    await screen.findByText("Checkout");
    const capture = screen.getByLabelText(/capture screenshots/i);
    await waitFor(() => expect(capture.getAttribute("data-disabled") ?? capture.getAttribute("disabled")).not.toBeNull());
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
