// Global store for minimizable "Debug with AI" sessions.
//
// WHY THIS IS GLOBAL. The dialogs used to own their own useLlmChat, which made
// a job die with the view that started it: TestDetailView is a route component,
// and RootView swaps the entire outlet for RecordingView while recording. The
// whole point of minimizing is to go do something else, so the session has to
// outlive every view — including the one it was started from. It also has to
// own the `requestId`: a session that loses that can never be cancelled, and
// with the Claude provider selected an orphaned stream is billed tokens.
//
// TWO CONTEXTS, ON PURPOSE. Metadata (status, labels) changes a handful of
// times per session; content changes once per streamed token. Putting both in
// one context would re-render the sidebar chip, the run panel and every trainer
// step row on every token. Consumers that only need a colour subscribe to
// AiDebugContext; only the open dialog subscribes to AiDebugContentContext.

import * as React from "react";
import { toast } from "@ui";

import { api } from "../lib/api";
import {
  canStartStream,
  hashScript,
  pruneSessions,
  runSessionKey,
  sortSessions,
  stepSessionKey,
  type StartDecision,
} from "../lib/ai-debug-sessions";
import { extractCorrectedScript } from "../lib/parse-llm-response";
import type { AiDebugKind, AiDebugSession, AiDebugStatus, TestSpeed } from "../lib/recorder-types";
import type { LlmErrorKind, LlmMessage } from "../lib/llm-types";

/** Metadata for one session — everything except the streamed text. */
export type AiDebugMeta = Omit<AiDebugSession, "content" | "reasoning">;

export interface AiDebugContent {
  content: string;
  reasoning: string;
}

const EMPTY_CONTENT: AiDebugContent = { content: "", reasoning: "" };

/** Everything the run dialog needs to build a prompt. Renderer-only and never
 *  persisted — it embeds the full script and run output. */
export interface AiDebugRunContext {
  kind: "run";
  testName: string;
  testUrl: string;
  script: string;
  output: string;
  imported: boolean;
  speed?: TestSpeed;
  failedStepIndex?: number;
  /** Artifact id of the run being debugged, for fetching its recorded logs.
   *  Absent until a run finishes. */
  recordId?: string;
  /** Whether that run actually recorded console/network. Drives whether the
   *  model is even told it may ask. */
  logsAvailable?: boolean;
  /** Whether that run recorded any Auto-Heal failure, which is where the page
   *  structure comes from. Independent of logsAvailable — different setting. */
  structureAvailable?: boolean;
  onApplyScript?: (source: string) => Promise<void>;
}

export interface AiDebugStepContext {
  kind: "step";
  testName: string;
  url: string;
  stepLabel: string;
  locator?: string;
  error: string;
  /** Already flattened to the prompt builder's shape — DebugLogLine's terse
   *  field names (i/t/m) are a wire format, not a prompt input. */
  logs: { level: "info" | "warn" | "error"; message: string }[];
}

export type AiDebugContextData = AiDebugRunContext | AiDebugStepContext;

export interface OpenSessionInit {
  key: string;
  kind: AiDebugKind;
  testId: string;
  label: string;
  testName: string;
  /** Which run this is about. When it differs from the existing session's, the
   *  session is RESET rather than reused — see openSession. */
  runKey?: string | null;
  context: AiDebugContextData;
}

export interface AiDebugContextValue {
  /** Newest activity first. Content-free — subscribe to the content context for text. */
  sessions: AiDebugMeta[];
  /** The session whose dialog is open, or null when everything is minimized. */
  expandedKey: string | null;
  /** True once the persisted sessions have been loaded. */
  hydrated: boolean;
  /** Create (or refocus) a session and expand its dialog. */
  openSession: (init: OpenSessionInit) => void;
  /** Refresh a live session's prompt context — e.g. its view remounted after a
   *  restore, and now has the real script and run output again. */
  attachContext: (key: string, context: AiDebugContextData) => void;
  /** Collapse the open dialog back into its icon. The job keeps running. */
  minimize: () => void;
  expand: (key: string) => void;
  /** Cancel (if live) and forget a session, on disk too. */
  discard: (key: string) => void;
  /** Cancel a live request but keep the session and its partial output. */
  stopStream: (key: string) => void;
  /** Mark a session as outliving the run it describes. Used when a still-live
   *  job is preserved across a re-run instead of being discarded — every
   *  surface must then say the answer is about earlier output. */
  markSuperseded: (key: string) => void;
  /** Begin (or restart) a stream. `scriptHash` records the script the prompt
   *  was built from, stamped at SEND time. Returns why it was refused, if it was. */
  startStream: (
    key: string,
    messages: LlmMessage[],
    options?: { model?: string; scriptHash?: string },
  ) => Promise<StartDecision>;
  /** Whether starting `key` right now would be refused, and by which session. */
  capacityFor: (key: string) => StartDecision;
  getContext: (key: string) => AiDebugContextData | null;
  getSession: (key: string) => AiDebugMeta | null;
}

const AiDebugContext = React.createContext<AiDebugContextValue | null>(null);
const AiDebugContentContext = React.createContext<Record<string, AiDebugContent>>({});

export function useAiDebug(): AiDebugContextValue {
  const ctx = React.useContext(AiDebugContext);
  if (!ctx) throw new Error("useAiDebug must be used within AiDebugProvider");
  return ctx;
}

/** Subscribe to one session's streamed text. Separate from useAiDebug so a
 *  component that only shows a status colour doesn't re-render per token. */
export function useAiDebugContent(key: string | null): AiDebugContent {
  const all = React.useContext(AiDebugContentContext);
  return (key ? all[key] : null) ?? EMPTY_CONTENT;
}

/**
 * Status of one session, for an icon. Null when no session applies.
 *
 * `runKey` scopes the answer to ONE execution. A session outlives the run it
 * describes — it is only reset when reopened — so without this the run panel
 * kept advertising the previous run's green "answer ready" after a re-run, for
 * output no longer on screen. Clicking it then reset the session and showed an
 * empty review form, so the icon had been lying the whole time.
 *
 * A session with NO recorded runKey (persisted before that field existed)
 * matches anything: treating unknown as "a different run" would blank the icon
 * for every restored session.
 */
export function useAiDebugStatus(key: string | null, runKey?: string | null): AiDebugStatus | null {
  const { sessions } = useAiDebug();
  if (!key) return null;
  const session = sessions.find((s) => s.key === key);
  if (!session) return null;
  if (runKey != null && session.runKey != null && session.runKey !== runKey) return null;
  return session.status;
}

/** Coalesce streamed chunks before committing them to React state. At ~60ms a
 *  fast local model still feels live, but the dialog re-renders ~16x/second
 *  instead of once per token. */
const CHUNK_FLUSH_MS = 60;

/** Write a still-streaming session to disk at most this often. Persisting per
 *  chunk would be a disk write per token; persisting only at the end would lose
 *  a long answer to a crash. Terminal transitions and minimize always flush. */
const PERSIST_THROTTLE_MS = 2000;

export { runSessionKey, stepSessionKey };

/** Strictly-increasing session timestamps.
 *
 *  `Date.now()` has millisecond resolution, and two sessions created in the
 *  same tick would share a startedAt — which breaks two things that look
 *  unrelated: the dialog's per-session state (draft, thread, fulfilment
 *  counters) all key on startedAt, so a reset within the same millisecond
 *  would silently reuse the previous run's state; and "stop the oldest stream"
 *  would have no defined answer between two ties. */
let lastStamp = 0;
function nextStamp(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

export function AiDebugProvider({ children }: { children: React.ReactNode }) {
  const [metas, setMetas] = React.useState<Record<string, AiDebugMeta>>({});
  const [contents, setContents] = React.useState<Record<string, AiDebugContent>>({});
  const [expandedKey, setExpandedKey] = React.useState<string | null>(null);
  const [hydrated, setHydrated] = React.useState(false);

  // requestId → session key. Routing by request id (rather than assuming the
  // only in-flight request is ours) is what keeps this store from swallowing
  // chunks belonging to GenerateTestDialog or any other useLlmChat caller.
  const routeRef = React.useRef<Record<string, string>>({});
  // Chunks awaiting the next flush, and the timer that will flush them.
  const pendingRef = React.useRef<Record<string, AiDebugContent>>({});
  const flushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest committed text per key, readable synchronously for persistence.
  const contentRef = React.useRef<Record<string, AiDebugContent>>({});
  const metaRef = React.useRef<Record<string, AiDebugMeta>>({});
  const ctxRef = React.useRef<Record<string, AiDebugContextData>>({});
  const lastPersistRef = React.useRef<Record<string, number>>({});
  // Readable from the llm:done/llm:error handlers, whose closures outlive any
  // one render: "is this session's dialog on screen right now?"
  const expandedRef = React.useRef<string | null>(null);

  metaRef.current = metas;
  expandedRef.current = expandedKey;

  const persist = React.useCallback((key: string, force: boolean) => {
    const meta = metaRef.current[key];
    if (!meta) return;
    const now = Date.now();
    if (!force && now - (lastPersistRef.current[key] ?? 0) < PERSIST_THROTTLE_MS) return;
    lastPersistRef.current[key] = now;
    const text = contentRef.current[key] ?? EMPTY_CONTENT;
    void api.aiDebug
      .save({ ...meta, content: text.content, reasoning: text.reasoning })
      .catch(() => {
        // Persistence is best-effort; the live session is unaffected.
      });
  }, []);

  const patchMeta = React.useCallback(
    (key: string, patch: Partial<AiDebugMeta>, opts?: { persist?: boolean }) => {
      setMetas((prev) => {
        const existing = prev[key];
        if (!existing) return prev;
        const next = { ...existing, ...patch, updatedAt: Date.now() };
        const updated = { ...prev, [key]: next };
        metaRef.current = updated;
        return updated;
      });
      if (opts?.persist !== false) {
        // Defer so metaRef reflects the patch above before we read it.
        queueMicrotask(() => persist(key, true));
      }
    },
    [persist],
  );

  const flushPending = React.useCallback(() => {
    flushTimerRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = {};
    const keys = Object.keys(pending);
    if (keys.length === 0) return;
    setContents((prev) => {
      const next = { ...prev };
      for (const k of keys) next[k] = pending[k];
      contentRef.current = next;
      return next;
    });
    for (const k of keys) persist(k, false);
  }, [persist]);

  const scheduleFlush = React.useCallback(() => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = setTimeout(flushPending, CHUNK_FLUSH_MS);
  }, [flushPending]);

  const appendChunk = React.useCallback(
    (key: string, delta: string, isReasoning: boolean) => {
      const base = pendingRef.current[key] ?? contentRef.current[key] ?? EMPTY_CONTENT;
      pendingRef.current[key] = isReasoning
        ? { content: base.content, reasoning: base.reasoning + delta }
        : { content: base.content + delta, reasoning: base.reasoning };
      scheduleFlush();
    },
    [scheduleFlush],
  );

  /** Completion side-effects for a job that finished while MINIMIZED: an
   *  in-app toast with a Review action, the desktop notification (the backend
   *  gates it on notifyOnAiDebugDone), and — behind its own experimental
   *  setting — auto-applying a run fix.
   *
   *  Auto-accept only ever fires when the script is byte-identical to the one
   *  the prompt was built from (`scriptHash`, stamped at send time). An edit
   *  made while the model was thinking always wins; the answer then falls back
   *  to the review toast, never silently applies, never silently disappears. */
  const announceFinished = React.useCallback((key: string, status: "done" | "error") => {
    const meta = metaRef.current[key];
    if (!meta) return;
    // A watched dialog needs no announcement — the answer finishes in front of
    // the user, and a banner on top of it would just be noise.
    if (expandedRef.current === key) return;
    const testName = meta.testName || meta.label || "test";

    void api.aiDebug.notifyDone({ testName, status }).catch(() => {
      // Best-effort, like every notification in this app.
    });

    if (status === "error") {
      toast.error(`AI debug failed — ${testName}`, {
        action: { label: "Review", onClick: () => setExpandedKey(key) },
      });
      return;
    }

    void (async () => {
      let auto = false;
      try {
        auto = (await api.recorder.getSettings()).autoAcceptAiDebugFixes === true;
      } catch {
        auto = false;
      }
      const ctx = ctxRef.current[key];
      const corrected = extractCorrectedScript(contentRef.current[key]?.content ?? "");
      const fresh =
        meta.scriptHash != null &&
        ctx?.kind === "run" &&
        hashScript(ctx.script) === meta.scriptHash;
      if (
        auto &&
        !meta.superseded &&
        meta.kind === "run" &&
        corrected &&
        ctx?.kind === "run" &&
        ctx.onApplyScript &&
        fresh
      ) {
        try {
          await ctx.onApplyScript(corrected);
          toast.success(`Applied the AI fix to “${testName}” automatically.`);
          return;
        } catch {
          // Fall through to the review toast — a failed apply must surface as
          // "there is something to review", not vanish.
        }
      }
      toast(`AI debug finished — ${testName}`, {
        description:
          auto && corrected && !fresh
            ? "The script changed while the AI was thinking, so nothing was applied."
            : "The suggestions are ready for review.",
        action: { label: "Review", onClick: () => setExpandedKey(key) },
      });
    })();
  }, []);

  // ── Backend stream subscription ────────────────────────────────────
  React.useEffect(() => {
    const offChunk = api.on<{ requestId: string; delta: string; reasoning?: boolean }>(
      "llm:chunk",
      ({ requestId, delta, reasoning }) => {
        const key = routeRef.current[requestId];
        if (!key) return;
        appendChunk(key, delta, Boolean(reasoning));
      },
    );
    const offDone = api.on<{ requestId: string; cancelled?: boolean }>(
      "llm:done",
      ({ requestId, cancelled }) => {
        const key = routeRef.current[requestId];
        if (!key) return;
        delete routeRef.current[requestId];
        // Flush before the status flips so the persisted terminal record holds
        // the complete answer rather than everything bar the last 60ms.
        flushPending();
        patchMeta(key, {
          status: cancelled ? "cancelled" : "done",
          requestId: null,
        });
        // A cancel is the user's own act — nothing to announce.
        if (!cancelled) announceFinished(key, "done");
      },
    );
    const offError = api.on<{ requestId: string; message: string; kind?: LlmErrorKind }>(
      "llm:error",
      ({ requestId, message, kind }) => {
        const key = routeRef.current[requestId];
        if (!key) return;
        delete routeRef.current[requestId];
        flushPending();
        patchMeta(key, { status: "error", error: message, errorKind: kind ?? null, requestId: null });
        announceFinished(key, "error");
      },
    );
    return () => {
      offChunk();
      offDone();
      offError();
    };
  }, [announceFinished, appendChunk, flushPending, patchMeta]);

  // Flush any buffered chunk on unmount so a pending timer can't drop the tail
  // of an answer.
  React.useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, []);

  // ── Hydration ──────────────────────────────────────────────────────
  // Restores persisted sessions. A session still marked "streaming" here means
  // the RENDERER reloaded while the backend kept going (dev HMR, window
  // reload) — a backend restart would already have reconciled it. Those are
  // re-adopted so their chunks land again, but only after confirming the
  // request is genuinely still in flight; one that finished while nobody was
  // listening would otherwise sit orange forever.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      let stored: AiDebugSession[] = [];
      try {
        const listed = await api.aiDebug.list();
        // A backend that returns something unexpected must not take down the
        // provider — losing history is recoverable, an unmountable app is not.
        stored = Array.isArray(listed) ? listed : [];
      } catch {
        stored = [];
      }
      if (cancelled) return;

      const nextMetas: Record<string, AiDebugMeta> = {};
      const nextContents: Record<string, AiDebugContent> = {};
      for (const s of stored) {
        const { content, reasoning, ...meta } = s;
        // A step session restored from disk has no live trainer behind it, so
        // it is readable but not re-runnable until the trainer reopens it.
        nextMetas[s.key] = { ...meta, readOnly: meta.kind === "step" ? true : meta.readOnly };
        nextContents[s.key] = { content: content ?? "", reasoning: reasoning ?? "" };
      }

      const adoptable = stored.filter((s) => s.status === "streaming" && s.requestId);
      for (const s of adoptable) {
        let active = false;
        try {
          active = (await api.llm.isActive(s.requestId as string)).active;
        } catch {
          active = false;
        }
        if (cancelled) return;
        if (active) {
          routeRef.current[s.requestId as string] = s.key;
        } else {
          nextMetas[s.key] = {
            ...nextMetas[s.key],
            status: "interrupted",
            requestId: null,
            errorKind: null,
            error:
              nextMetas[s.key].error ??
              "Interrupted — the app closed while the model was answering",
          };
        }
      }

      if (cancelled) return;
      // MERGE, don't replace. Hydration is async, so a user who opens a test
      // and clicks "Debug with AI" before the read completes already has a live
      // session — replacing the map wholesale would silently delete the job
      // they just started.
      //
      // Where both exist, which one wins depends on whether the live one has
      // actually done anything. A freshly-opened session is still "idle" with
      // no answer, so the STORED record is the more informative of the two:
      // keep its answer and provenance, and take only the live grounding
      // (it has real context behind it again). Once the live session has been
      // sent, it is authoritative and the stored copy is simply older.
      const keptStored = new Set<string>();
      setMetas((live) => {
        const merged: Record<string, AiDebugMeta> = { ...nextMetas };
        for (const [key, liveMeta] of Object.entries(live)) {
          const stored = nextMetas[key];
          if (stored && liveMeta.status === "idle") {
            keptStored.add(key);
            merged[key] = {
              ...stored,
              readOnly: liveMeta.readOnly,
              label: liveMeta.label,
              testName: liveMeta.testName,
              updatedAt: liveMeta.updatedAt,
            };
          } else {
            merged[key] = liveMeta;
          }
        }
        metaRef.current = merged;
        return merged;
      });
      setContents((live) => {
        const merged: Record<string, AiDebugContent> = { ...nextContents };
        for (const [key, liveContent] of Object.entries(live)) {
          if (keptStored.has(key)) continue;
          merged[key] = liveContent;
        }
        contentRef.current = merged;
        return merged;
      });
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Actions ────────────────────────────────────────────────────────
  const openSession = React.useCallback(
    (init: OpenSessionInit) => {
      ctxRef.current[init.key] = init.context;
      const prior = metaRef.current[init.key];
      // A session is about ONE execution. Re-running the test and reopening the
      // panel must not show the previous run's diagnosis, its diff, or its
      // stale-script warning — all of which describe output that is no longer
      // on screen. A differing runKey resets the session instead of reusing it.
      const isNewRun =
        Boolean(prior) && init.runKey != null && prior.runKey != null && prior.runKey !== init.runKey;
      if (isNewRun && prior?.requestId) {
        // The old request is answering about the old run, and its chunks route
        // by key — leaving it alive would stream them into the new session.
        void api.llm.cancel(prior.requestId).catch(() => {});
        delete routeRef.current[prior.requestId];
      }
      if (isNewRun) {
        delete pendingRef.current[init.key];
        setContents((prev) => {
          const next = { ...prev, [init.key]: EMPTY_CONTENT };
          contentRef.current = next;
          return next;
        });
      }
      setMetas((prev) => {
        const existing = isNewRun ? undefined : prev[init.key];
        const now = nextStamp();
        const next: AiDebugMeta = existing
          ? {
              ...existing,
              label: init.label,
              testName: init.testName,
              // Reopening from a live view re-grounds a restored session: there
              // is real context behind it again, so it stops being read-only.
              readOnly: false,
              // scriptHash is deliberately NOT touched here. It records the
              // script a prompt was SENT with; re-stamping it on open would
              // erase the mismatch that warns the user their edits predate the
              // diagnosis they are about to apply.
              runKey: init.runKey ?? existing.runKey ?? null,
              // Reopening for the run it actually belongs to clears the flag.
              superseded: init.runKey != null && init.runKey === existing.runKey ? false : existing.superseded,
              updatedAt: now,
            }
          : {
              key: init.key,
              kind: init.kind,
              testId: init.testId,
              label: init.label,
              testName: init.testName,
              status: "idle",
              error: null,
              requestId: null,
              // Stamped when the prompt is actually sent (see startStream).
              scriptHash: null,
              runKey: init.runKey ?? null,
              superseded: false,
              // A fresh startedAt is what resets the dialog's own per-session
              // state (draft, thread, fulfilment counters), all of which key on
              // it — so one reset here reaches every one of them.
              startedAt: now,
              updatedAt: now,
              readOnly: false,
            };
        const merged = pruneSessions(Object.values({ ...prev, [init.key]: next }));
        const byKey: Record<string, AiDebugMeta> = {};
        for (const m of merged) byKey[m.key] = m;
        metaRef.current = byKey;
        return byKey;
      });
      setExpandedKey(init.key);
    },
    [],
  );

  const attachContext = React.useCallback((key: string, context: AiDebugContextData) => {
    // Context is renderer-only and changes as the view re-renders, so it lives
    // in a ref: writing it to state would re-render every icon in the app each
    // time a run streamed another line of output.
    ctxRef.current[key] = context;
  }, []);

  const minimize = React.useCallback(() => {
    setExpandedKey((prev) => {
      if (prev) {
        flushPending();
        queueMicrotask(() => persist(prev, true));
      }
      return null;
    });
  }, [flushPending, persist]);

  const expand = React.useCallback((key: string) => setExpandedKey(key), []);

  const discard = React.useCallback((key: string) => {
    const meta = metaRef.current[key];
    if (meta?.requestId) {
      void api.llm.cancel(meta.requestId).catch(() => {});
      delete routeRef.current[meta.requestId];
    }
    delete ctxRef.current[key];
    delete pendingRef.current[key];
    delete lastPersistRef.current[key];
    setMetas((prev) => {
      const next = { ...prev };
      delete next[key];
      metaRef.current = next;
      return next;
    });
    setContents((prev) => {
      const next = { ...prev };
      delete next[key];
      contentRef.current = next;
      return next;
    });
    setExpandedKey((prev) => (prev === key ? null : prev));
    void api.aiDebug.remove(key).catch(() => {});
  }, []);

  const stopStream = React.useCallback((key: string) => {
    const meta = metaRef.current[key];
    if (!meta?.requestId) return;
    void api.llm.cancel(meta.requestId).catch(() => {});
  }, []);

  const markSuperseded = React.useCallback(
    (key: string) => {
      if (metaRef.current[key]?.superseded) return;
      patchMeta(key, { superseded: true });
    },
    [patchMeta],
  );

  const capacityFor = React.useCallback(
    (key: string) => canStartStream(Object.values(metaRef.current), key),
    [],
  );

  const startStream = React.useCallback(
    async (key: string, messages: LlmMessage[], options?: { model?: string; scriptHash?: string }) => {
      const decision = canStartStream(Object.values(metaRef.current), key);
      if (!decision.ok) return decision;

      // Restarting a session that is already streaming replaces its own
      // request — cancel the old one first so it doesn't keep billing tokens
      // and land chunks in a session that has moved on.
      const existing = metaRef.current[key];
      if (existing?.requestId) {
        void api.llm.cancel(existing.requestId).catch(() => {});
        delete routeRef.current[existing.requestId];
      }

      pendingRef.current[key] = EMPTY_CONTENT;
      setContents((prev) => {
        const next = { ...prev, [key]: EMPTY_CONTENT };
        contentRef.current = next;
        return next;
      });
      patchMeta(
        key,
        {
          status: "streaming",
          error: null,
          errorKind: null,
          requestId: null,
          // Stamp what this prompt was built from, so a later approval can tell
          // whether the script has moved on since.
          ...(options?.scriptHash ? { scriptHash: options.scriptHash } : {}),
        },
        { persist: false },
      );

      try {
        const { requestId } = await api.llm.chat({ messages, model: options?.model });
        routeRef.current[requestId] = key;
        patchMeta(key, { status: "streaming", requestId });
      } catch (err) {
        patchMeta(key, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          errorKind: null,
          requestId: null,
        });
      }
      return decision;
    },
    [patchMeta],
  );

  const getContext = React.useCallback((key: string) => ctxRef.current[key] ?? null, []);
  const getSession = React.useCallback((key: string) => metaRef.current[key] ?? null, []);

  const sessions = React.useMemo(() => sortSessions(Object.values(metas)), [metas]);

  const value = React.useMemo<AiDebugContextValue>(
    () => ({
      sessions,
      expandedKey,
      hydrated,
      openSession,
      attachContext,
      minimize,
      expand,
      discard,
      stopStream,
      markSuperseded,
      startStream,
      capacityFor,
      getContext,
      getSession,
    }),
    [
      sessions,
      expandedKey,
      hydrated,
      openSession,
      attachContext,
      minimize,
      expand,
      discard,
      stopStream,
      markSuperseded,
      startStream,
      capacityFor,
      getContext,
      getSession,
    ],
  );

  return (
    <AiDebugContext.Provider value={value}>
      <AiDebugContentContext.Provider value={contents}>{children}</AiDebugContentContext.Provider>
    </AiDebugContext.Provider>
  );
}
