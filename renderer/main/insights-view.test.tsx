// Component tests for the Insights view.
//
// The claims here are the quiet ones. An action button acting on a deleted
// test would run or debug the WRONG thing — the disabled path must hold. The
// numbers strip must come from `stats` (and skip nulls) so a metrics-less
// report doesn't render reassuring zeros. Opening a report must mark it read,
// or the rail dot never clears. And the fixed verbs are the contract that
// model output cannot relabel a button.
//
// The api module is mocked rather than the IPC bridge, per the house rule.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { InsightReport, InsightsStatus, TestRecord } from "../lib/recorder-types";
import { consumeAiDebugRequest } from "./insight-intents";
import { InsightsView } from "./insights-view";

// ── Mocks ────────────────────────────────────────────────────────────
const navigate = vi.fn();
const run = vi.fn();

const { mocks } = vi.hoisted(() => ({
  mocks: {
    list: vi.fn(async (): Promise<unknown[]> => []),
    get: vi.fn(async (): Promise<unknown> => null),
    status: vi.fn(
      async (): Promise<InsightsStatus> => ({
        generating: false,
        lastGeneratedAt: null,
        lastAttemptAt: null,
        lastError: null,
        lastSeenAppVersion: null,
      }),
    ),
    markRead: vi.fn(async () => ({ changed: true })),
    delete: vi.fn(async () => ({ removed: true })),
    generateNow: vi.fn(async () => ({ started: true as const })),
    exportPdf: vi.fn(async (): Promise<{ path: string; bytes: number } | null> => null),
    getSettings: vi.fn(async (): Promise<unknown> => ({ aiInsightsEnabled: true })),
    testsList: vi.fn(async (): Promise<TestRecord[]> => []),
  },
}));

vi.mock("../lib/api", () => ({
  api: {
    insights: {
      list: mocks.list,
      get: mocks.get,
      status: mocks.status,
      markRead: mocks.markRead,
      delete: mocks.delete,
      generateNow: mocks.generateNow,
      exportPdf: mocks.exportPdf,
    },
    recorder: { getSettings: mocks.getSettings },
    tests: { list: mocks.testsList },
  },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("./recorder-store", () => ({ useRecorder: () => ({ run }) }));
// The real dialog drags in the whole issues pipeline; what THIS file owns is
// that the button opens it with the right source. The stub reports its props.
vi.mock("../components/issue-compose-dialog", () => ({
  IssueComposeDialog: (props: { open: boolean; source: { kind: string } | null }) =>
    props.open && props.source ? (
      <div data-testid="compose-dialog">{props.source.kind}</div>
    ) : null,
}));

function test_(id: string, name: string): TestRecord {
  return { id, name, url: "https://example.com", createdAt: 1, steps: [] } as unknown as TestRecord;
}

function report(over: Partial<InsightReport> = {}): InsightReport {
  return {
    id: "ins-1",
    cadence: "weekly",
    periodStart: 1_000,
    periodEnd: 2_000,
    generatedAt: 2_000,
    provider: "ollama",
    model: "qwen",
    headline: "One failure worth a look.",
    sections: [
      { title: "Overview", body: "First paragraph.\n\nSecond paragraph." },
    ],
    actions: [],
    stats: {
      runs: 12,
      failed: 3,
      previousRuns: 9,
      flakyRuns: 1,
      healedSteps: 2,
      healFailures: 0,
      visualChanges: null,
      newClusters: null,
      a11yNewSteps: 0,
      testsCreated: 0,
      unreviewedScriptChanges: 0,
      expiringSignatures: 0,
      siteHealthDomains: null,
    },
    sending: [{ label: "Run counts", chars: 640 }],
    promptChars: 5000,
    answerChars: 900,
    durationMs: 30_000,
    firstTokenMs: 400,
    read: true,
    ...over,
  };
}

function summaryOf(r: InsightReport) {
  return {
    id: r.id,
    cadence: r.cadence,
    generatedAt: r.generatedAt,
    headline: r.headline,
    read: r.read,
    ...(r.degraded ? { degraded: true } : {}),
  };
}

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <InsightsView />
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([]);
  mocks.get.mockResolvedValue(null);
  mocks.getSettings.mockResolvedValue({ aiInsightsEnabled: true });
  mocks.testsList.mockResolvedValue([]);
  mocks.status.mockResolvedValue({
    generating: false,
    lastGeneratedAt: null,
    lastAttemptAt: null,
    lastError: null,
    lastSeenAppVersion: null,
  });
});

describe("empty states", () => {
  it("explains the feature and points at Settings when it is off", async () => {
    mocks.getSettings.mockResolvedValue({ aiInsightsEnabled: false });
    renderView();
    expect(await screen.findByText(/reports are off/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /open alerts settings/i })).toBeTruthy();
    // No Generate button while off — it would refuse anyway.
    expect(screen.queryByRole("button", { name: /generate now/i })).toBeNull();
  });

  it("says the first report is on its way when enabled and empty", async () => {
    renderView();
    expect(await screen.findByText(/first one generates within/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /generate now/i })).toBeTruthy();
  });

  it("reports an in-flight generation", async () => {
    mocks.status.mockResolvedValue({
      generating: true,
      lastGeneratedAt: null,
      lastAttemptAt: null,
      lastError: null,
      lastSeenAppVersion: null,
    });
    renderView();
    expect(await screen.findByText(/writing the report now/i)).toBeTruthy();
  });

  it("surfaces the last failure instead of a blank list", async () => {
    mocks.status.mockResolvedValue({
      generating: false,
      lastGeneratedAt: null,
      lastAttemptAt: 1_000,
      lastError: { at: 1_000, kind: "connection", message: "Could not reach Ollama." },
      lastSeenAppVersion: null,
    });
    renderView();
    expect(await screen.findByText(/could not reach ollama/i)).toBeTruthy();
  });
});

describe("a rendered report", () => {
  beforeEach(() => {
    const r = report();
    mocks.list.mockResolvedValue([summaryOf(r)]);
    mocks.get.mockResolvedValue(r);
  });

  it("renders the headline, split paragraphs, and the deterministic stats", async () => {
    renderView();
    expect(await screen.findByRole("heading", { name: /one failure worth a look/i })).toBeTruthy();
    // Paragraph split on blank lines — never markup interpretation.
    expect(screen.getByText("First paragraph.")).toBeTruthy();
    expect(screen.getByText("Second paragraph.")).toBeTruthy();
    // The strip renders from `stats`.
    expect(screen.getByText("Runs")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    // Null metrics fields are SKIPPED, never rendered as zero.
    expect(screen.queryByText("Visual changes")).toBeNull();
    expect(screen.queryByText("New failure signatures")).toBeNull();
  });

  it("shows what was sent, from the stored disclosure", async () => {
    renderView();
    expect(await screen.findByText(/sent to the provider/i)).toBeTruthy();
    expect(screen.getByText(/run counts — 640/i)).toBeTruthy();
  });

  it("marks an unread report read on open — once", async () => {
    const r = report({ read: false });
    mocks.list.mockResolvedValue([summaryOf(r)]);
    mocks.get.mockResolvedValue(r);
    renderView();
    await screen.findByRole("heading", { name: /one failure worth a look/i });
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith("ins-1"));
    expect(mocks.markRead).toHaveBeenCalledTimes(1);
  });

  it("does not re-mark a report already read", async () => {
    renderView();
    await screen.findByRole("heading", { name: /one failure worth a look/i });
    expect(mocks.markRead).not.toHaveBeenCalled();
  });

  it("labels a degraded report and carries no actions", async () => {
    const r = report({ degraded: true, actions: [] });
    mocks.list.mockResolvedValue([summaryOf(r)]);
    mocks.get.mockResolvedValue(r);
    renderView();
    expect(await screen.findByText(/didn't follow the report format/i)).toBeTruthy();
  });

  it("PDF asks the backend by id and stays silent on a cancelled save", async () => {
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: /pdf/i }));
    await waitFor(() => expect(mocks.exportPdf).toHaveBeenCalledWith("ins-1"));
  });

  it("File issue opens the shared compose dialog with the report source", async () => {
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: /file issue/i }));
    const dialog = await screen.findByTestId("compose-dialog");
    // The same dialog visual/a11y defects file through, pointed at the report
    // — parse-time and render-time validation come with it.
    expect(dialog.textContent).toBe("insight-report");
  });
});

describe("actions", () => {
  function withActions(actions: InsightReport["actions"], tests: TestRecord[]) {
    const r = report({ actions });
    mocks.list.mockResolvedValue([summaryOf(r)]);
    mocks.get.mockResolvedValue(r);
    mocks.testsList.mockResolvedValue(tests);
  }

  it("run-test starts the run and lands on the test", async () => {
    withActions(
      [{ kind: "run-test", testId: "t1", label: "Hasn't run lately." }],
      [test_("t1", "Login")],
    );
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: /run test/i }));
    expect(run).toHaveBeenCalledWith("t1", undefined, undefined);
    expect(navigate).toHaveBeenCalledWith({ to: "/test/$id", params: { id: "t1" } });
  });

  it("debug-test records the one-shot intent and navigates — it does not send", async () => {
    withActions(
      [{ kind: "debug-test", testId: "t1", label: "Keeps failing." }],
      [test_("t1", "Login")],
    );
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: /debug with ai/i }));
    expect(navigate).toHaveBeenCalledWith({ to: "/test/$id", params: { id: "t1" } });
    // The intent is what the detail view consumes to open the dialog — and it
    // is one-shot, so a second consume is a no-op.
    expect(consumeAiDebugRequest("t1")).toBe(true);
    expect(consumeAiDebugRequest("t1")).toBe(false);
  });

  it("a deleted test's action renders its recorded name, disabled", async () => {
    withActions(
      [{ kind: "run-test", testId: "t-gone", testName: "Old signup", label: "Run it." }],
      [test_("t1", "Login")],
    );
    renderView();
    const button = await screen.findByRole("button", { name: /run test/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Old signup")).toBeTruthy();
    fireEvent.click(button);
    expect(run).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("navigation kinds go where they say, with fixed verbs", async () => {
    withActions(
      [
        { kind: "open-heals", label: "Review the heals." },
        { kind: "open-visual", label: "Look at the diffs." },
      ],
      [],
    );
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: /open heals/i }));
    expect(navigate).toHaveBeenCalledWith({ to: "/heals" });
    fireEvent.click(screen.getByRole("button", { name: /open visual/i }));
    expect(navigate).toHaveBeenCalledWith({ to: "/visual" });
  });
});
