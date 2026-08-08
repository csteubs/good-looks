// The AI debug session store.
//
// Everything here is a behaviour that used to be impossible: before the store,
// a diagnosis lived in the dialog's own useLlmChat, so minimizing was fine but
// NAVIGATING AWAY silently destroyed the job — and left its backend request
// running with nobody holding the requestId to cancel it. These tests pin the
// four things that make minimizing trustworthy: chunks keep landing while
// minimized, a consumer unmounting doesn't kill the session, discarding really
// cancels, and a restored session never lies about being live.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import * as React from "react";

import { clearToastCalls, toastCalls, toastTexts } from "../__tests__/sonner-stub";
import { hashScript } from "../lib/ai-debug-sessions";
import type { AiDebugSession } from "../lib/recorder-types";
import {
  AiDebugProvider,
  runSessionKey,
  useAiDebug,
  useAiDebugContent,
  type AiDebugContextValue,
} from "./ai-debug-store";

const h = vi.hoisted(() => {
  const handlers: Record<string, ((payload: unknown) => void)[]> = {};
  return {
    handlers,
    listResult: [] as AiDebugSession[],
    nextRequestId: "req-1",
    isActiveResult: false,
    settings: {} as Record<string, unknown>,
    chat: vi.fn(),
    cancel: vi.fn(),
    isActive: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
    notifyDone: vi.fn(),
  };
});

vi.mock("../lib/api", () => ({
  api: {
    aiDebug: {
      list: async () => h.listResult,
      save: async (session: unknown) => {
        h.save(session);
        return session;
      },
      remove: async (key: string) => {
        h.remove(key);
        return { removed: 1 };
      },
      clear: async () => {
        h.clear();
        return { removed: 0 };
      },
      notifyDone: async (p: unknown) => {
        h.notifyDone(p);
        return { ok: true };
      },
    },
    recorder: { getSettings: async () => h.settings },
    llm: {
      chat: async (params: unknown) => {
        h.chat(params);
        return { requestId: h.nextRequestId };
      },
      cancel: async (requestId: string) => {
        h.cancel(requestId);
      },
      isActive: async (requestId: string) => {
        h.isActive(requestId);
        return { active: h.isActiveResult };
      },
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

let store: AiDebugContextValue;

function Capture() {
  store = useAiDebug();
  return null;
}

function Content({ sessionKey }: { sessionKey: string }) {
  const { content, reasoning } = useAiDebugContent(sessionKey);
  return (
    <div>
      <span data-testid="content">{content}</span>
      <span data-testid="reasoning">{reasoning}</span>
    </div>
  );
}

/** Stands in for a view that starts a session and can be navigated away from. */
function View({ sessionKey }: { sessionKey: string }) {
  const s = useAiDebug();
  React.useEffect(() => {
    s.openSession({
      key: sessionKey,
      kind: "run",
      testId: "t1",
      label: "Checkout",
      testName: "Checkout",
      context: {
        kind: "run",
        testName: "Checkout",
        testUrl: "https://example.com",
        script: "the script",
        output: "the output",
        imported: false,
      },
    });
    // Deliberately mount-only: re-opening on every render would fight the user.
  }, []);
  return <span data-testid="view">view mounted</span>;
}

function Harness({ showView = true, sessionKey }: { showView?: boolean; sessionKey: string }) {
  return (
    <AiDebugProvider>
      <Capture />
      {showView ? <View sessionKey={sessionKey} /> : null}
      <Content sessionKey={sessionKey} />
    </AiDebugProvider>
  );
}

function emit(channel: string, payload: unknown) {
  act(() => {
    for (const cb of h.handlers[channel] ?? []) cb(payload);
  });
}

async function startStream(key: string) {
  await act(async () => {
    await store.startStream(key, [{ role: "user", content: "hi" }]);
  });
}

const KEY = runSessionKey("t1");

function session(over: Partial<AiDebugSession> = {}): AiDebugSession {
  return {
    key: KEY,
    kind: "run",
    testId: "t1",
    label: "Checkout",
    testName: "Checkout",
    status: "done",
    content: "restored answer",
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
  h.listResult = [];
  h.nextRequestId = "req-1";
  h.isActiveResult = false;
  h.settings = {};
  clearToastCalls();
});

describe("streaming while minimized", () => {
  it("keeps accumulating chunks after the dialog is collapsed", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    await startStream(KEY);

    act(() => store.minimize());
    expect(store.expandedKey).toBeNull();

    emit("llm:chunk", { requestId: "req-1", delta: "Hello " });
    emit("llm:chunk", { requestId: "req-1", delta: "world" });

    // The whole promise of minimizing: the job did not pause, and the text is
    // there to come back to.
    await waitFor(() => expect(screen.getByTestId("content").textContent).toBe("Hello world"));
    expect(store.sessions[0].status).toBe("streaming");
  });

  it("keeps a reasoning model's thinking separate from its answer", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    await startStream(KEY);

    emit("llm:chunk", { requestId: "req-1", delta: "thinking…", reasoning: true });
    emit("llm:chunk", { requestId: "req-1", delta: "the answer" });

    await waitFor(() => expect(screen.getByTestId("content").textContent).toBe("the answer"));
    // Merging them would present the model's scratchpad as its conclusion, and
    // the apply-to-script path reads the answer as a diff.
    expect(screen.getByTestId("content").textContent).not.toContain("thinking");
    expect(screen.getByTestId("reasoning").textContent).toBe("thinking…");
  });

  it("survives the view that started it unmounting, as navigation would", async () => {
    const { rerender } = render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    await startStream(KEY);
    act(() => store.minimize());

    // Navigate away: the detail view is gone, the provider above the router is not.
    rerender(<Harness sessionKey={KEY} showView={false} />);
    expect(screen.queryByTestId("view")).toBeNull();

    emit("llm:chunk", { requestId: "req-1", delta: "still arriving" });
    await waitFor(() => expect(screen.getByTestId("content").textContent).toBe("still arriving"));
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0].status).toBe("streaming");
  });

  it("restores the accumulated answer when expanded again", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    await startStream(KEY);
    act(() => store.minimize());
    emit("llm:chunk", { requestId: "req-1", delta: "answer while away" });
    emit("llm:done", { requestId: "req-1" });

    act(() => store.expand(KEY));
    expect(store.expandedKey).toBe(KEY);
    await waitFor(() => expect(screen.getByTestId("content").textContent).toBe("answer while away"));
    expect(store.sessions[0].status).toBe("done");
  });

  it("ignores chunks belonging to some other llm request", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    await startStream(KEY);

    // GenerateTestDialog and friends stream through the same push channels.
    // Routing by requestId is what keeps this store from swallowing their text.
    emit("llm:chunk", { requestId: "someone-elses-request", delta: "NOT OURS" });
    emit("llm:chunk", { requestId: "req-1", delta: "ours" });

    await waitFor(() => expect(screen.getByTestId("content").textContent).toBe("ours"));
    expect(screen.getByTestId("content").textContent).not.toContain("NOT OURS");
  });
});

describe("terminal transitions", () => {
  it("marks a finished stream done and drops its request id", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    await startStream(KEY);
    emit("llm:done", { requestId: "req-1" });

    await waitFor(() => expect(store.sessions[0].status).toBe("done"));
    expect(store.sessions[0].requestId).toBeNull();
  });

  it("records a cancelled stream as cancelled, not as a finished answer", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    await startStream(KEY);
    emit("llm:done", { requestId: "req-1", cancelled: true });

    await waitFor(() => expect(store.sessions[0].status).toBe("cancelled"));
  });

  it("records an error with its message", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    await startStream(KEY);
    emit("llm:error", { requestId: "req-1", message: "connection refused" });

    await waitFor(() => expect(store.sessions[0].status).toBe("error"));
    expect(store.sessions[0].error).toBe("connection refused");
  });

  it("does not lose the tail of an answer to the chunk-flush timer", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    await startStream(KEY);

    // A chunk and the done event in the same tick: without an explicit flush
    // before the status flips, the final tokens would sit in the pending buffer
    // and the persisted "complete" answer would be missing its ending.
    emit("llm:chunk", { requestId: "req-1", delta: "the final word" });
    emit("llm:done", { requestId: "req-1" });

    await waitFor(() => expect(screen.getByTestId("content").textContent).toBe("the final word"));
  });

  it("persists the finished session so it survives a restart", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    await startStream(KEY);
    emit("llm:chunk", { requestId: "req-1", delta: "saved answer" });
    emit("llm:done", { requestId: "req-1" });

    await waitFor(() => {
      const saved = h.save.mock.calls.map((call) => call[0] as AiDebugSession);
      const done = saved.filter((s) => s.status === "done");
      expect(done.length).toBeGreaterThan(0);
      expect(done[done.length - 1].content).toBe("saved answer");
    });
  });
});

describe("stopping and discarding", () => {
  it("cancels the live request when a session is discarded", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    await startStream(KEY);

    act(() => store.discard(KEY));

    // The point of owning the requestId: a discarded job stops costing tokens.
    expect(h.cancel).toHaveBeenCalledWith("req-1");
    expect(store.sessions).toHaveLength(0);
    expect(store.expandedKey).toBeNull();
    expect(h.remove).toHaveBeenCalledWith(KEY);
  });

  it("stops a stream without forgetting the partial answer", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    await startStream(KEY);
    emit("llm:chunk", { requestId: "req-1", delta: "half an answer" });
    await waitFor(() => expect(screen.getByTestId("content").textContent).toBe("half an answer"));

    act(() => store.stopStream(KEY));
    expect(h.cancel).toHaveBeenCalledWith("req-1");
    // Stop is not discard: the session and everything streamed so far stay.
    expect(store.sessions).toHaveLength(1);
    expect(screen.getByTestId("content").textContent).toBe("half an answer");
  });

  it("ignores a stop on a session with nothing in flight", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    act(() => store.stopStream(KEY));
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("chunks for a discarded session never resurrect it", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    await startStream(KEY);
    act(() => store.discard(KEY));

    emit("llm:chunk", { requestId: "req-1", delta: "late chunk" });
    await new Promise((r) => setTimeout(r, 100));
    expect(store.sessions).toHaveLength(0);
    expect(screen.getByTestId("content").textContent).toBe("");
  });
});

describe("concurrency", () => {
  it("refuses a third concurrent stream and names the oldest to stop", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));

    const open = (key: string) =>
      act(() => {
        store.openSession({
          key,
          kind: "run",
          testId: key,
          label: key,
          testName: key,
          context: {
            kind: "run",
            testName: key,
            testUrl: "u",
            script: "",
            output: "",
            imported: false,
          },
        });
      });

    open("run:a");
    h.nextRequestId = "req-a";
    await startStream("run:a");
    open("run:b");
    h.nextRequestId = "req-b";
    await startStream("run:b");

    open("run:c");
    h.nextRequestId = "req-c";
    let decision!: Awaited<ReturnType<typeof store.startStream>>;
    await act(async () => {
      decision = await store.startStream("run:c", [{ role: "user", content: "hi" }]);
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.oldestStreamingKey).toBe("run:a");
    // Refused means NOT SENT — a queued third request would sit "thinking"
    // behind the others while a local provider serves them one at a time.
    expect(h.chat).toHaveBeenCalledTimes(2);
    expect(store.sessions.find((s) => s.key === "run:c")?.status).toBe("idle");
  });

  it("lets a session restart itself even at capacity", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));

    act(() => {
      store.openSession({
        key: "run:a",
        kind: "run",
        testId: "a",
        label: "a",
        testName: "a",
        context: { kind: "run", testName: "a", testUrl: "u", script: "", output: "", imported: false },
      });
    });
    h.nextRequestId = "req-a";
    await startStream("run:a");
    h.nextRequestId = "req-1";
    await startStream(KEY);

    // At capacity now (req-a + req-1). Regenerating KEY replaces its own
    // request, so it must be allowed — otherwise the dialog you're looking at
    // refuses to work.
    h.nextRequestId = "req-1b";
    let decision!: Awaited<ReturnType<typeof store.startStream>>;
    await act(async () => {
      decision = await store.startStream(KEY, [{ role: "user", content: "again" }]);
    });
    expect(decision.ok).toBe(true);
    // …and the superseded request is cancelled rather than left running.
    expect(h.cancel).toHaveBeenCalledWith("req-1");
  });

  it("clears the previous answer when a session is restarted", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    await startStream(KEY);
    emit("llm:chunk", { requestId: "req-1", delta: "old answer" });
    emit("llm:done", { requestId: "req-1" });
    await waitFor(() => expect(screen.getByTestId("content").textContent).toBe("old answer"));

    h.nextRequestId = "req-2";
    await startStream(KEY);
    await waitFor(() => expect(screen.getByTestId("content").textContent).toBe(""));
    emit("llm:chunk", { requestId: "req-2", delta: "new answer" });
    await waitFor(() => expect(screen.getByTestId("content").textContent).toBe("new answer"));
  });

  it("reports a failed send as an error rather than leaving it stuck thinking", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    h.chat.mockImplementationOnce(() => {
      throw new Error("provider offline");
    });
    await startStream(KEY);
    await waitFor(() => expect(store.sessions[0].status).toBe("error"));
    expect(store.sessions[0].error).toBe("provider offline");
  });
});

describe("hydration from disk", () => {
  it("restores a finished session and its answer", async () => {
    h.listResult = [session({ content: "yesterday's diagnosis" })];
    render(<Harness sessionKey={KEY} showView={false} />);

    await waitFor(() => expect(store.hydrated).toBe(true));
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0].status).toBe("done");
    expect(screen.getByTestId("content").textContent).toBe("yesterday's diagnosis");
  });

  it("marks a restored trainer-step session read-only", async () => {
    // There is no live trainer behind it, so regenerating would have no page to
    // reason about. Readable, not re-runnable.
    h.listResult = [session({ key: "step:t1:2", kind: "step", label: "Step 3" })];
    render(<Harness sessionKey="step:t1:2" showView={false} />);

    await waitFor(() => expect(store.hydrated).toBe(true));
    expect(store.sessions[0].readOnly).toBe(true);
  });

  it("re-adopts a request that is genuinely still streaming", async () => {
    // A renderer reload (HMR, window reload) drops the listeners while the
    // backend keeps going. Re-adopting is what stops that from orphaning a job.
    h.listResult = [session({ status: "streaming", requestId: "req-live", content: "partial" })];
    h.isActiveResult = true;
    render(<Harness sessionKey={KEY} showView={false} />);

    await waitFor(() => expect(store.hydrated).toBe(true));
    expect(store.sessions[0].status).toBe("streaming");

    emit("llm:chunk", { requestId: "req-live", delta: " — and the rest" });
    await waitFor(() =>
      expect(screen.getByTestId("content").textContent).toBe("partial — and the rest"),
    );
  });

  it("never restores a dead request as still thinking", async () => {
    // The failure this prevents: an icon stuck orange forever for a request
    // that finished (or died) while nobody was listening.
    h.listResult = [session({ status: "streaming", requestId: "req-dead" })];
    h.isActiveResult = false;
    render(<Harness sessionKey={KEY} showView={false} />);

    await waitFor(() => expect(store.hydrated).toBe(true));
    expect(store.sessions[0].status).toBe("interrupted");
    expect(store.sessions[0].requestId).toBeNull();
    expect(store.sessions[0].error).toBeTruthy();
  });

  it("survives a backend that cannot list sessions", async () => {
    h.listResult = null as unknown as AiDebugSession[];
    render(<Harness sessionKey={KEY} showView={false} />);
    await waitFor(() => expect(store.hydrated).toBe(true));
    expect(store.sessions).toHaveLength(0);
  });

  it("re-grounds a restored session when its view opens it again", async () => {
    h.listResult = [session({ readOnly: true })];
    render(<Harness sessionKey={KEY} />);

    await waitFor(() => expect(store.hydrated).toBe(true));
    // The View child opens the session with live context on mount, which is
    // what makes a restored diagnosis actionable again.
    await waitFor(() => expect(store.sessions[0].readOnly).toBe(false));
    expect(store.getContext(KEY)?.kind).toBe("run");
  });
});

// ── One session, one run ─────────────────────────────────────────────
// A session describes ONE execution. Keying it by test id alone meant a
// re-run reused the previous run's session, so reopening the panel showed a
// diagnosis, a diff and a stale-script warning about output that was no longer
// on screen.

describe("re-running the test", () => {
  function open(runKey: string) {
    act(() => {
      store.openSession({
        key: KEY,
        kind: "run",
        testId: "t1",
        label: "Checkout",
        testName: "Checkout",
        runKey,
        context: {
          kind: "run",
          testName: "Checkout",
          testUrl: "u",
          script: "s",
          output: "o",
          imported: false,
        },
      });
    });
  }

  it("clears the previous run's answer when a different run is debugged", async () => {
    render(<Harness sessionKey={KEY} showView={false} />);
    await waitFor(() => expect(store.hydrated).toBe(true));

    open("run-a");
    await startStream(KEY);
    emit("llm:chunk", { requestId: "req-1", delta: "diagnosis of run A" });
    emit("llm:done", { requestId: "req-1" });
    await waitFor(() => expect(screen.getByTestId("content").textContent).toBe("diagnosis of run A"));

    open("run-b");
    await waitFor(() => expect(screen.getByTestId("content").textContent).toBe(""));
    expect(store.sessions[0].status).toBe("idle");
    expect(store.sessions[0].error).toBeNull();
  });

  it("clears the stale-script warning's basis along with the answer", async () => {
    // The warning fires on a scriptHash from a SEND. Carrying it across runs
    // is what put "the script changed after this diagnosis" on a diagnosis
    // that had not been requested yet.
    render(<Harness sessionKey={KEY} showView={false} />);
    await waitFor(() => expect(store.hydrated).toBe(true));

    open("run-a");
    await act(async () => {
      await store.startStream(KEY, [{ role: "user", content: "hi" }], { scriptHash: "aaaa1111" });
    });
    expect(store.sessions[0].scriptHash).toBe("aaaa1111");

    open("run-b");
    expect(store.sessions[0].scriptHash).toBeNull();
  });

  it("gives the new run a fresh identity, so per-session UI state resets too", async () => {
    render(<Harness sessionKey={KEY} showView={false} />);
    await waitFor(() => expect(store.hydrated).toBe(true));

    open("run-a");
    const first = store.sessions[0].startedAt;
    open("run-b");
    // The dialog's draft, thread and fulfilment counters all key on startedAt,
    // so bumping it here is what resets every one of them at once.
    expect(store.sessions[0].startedAt).not.toBe(first);
    expect(store.sessions[0].runKey).toBe("run-b");
  });

  it("cancels a stream still answering about the previous run", async () => {
    // Chunks route by session key, so a surviving request would stream the old
    // run's answer into the new run's session.
    render(<Harness sessionKey={KEY} showView={false} />);
    await waitFor(() => expect(store.hydrated).toBe(true));

    open("run-a");
    await startStream(KEY);
    open("run-b");

    expect(h.cancel).toHaveBeenCalledWith("req-1");
    emit("llm:chunk", { requestId: "req-1", delta: "late answer about run A" });
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId("content").textContent).toBe("");
  });

  it("keeps the session when the same run is reopened", async () => {
    render(<Harness sessionKey={KEY} showView={false} />);
    await waitFor(() => expect(store.hydrated).toBe(true));

    open("run-a");
    await startStream(KEY);
    emit("llm:chunk", { requestId: "req-1", delta: "keep me" });
    emit("llm:done", { requestId: "req-1" });
    await waitFor(() => expect(screen.getByTestId("content").textContent).toBe("keep me"));

    // Minimizing and reopening the SAME run must not throw the answer away —
    // that is the entire point of the feature.
    open("run-a");
    expect(screen.getByTestId("content").textContent).toBe("keep me");
    expect(store.sessions[0].status).toBe("done");
  });

  it("does not reset a session restored from disk that has no run identity", async () => {
    // Sessions persisted before runKey existed have none; treating "unknown"
    // as "different" would wipe every restored diagnosis on first open.
    h.listResult = [session({ content: "restored answer", runKey: undefined })];
    render(<Harness sessionKey={KEY} showView={false} />);
    await waitFor(() => expect(store.hydrated).toBe(true));

    open("run-a");
    expect(screen.getByTestId("content").textContent).toBe("restored answer");
  });
});

describe("script hashing and staleness", () => {
  it("has no hash until a prompt is actually sent", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    // The hash records what was SENT. A session sitting in the review phase
    // has sent nothing, so claiming a hash would be a lie about provenance.
    expect(store.sessions[0].scriptHash).toBeNull();
  });

  it("stamps the hash at send time", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    await act(async () => {
      await store.startStream(KEY, [{ role: "user", content: "hi" }], { scriptHash: "deadbeef" });
    });
    expect(store.sessions[0].scriptHash).toBe("deadbeef");
  });

  it("leaves a restored session's hash alone when its view reopens it", async () => {
    // The regression this pins: re-stamping on open would make every restored
    // session look current, and the stale-script warning would never fire —
    // exactly when it matters most, after the app has been closed and reopened.
    h.listResult = [session({ scriptHash: "originalhash", content: "the stored answer" })];
    render(<Harness sessionKey={KEY} />);

    await waitFor(() => expect(store.hydrated).toBe(true));
    await waitFor(() => expect(store.sessions[0].readOnly).toBe(false));
    expect(store.sessions[0].scriptHash).toBe("originalhash");
    // The view opening the session mid-hydration must not wipe the answer it
    // was opened to look at.
    expect(store.sessions[0].status).toBe("done");
    expect(screen.getByTestId("content").textContent).toBe("the stored answer");
  });

  it("lets a session that has already been sent win over its stored copy", async () => {
    h.listResult = [session({ content: "the OLD answer", updatedAt: 1 })];
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    // Sending makes the live session authoritative — the stored record is by
    // definition the older one, and must not overwrite it back.
    await startStream(KEY);
    await waitFor(() => expect(store.hydrated).toBe(true));
    expect(store.sessions[0].status).toBe("streaming");
    expect(screen.getByTestId("content").textContent).toBe("");
  });

  it("keeps context out of session state so a re-render can't churn every icon", async () => {
    render(<Harness sessionKey={KEY} />);
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    const before = store.sessions[0];

    act(() => {
      store.attachContext(KEY, {
        kind: "run",
        testName: "Checkout",
        testUrl: "https://example.com",
        script: "an EDITED script",
        output: "the output",
        imported: false,
      });
    });

    expect(store.sessions[0]).toBe(before);
    expect((store.getContext(KEY) as { script: string }).script).toBe("an EDITED script");
  });
});

// ── Finishing while minimized ────────────────────────────────────────
// The completion side-effects: a toast with a Review action, a ping to the
// backend notifier (which gates on its own setting), and — behind the
// experimental autoAcceptAiDebugFixes setting — applying a run fix on its own.
// Every guard here exists so the auto path can never clobber a user's edit.

/** A run view whose context carries an apply handler, like TestDetailView's. */
function ViewWithApply({ onApplyScript }: { onApplyScript: (source: string) => Promise<void> }) {
  const s = useAiDebug();
  React.useEffect(() => {
    s.openSession({
      key: KEY,
      kind: "run",
      testId: "t1",
      label: "Checkout",
      testName: "Checkout",
      context: {
        kind: "run",
        testName: "Checkout",
        testUrl: "https://example.com",
        script: "the script",
        output: "the output",
        imported: false,
        onApplyScript,
      },
    });
  }, []);
  return null;
}

/** A model answer whose fenced block satisfies extractCorrectedScript. */
const CORRECTED_ANSWER = [
  "The selector was stale. Here is the corrected spec:",
  "```ts",
  'import { test, expect } from "@playwright/test";',
  'test("Checkout", async ({ page }) => { await page.goto("https://example.com"); });',
  "```",
].join("\n");

/** The Review action of the most recent toast that carries one.
 *
 *  The SDK's toast bakes `action` into the RENDERED element (an `actions`
 *  prop on its Toast component) rather than forwarding it to sonner's options,
 *  so pressing the button from a test means rendering the recorded custom
 *  toast and pulling the handler off its props. */
function reviewAction(): (() => void) | null {
  for (let i = toastCalls.length - 1; i >= 0; i--) {
    const call = toastCalls[i];
    const direct = (call.options as { action?: { onClick?: () => void } } | undefined)?.action;
    if (direct?.onClick) return direct.onClick;
    if (typeof call.message === "function") {
      const rendered = (call.message as (id: string) => unknown)("test-toast");
      const props = (rendered as {
        props?: { actions?: { label?: string; onClick?: () => void }[] };
      } | null)?.props;
      const review = (props?.actions ?? []).filter((a) => a.label === "Review")[0];
      if (review?.onClick) return review.onClick;
    }
  }
  return null;
}

describe("finishing while minimized", () => {
  it("announces a finished job with a toast whose Review restores the dialog", async () => {
    render(<Harness sessionKey={KEY} />);
    await startStream(KEY);
    act(() => store.minimize());

    emit("llm:chunk", { requestId: "req-1", delta: "the answer" });
    emit("llm:done", { requestId: "req-1" });

    await waitFor(() => expect(h.notifyDone).toHaveBeenCalledWith({ testName: "Checkout", status: "done" }));
    await waitFor(() =>
      expect(toastTexts().some((t) => t.title.includes("AI debug finished — Checkout"))).toBe(true),
    );

    const review = reviewAction();
    expect(review).not.toBeNull();
    act(() => review!());
    expect(store.expandedKey).toBe(KEY);
  });

  it("stays quiet while the dialog is open — the user is already watching", async () => {
    render(<Harness sessionKey={KEY} />);
    await startStream(KEY);

    emit("llm:done", { requestId: "req-1" });

    // Flush any stray async work before asserting silence.
    await act(async () => {});
    expect(h.notifyDone).not.toHaveBeenCalled();
    expect(toastTexts()).toHaveLength(0);
  });

  it("says nothing about a cancel the user asked for", async () => {
    render(<Harness sessionKey={KEY} />);
    await startStream(KEY);
    act(() => store.minimize());

    emit("llm:done", { requestId: "req-1", cancelled: true });

    await act(async () => {});
    expect(h.notifyDone).not.toHaveBeenCalled();
    expect(toastTexts()).toHaveLength(0);
  });

  it("announces a failure as a failure", async () => {
    render(<Harness sessionKey={KEY} />);
    await startStream(KEY);
    act(() => store.minimize());

    emit("llm:error", { requestId: "req-1", message: "connection refused" });

    await waitFor(() => expect(h.notifyDone).toHaveBeenCalledWith({ testName: "Checkout", status: "error" }));
    await waitFor(() =>
      expect(toastTexts().some((t) => t.title.includes("AI debug failed — Checkout"))).toBe(true),
    );
  });

  it("auto-applies a fix when enabled and the script has not changed since send", async () => {
    h.settings = { autoAcceptAiDebugFixes: true };
    const onApplyScript = vi.fn(async (_source: string) => {});
    render(
      <AiDebugProvider>
        <Capture />
        <ViewWithApply onApplyScript={onApplyScript} />
      </AiDebugProvider>,
    );
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    await act(async () => {
      await store.startStream(
        KEY,
        [{ role: "user", content: "fix it" }],
        { scriptHash: hashScript("the script") },
      );
    });
    act(() => store.minimize());

    emit("llm:chunk", { requestId: "req-1", delta: CORRECTED_ANSWER });
    emit("llm:done", { requestId: "req-1" });

    await waitFor(() => expect(onApplyScript).toHaveBeenCalledTimes(1));
    expect(onApplyScript.mock.calls[0][0]).toContain('test("Checkout"');
    await waitFor(() =>
      expect(toastTexts().some((t) => t.title.includes("Applied the AI fix"))).toBe(true),
    );
  });

  it("refuses to auto-apply over a script edited while the model was thinking", async () => {
    // Delete the hash guard in announceFinished and THIS is the test that
    // fails — the apply fires against a script the prompt never saw.
    h.settings = { autoAcceptAiDebugFixes: true };
    const onApplyScript = vi.fn(async (_source: string) => {});
    render(
      <AiDebugProvider>
        <Capture />
        <ViewWithApply onApplyScript={onApplyScript} />
      </AiDebugProvider>,
    );
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    await act(async () => {
      await store.startStream(
        KEY,
        [{ role: "user", content: "fix it" }],
        { scriptHash: hashScript("what the prompt was built from") },
      );
    });
    act(() => store.minimize());

    emit("llm:chunk", { requestId: "req-1", delta: CORRECTED_ANSWER });
    emit("llm:done", { requestId: "req-1" });

    await waitFor(() =>
      expect(toastTexts().some((t) => t.title.includes("AI debug finished — Checkout"))).toBe(true),
    );
    expect(onApplyScript).not.toHaveBeenCalled();
    // The toast says WHY nothing was applied, not just that there is a result.
    expect(
      toastTexts().some((t) => (t.description ?? "").includes("script changed")),
    ).toBe(true);
  });

  it("leaves auto-apply off by default", async () => {
    const onApplyScript = vi.fn(async (_source: string) => {});
    render(
      <AiDebugProvider>
        <Capture />
        <ViewWithApply onApplyScript={onApplyScript} />
      </AiDebugProvider>,
    );
    await waitFor(() => expect(store.sessions).toHaveLength(1));
    await act(async () => {
      await store.startStream(
        KEY,
        [{ role: "user", content: "fix it" }],
        { scriptHash: hashScript("the script") },
      );
    });
    act(() => store.minimize());

    emit("llm:chunk", { requestId: "req-1", delta: CORRECTED_ANSWER });
    emit("llm:done", { requestId: "req-1" });

    await waitFor(() =>
      expect(toastTexts().some((t) => t.title.includes("AI debug finished — Checkout"))).toBe(true),
    );
    expect(onApplyScript).not.toHaveBeenCalled();
  });
});
