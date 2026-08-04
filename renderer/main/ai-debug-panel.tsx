// Streams an AI diagnosis of a failed test run (script + run output) via the
// local LLM chat API (main/services/llm-service.ts). Auto-starts when opened.
// Renders the response with code changes as distinct, copyable blocks, and — when
// the model returns a complete corrected spec — offers to apply it to the script.

import * as React from "react";
import { Button, Dialog, Field, ScrollArea, Status, Text, Textarea, toast } from "@glaze/core/components";
import { Check, ChevronDown, Copy, RotateCcw, Send, Square, Wand2 } from "lucide-react";

import glitchGif from "./assets/glitch.gif";

import { api } from "../lib/api";
import { diffLines, diffSummary, type DiffLine } from "../lib/line-diff";
import type { LlmModel } from "../lib/llm-types";
import { buildDebugMessages, buildStepDebugMessages } from "../lib/llm-prompts";
import { extractCorrectedScript, parseResponse } from "../lib/parse-llm-response";
import type { TestSpeed } from "../lib/recorder-types";
import { useDisabledEnhancements } from "../lib/use-disabled-enhancements";
import { useLlmChat } from "../lib/use-llm-chat";

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
  status: "idle" | "streaming" | "done" | "error" | "cancelled";
  enabled: boolean;
}) {
  // `expanding` while streaming; `contracting` for the 5s ease-out after the
  // response arrives; `hidden` once the scale-out completes.
  const [phase, setPhase] = React.useState<"hidden" | "expanding" | "contracting">("hidden");
  // Tracks whether the scaleX target has been applied yet so the CSS transition
  // actually animates from 0 → 1 (without this, React renders scaleX(1) on the
  // first frame and there's nothing to transition from).
  const [scaledIn, setScaledIn] = React.useState(false);
  const phaseRef = React.useRef(phase);
  phaseRef.current = phase;

  React.useEffect(() => {
    if (!enabled) {
      setPhase("hidden");
      setScaledIn(false);
      return;
    }
    if (status === "streaming") {
      setPhase("expanding");
      // Start at scaleX(0), then on the next frame flip to scaleX(1) so the
      // 5s ease-in transition runs.
      setScaledIn(false);
      const raf = requestAnimationFrame(() => {
        requestAnimationFrame(() => setScaledIn(true));
      });
      return () => cancelAnimationFrame(raf);
    }
    // Response received (done/error/cancelled) — start the 0.5s ease-out.
    if (phaseRef.current === "expanding") {
      setPhase("contracting");
      setScaledIn(false);
      const t = setTimeout(() => setPhase("hidden"), 500);
      return () => clearTimeout(t);
    }
  }, [status, enabled]);

  if (!enabled || phase === "hidden") return null;

  const targetScale = phase === "expanding" ? (scaledIn ? 1 : 0) : 0;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-md"
      style={{ backgroundColor: "#000000" }}
    >
      <div className="flex h-full w-full items-center justify-center">
        <img
          src={glitchGif}
          alt=""
          className="h-full w-full max-w-none object-contain"
          style={{
            transform: `scaleX(${targetScale})`,
            transformOrigin: "center",
            transition: `transform ${phase === "contracting" ? "0.5s" : "5s"} ease-in-out`,
          }}
        />
      </div>
    </div>
  );
}

export function friendlyError(message: string): string {
  if (/no model selected/i.test(message)) {
    return `${message} Open Settings (⌘,) → AI provider to pick one.`;
  }
  if (/could not reach|abort|timeout|econnrefused|fetch failed|network/i.test(message)) {
    return `${message} Open Settings (⌘,) → AI provider to check the connection.`;
  }
  return message;
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

export function AiDebugDialog({
  open,
  onOpenChange,
  testName,
  testUrl,
  script,
  output,
  imported,
  speed,
  failedStepIndex,
  onApplyScript,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testName: string;
  testUrl: string;
  script: string;
  output: string;
  imported: boolean;
  speed?: TestSpeed;
  /** 0-based index of the step the run failed on, if known — lets the debug prompt skip steps that never ran. */
  failedStepIndex?: number;
  /** Persist an AI-suggested full-file replacement of the test's script. */
  onApplyScript?: (source: string) => Promise<void>;
}) {
  const { content, status, error, start, stop } = useLlmChat();
  const [copied, setCopied] = React.useState(false);
  const [applied, setApplied] = React.useState(false);
  const [modelName, setModelName] = React.useState<string | null>(null);
  const [models, setModels] = React.useState<LlmModel[]>([]);
  const startedKeyRef = React.useRef<string | null>(null);
  const disabledEnhancements = useDisabledEnhancements();
  const thinkingGifEnabled = !disabledEnhancements.has("aiThinkingGif");
  // Whether the dialog is showing the prompt-review phase (true) or the
  // streamed-response phase (false). Starts in review so the user must
  // explicitly confirm before any request is sent; "Regenerate" returns to
  // review so the user can adjust context before re-sending.
  const [reviewing, setReviewing] = React.useState(true);

  // Fetch the configured LLM model name for the dialog title and the model
  // picker, then load the available models for that provider so the picker can
  // cycle through them.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.llm
      .getConfig()
      .then(async (cfg) => {
        if (cancelled) return;
        setModelName(cfg.model);
        try {
          const st = await api.llm.status(cfg.provider);
          if (!cancelled) setModels(st.models);
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

  // Persist a model selection from the title picker as the default so future
  // prompts (this dialog's Regenerate, and other AI features) use it.
  const confirmModel = React.useCallback(async (model: string) => {
    setModelName(model);
    try {
      await api.llm.setConfig({ model });
    } catch {
      // best-effort; the local state already reflects the user's pick
    }
  }, []);

  // The full prompt that will be sent to the model, memoized so it stays
  // stable across re-renders while the dialog is open. Shown to the user in
  // the review phase so they can see exactly what the system is sending.
  const promptMessages = React.useMemo(
    () => buildDebugMessages({ testName, testUrl, script, output, imported, speed, failedStepIndex }),
    [testName, testUrl, script, output, imported, speed, failedStepIndex],
  );

  // Optional extra context the user can add before sending. Appended to the
  // user message so the model sees it as part of the same diagnostic request.
  const [additionalContext, setAdditionalContext] = React.useState("");

  // Poll the live configured model right before sending so the "Thinking with
  // {model}" placeholder reflects the model the backend will actually use,
  // even if the default changed (in Settings or another dialog) after this
  // dialog opened. Falls back to the cached `modelName` if the poll fails.
  // The user must explicitly confirm by clicking "Send to AI" — the dialog
  // never sends a request automatically.
  const sendDiagnosis = React.useCallback(async () => {
    let model = modelName ?? undefined;
    try {
      const cfg = await api.llm.getConfig();
      setModelName(cfg.model);
      model = cfg.model ?? undefined;
    } catch {
      // keep the cached name; the backend will fall back to its own config
    }
    const trimmed = additionalContext.trim();
    const messages =
      trimmed.length > 0
        ? promptMessages.map((m, i) =>
            m.role === "user" && i === promptMessages.length - 1
              ? { ...m, content: `${m.content}\n\nAdditional context from the user:\n${trimmed}` }
              : m,
          )
        : promptMessages;
    setReviewing(false);
    void start(messages, { model });
  }, [start, modelName, additionalContext, promptMessages]);

  // Reset to the review phase (clear the additional-context box and any prior
  // streamed response) when the dialog opens for a different run. We do NOT
  // auto-send — the user must click "Send to AI".
  React.useEffect(() => {
    if (!open) return;
    const key = `${testName}:${output.length}`;
    if (startedKeyRef.current === key) return;
    startedKeyRef.current = key;
    setApplied(false);
    setAdditionalContext("");
    setReviewing(true);
  }, [open, testName, output.length]);

  const copyResponse = async () => {
    await window.glazeAPI.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // A full, applyable corrected spec is only offered once streaming finishes.
  const correctedScript = status === "done" ? extractCorrectedScript(content) : null;
  // Line-level diff between the current script and the AI's corrected spec,
  // shown in the apply confirm so the user can review the changes. Memoized so
  // we don't recompute the LCS on every render while the dialog is open.
  const diff = React.useMemo<DiffLine[] | null>(() => {
    if (!correctedScript) return null;
    return diffLines(script, correctedScript);
  }, [script, correctedScript]);
  const summary = diff ? diffSummary(diff) : null;

  const applyScript = async () => {
    if (!correctedScript || !onApplyScript) return;
    try {
      await onApplyScript(correctedScript);
      setApplied(true);
      toast.success("Applied the suggested fix to the script.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to apply the suggested fix.");
    }
  };

  const segments = parseResponse(content);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        models.length > 0 ? (
          <span className="inline-flex items-baseline gap-1">
            Debugging with{" "}
            <ModelPicker modelName={modelName} models={models} onConfirm={confirmModel} />
          </span>
        ) : (
          modelName ? `Debugging with ${modelName}` : "Debugging with AI"
        )
      }
      description={
        <span className="inline-flex items-center gap-2">
          {testName}
          {status === "streaming" ? (
            <Button size="small" variant="destructive" onClick={stop}>
              <Square className="size-3.5" /> Stop
            </Button>
          ) : null}
        </span>
      }
      size="xl"
    >
      <div className="relative flex max-h-[50vh] flex-col gap-3">
        <ThinkingGifOverlay status={status} enabled={thinkingGifEnabled} />
        <div className="relative z-10 flex flex-1 flex-col gap-3">
        {reviewing ? (
          // Review phase: show the full prompt that will be sent and let the
          // user add context. Nothing is sent until they click "Send to AI".
          <>
            <Text variant="small" color="secondary">
              Review the prompt that will be sent to the model, then add any context you want and confirm to send. Nothing is sent until you confirm.
            </Text>
            <ScrollArea
              className="max-h-[32vh] rounded-md border border-separator"
              viewportClassName="max-h-[32vh]"
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
            <Field
              label={
                <span className="flex w-full items-center justify-between gap-2">
                  <span>Anything else you want to include? (Optional)</span>
                  <span className="flex flex-wrap items-center justify-end gap-1.5">
                    {QUICK_CONTEXT_REASONS.map((reason) => {
                      const active = isReasonActive(additionalContext, reason);
                      return (
                        <Button
                          key={reason}
                          size="small"
                          variant={active ? "muted" : "transparent"}
                          radius="full"
                          className="h-6 px-2 text-small"
                          onClick={() => setAdditionalContext((prev) => toggleReason(prev, reason))}
                        >
                          {reason}
                        </Button>
                      );
                    })}
                  </span>
                </span>
              }
              orientation="vertical"
            >
              <Textarea
                size="medium"
                placeholder={"Add anything the model should know — e.g. the site changed recently, this selector is flaky, or you suspect a timing issue."}
                value={additionalContext}
                onChange={(e) => setAdditionalContext(e.target.value)}
              />
            </Field>
            <div className="flex items-center justify-end gap-2 pb-8">
              <Button size="small" variant="muted" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button size="small" variant="accent" onClick={sendDiagnosis}>
                <Send className="size-3.5" /> Send to AI
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              {status === "streaming" ? (
                <Status variant="loading">{modelName ? `Thinking with ${modelName}` : "Thinking"}</Status>
              ) : null}
              {status === "error" ? <Status variant="error">Error</Status> : null}
              {status === "done" ? <Status variant="success">Done</Status> : null}
              {status === "cancelled" ? <Status variant="neutral">Stopped</Status> : null}
              <Button size="small" variant="muted" onClick={() => setReviewing(true)}>
                <RotateCcw className="size-3.5" /> Regenerate
              </Button>
              {correctedScript && onApplyScript ? (
                <Button size="small" variant="accent" disabled={applied} onClick={applyScript}>
                  <Wand2 className="size-3.5" /> {applied ? "Applied" : "Apply"}
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
            </div>
            <ScrollArea
              className="max-h-[40vh] rounded-md border border-separator"
              viewportClassName="max-h-[40vh]"
              autoScrollToBottom
              autoScrollDeps={[content.length]}
            >
              <div className="flex flex-col gap-1 p-3">
                {status === "error" && error ? (
                  <pre className="text-small overflow-x-auto whitespace-pre-wrap break-words text-primary">{friendlyError(error)}</pre>
                ) : content ? (
                  segments.map((seg, i) =>
                    seg.type === "code" ? (
                      <CodeBlock key={i} lang={seg.lang} content={seg.content} />
                    ) : (
                      <p key={i} className="text-small whitespace-pre-wrap break-words text-primary">
                        {seg.content}
                      </p>
                    ),
                  )
                ) : status === "streaming" && thinkingGifEnabled ? (
                  <p className="text-small text-secondary">
                    {modelName ? `Thinking with ${modelName}…` : "Thinking…"}
                  </p>
                ) : (
                  <p className="text-small text-secondary">
                    {status === "streaming" ? (modelName ? `Thinking with ${modelName}…` : "Thinking…") : ""}
                  </p>
                )}
                {correctedScript && diff ? (
                  <div className="mt-2 flex flex-col gap-1.5">
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
// step from the Console tab. Same streaming + rendering machinery, but no
// "Apply to script" (these are editable steps, not a script file) — just a
// diagnosis and an optional corrected-expression snippet the user can copy.

export function StepAiDebugDialog({
  open,
  onOpenChange,
  testName,
  url,
  stepLabel,
  locator,
  error,
  logs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testName: string;
  url: string;
  stepLabel: string;
  locator?: string;
  error: string;
  logs: { level: "info" | "warn" | "error"; message: string }[];
}) {
  const { content, status, error: chatError, start, stop } = useLlmChat();
  const [copied, setCopied] = React.useState(false);
  const [modelName, setModelName] = React.useState<string | null>(null);
  const [models, setModels] = React.useState<LlmModel[]>([]);
  const startedKeyRef = React.useRef<string | null>(null);
  const disabledEnhancements = useDisabledEnhancements();
  const thinkingGifEnabled = !disabledEnhancements.has("aiThinkingGif");

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.llm
      .getConfig()
      .then(async (cfg) => {
        if (cancelled) return;
        setModelName(cfg.model);
        try {
          const st = await api.llm.status(cfg.provider);
          if (!cancelled) setModels(st.models);
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
      // best-effort
    }
  }, []);

  const runDiagnosis = React.useCallback(async () => {
    let model = modelName ?? undefined;
    try {
      const cfg = await api.llm.getConfig();
      setModelName(cfg.model);
      model = cfg.model ?? undefined;
    } catch {
      // keep the cached name
    }
    void start(
      buildStepDebugMessages({ testName, url, stepLabel, locator, error, logs }),
      { model },
    );
  }, [start, modelName, testName, url, stepLabel, locator, error, logs]);

  // Auto-start once per unique failed step while the dialog is open. Like
  // AiDebugDialog, we don't reset the key on close so reopening for the same
  // step shows the prior streamed response.
  React.useEffect(() => {
    if (!open) return;
    const key = `${stepLabel}:${error.length}:${logs.length}`;
    if (startedKeyRef.current === key) return;
    startedKeyRef.current = key;
    void runDiagnosis();
  }, [open, stepLabel, error.length, logs.length, runDiagnosis]);

  const copyResponse = async () => {
    await window.glazeAPI.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const segments = parseResponse(content);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        models.length > 0 ? (
          <span className="inline-flex items-baseline gap-1">
            Debugging step with{" "}
            <ModelPicker modelName={modelName} models={models} onConfirm={confirmModel} />
          </span>
        ) : (
          modelName ? `Debugging step with ${modelName}` : "Debugging step with AI"
        )
      }
      description={
        <span className="inline-flex items-center gap-2">
          {stepLabel}
          {status === "streaming" ? (
            <Button size="small" variant="destructive" onClick={stop}>
              <Square className="size-3.5" /> Stop
            </Button>
          ) : null}
        </span>
      }
      size="xl"
    >
      <div className="relative flex max-h-[50vh] flex-col gap-3">
        <ThinkingGifOverlay status={status} enabled={thinkingGifEnabled} />
        <div className="relative z-10 flex flex-1 flex-col gap-3">
        <div className="flex items-center gap-2">
          {status === "streaming" ? (
            <Status variant="loading">{modelName ? `Thinking with ${modelName}` : "Thinking"}</Status>
          ) : null}
          {status === "error" ? <Status variant="error">Error</Status> : null}
          {status === "done" ? <Status variant="success">Done</Status> : null}
          {status === "cancelled" ? <Status variant="neutral">Stopped</Status> : null}
          <Button size="small" variant="muted" onClick={runDiagnosis}>
            <RotateCcw className="size-3.5" /> Regenerate
          </Button>
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
        </div>
        <ScrollArea
          className="max-h-[42vh] rounded-md border border-separator"
          viewportClassName="max-h-[42vh]"
          autoScrollToBottom
          autoScrollDeps={[content.length]}
        >
          <div className="flex flex-col gap-1 p-3">
            {status === "error" && chatError ? (
              <pre className="text-small overflow-x-auto whitespace-pre-wrap break-words text-primary">{friendlyError(chatError)}</pre>
            ) : content ? (
              segments.map((seg, i) =>
                seg.type === "code" ? (
                  <CodeBlock key={i} lang={seg.lang} content={seg.content} />
                ) : (
                  <p key={i} className="text-small whitespace-pre-wrap break-words text-primary">
                    {seg.content}
                  </p>
                ),
              )
            ) : status === "streaming" && thinkingGifEnabled ? (
              <p className="text-small text-secondary">
                {modelName ? `Thinking with ${modelName}…` : "Thinking…"}
              </p>
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
