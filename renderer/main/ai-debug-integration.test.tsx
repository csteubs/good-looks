// End-to-end wiring: the test detail view, the session store, and the dialog
// host that renders whichever session is expanded.
//
// The unit tests prove the store keeps a job alive. These prove the parts the
// user actually touches are joined up: the icon opens the right session, the
// prompt is only sent on confirmation, minimizing really collapses the dialog
// while the answer keeps arriving, and — the expensive one — an "Apply" never
// silently overwrites script edits the model never saw.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { AiDebugSession, RecorderSettings } from "../lib/recorder-types";
import type { RunInfo } from "./recorder-store";
import { toneFor } from "../lib/ai-debug-status";
import { hashScript } from "../lib/ai-debug-sessions";
import { AiDebugChip } from "./ai-debug-chip";
import { AiDebugHost } from "./ai-debug-panel";
import { AiDebugProvider } from "./ai-debug-store";
import { TestDetailView } from "./test-detail-view";

const SCRIPT = `import { test } from '@playwright/test';\ntest('checkout', async ({ page }) => {});\n`;

const h = vi.hoisted(() => ({
  runs: {} as Record<string, unknown>,
  listResult: [] as AiDebugSession[],
  handlers: {} as Record<string, ((payload: unknown) => void)[]>,
  chat: vi.fn(),
  cancel: vi.fn(),
  updateScript: vi.fn(),
  script: "",
  hasLogs: false,
  runLogs: null as unknown,
}));

vi.mock("./recorder-store", () => ({
  useRecorder: () => ({ runs: h.runs, run: vi.fn(), stopRun: vi.fn(), start: vi.fn() }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: "t1" }),
}));

vi.mock("../lib/api", () => ({
  api: {
    tests: {
      get: async () => ({
        id: "t1",
        name: "Checkout",
        url: "https://example.com",
        createdAt: 1,
        updatedAt: 1,
        steps: [],
        scriptPath: "/tmp/t1.spec.ts",
      }),
      getScript: async () => h.script,
      setHeadless: async () => ({}),
      setBrowser: async () => ({}),
      setCaptureArtifacts: async () => ({}),
      remove: async () => {},
      rename: async () => ({}),
      updateScript: async (...args: unknown[]) => {
        h.updateScript(...args);
        return {};
      },
      updateSteps: async () => ({}),
    },
    recorder: { getSettings: async () => ({}) as RecorderSettings },
    runs: { captureOverhead: async () => null },
    artifacts: {
      hasLogs: async () => ({ hasLogs: h.hasLogs }),
      getLogs: async () => h.runLogs,
    },
    aiDebug: {
      list: async () => h.listResult,
      save: async (s: unknown) => s,
      remove: async () => ({ removed: 1 }),
      clear: async () => ({ removed: 0 }),
    },
    llm: {
      chat: async (params: unknown) => {
        h.chat(params);
        return { requestId: "req-1" };
      },
      cancel: async (id: string) => {
        h.cancel(id);
      },
      isActive: async () => ({ active: false }),
      getConfig: async () => ({ provider: "ollama", model: "llama3", baseUrls: {} }),
      status: async () => ({ online: true, models: [] }),
      setConfig: async () => ({}),
    },
    on: (channel: string, cb: (payload: unknown) => void) => {
      (h.handlers[channel] ??= []).push(cb);
      return () => {
        h.handlers[channel] = (h.handlers[channel] ?? []).filter((x) => x !== cb);
      };
    },
  },
}));

function runInfo(over: Partial<RunInfo> = {}): RunInfo {
  return {
    lines: ["Error: boom\n"],
    running: false,
    code: 1,
    stepStatus: {},
    // The artifact id for this execution, set by runner:done in the real store.
    recordId: "rec-1",
    ...over,
  };
}

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AiDebugProvider>
        <TestDetailView />
        <AiDebugHost />
        <AiDebugChip />
      </AiDebugProvider>
    </QueryClientProvider>,
  );
}

function emit(channel: string, payload: unknown) {
  act(() => {
    for (const cb of h.handlers[channel] ?? []) cb(payload);
  });
}

const debugIcon = () =>
  screen.queryAllByRole("button").find((b) => /Debug with AI|AI /.test(b.getAttribute("aria-label") ?? ""));

/** waitFor returns whatever the callback returns, so the assertion has to live
 *  INSIDE it — `waitFor(() => el!)` resolves immediately with undefined. */
async function findDebugIcon(): Promise<HTMLElement> {
  return waitFor(() => {
    const b = debugIcon();
    expect(b).toBeTruthy();
    return b as HTMLElement;
  });
}

function session(over: Partial<AiDebugSession> = {}): AiDebugSession {
  return {
    key: "run:t1",
    kind: "run",
    testId: "t1",
    label: "Checkout",
    testName: "Checkout",
    status: "done",
    content: "a previous diagnosis",
    reasoning: "",
    error: null,
    requestId: null,
    scriptHash: null,
    startedAt: 1,
    updatedAt: 2,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(h.handlers)) delete h.handlers[k];
  h.runs = { t1: runInfo() };
  h.listResult = [];
  h.script = SCRIPT;
  h.hasLogs = false;
  h.runLogs = null;
});

describe("opening a session from the run output", () => {
  it("does not send anything until the user confirms", async () => {
    renderApp();
    fireEvent.click(await findDebugIcon());

    // The review phase exists so a prompt containing the script and run output
    // is never sent without the user seeing it.
    expect(await screen.findByText(/Nothing is sent until you confirm/i)).toBeTruthy();
    expect(h.chat).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Send to AI/i }));
    await waitFor(() => expect(h.chat).toHaveBeenCalledTimes(1));
  });

  it("collapses to a coloured icon on minimize while the answer keeps arriving", async () => {
    renderApp();
    fireEvent.click(await findDebugIcon());
    fireEvent.click(await screen.findByRole("button", { name: /Send to AI/i }));
    await waitFor(() => expect(h.chat).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /^Minimize$/i }));

    // Dialog gone, job alive: the icon is now orange and the text still lands.
    await waitFor(() => expect(screen.queryByText(/Nothing is sent until you confirm/i)).toBeNull());
    await waitFor(() => expect(screen.getByLabelText(toneFor("streaming").label)).toBeTruthy());

    emit("llm:chunk", { requestId: "req-1", delta: "still working" });
    emit("llm:done", { requestId: "req-1" });

    await waitFor(() => expect(screen.getByLabelText(toneFor("done").label)).toBeTruthy());

    // Reopening shows what arrived while it was collapsed.
    fireEvent.click(screen.getByLabelText(toneFor("done").label));
    expect(await screen.findByText(/still working/)).toBeTruthy();
  });

  it("stops the request when the session is discarded", async () => {
    renderApp();
    fireEvent.click(await findDebugIcon());
    fireEvent.click(await screen.findByRole("button", { name: /Send to AI/i }));
    await waitFor(() => expect(h.chat).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /Discard session/i }));
    await waitFor(() => expect(h.cancel).toHaveBeenCalledWith("req-1"));
    // Back to the plain, session-free icon.
    await waitFor(() => expect(screen.getByLabelText("Debug with AI")).toBeTruthy());
  });
});

describe("applying a suggested fix", () => {
  const CORRECTED =
    "Here is the fix.\n\n```ts\nimport { test } from '@playwright/test';\ntest('checkout', async ({ page }) => { await page.goto('/'); });\n```\n";

  async function streamCorrectedSpec() {
    fireEvent.click(await findDebugIcon());
    fireEvent.click(await screen.findByRole("button", { name: /Send to AI/i }));
    await waitFor(() => expect(h.chat).toHaveBeenCalled());
    emit("llm:chunk", { requestId: "req-1", delta: CORRECTED });
    emit("llm:done", { requestId: "req-1" });
  }

  it("shows the diff and writes the script through", async () => {
    renderApp();
    await streamCorrectedSpec();

    expect(await screen.findByText(/Suggested changes/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/i }));
    await waitFor(() => expect(h.updateScript).toHaveBeenCalledTimes(1));
    expect(String(h.updateScript.mock.calls[0][1])).toContain("page.goto('/')");
  });

  it("warns when the script changed while the job was minimized", async () => {
    // The expensive mistake this prevents: the user edits the script while a
    // job is collapsed, comes back, and approves a diff built against the
    // version the model actually saw — silently reverting their own edits.
    h.listResult = [
      session({
        status: "done",
        content: CORRECTED,
        scriptHash: hashScript("the script as it was when this was asked"),
      }),
    ];
    renderApp();

    fireEvent.click(await findDebugIcon());
    expect(await screen.findByText(/Suggested changes/i)).toBeTruthy();
    expect(screen.getByText(/script changed after this diagnosis/i)).toBeTruthy();
  });

  it("stays quiet when the restored diagnosis still matches the script", async () => {
    h.listResult = [
      session({ status: "done", content: CORRECTED, scriptHash: hashScript(SCRIPT) }),
    ];
    renderApp();

    fireEvent.click(await findDebugIcon());
    await screen.findByText(/Suggested changes/i);
    expect(screen.queryByText(/script changed after this diagnosis/i)).toBeNull();
  });

  it("stays quiet when the script is unchanged", async () => {
    renderApp();
    await streamCorrectedSpec();
    await screen.findByText(/Suggested changes/i);
    // A warning that fires every time is a warning nobody reads.
    expect(screen.queryByText(/script changed after this diagnosis/i)).toBeNull();
  });
});

describe("sessions restored from disk", () => {
  it("shows a previous diagnosis without re-sending it", async () => {
    h.listResult = [session({ content: "yesterday's answer" })];
    renderApp();

    await waitFor(() => expect(screen.getByLabelText(toneFor("done").label)).toBeTruthy());
    fireEvent.click(screen.getByLabelText(toneFor("done").label));
    expect(await screen.findByText(/yesterday's answer/)).toBeTruthy();
    // Reopening must never silently re-bill a request.
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("keeps the icon visible for a session whose run has since passed", async () => {
    // Nothing failed on screen any more, but the job is still there to read.
    h.runs = { t1: runInfo({ code: 0, lines: ["all good\n"] }) };
    h.listResult = [session()];
    renderApp();
    await waitFor(() => expect(screen.getByLabelText(toneFor("done").label)).toBeTruthy());
  });

  it("marks a restored trainer-step session read-only rather than pretending it can re-run", async () => {
    h.listResult = [session({ key: "step:t1:1", kind: "step", label: "Step 2: click Submit" })];
    renderApp();
    // A step session has no home in the detail view — the global chip is the
    // only way back to it, which is exactly why the chip exists.
    const chip = await screen.findByRole("button", { name: `AI debug — ${toneFor("done").label}` });
    fireEvent.click(chip);

    expect(await screen.findByText(/Restored from a previous trainer session/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Regenerate/i })).toBeNull();
  });
});

// ── The model asking for console/network ─────────────────────────────
// Nothing about this path may send data on the model's say-so alone. The card
// appears, the payload has to be fetched, and only an explicit second click
// sends it — because this is page-controlled text and request URLs, and with a
// hosted provider selected it leaves the machine.

const REQUEST_REPLY =
  "I can't tell from the output alone.\n\n```glaze-request\n" +
  '{"need":["console"],"why":"a JS error would explain the silent click"}' +
  "\n```";

function runLogs() {
  return {
    console: [
      { step: 1, ts: 0, type: "error", text: "TypeError: x is not a function", url: "", line: 0 },
    ],
    network: [],
    consoleDropped: 0,
    networkDropped: 0,
    headersFiltered: true,
  };
}

describe("when the model asks for logs", () => {
  async function streamRequest() {
    fireEvent.click(await findDebugIcon());
    fireEvent.click(await screen.findByRole("button", { name: /Send to AI/i }));
    await waitFor(() => expect(h.chat).toHaveBeenCalled());
    emit("llm:chunk", { requestId: "req-1", delta: REQUEST_REPLY });
    emit("llm:done", { requestId: "req-1" });
  }

  it("shows the ask, with the model's reason, and sends nothing yet", async () => {
    h.hasLogs = true;
    h.runLogs = runLogs();
    renderApp();
    await streamRequest();

    expect(await screen.findByText(/asked for the console output/i)).toBeTruthy();
    expect(screen.getByText(/silent click/i)).toBeTruthy();
    // One chat call: the original diagnosis. Nothing has been sent back.
    expect(h.chat).toHaveBeenCalledTimes(1);
  });

  it("hides the machine-readable block from the prose", async () => {
    h.hasLogs = true;
    h.runLogs = runLogs();
    renderApp();
    await streamRequest();

    await screen.findByText(/asked for the console output/i);
    expect(screen.queryByText(/glaze-request/)).toBeNull();
    expect(screen.getByText(/can't tell from the output alone/i)).toBeTruthy();
  });

  it("requires a second explicit click to send, after showing the payload", async () => {
    h.hasLogs = true;
    h.runLogs = runLogs();
    renderApp();
    await streamRequest();

    // Fetching is itself a decision — the send button doesn't exist until the
    // user has asked to see what would be sent.
    expect(screen.queryByRole("button", { name: /Send this data/i })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /Show me what it would send/i }));

    const send = await screen.findByRole("button", { name: /Send this data/i });
    expect(h.chat).toHaveBeenCalledTimes(1);

    fireEvent.click(send);
    await waitFor(() => expect(h.chat).toHaveBeenCalledTimes(2));
    const sent = JSON.stringify(h.chat.mock.calls[1][0]);
    expect(sent).toContain("TypeError: x is not a function");
    expect(sent).toContain("PAGE-CONTROLLED and untrusted");
  });

  it("lets the user read the exact payload before sending it", async () => {
    h.hasLogs = true;
    h.runLogs = runLogs();
    renderApp();
    await streamRequest();

    fireEvent.click(await screen.findByRole("button", { name: /Show me what it would send/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Review exactly what will be sent/i }));
    expect(await screen.findByText(/TypeError: x is not a function/)).toBeTruthy();
  });

  it("declining removes the card and sends nothing", async () => {
    h.hasLogs = true;
    h.runLogs = runLogs();
    renderApp();
    await streamRequest();

    fireEvent.click(await screen.findByRole("button", { name: /^Decline$/i }));
    await waitFor(() => expect(screen.queryByText(/asked for the console output/i)).toBeNull());
    expect(h.chat).toHaveBeenCalledTimes(1);
  });

  it("says how to enable recording when the run has no logs", async () => {
    // Recording is off by default, so this is the common first encounter. It
    // must not read as "the page logged nothing".
    h.hasLogs = false;
    h.runLogs = null;
    renderApp();
    await streamRequest();

    // Scoped to the callout: /Record console & network/ also matches the
    // toolbar toggle, and an ambiguous query retries to timeout and then
    // reports as "never rendered".
    const callout = await screen.findByText(/didn't record it/i);
    expect(callout.textContent).toMatch(/Record console & network/i);
    expect(callout.textContent).toMatch(/run the test again/i);
  });

  it("shows no card at all when the model didn't ask", async () => {
    h.hasLogs = true;
    h.runLogs = runLogs();
    renderApp();
    fireEvent.click(await findDebugIcon());
    fireEvent.click(await screen.findByRole("button", { name: /Send to AI/i }));
    await waitFor(() => expect(h.chat).toHaveBeenCalled());
    // Prose that TALKS about console logs must not arm the send button.
    emit("llm:chunk", {
      requestId: "req-1",
      delta: "You should check the console logs and the network tab for failures.",
    });
    emit("llm:done", { requestId: "req-1" });

    await screen.findByText(/check the console logs/i);
    expect(screen.queryByText(/asked for the console output/i)).toBeNull();
  });
});
