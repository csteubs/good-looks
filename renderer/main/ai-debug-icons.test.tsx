// THE icon-state suite for the AI debug feature.
//
// The colour IS the feature. A minimized job is only useful if its icon tells
// you truthfully whether the model is still working (orange), the answer is
// waiting (green), it failed (red), or it is ready for input (blue). Every one
// of those is a lie the user acts on: they walk away from a finished answer, or
// keep waiting on one that died.
//
// EXTEND THIS FILE whenever the AI debug feature changes. Icon regressions do
// not throw, do not fail a build, and do not show up in any other test — the
// panel works perfectly while the icon says the wrong thing. This is the only
// place that catches them.
//
// Covered surfaces:
//   • the run Output panel's sparkle (per test)
//   • the trainer Console's per-step sparkles (per step)
//   • the global chip (aggregate across sessions)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";

import type { AiDebugSession, AiDebugStatus } from "../lib/recorder-types";
import { toneFor } from "../lib/ai-debug-status";
import { AiDebugChip } from "./ai-debug-chip";
import {
  AiDebugProvider,
  runSessionKey,
  useAiDebug,
  useAiDebugStatus,
  type AiDebugContextValue,
} from "./ai-debug-store";
import { RunOutput } from "./run-output";
import type { RunInfo } from "./recorder-store";

const h = vi.hoisted(() => ({
  listResult: [] as AiDebugSession[],
  handlers: {} as Record<string, ((payload: unknown) => void)[]>,
  navigate: vi.fn(),
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
    },
    llm: {
      chat: async () => ({ requestId: "req-1" }),
      cancel: async () => {},
      isActive: async () => ({ active: false }),
      getConfig: async () => ({ provider: "ollama", model: null, baseUrls: {} }),
      status: async () => ({ online: false, models: [] }),
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

const ALL_STATUSES: AiDebugStatus[] = [
  "idle",
  "streaming",
  "done",
  "error",
  "cancelled",
  "interrupted",
];

let store: AiDebugContextValue;

function Capture() {
  store = useAiDebug();
  return null;
}

function info(): RunInfo {
  return { lines: ["x\n"], running: false, code: 1, stepStatus: {}, recordId: "rec-1", startedAt: 1 };
}

/** Stands in for TestDetailView: looks the status up by the CURRENT test's key
 *  and hands it to the run panel, exactly as the real view does. */
function TestPanel({ testId }: { testId: string }) {
  const status = useAiDebugStatus(runSessionKey(testId));
  return <RunOutput info={info()} onDebug={() => {}} aiStatus={status} />;
}

function session(over: Partial<AiDebugSession> = {}): AiDebugSession {
  return {
    key: runSessionKey("t1"),
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
    runKey: "rec-1",
    startedAt: 1,
    updatedAt: 2,
    ...over,
  };
}

function emit(channel: string, payload: unknown) {
  act(() => {
    for (const cb of h.handlers[channel] ?? []) cb(payload);
  });
}

/** The colour class actually on the rendered icon, whatever wraps it. */
function iconClassOf(label: string): string {
  return screen.getByLabelText(label).querySelector("svg")?.getAttribute("class") ?? "";
}

function openSessionFor(testId: string) {
  act(() => {
    store.openSession({
      key: runSessionKey(testId),
      kind: "run",
      testId,
      label: testId,
      testName: testId,
      runKey: `rec-${testId}`,
      context: {
        kind: "run",
        testName: testId,
        testUrl: "u",
        script: "",
        output: "",
        imported: false,
      },
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(h.handlers)) delete h.handlers[k];
  h.listResult = [];
});

// ── The run panel's icon ─────────────────────────────────────────────

describe("the run panel icon, per status", () => {
  it("shows every status with its own colour and label", async () => {
    for (const status of ALL_STATUSES) {
      h.listResult = [session({ status })];
      const { unmount } = render(
        <AiDebugProvider>
          <Capture />
          <TestPanel testId="t1" />
        </AiDebugProvider>,
      );
      const tone = toneFor(status);
      await waitFor(() => expect(screen.getByLabelText(tone.label)).toBeTruthy());
      expect(iconClassOf(tone.label)).toContain(tone.className);
      unmount();
    }
  });
});

describe("the run panel icon, as a session progresses", () => {
  it("follows the session from idle through streaming to done", async () => {
    render(
      <AiDebugProvider>
        <Capture />
        <TestPanel testId="t1" />
      </AiDebugProvider>,
    );
    await waitFor(() => expect(store.hydrated).toBe(true));

    // No session yet: the plain, unstarted affordance.
    expect(screen.getByLabelText("Debug with AI")).toBeTruthy();

    openSessionFor("t1");
    await waitFor(() => expect(screen.getByLabelText(toneFor("idle").label)).toBeTruthy());
    expect(iconClassOf(toneFor("idle").label)).toContain("text-accent");

    await act(async () => {
      await store.startStream(runSessionKey("t1"), [{ role: "user", content: "hi" }]);
    });
    await waitFor(() => expect(screen.getByLabelText(toneFor("streaming").label)).toBeTruthy());
    expect(iconClassOf(toneFor("streaming").label)).toContain("text-support-orange");

    emit("llm:done", { requestId: "req-1" });
    await waitFor(() => expect(screen.getByLabelText(toneFor("done").label)).toBeTruthy());
    expect(iconClassOf(toneFor("done").label)).toContain("text-support-green");
  });

  it("turns red when the request fails, without a reload", async () => {
    render(
      <AiDebugProvider>
        <Capture />
        <TestPanel testId="t1" />
      </AiDebugProvider>,
    );
    await waitFor(() => expect(store.hydrated).toBe(true));
    openSessionFor("t1");
    await act(async () => {
      await store.startStream(runSessionKey("t1"), [{ role: "user", content: "hi" }]);
    });

    emit("llm:error", { requestId: "req-1", message: "boom", kind: "provider" });
    await waitFor(() => expect(screen.getByLabelText(toneFor("error").label)).toBeTruthy());
    expect(iconClassOf(toneFor("error").label)).toContain("text-support-red");
  });

  it("goes back to blue when a session is discarded", async () => {
    h.listResult = [session({ status: "done" })];
    render(
      <AiDebugProvider>
        <Capture />
        <TestPanel testId="t1" />
      </AiDebugProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText(toneFor("done").label)).toBeTruthy());

    act(() => store.discard(runSessionKey("t1")));
    // No session at all — back to the plain affordance, not a stale green.
    await waitFor(() => expect(screen.getByLabelText("Debug with AI")).toBeTruthy());
  });
});

// ── Between tests ────────────────────────────────────────────────────
// The reported symptom: the colour not updating "between sessions and tests".

describe("the run panel icon, across tests", () => {
  it("shows each test its OWN session's status, not the other's", async () => {
    h.listResult = [
      session({ key: runSessionKey("t1"), testId: "t1", status: "done" }),
      session({ key: runSessionKey("t2"), testId: "t2", status: "error" }),
    ];
    render(
      <AiDebugProvider>
        <Capture />
        <TestPanel testId="t1" />
      </AiDebugProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText(toneFor("done").label)).toBeTruthy());
    expect(screen.queryByLabelText(toneFor("error").label)).toBeNull();
  });

  it("does not carry a colour over when the view switches test", async () => {
    // Navigating is a re-render with a different id, not a remount, so a stale
    // memo or a status read that isn't keyed by the current test shows the
    // PREVIOUS test's colour on the new one.
    h.listResult = [session({ key: runSessionKey("t1"), testId: "t1", status: "done" })];
    const { rerender } = render(
      <AiDebugProvider>
        <Capture />
        <TestPanel testId="t1" />
      </AiDebugProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText(toneFor("done").label)).toBeTruthy());

    rerender(
      <AiDebugProvider>
        <Capture />
        <TestPanel testId="t2" />
      </AiDebugProvider>,
    );
    // t2 has no session: the plain affordance, never t1's green.
    await waitFor(() => expect(screen.getByLabelText("Debug with AI")).toBeTruthy());
    expect(screen.queryByLabelText(toneFor("done").label)).toBeNull();
  });

  it("updates when the OTHER test's session changes, without touching this one", async () => {
    h.listResult = [
      session({ key: runSessionKey("t1"), testId: "t1", status: "idle" }),
      session({ key: runSessionKey("t2"), testId: "t2", status: "idle" }),
    ];
    render(
      <AiDebugProvider>
        <Capture />
        <TestPanel testId="t1" />
      </AiDebugProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText(toneFor("idle").label)).toBeTruthy());

    await act(async () => {
      await store.startStream(runSessionKey("t2"), [{ role: "user", content: "hi" }]);
    });
    // t1's icon must stay blue — t2 is the one that started thinking.
    expect(screen.getByLabelText(toneFor("idle").label)).toBeTruthy();
    expect(screen.queryByLabelText(toneFor("streaming").label)).toBeNull();
  });
});

// ── Across runs of the SAME test ─────────────────────────────────────
// A session describes one execution. Its status must not be advertised on a
// DIFFERENT run of the same test: the icon would promise an answer about
// output that is no longer on screen, and clicking it resets the session and
// shows an empty review form instead — the icon having lied the whole time.

describe("the run panel icon, across runs of one test", () => {
  /** The panel as the real view drives it: keyed by test, but describing one run. */
  function RunPanel({ testId, runKey }: { testId: string; runKey: string }) {
    const status = useAiDebugStatus(runSessionKey(testId), runKey);
    return <RunOutput info={info()} onDebug={() => {}} aiStatus={status} />;
  }

  it("does not show the previous run's colour on a new run", async () => {
    h.listResult = [session({ status: "done", runKey: "rec-1" })];
    const { rerender } = render(
      <AiDebugProvider>
        <Capture />
        <RunPanel testId="t1" runKey="rec-1" />
      </AiDebugProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText(toneFor("done").label)).toBeTruthy());

    // The test is re-run: same test, new execution.
    rerender(
      <AiDebugProvider>
        <Capture />
        <RunPanel testId="t1" runKey="rec-2" />
      </AiDebugProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("Debug with AI")).toBeTruthy());
    expect(screen.queryByLabelText(toneFor("done").label)).toBeNull();
  });

  it("still shows the colour for the run it belongs to", async () => {
    h.listResult = [session({ status: "streaming", runKey: "rec-1" })];
    render(
      <AiDebugProvider>
        <Capture />
        <RunPanel testId="t1" runKey="rec-1" />
      </AiDebugProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText(toneFor("streaming").label)).toBeTruthy());
  });

  it("shows a session with no recorded run identity, rather than hiding it", async () => {
    // Sessions persisted before runKey existed have none. Treating unknown as
    // "a different run" would blank the icon for every restored session.
    h.listResult = [session({ status: "done", runKey: undefined })];
    render(
      <AiDebugProvider>
        <Capture />
        <RunPanel testId="t1" runKey="rec-9" />
      </AiDebugProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText(toneFor("done").label)).toBeTruthy());
  });
});

// ── The global chip ──────────────────────────────────────────────────

describe("the global chip", () => {
  it("shows nothing with no sessions and appears when one starts", async () => {
    render(
      <AiDebugProvider>
        <Capture />
        <AiDebugChip />
      </AiDebugProvider>,
    );
    await waitFor(() => expect(store.hydrated).toBe(true));
    expect(screen.queryByRole("button", { name: /^AI debug —/ })).toBeNull();

    openSessionFor("t1");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: `AI debug — ${toneFor("idle").label}` })).toBeTruthy(),
    );
  });

  it("re-colours as the session it is advertising changes", async () => {
    render(
      <AiDebugProvider>
        <Capture />
        <AiDebugChip />
      </AiDebugProvider>,
    );
    await waitFor(() => expect(store.hydrated).toBe(true));
    openSessionFor("t1");
    await act(async () => {
      await store.startStream(runSessionKey("t1"), [{ role: "user", content: "hi" }]);
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: `AI debug — ${toneFor("streaming").label}` })).toBeTruthy(),
    );

    emit("llm:done", { requestId: "req-1" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: `AI debug — ${toneFor("done").label}` })).toBeTruthy(),
    );
  });

  it("switches to the finished job when one of several completes", async () => {
    h.listResult = [
      session({ key: runSessionKey("t1"), testId: "t1", status: "idle", updatedAt: 5 }),
      session({ key: runSessionKey("t2"), testId: "t2", status: "idle", updatedAt: 9 }),
    ];
    render(
      <AiDebugProvider>
        <Capture />
        <AiDebugChip />
      </AiDebugProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: `AI debug — ${toneFor("idle").label}` })).toBeTruthy(),
    );

    await act(async () => {
      await store.startStream(runSessionKey("t2"), [{ role: "user", content: "hi" }]);
    });
    emit("llm:done", { requestId: "req-1" });

    // Green beats blue: something is ready to read.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: `AI debug — ${toneFor("done").label}` })).toBeTruthy(),
    );
  });
});
