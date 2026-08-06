// Streams an AI diagnosis of a failed test run (script + run output) via the
// local LLM chat API (main/services/llm-service.ts). Auto-starts when opened.
// Renders the response with code changes as distinct, copyable blocks, and — when
// the model returns a complete corrected spec — offers to apply it to the script.

import * as React from "react";
import { Button, Callout, Dialog, Field, ScrollArea, Text, Textarea, toast } from "@glaze/core/components";
import {
  Check,
  ChevronDown,
  Copy,
  Minimize2,
  RotateCcw,
  FileSearch,
  Send,
  Square,
  Trash2,
  TriangleAlert,
  Wand2,
} from "lucide-react";

import glitchGif from "./assets/glitch.gif";

import { api } from "../lib/api";
import { MAX_ACTIVE_STREAMS, hashScript, isStale, type StartDecision } from "../lib/ai-debug-sessions";
import { buildLogPayload, type LogPayload } from "../lib/ai-log-payload";
import {
  describeNeed,
  parseLogRequest,
  stripLogRequest,
  type LogRequest,
} from "../lib/ai-log-request";
import { diffLines, diffSummary, type DiffLine } from "../lib/line-diff";
import { friendlyError } from "../lib/llm-errors";
import type { LlmMessage, LlmModel } from "../lib/llm-types";
import { buildDebugMessages, buildStepDebugMessages } from "../lib/llm-prompts";
import { extractCorrectedScript, parseResponse } from "../lib/parse-llm-response";
import type { AiDebugStatus } from "../lib/recorder-types";
import { useDisabledEnhancements } from "../lib/use-disabled-enhancements";
import { useAiDebug, useAiDebugContent } from "./ai-debug-store";

// Common failure reasons a user can toggle into the "additional context" box
// instead of retyping them every time. Each is appended on its own line; clicking
// an active reason removes its line again.
const QUICK_CONTEXT_REASONS = [
  "Flaky selector",
  "Wrong A/B variant",
  "Timing / race condition",
  "Site changed recently",
  "Auth / login state",
] as const;

function reasonLine(reason: string): string {
  return `- ${reason}`;
}

function isReasonActive(text: string, reason: string): boolean {
  return text.split("\n").some((l) => l.trim() === reasonLine(reason).trim());
}

function toggleReason(text: string, reason: string): string {
  const line = reasonLine(reason);
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l.trim() === line.trim());
  if (idx >= 0) {
    const next = lines.filter((_, i) => i !== idx);
    return next.join("\n").replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n+$/, "");
  }
  const joined = [text.replace(/\n+$/, ""), line].filter((s) => s.length > 0).join("\n");
  return joined;
}

/** Full-bleed glitch gif that eases in to fill the dialog while the model is
 *  processing, then eases back out when the response arrives. Sits behind the
 *  text layer so all window text stays visible. Background is #000000 while
 *  active or transitioning. */
function ThinkingGifOverlay({
  status,
  enabled,
}: {
  status: AiDebugStatus;
  enabled: boolean;
}) {
  // `expanding` while streaming; `contracting` for the 5s ease-out after the
  // response arrives; `hidden` once the fade-out completes.
  const [phase, setPhase] = React.useState<"hidden" | "expanding" | "contracting">("hidden");
  // Tracks whether the opacity target has been applied yet so the CSS transition
  // actually animates from 0 → 1 (without this, React renders opacity(1) on the
  // first frame and there's nothing to transition from).
  const [fadedIn, setFadedIn] = React.useState(false);
  const phaseRef = React.useRef(phase);
  phaseRef.current = phase;

  React.useEffect(() => {
    if (!enabled) {
      setPhase("hidden");
      setFadedIn(false);
      return;
    }
    if (status === "streaming") {
      setPhase("expanding");
      // Start at opacity 0, then on the next frame fade to opacity 1 so the
      // 5s ease-in transition runs.
      setFadedIn(false);
      const raf = requestAnimationFrame(() => {
        requestAnimationFrame(() => setFadedIn(true));
      });
      return () => cancelAnimationFrame(raf);
    }
    // Response received (done/error/cancelled) — start the 0.5s ease-out.
    if (phaseRef.current === "expanding") {
      setPhase("contracting");
      setFadedIn(false);
      const t = setTimeout(() => setPhase("hidden"), 500);
      return () => clearTimeout(t);
    }
  }, [status, enabled]);

  if (!enabled || phase === "hidden") return null;

  const targetOpacity = phase === "expanding" ? (fadedIn ? 0.5 : 0) : 0;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-md"
      style={{ backgroundColor: "#000000" }}
    >
      <div className="flex h-full w-full items-center justify-center">
        <img
          src={glitchGif}
          alt=""
          className="max-h-[300px] max-w-[400px] object-contain"
          style={{
            opacity: targetOpacity,
            transition: `opacity ${phase === "contracting" ? "0.5s" : "5s"} ease-in-out`,
          }}
        />
      </div>
    </div>
  );
}

// A fenced code block from the response, rendered distinctly with its own copy.
export function CodeBlock({ lang, content }: { lang: string; content: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    await window.glazeAPI.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="my-1 overflow-hidden rounded-md border border-separator">
      <div className="flex items-center justify-between border-b border-separator bg-control-subtle px-3 py-1">
        <span className="text-small text-secondary">{lang || "code"}</span>
        <Button iconOnly size="small" variant="transparent" onClick={copy} aria-label="Copy code" title="Copy code">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
      <pre className="text-small-mono overflow-x-auto whitespace-pre-wrap break-words p-3 text-primary">{content}</pre>
    </div>
  );
}

// Renders a line-level diff between the current script and the AI's corrected
// spec, shown in the "Apply to script" confirm so the user can review exactly
// what changes before overwriting the file. Equal lines are dimmed; removed
// lines (current) get a red tint; added lines (corrected) get a green tint.
function DiffView({ diff }: { diff: DiffLine[] }) {
  return (
    <div className="text-small-mono overflow-auto rounded-md border border-separator">
      <div className="min-w-max">
        {diff.map((d, i) => {
          const sign = d.type === "add" ? "+" : d.type === "remove" ? "-" : " ";
          const cls =
            d.type === "add"
              ? "bg-[var(--color-positive-subtle,rgba(46,196,87,0.12))] text-primary"
              : d.type === "remove"
                ? "bg-[var(--color-negative-subtle,rgba(229,72,77,0.12))] text-primary"
                : "text-secondary";
          return (
            <div key={i} className={`whitespace-pre px-2 py-px ${cls}`}>
              <span className="select-none opacity-60">{sign} </span>
              {d.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// A clickable model name used in the AiDebugDialog title. Clicking opens a
// small floating list of the available models; scrolling or arrow keys cycle
// the highlighted entry, Enter or click confirms the selection (persisted via
// llm:setConfig so future prompts use it), Escape closes without changing.
export function ModelPicker({
  modelName,
  models,
  onConfirm,
}: {
  modelName: string | null;
  models: LlmModel[];
  onConfirm: (model: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [highlight, setHighlight] = React.useState<number>(-1);
  const wrapRef = React.useRef<HTMLSpanElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  // Index of the currently-selected model in the list, so we can start the
  // highlight there when the picker opens.
  const selectedIndex = React.useMemo(() => {
    if (!modelName || models.length === 0) return -1;
    return Math.max(0, models.findIndex((m) => m.id === modelName));
  }, [modelName, models]);

  const cycle = React.useCallback(
    (dir: 1 | -1) => {
      if (models.length === 0) return;
      setHighlight((h) => {
        const base = h < 0 ? selectedIndex : h;
        const next = (base + dir + models.length) % models.length;
        return next < 0 ? next + models.length : next;
      });
    },
    [models.length, selectedIndex],
  );

  // When the list opens, seed the highlight at the current selection and
    // scroll it into view.
  React.useEffect(() => {
    if (!open) return;
    setHighlight(selectedIndex < 0 ? 0 : selectedIndex);
    // Defer the scroll until the list is painted.
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selectedIndex < 0 ? 0 : selectedIndex}"]`);
      el?.scrollIntoView({ block: "nearest" });
    });
  }, [open, selectedIndex]);

  // Close on outside click.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the highlighted item scrolled into view as the user cycles.
  React.useEffect(() => {
    if (!open || highlight < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

  const confirm = (idx: number) => {
    const m = models[idx];
    if (!m) return;
    onConfirm(m.id);
    setOpen(false);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (models.length === 0) return;
    // Prevent the page from scrolling while cycling models in the list.
    e.preventDefault();
    cycle(e.deltaY > 0 ? 1 : -1);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      cycle(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cycle(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      confirm(highlight < 0 ? selectedIndex : highlight);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  const label = modelName ?? "AI";
  const disabled = models.length === 0;

  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        className="inline-flex items-center gap-1 rounded-sm px-0.5 text-left align-baseline outline-none transition-colors hover:text-accent focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-60 disabled:hover:text-primary"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={disabled ? "No models available" : "Change model"}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-60" />
      </button>
      {open && !disabled ? (
        <div
          ref={listRef}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
          role="listbox"
          tabIndex={-1}
          className="absolute left-0 top-full z-50 mt-1 max-h-64 w-72 overflow-auto rounded-md border border-separator bg-popover p-1 shadow-lg"
        >
          {models.map((m, i) => (
            <button
              key={m.id}
              type="button"
              data-idx={i}
              onClick={() => confirm(i)}
              onMouseEnter={() => setHighlight(i)}
              className={`flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-small ${
                i === highlight ? "bg-accent text-on-accent" : "text-primary"
              }`}
            >
              <Check
                className={`size-3.5 shrink-0 ${m.id === modelName ? "opacity-100" : "opacity-0"}`}
              />
              <span className="truncate">{m.label || m.id}</span>
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}


// ── Per-session UI drafts ────────────────────────────────────────────
// A minimized dialog is UNMOUNTED (only the expanded one is rendered), so any
// half-written context box or in-progress thread would be lost on minimize —
// the one thing a "come back later" feature must not do. These live outside
// React, keyed by session, and are dropped when the session is discarded.

interface SessionDraft {
  /** The session this draft belongs to. A key can be reused — discard a
   *  session and debug the same run again — and inheriting the old draft would
   *  drop the new session straight past its review phase into a stale thread. */
  startedAt: number;
  reviewing: boolean;
  additionalContext: string;
  followUp: string;
  applied: boolean;
}

const drafts = new Map<string, SessionDraft>();
/** Which needs a session has already supplied, and how many times. A model that
 *  keeps asking would otherwise loop the user through the same approval — and
 *  each fulfilment is another copy of the data in the conversation. */
const fulfilments = new Map<
  string,
  { startedAt: number; sent: Set<string>; count: number; declined: Set<string> }
>();
/** Hard stop on fulfilments per session. */
export const MAX_LOG_FULFILMENTS = 3;

/** Keyed by session AND its start time. A discarded session's key can be
 *  reused by a new debug of the same run, and inheriting "already sent" would
 *  leave the new session showing a fulfilment that never happened — and quietly
 *  spending its cap. */
function fulfilmentState(key: string, startedAt: number) {
  const existing = fulfilments.get(key);
  if (existing && existing.startedAt === startedAt) return existing;
  const state = { startedAt, sent: new Set<string>(), count: 0, declined: new Set<string>() };
  fulfilments.set(key, state);
  return state;
}
/** Conversation history per session, so a follow-up after a minimize still
 *  carries the original prompt rather than starting a fresh thread. */
const threads = new Map<string, LlmMessage[]>();

function draftFor(key: string, startedAt: number, status: AiDebugStatus): SessionDraft {
  const existing = drafts.get(key);
  if (existing && existing.startedAt === startedAt) return existing;
  return {
    startedAt,
    // A session that has never been sent opens in the review phase; one with an
    // answer already in it opens on the answer. Reopening a finished diagnosis
    // into an empty prompt form would look like the work had been lost.
    reviewing: status === "idle",
    additionalContext: "",
    followUp: "",
    applied: false,
  };
}

export function forgetDraft(key: string): void {
  drafts.delete(key);
  threads.delete(key);
  fulfilments.delete(key);
}

/** Fetch the configured model, and the model list for its provider. Shared by
 *  both dialogs — each needs the name for the title and the list for the picker. */
function useModelPicker(open: boolean) {
  const [modelName, setModelName] = React.useState<string | null>(null);
  const [models, setModels] = React.useState<LlmModel[]>([]);

  // Restoring a minimized dialog re-runs this. Listing models is a request to
  // the provider, so refetching every time put a GET /v1/models on the wire on
  // each restore — noise that shows up in the server's log right next to an
  // in-flight completion and reads like the reopen is doing something to it.
  // The list only changes when the user changes providers or loads a model, so
  // fetch it once and refresh only when the provider actually differs.
  const loadedProviderRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.llm
      .getConfig()
      .then(async (cfg) => {
        if (cancelled) return;
        setModelName(cfg.model);
        if (loadedProviderRef.current === cfg.provider) return;
        try {
          const st = await api.llm.status(cfg.provider);
          if (cancelled) return;
          loadedProviderRef.current = cfg.provider;
          setModels(st.models);
        } catch {
          if (!cancelled) setModels([]);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModelName(null);
          setModels([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const confirmModel = React.useCallback(async (model: string) => {
    setModelName(model);
    try {
      await api.llm.setConfig({ model });
    } catch {
      // best-effort; the local state already reflects the user's pick
    }
  }, []);

  /** Re-poll right before sending so "Thinking with {model}" names the model the
   *  backend will actually use, even if the default changed since open. */
  const currentModel = React.useCallback(async () => {
    try {
      const cfg = await api.llm.getConfig();
      setModelName(cfg.model);
      return cfg.model ?? undefined;
    } catch {
      return modelName ?? undefined;
    }
  }, [modelName]);

  return { modelName, models, confirmModel, currentModel };
}

/** Title node: "Debugging with <model picker>", falling back to plain text. */
function dialogTitle(
  prefix: string,
  modelName: string | null,
  models: LlmModel[],
  onConfirm: (m: string) => void,
) {
  if (models.length > 0) {
    return (
      <span className="inline-flex items-baseline gap-1">
        {prefix} <ModelPicker modelName={modelName} models={models} onConfirm={onConfirm} />
      </span>
    );
  }
  return modelName ? `${prefix} ${modelName}` : `${prefix} AI`;
}

/** Minimize / discard, shown on both dialogs. Minimize is the DEFAULT dismissal
 *  (Esc and the close button route here too) — discarding a running job by
 *  accident is the expensive mistake, so it takes its own explicit click. */
function SessionControls({ sessionKey }: { sessionKey: string }) {
  const { minimize, discard } = useAiDebug();
  return (
    <>
      <Button
        iconOnly
        size="small"
        variant="muted"
        onClick={minimize}
        aria-label="Minimize"
        title="Minimize — the job keeps running"
      >
        <Minimize2 className="size-3.5" />
      </Button>
      <Button
        iconOnly
        size="small"
        variant="transparent"
        onClick={() => discard(sessionKey)}
        aria-label="Discard session"
        title="Discard — stops the job and forgets it"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </>
  );
}

/** The model asked for the run's recorded console/network.
 *
 *  Nothing is sent by clicking "Ask" — that only FETCHES and shows the payload.
 *  Sending is a second, explicit click on a payload the user has seen in full.
 *  The data is page-controlled text and request URLs, and with a hosted
 *  provider selected it leaves the machine, so "the model asked for it" is not
 *  on its own a reason to hand it over. */
function LogRequestCard({
  request,
  payload,
  fulfilled,
  logsMissing,
  onFetch,
  onSend,
  onDecline,
}: {
  request: LogRequest;
  payload: LogPayload | null;
  fulfilled: boolean;
  logsMissing: boolean;
  onFetch: () => void;
  onSend: () => void;
  onDecline: () => void;
}) {
  const [showPayload, setShowPayload] = React.useState(false);

  if (fulfilled) {
    return (
      <Callout color="green" icon={<Check className="size-4" />}>
        <Callout.Text>Sent {describeNeed(request.need)} to the model.</Callout.Text>
      </Callout>
    );
  }

  // Recording is off by default, so this is the common first-time case and it
  // needs to say what to DO — reporting "no logs" would read as "the page was
  // silent", which is a different and misleading thing.
  if (logsMissing) {
    return (
      <Callout color="yellow" icon={<TriangleAlert className="size-4" />}>
        <Callout.Text>
          The model asked for {describeNeed(request.need)}, but this run didn&apos;t record it. Turn
          on &ldquo;Record console &amp; network&rdquo; in the toolbar and run the test again to
          give the model this data.
        </Callout.Text>
      </Callout>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-separator bg-control-subtle p-3">
      <div className="flex items-start gap-2">
        <FileSearch className="mt-0.5 size-4 shrink-0 text-accent" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <Text variant="small-strong">The model asked for {describeNeed(request.need)}</Text>
          {request.why ? (
            <Text variant="small" color="secondary">
              “{request.why}”
            </Text>
          ) : null}
        </div>
      </div>

      {payload ? (
        <>
          <Text variant="small" color="secondary">
            {payload.consoleCount} console {payload.consoleCount === 1 ? "entry" : "entries"} (
            {payload.consoleErrors} errors/warnings) · {payload.networkCount}{" "}
            {payload.networkCount === 1 ? "request" : "requests"} ({payload.networkFailures} failed)
            · about {payload.approxTokens.toLocaleString()} tokens
            {payload.omitted > 0 ? ` · ${payload.omitted} not included` : ""}
          </Text>
          <button
            type="button"
            onClick={() => setShowPayload((v) => !v)}
            className="self-start text-small text-accent hover:underline"
          >
            {showPayload ? "Hide" : "Review"} exactly what will be sent
          </button>
          {showPayload ? (
            <ScrollArea className="max-h-56 rounded-md border border-separator" viewportClassName="max-h-56">
              <pre className="text-small-mono whitespace-pre-wrap break-words p-2 text-primary">
                {payload.text}
              </pre>
            </ScrollArea>
          ) : null}
        </>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button size="small" variant="muted" onClick={onDecline}>
          Decline
        </Button>
        {payload ? (
          <Button size="small" variant="accent" onClick={onSend}>
            <Send className="size-3.5" /> Send this data
          </Button>
        ) : (
          <Button size="small" variant="glass" onClick={onFetch}>
            Show me what it would send
          </Button>
        )}
      </div>
    </div>
  );
}

/** Explains a refused send. The cap exists because local providers serialize
 *  requests, so a third stream would sit "thinking" without progressing. */
function CapacityNotice({
  decision,
  onStopOldest,
}: {
  decision: Extract<StartDecision, { ok: false }>;
  onStopOldest: () => void;
}) {
  return (
    <Callout color="yellow" icon={<TriangleAlert className="size-4" />}>
      <Callout.Text>
        {MAX_ACTIVE_STREAMS} AI jobs are already running. They finish one at a time, so this one
        would just wait.
      </Callout.Text>
      {decision.oldestStreamingKey ? (
        <Button size="small" variant="muted" onClick={onStopOldest}>
          Stop the oldest and send
        </Button>
      ) : null}
    </Callout>
  );
}

// ── Full-run debug dialog ────────────────────────────────────────────

export function AiDebugDialog({ sessionKey }: { sessionKey: string }) {
  const store = useAiDebug();
  const { content, reasoning } = useAiDebugContent(sessionKey);
  const session = store.sessions.find((s) => s.key === sessionKey) ?? null;
  const ctx = store.getContext(sessionKey);
  const runCtx = ctx?.kind === "run" ? ctx : null;
  const open = store.expandedKey === sessionKey;

  const [draft, setDraftState] = React.useState<SessionDraft>(() =>
    draftFor(sessionKey, session?.startedAt ?? 0, session?.status ?? "idle"),
  );
  const setDraft = React.useCallback(
    (patch: Partial<SessionDraft>) => {
      setDraftState((prev) => {
        const next = { ...prev, ...patch };
        drafts.set(sessionKey, next);
        return next;
      });
    },
    [sessionKey],
  );

  const [copied, setCopied] = React.useState(false);
  const [refused, setRefused] = React.useState<Extract<StartDecision, { ok: false }> | null>(null);
  // A pending request from the model, and the payload once the user asks to see
  // it. Payload stays null until then — fetching is itself a decision.
  const [logPayload, setLogPayload] = React.useState<LogPayload | null>(null);
  const [logsMissing, setLogsMissing] = React.useState(false);
  const { modelName, models, confirmModel, currentModel } = useModelPicker(open);
  const disabledEnhancements = useDisabledEnhancements();
  const thinkingGifEnabled = !disabledEnhancements.has("aiThinkingGif");

  const status = session?.status ?? "idle";
  // Read-only: restored from disk with no live run behind it. The answer is
  // still worth reading; pretending it can be re-sent is not.
  const readOnly = !runCtx || Boolean(session?.readOnly);
  const reviewing = draft.reviewing && !readOnly;

  const promptMessages = React.useMemo(
    () =>
      runCtx
        ? buildDebugMessages({
            testName: runCtx.testName,
            testUrl: runCtx.testUrl,
            script: runCtx.script,
            output: runCtx.output,
            imported: runCtx.imported,
            speed: runCtx.speed,
            failedStepIndex: runCtx.failedStepIndex,
          })
        : [],
    [runCtx],
  );

  const send = React.useCallback(
    async (stopOldest?: boolean) => {
      if (!runCtx) return;
      if (stopOldest) {
        const decision = store.capacityFor(sessionKey);
        if (!decision.ok && decision.oldestStreamingKey) store.stopStream(decision.oldestStreamingKey);
      }
      const model = await currentModel();
      const trimmed = draft.additionalContext.trim();
      const messages =
        trimmed.length > 0
          ? promptMessages.map((m, i) =>
              m.role === "user" && i === promptMessages.length - 1
                ? { ...m, content: `${m.content}\n\nAdditional context from the user:\n${trimmed}` }
                : m,
            )
          : promptMessages;
      threads.set(sessionKey, messages);
      const decision = await store.startStream(sessionKey, messages, {
        model,
        scriptHash: hashScript(runCtx.script),
      });
      if (!decision.ok) {
        setRefused(decision);
        return;
      }
      setRefused(null);
      setDraft({ reviewing: false, followUp: "", applied: false });
    },
    [runCtx, store, sessionKey, currentModel, draft.additionalContext, promptMessages, setDraft],
  );

  const sendFollowUp = React.useCallback(async () => {
    const trimmed = draft.followUp.trim();
    const thread = threads.get(sessionKey);
    if (!trimmed || !thread || !content) return;
    const model = await currentModel();
    const messages: LlmMessage[] = [
      ...thread,
      { role: "assistant", content },
      { role: "user", content: trimmed },
    ];
    threads.set(sessionKey, messages);
    const decision = await store.startStream(sessionKey, messages, { model });
    if (!decision.ok) {
      setRefused(decision);
      return;
    }
    setRefused(null);
    setDraft({ followUp: "" });
  }, [draft.followUp, sessionKey, content, currentModel, store, setDraft]);

  const copyResponse = async () => {
    await window.glazeAPI.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // A full, applyable corrected spec is only offered once streaming finishes.
  const correctedScript = status === "done" ? extractCorrectedScript(content) : null;
  const liveScript = runCtx?.script ?? null;
  const diff = React.useMemo<DiffLine[] | null>(() => {
    if (!correctedScript || liveScript === null) return null;
    // Always diff against the CURRENT script, not the one the prompt was built
    // from — that's what an approval actually overwrites.
    return diffLines(liveScript, correctedScript);
  }, [liveScript, correctedScript]);
  const summary = diff ? diffSummary(diff) : null;
  // The script changed after this diagnosis was requested, so the model never
  // saw the edits that applying would overwrite.
  const stale = session ? isStale(session, liveScript) : false;

  const applyScript = async () => {
    if (!correctedScript || !runCtx?.onApplyScript) return;
    try {
      await runCtx.onApplyScript(correctedScript);
      setDraft({ applied: true });
      toast.success("Applied the suggested fix to the script.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to apply the suggested fix.");
    }
  };

  // A request is only honoured once streaming has FINISHED — a fenced block is
  // not complete until its closing fence has arrived, and offering to send data
  // on a half-streamed block would be acting on a sentence the model hasn't
  // finished writing.
  const logRequest = React.useMemo<LogRequest | null>(
    () => (status === "done" ? parseLogRequest(content) : null),
    [status, content],
  );
  const fulfil = logRequest ? fulfilmentState(sessionKey, session?.startedAt ?? 0) : null;
  const needKey = logRequest ? logRequest.need.join("+") : "";
  const alreadySent = Boolean(fulfil && fulfil.sent.has(needKey));
  const declined = Boolean(fulfil && fulfil.declined.has(needKey));
  const atFulfilmentCap = Boolean(fulfil && fulfil.count >= MAX_LOG_FULFILMENTS);
  const showLogRequest = Boolean(logRequest) && !declined && !atFulfilmentCap;
  // Known up front when the run recorded nothing: make the user click "show me"
  // only to be told there is nothing to show would be a pointless round trip.
  const noLogsRecorded = logsMissing || runCtx?.logsAvailable === false || !runCtx?.recordId;

  const fetchLogPayload = React.useCallback(async () => {
    if (!logRequest || !runCtx?.recordId || !session) return;
    try {
      const logs = await api.artifacts.getLogs(session.testId, runCtx.recordId);
      if (!logs) {
        setLogsMissing(true);
        return;
      }
      setLogsMissing(false);
      setLogPayload(buildLogPayload(logs, logRequest.need));
    } catch {
      setLogsMissing(true);
    }
  }, [logRequest, runCtx?.recordId, session]);

  const sendLogPayload = React.useCallback(async () => {
    if (!logPayload || !logRequest) return;
    const thread = threads.get(sessionKey);
    if (!thread || !content) return;
    const state = fulfilmentState(sessionKey, session?.startedAt ?? 0);
    const model = await currentModel();
    const messages: LlmMessage[] = [
      ...thread,
      { role: "assistant", content },
      { role: "user", content: logPayload.text },
    ];
    threads.set(sessionKey, messages);
    const decision = await store.startStream(sessionKey, messages, { model });
    if (!decision.ok) {
      setRefused(decision);
      return;
    }
    state.sent.add(needKey);
    state.count += 1;
    setRefused(null);
    setLogPayload(null);
  }, [logPayload, logRequest, sessionKey, content, currentModel, store, needKey, session?.startedAt]);

  const declineLogRequest = React.useCallback(() => {
    fulfilmentState(sessionKey, session?.startedAt ?? 0).declined.add(needKey);
    setLogPayload(null);
    // Re-render: the Sets above are outside React state on purpose (they must
    // survive minimize), so nudge the draft to reflect the decision.
    setDraft({});
  }, [sessionKey, needKey, setDraft, session?.startedAt]);

  // Prose only — the machine-readable request block is rendered as the card
  // below, not as text the user has to read past.
  const segments = parseResponse(logRequest ? stripLogRequest(content) : content);

  return (
    <Dialog
      open={open}
      // Dismissing (Esc, close button, outside click) MINIMIZES. Losing a
      // running job to a stray Escape is the failure this feature exists to
      // avoid; discarding is a separate, explicit button.
      onOpenChange={(next) => {
        if (!next) store.minimize();
      }}
      title={dialogTitle("Debugging with", modelName, models, confirmModel)}
      description={
        <span className="inline-flex items-center gap-2">
          {session?.testName ?? ""}
          {status === "streaming" ? (
            <Button
              iconOnly
              size="small"
              variant="muted"
              onClick={() => store.stopStream(sessionKey)}
              aria-label="Stop"
              title="Stop"
            >
              <Square className="size-3.5" />
            </Button>
          ) : null}
          {!reviewing && status !== "streaming" && !readOnly ? (
            <Button
              iconOnly
              size="small"
              variant="muted"
              onClick={() => setDraft({ reviewing: true })}
              aria-label="Regenerate"
              title="Regenerate"
            >
              <RotateCcw className="size-3.5" />
            </Button>
          ) : null}
          {!reviewing && correctedScript && runCtx?.onApplyScript ? (
            <Button size="small" variant="accent" disabled={draft.applied} onClick={applyScript}>
              <Wand2 className="size-3.5" /> {draft.applied ? "Applied" : "Apply"}
            </Button>
          ) : null}
          {!reviewing && content ? (
            <Button
              iconOnly
              size="small"
              variant="transparent"
              onClick={copyResponse}
              aria-label="Copy response"
              title="Copy response"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
          ) : null}
          <SessionControls sessionKey={sessionKey} />
        </span>
      }
      size="2xl"
    >
      <div className="relative flex min-h-[400px] max-h-[70vh] flex-col gap-3">
        <ThinkingGifOverlay status={status} enabled={thinkingGifEnabled} />
        <div className="relative z-10 flex flex-1 flex-col gap-3">
          {readOnly ? (
            <Callout color="yellow" icon={<TriangleAlert className="size-4" />}>
              <Callout.Text>
                Restored from a previous session — the run behind it is gone, so this diagnosis is
                read-only. Run the test again to ask for a fresh one.
              </Callout.Text>
            </Callout>
          ) : null}
          {refused ? (
            <CapacityNotice decision={refused} onStopOldest={() => void send(true)} />
          ) : null}
          {reviewing ? (
            // Review phase: show the full prompt that will be sent and let the
            // user add context. Nothing is sent until they click "Send to AI".
            <>
              <Text variant="small" color="secondary">
                Review the prompt that will be sent to the model, then add any context you want and
                confirm to send. Nothing is sent until you confirm.
              </Text>
              <div className="flex flex-wrap items-center gap-1.5">
                {QUICK_CONTEXT_REASONS.map((reason) => {
                  const active = isReasonActive(draft.additionalContext, reason);
                  return (
                    <Button
                      key={reason}
                      size="small"
                      variant={active ? "muted" : "transparent"}
                      radius="full"
                      className="h-6 px-2 text-small"
                      onClick={() =>
                        setDraft({ additionalContext: toggleReason(draft.additionalContext, reason) })
                      }
                    >
                      {reason}
                    </Button>
                  );
                })}
              </div>
              <Field label="Anything else you want to include? (Optional)" orientation="vertical">
                <Textarea
                  size="medium"
                  placeholder={
                    "Add anything the model should know — e.g. the site changed recently, this selector is flaky, or you suspect a timing issue."
                  }
                  value={draft.additionalContext}
                  onChange={(e) => setDraft({ additionalContext: e.target.value })}
                />
              </Field>
              <div className="flex items-center justify-end gap-2">
                <Button size="small" variant="muted" onClick={store.minimize}>
                  Cancel
                </Button>
                <Button size="small" variant="accent" onClick={() => void send()}>
                  <Send className="size-3.5" /> Send to AI
                </Button>
              </div>
              <ScrollArea
                className="max-h-[56vh] flex-1 min-h-0 rounded-md border border-separator"
                viewportClassName="max-h-[56vh]"
              >
                <div className="flex flex-col gap-3 p-3">
                  {promptMessages.map((m, i) => (
                    <div key={i} className="flex flex-col gap-1">
                      <Text variant="small-strong" color="secondary">
                        {m.role === "system" ? "System prompt" : m.role === "user" ? "User prompt" : "Assistant"}
                      </Text>
                      <pre className="text-small-mono overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-control-subtle p-2 text-primary">
                        {m.content}
                      </pre>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </>
          ) : (
            <>
              {status === "done" && content && !readOnly ? (
                <div className="flex items-end gap-2">
                  <Textarea
                    size="medium"
                    className="flex-1 min-h-0 resize-none"
                    placeholder="The model asked for more info — add details here and send a follow-up."
                    value={draft.followUp}
                    onChange={(e) => setDraft({ followUp: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void sendFollowUp();
                      }
                    }}
                  />
                  <Button
                    size="small"
                    variant="accent"
                    disabled={!draft.followUp.trim() || status !== "done"}
                    onClick={() => void sendFollowUp()}
                  >
                    <Send className="size-3.5" /> Send
                  </Button>
                </div>
              ) : null}
              <ScrollArea
                className="max-h-[56vh] rounded-md border border-separator"
                viewportClassName="max-h-[56vh]"
                autoScrollToBottom
                autoScrollDeps={[content.length, reasoning.length]}
              >
                <div className="flex flex-col gap-1 p-3">
                  {status === "error" && session?.error ? (
                    <pre className="text-small overflow-x-auto whitespace-pre-wrap break-words text-primary">
                      {friendlyError(session.error, session.errorKind)}
                    </pre>
                  ) : content ? (
                    segments.map((seg, i) =>
                      seg.type === "code" ? (
                        <CodeBlock key={i} lang={seg.lang} content={seg.content} />
                      ) : (
                        <p key={i} className="py-1 text-small whitespace-pre-wrap break-words text-primary">
                          {seg.content}
                        </p>
                      ),
                    )
                  ) : status === "streaming" ? (
                    <div className="flex flex-col gap-1">
                      <p className="text-small text-secondary">
                        {modelName ? `Thinking with ${modelName}…` : "Thinking…"}
                      </p>
                      {/* A reasoning model can spend a long time here with no
                          answer yet. Showing the thinking as it arrives is the
                          difference between "working" and "hung". */}
                      {reasoning ? (
                        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-separator pl-2 font-mono text-[11px] text-tertiary">
                          {reasoning}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
                  {showLogRequest && logRequest ? (
                    <div className="mt-2">
                      <LogRequestCard
                        request={logRequest}
                        payload={logPayload}
                        fulfilled={alreadySent}
                        logsMissing={noLogsRecorded}
                        onFetch={() => void fetchLogPayload()}
                        onSend={() => void sendLogPayload()}
                        onDecline={declineLogRequest}
                      />
                    </div>
                  ) : null}
                  {correctedScript && diff ? (
                    <div className="mt-2 flex flex-col gap-1.5">
                      {stale ? (
                        <Callout color="yellow" icon={<TriangleAlert className="size-4" />}>
                          <Callout.Text>
                            The script changed after this diagnosis was requested. The diff below is
                            against the current script, but the model never saw those edits —
                            review it before applying.
                          </Callout.Text>
                        </Callout>
                      ) : null}
                      <Text variant="small-strong" color="secondary">
                        Suggested changes
                        {summary ? ` (+${summary.added} / -${summary.removed} lines)` : ""}
                      </Text>
                      <DiffView diff={diff} />
                    </div>
                  ) : null}
                </div>
              </ScrollArea>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ── Per-step replay debugging (trainer Console) ───────────────────────
// A leaner sibling of AiDebugDialog for diagnosing a SINGLE failed trainer
// step. Same streaming + rendering machinery, but no "Apply to script" (these
// are editable steps, not a script file) — just a diagnosis and an optional
// corrected-expression snippet the user can copy.

export function StepAiDebugDialog({ sessionKey }: { sessionKey: string }) {
  const store = useAiDebug();
  const { content } = useAiDebugContent(sessionKey);
  const session = store.sessions.find((s) => s.key === sessionKey) ?? null;
  const ctx = store.getContext(sessionKey);
  const stepCtx = ctx?.kind === "step" ? ctx : null;
  const open = store.expandedKey === sessionKey;

  const [copied, setCopied] = React.useState(false);
  const [refused, setRefused] = React.useState<Extract<StartDecision, { ok: false }> | null>(null);
  const { modelName, models, confirmModel, currentModel } = useModelPicker(open);
  const disabledEnhancements = useDisabledEnhancements();
  const thinkingGifEnabled = !disabledEnhancements.has("aiThinkingGif");
  const startedKeyRef = React.useRef<string | null>(null);

  const status = session?.status ?? "idle";
  const readOnly = !stepCtx || Boolean(session?.readOnly);

  const runDiagnosis = React.useCallback(
    async (stopOldest?: boolean) => {
      if (!stepCtx) return;
      if (stopOldest) {
        const decision = store.capacityFor(sessionKey);
        if (!decision.ok && decision.oldestStreamingKey) store.stopStream(decision.oldestStreamingKey);
      }
      const model = await currentModel();
      const decision = await store.startStream(
        sessionKey,
        buildStepDebugMessages({
          testName: stepCtx.testName,
          url: stepCtx.url,
          stepLabel: stepCtx.stepLabel,
          locator: stepCtx.locator,
          error: stepCtx.error,
          logs: stepCtx.logs,
        }),
        { model },
      );
      if (!decision.ok) setRefused(decision);
      else setRefused(null);
    },
    [stepCtx, store, sessionKey, currentModel],
  );

  // Auto-start once per unique failed step, but only for a session that has
  // never been sent — a restored or already-answered session must not re-send
  // itself (and re-bill) just because the user reopened it.
  React.useEffect(() => {
    if (!open || !stepCtx || readOnly) return;
    if (status !== "idle") return;
    const key = `${sessionKey}:${stepCtx.error.length}:${stepCtx.logs.length}`;
    if (startedKeyRef.current === key) return;
    startedKeyRef.current = key;
    void runDiagnosis();
  }, [open, stepCtx, readOnly, status, sessionKey, runDiagnosis]);

  const copyResponse = async () => {
    await window.glazeAPI.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const segments = parseResponse(content);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) store.minimize();
      }}
      title={dialogTitle("Debugging step with", modelName, models, confirmModel)}
      description={
        <span className="inline-flex items-center gap-2">
          {session?.label ?? "Step"}
          {status === "streaming" ? (
            <Button
              iconOnly
              size="small"
              variant="muted"
              onClick={() => store.stopStream(sessionKey)}
              aria-label="Stop"
              title="Stop"
            >
              <Square className="size-3.5" />
            </Button>
          ) : null}
          {status !== "streaming" && !readOnly ? (
            <Button
              iconOnly
              size="small"
              variant="muted"
              onClick={() => void runDiagnosis()}
              aria-label="Regenerate"
              title="Regenerate"
            >
              <RotateCcw className="size-3.5" />
            </Button>
          ) : null}
          {content ? (
            <Button
              iconOnly
              size="small"
              variant="transparent"
              onClick={copyResponse}
              aria-label="Copy response"
              title="Copy response"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
          ) : null}
          <SessionControls sessionKey={sessionKey} />
        </span>
      }
      size="2xl"
    >
      <div className="relative flex min-h-[400px] max-h-[70vh] flex-col gap-3">
        <ThinkingGifOverlay status={status} enabled={thinkingGifEnabled} />
        <div className="relative z-10 flex flex-1 flex-col gap-3">
          {readOnly ? (
            <Callout color="yellow" icon={<TriangleAlert className="size-4" />}>
              <Callout.Text>
                Restored from a previous trainer session — the step it describes is no longer live,
                so this diagnosis is read-only.
              </Callout.Text>
            </Callout>
          ) : null}
          {refused ? (
            <CapacityNotice decision={refused} onStopOldest={() => void runDiagnosis(true)} />
          ) : null}
          <ScrollArea
            className="max-h-[56vh] rounded-md border border-separator"
            viewportClassName="max-h-[56vh]"
            autoScrollToBottom
            autoScrollDeps={[content.length]}
          >
            <div className="flex flex-col gap-1 p-3">
              {status === "error" && session?.error ? (
                <pre className="text-small overflow-x-auto whitespace-pre-wrap break-words text-primary">
                  {friendlyError(session.error, session.errorKind)}
                </pre>
              ) : content ? (
                segments.map((seg, i) =>
                  seg.type === "code" ? (
                    <CodeBlock key={i} lang={seg.lang} content={seg.content} />
                  ) : (
                    <p key={i} className="py-1 text-small whitespace-pre-wrap break-words text-primary">
                      {seg.content}
                    </p>
                  ),
                )
              ) : (
                <p className="text-small text-secondary">
                  {status === "streaming" ? (modelName ? `Thinking with ${modelName}…` : "Thinking…") : ""}
                </p>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>
    </Dialog>
  );
}

// ── Host ─────────────────────────────────────────────────────────────
// Renders whichever session is expanded. Mounted ONCE, above the router, so a
// minimized job can be restored from anywhere — including from a view that
// isn't the one that started it, and while the trainer has replaced the outlet.

export function AiDebugHost() {
  const { sessions, expandedKey } = useAiDebug();

  // Drop the UI draft of any session that no longer exists, so a discarded
  // session's half-written context box can't reappear under a recycled key.
  const knownRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    const live = new Set(sessions.map((s) => s.key));
    for (const key of knownRef.current) {
      if (!live.has(key)) forgetDraft(key);
    }
    knownRef.current = live;
  }, [sessions]);

  if (!expandedKey) return null;
  const session = sessions.find((s) => s.key === expandedKey);
  if (!session) return null;
  // Keyed by startedAt as well as the session key so a session discarded and
  // re-created under the same key gets a genuinely fresh dialog rather than one
  // still holding the previous session's local state.
  return session.kind === "step" ? (
    <StepAiDebugDialog key={`${session.key}:${session.startedAt}`} sessionKey={expandedKey} />
  ) : (
    <AiDebugDialog key={`${session.key}:${session.startedAt}`} sessionKey={expandedKey} />
  );
}
