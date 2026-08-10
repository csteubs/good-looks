// The global minimized-session chip.
//
// This is the ONLY affordance that survives navigation and the trainer
// replacing the entire outlet, so if it picks the wrong aggregate status or
// can't restore a session, a minimized job is effectively lost. The aggregate
// rule that matters most: a finished answer must never hide behind a job that
// is still thinking — that's precisely the "come back when it's ready" promise.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";

import type { AiDebugSession } from "../lib/recorder-types";
import { toneFor } from "../lib/ai-debug-status";
import { AiDebugChip } from "./ai-debug-chip";
import { AiDebugProvider, useAiDebug, type AiDebugContextValue } from "./ai-debug-store";

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  listResult: [] as AiDebugSession[],
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
}));

vi.mock("../lib/api", () => ({
  api: {
    aiDebug: {
      list: async () => h.listResult,
      save: async (s: unknown) => s,
      remove: async () => ({ removed: 1 }),
      clear: async () => ({ removed: 0 }),
      notifyDone: async () => ({ ok: true }),
    },
    recorder: { getSettings: async () => ({}) },
    llm: {
      chat: async () => ({ requestId: "req-1" }),
      cancel: async () => {},
      isActive: async () => ({ active: false }),
      getConfig: async () => ({ provider: "ollama", model: null, baseUrls: {} }),
      status: async () => ({ online: false, models: [] }),
      setConfig: async () => ({}),
    },
    on: () => () => {},
  },
}));

let store: AiDebugContextValue;

function Capture() {
  store = useAiDebug();
  return null;
}

function renderChip() {
  return render(
    <AiDebugProvider>
      <Capture />
      <AiDebugChip />
    </AiDebugProvider>,
  );
}

function session(over: Partial<AiDebugSession> = {}): AiDebugSession {
  return {
    key: "run:t1",
    kind: "run",
    testId: "t1",
    label: "Checkout",
    testName: "Checkout",
    status: "done",
    content: "answer",
    reasoning: "",
    error: null,
    requestId: null,
    scriptHash: null,
    startedAt: 1,
    updatedAt: 2,
    ...over,
  };
}

const chip = () => screen.queryByRole("button", { name: /^AI debug —/ });

beforeEach(() => {
  vi.clearAllMocks();
  h.listResult = [];
});

describe("AiDebugChip", () => {
  it("renders nothing when there are no sessions", async () => {
    renderChip();
    await waitFor(() => expect(store.hydrated).toBe(true));
    expect(chip()).toBeNull();
  });

  it("shows a finished session in green", async () => {
    h.listResult = [session({ status: "done" })];
    renderChip();
    await waitFor(() => expect(chip()).not.toBeNull());

    const button = screen.getByRole("button", { name: `AI debug — ${toneFor("done").label}` });
    expect(button.querySelector("svg")?.getAttribute("class") ?? "").toContain(toneFor("done").className);
  });

  it("shows a running session in orange, pulsing", async () => {
    h.listResult = [session({ status: "streaming", requestId: "req-x" })];
    renderChip();
    await waitFor(() => expect(chip()).not.toBeNull());

    // Hydration marks a request the backend no longer knows about as
    // interrupted, so drive the live state through the store instead.
    act(() => {
      store.openSession({
        key: "run:live",
        kind: "run",
        testId: "live",
        label: "Live",
        testName: "Live",
        context: { kind: "run", testName: "Live", testUrl: "u", script: "", output: "", imported: false },
      });
    });
    await act(async () => {
      await store.startStream("run:live", [{ role: "user", content: "hi" }]);
    });

    const button = screen.getByRole("button", { name: /^AI debug —/ });
    const cls = button.querySelector("svg")?.getAttribute("class") ?? "";
    expect(cls).toContain(toneFor("streaming").className);
    expect(cls).toContain("animate-pulse");
  });

  it("surfaces a finished answer over a job that is still thinking", async () => {
    h.listResult = [
      session({ key: "run:done", status: "done", updatedAt: 1 }),
      session({ key: "run:other", status: "idle", updatedAt: 9 }),
    ];
    renderChip();
    await waitFor(() => expect(chip()).not.toBeNull());

    act(() => {
      store.openSession({
        key: "run:live",
        kind: "run",
        testId: "live",
        label: "Live",
        testName: "Live",
        context: { kind: "run", testName: "Live", testUrl: "u", script: "", output: "", imported: false },
      });
    });
    await act(async () => {
      await store.startStream("run:live", [{ role: "user", content: "hi" }]);
    });

    // Even with a newer, still-streaming session, the chip advertises the one
    // that is ready to read.
    expect(screen.getByRole("button", { name: `AI debug — ${toneFor("done").label}` })).toBeTruthy();
  });

  it("counts the sessions when there is more than one", async () => {
    h.listResult = [session({ key: "run:a" }), session({ key: "run:b" })];
    renderChip();
    await waitFor(() => expect(chip()).not.toBeNull());
    expect(screen.getByRole("button", { name: /^AI debug —/ }).textContent).toContain("(2)");
  });

  it("restores a single session directly, navigating to its test first", async () => {
    h.listResult = [session({ key: "run:t7", testId: "t7" })];
    renderChip();
    await waitFor(() => expect(chip()).not.toBeNull());

    act(() => {
      screen.getByRole("button", { name: /^AI debug —/ }).click();
    });

    // A run session belongs to a test detail view; opening the dialog without
    // going there first would float it over an unrelated view with no script
    // or run output behind it.
    expect(h.navigate).toHaveBeenCalledWith({ to: "/test/$id", params: { id: "t7" } });
    expect(store.expandedKey).toBe("run:t7");
  });

  it("opens a picker when several sessions exist, and restores the chosen one", async () => {
    h.listResult = [
      session({ key: "run:a", testId: "a", label: "Alpha", updatedAt: 5 }),
      session({ key: "run:b", testId: "b", label: "Beta", updatedAt: 9 }),
    ];
    renderChip();
    await waitFor(() => expect(chip()).not.toBeNull());

    act(() => {
      screen.getByRole("button", { name: /^AI debug —/ }).click();
    });
    // Newest activity first.
    const entries = screen.getAllByRole("button").filter((b) => /Alpha|Beta/.test(b.textContent ?? ""));
    expect(entries.map((b) => b.textContent)).toEqual([
      expect.stringContaining("Beta"),
      expect.stringContaining("Alpha"),
    ]);

    act(() => {
      entries[1].click();
    });
    expect(store.expandedKey).toBe("run:a");
    expect(h.navigate).toHaveBeenCalledWith({ to: "/test/$id", params: { id: "a" } });
  });

  it("restores a trainer step session without navigating away from the trainer", async () => {
    // Navigating would tear down the very trainer the step belongs to.
    h.listResult = [session({ key: "step:t1:2", kind: "step", label: "Step 3: click Submit" })];
    renderChip();
    await waitFor(() => expect(chip()).not.toBeNull());

    act(() => {
      screen.getByRole("button", { name: /^AI debug —/ }).click();
    });
    expect(h.navigate).not.toHaveBeenCalled();
    expect(store.expandedKey).toBe("step:t1:2");
  });

  it("disappears once the last session is discarded", async () => {
    h.listResult = [session({ key: "run:t1" })];
    renderChip();
    await waitFor(() => expect(chip()).not.toBeNull());

    act(() => store.discard("run:t1"));
    await waitFor(() => expect(chip()).toBeNull());
  });
});
