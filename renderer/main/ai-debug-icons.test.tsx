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
//   • the library sidebar's per-row sparkle (aggregate per test)
//   • the open dialog's stop-button spinner (streaming, in both dialogs)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
import { AiDebugHost } from "./ai-debug-panel";
import { LibrarySidebar } from "./library-sidebar";
import { RunOutput } from "./run-output";
import type { RunInfo } from "./recorder-store";

const h = vi.hoisted(() => ({
  listResult: [] as AiDebugSession[],
  handlers: {} as Record<string, ((payload: unknown) => void)[]>,
  navigate: vi.fn(),
  /** What `api.recorder.getSettings()` answers — the stop-spinner surface is
   *  gated on `disabledAestheticEnhancements`. */
  settings: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
  // The sidebar (a covered surface below) reads both; neither matters here.
  useParams: () => ({}),
  useRouterState: () => "/",
}));

// The sidebar's dialogs each open their own queries and native bridges; none
// of them is an icon surface.
vi.mock("./new-recording-dialog", () => ({ NewRecordingDialog: () => null }));
vi.mock("./generate-test-dialog", () => ({ GenerateTestDialog: () => null }));
vi.mock("./import-git-dialog", () => ({ ImportGitDialog: () => null }));
vi.mock("./tags-dialog", () => ({ TagsDialog: () => null }));

vi.mock("../lib/api", () => ({
  api: {
    aiDebug: {
      list: async () => h.listResult,
      save: async (s: unknown) => s,
      remove: async () => ({ removed: 1 }),
      clear: async () => ({ removed: 0 }),
      notifyDone: async () => ({ ok: true }),
    },
    recorder: { getSettings: async () => h.settings },
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
    // For the sidebar surface: one test the sessions can attach to, no runs
    // (the verdict dot is library-sidebar.test.tsx's business, not this file's).
    tests: {
      list: async () => [
        {
          id: "t1",
          name: "Checkout",
          url: "https://example.com",
          createdAt: 1,
          updatedAt: 1,
          steps: [],
          scriptPath: "/tmp/t1.spec.ts",
        },
      ],
    },
    runs: { list: async () => [] },
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
  h.settings = {};
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

describe("the icon for a job kept across a re-run (experimental)", () => {
  function RunPanel({ testId, runKey }: { testId: string; runKey: string }) {
    const status = useAiDebugStatus(runSessionKey(testId), runKey);
    return <RunOutput info={info()} onDebug={() => {}} aiStatus={status} />;
  }

  it("leaves the new run's icon blank while the kept job stays visible on the chip", async () => {
    // The kept job is deliberately still in the store, so this is exactly the
    // case where a run-scoped icon earns its keep.
    h.listResult = [session({ status: "streaming", runKey: "rec-1", superseded: true })];
    render(
      <AiDebugProvider>
        <Capture />
        <RunPanel testId="t1" runKey="rec-2" />
        <AiDebugChip />
      </AiDebugProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText("Debug with AI")).toBeTruthy());
    expect(screen.queryByLabelText(toneFor("streaming").label)).toBeNull();
    // …but it is still reachable, and still says it is thinking.
    expect(
      screen.getByRole("button", { name: `AI debug — ${toneFor("streaming").label}` }),
    ).toBeTruthy();
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

// ── Applying a fix must not disturb the icon ─────────────────────────
//
// The new-step highlight hangs off the apply path, one call away from the
// session whose colour this suite exists to protect. Applying re-runs the
// view's `runContext` memo (the apply handler is one of its inputs) and
// re-attaches it, so every apply now pushes a fresh context object at a
// finished session. If that ever moved the session — status reset, icon
// re-rendered from scratch — the failure is silent in both directions: orange
// on a finished job leaves the user waiting on nothing, and a lost green loses
// them an answer they asked for.

// ── The library sidebar's per-row sparkle ────────────────────────────

describe("the sidebar row sparkle", () => {
  // The sidebar needs a QueryClient for its tests/runs queries; the other
  // surfaces above don't, so the wrapper lives here rather than in a shared
  // helper that would imply they use it.
  function renderSidebar() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <AiDebugProvider>
          <Capture />
          <LibrarySidebar />
        </AiDebugProvider>
      </QueryClientProvider>,
    );
  }

  it("shows every status with its own colour and label on the test's row", async () => {
    for (const status of ALL_STATUSES) {
      h.listResult = [session({ status })];
      const { unmount } = renderSidebar();
      const tone = toneFor(status);
      const label = `AI debug — ${tone.label}`;
      await waitFor(() => expect(screen.getByLabelText(label)).toBeTruthy());
      expect(screen.getByLabelText(label).getAttribute("class") ?? "").toContain(tone.className);
      unmount();
    }
  });

  it("pulses while streaming and holds still once done", async () => {
    h.listResult = [session({ status: "streaming" })];
    const first = renderSidebar();
    const busyLabel = `AI debug — ${toneFor("streaming").label}`;
    await waitFor(() => expect(screen.getByLabelText(busyLabel)).toBeTruthy());
    expect(screen.getByLabelText(busyLabel).getAttribute("class") ?? "").toContain("animate-pulse");
    first.unmount();

    h.listResult = [session({ status: "done" })];
    renderSidebar();
    const doneLabel = `AI debug — ${toneFor("done").label}`;
    await waitFor(() => expect(screen.getByLabelText(doneLabel)).toBeTruthy());
    expect(screen.getByLabelText(doneLabel).getAttribute("class") ?? "").not.toContain(
      "animate-pulse",
    );
  });

  it("keeps a row without sessions clean", async () => {
    h.listResult = [];
    renderSidebar();
    await screen.findByText("Checkout");
    expect(screen.queryByLabelText(/^AI debug — /)).toBeNull();
  });

  it("follows a session from streaming to done, live", async () => {
    // The row must update while the user is elsewhere in the app — that's the
    // whole point of surfacing it in the LIST rather than only in the detail
    // view they navigated away from.
    h.listResult = [];
    renderSidebar();
    await screen.findByText("Checkout");

    openSessionFor("t1");
    await act(async () => {
      await store.startStream(runSessionKey("t1"), [{ role: "user", content: "hi" }]);
    });
    const busyLabel = `AI debug — ${toneFor("streaming").label}`;
    await waitFor(() => expect(screen.getByLabelText(busyLabel)).toBeTruthy());

    emit("llm:done", { requestId: "req-1" });
    const doneLabel = `AI debug — ${toneFor("done").label}`;
    await waitFor(() => expect(screen.getByLabelText(doneLabel)).toBeTruthy());
    expect(screen.queryByLabelText(busyLabel)).toBeNull();
  });
});

// ── The open dialog's stop-button spinner ────────────────────────────

describe("the stop button's spinner", () => {
  // The ring around the stop square says "still working" at the one control
  // the user reaches for when deciding whether to wait or kill the job. It is
  // a status icon like the sparkles above, so it belongs in this file: a ring
  // left spinning on a finished job, or missing on a live one, is silent.

  function renderHost() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <AiDebugProvider>
          <Capture />
          <AiDebugHost />
        </AiDebugProvider>
      </QueryClientProvider>,
    );
  }

  /** Open a session of either kind and leave its dialog expanded. */
  function openExpanded(kind: "run" | "step") {
    act(() => {
      store.openSession(
        kind === "run"
          ? {
              key: runSessionKey("t1"),
              kind: "run",
              testId: "t1",
              label: "Checkout",
              testName: "Checkout",
              runKey: "rec-t1",
              context: {
                kind: "run",
                testName: "Checkout",
                testUrl: "u",
                script: "",
                output: "",
                imported: false,
              },
            }
          : {
              key: "step:t1:0",
              kind: "step",
              testId: "t1",
              label: "Click Submit",
              testName: "Checkout",
              context: {
                kind: "step",
                testName: "Checkout",
                url: "u",
                stepLabel: "Click Submit",
                error: "boom",
                logs: [],
              },
            },
      );
    });
  }

  for (const kind of ["run", "step"] as const) {
    it(`spins only while the ${kind} dialog's job is streaming`, async () => {
      renderHost();
      await waitFor(() => expect(store.hydrated).toBe(true));
      openExpanded(kind);
      const key = kind === "run" ? runSessionKey("t1") : "step:t1:0";

      // Idle: the stop button isn't offered at all, so neither is the ring.
      await waitFor(() => expect(screen.queryByLabelText("Stop")).toBeNull());

      await act(async () => {
        await store.startStream(key, [{ role: "user", content: "hi" }]);
      });
      await waitFor(() => expect(screen.getByLabelText("Stop")).toBeTruthy());
      expect(screen.getByTestId("ai-stop-spinner")).toBeTruthy();

      emit("llm:done", { requestId: "req-1" });
      // The job is finished: no stop control, and therefore no ring still
      // turning to claim otherwise.
      await waitFor(() => expect(screen.queryByLabelText("Stop")).toBeNull());
      expect(screen.queryByTestId("ai-stop-spinner")).toBeNull();
    });
  }

  it("respects reduce-motion by gating the animation, not the icon", async () => {
    // motion-safe: is the OS accessibility request. The ring must still be
    // THERE (it is part of the button's shape) — only its animation is gated.
    renderHost();
    await waitFor(() => expect(store.hydrated).toBe(true));
    openExpanded("run");
    await act(async () => {
      await store.startStream(runSessionKey("t1"), [{ role: "user", content: "hi" }]);
    });
    const ring = await screen.findByTestId("ai-stop-spinner");
    expect(ring.getAttribute("class") ?? "").toContain("motion-safe:animate-spin");
  });

  it("leaves the plain square when the flourish is switched off", async () => {
    // The Appearance pane can retire the ring. The button must survive it —
    // this is decoration, and the stop control is not.
    h.settings = { disabledAestheticEnhancements: ["aiStopSpinner"] };
    renderHost();
    await waitFor(() => expect(store.hydrated).toBe(true));
    openExpanded("run");
    await act(async () => {
      await store.startStream(runSessionKey("t1"), [{ role: "user", content: "hi" }]);
    });

    await waitFor(() => expect(screen.getByLabelText("Stop")).toBeTruthy());
    await waitFor(() => expect(screen.queryByTestId("ai-stop-spinner")).toBeNull());
  });
});

describe("applying a suggested fix", () => {
  function renderFinishedSession() {
    h.listResult = [session({ status: "done" })];
    return render(
      <AiDebugProvider>
        <Capture />
        <TestPanel testId="t1" />
      </AiDebugProvider>,
    );
  }

  const freshContext = (script: string) => ({
    kind: "run" as const,
    testName: "Checkout",
    testUrl: "https://example.com",
    script,
    output: "",
    imported: false,
    onApplyScript: async () => {},
  });

  it("leaves a finished session reading as ready for review", async () => {
    renderFinishedSession();
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    const before = iconClassOf(toneFor("done").label);
    expect(before).toContain("text-support-green");

    // What the view does after writing the script: hand the session the newly
    // current script so a later diff is computed against what is really there.
    act(() => store.attachContext(runSessionKey("t1"), freshContext("// corrected")));

    expect(store.sessions.find((x) => x.key === runSessionKey("t1"))?.status).toBe("done");
    expect(iconClassOf(toneFor("done").label)).toBe(before);
  });

  it("keeps a live job reading as still working", async () => {
    // The other direction: an apply can land while a SECOND question is
    // streaming, and must not flip that job to a finished colour.
    h.listResult = [session({ status: "streaming" })];
    render(
      <AiDebugProvider>
        <Capture />
        <TestPanel testId="t1" />
      </AiDebugProvider>,
    );
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    const before = iconClassOf(toneFor("streaming").label);
    expect(before).toContain("text-support-orange");

    act(() => store.attachContext(runSessionKey("t1"), freshContext("// corrected")));

    expect(store.sessions.find((x) => x.key === runSessionKey("t1"))?.status).toBe("streaming");
    expect(iconClassOf(toneFor("streaming").label)).toBe(before);
  });

  it("does not put a discarded session back on screen", async () => {
    // The view re-attaches on every render, including renders that happen
    // after the user discarded the job. Attaching must not be able to create
    // a session, or a stale icon reappears with no way to get rid of it.
    renderFinishedSession();
    await waitFor(() => expect(store.sessions).toHaveLength(1));

    act(() => store.discard(runSessionKey("t1")));
    expect(store.sessions).toHaveLength(0);

    act(() => store.attachContext(runSessionKey("t1"), freshContext("// corrected")));

    expect(store.sessions).toHaveLength(0);
    expect(screen.queryByLabelText(toneFor("done").label)).toBeNull();
  });
});
