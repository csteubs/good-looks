// Streams an AI diagnosis of a failed test run (script + run output) via the
// local LLM chat API (main/services/llm-service.ts). Auto-starts when opened.
// Renders the response with code changes as distinct, copyable blocks, and — when
// the model returns a complete corrected spec — offers to apply it to the script.

import * as React from "react";
import { AlertDialog, Button, Dialog, ScrollArea, Status, toast } from "@glaze/core/components";
import { Check, ChevronDown, Copy, RotateCcw, Square, Wand2 } from "lucide-react";

import { api } from "../lib/api";
import { diffLines, diffSummary, type DiffLine } from "../lib/line-diff";
import type { LlmModel } from "../lib/llm-types";
import { buildDebugMessages } from "../lib/llm-prompts";
import { extractCorrectedScript, parseResponse } from "../lib/parse-llm-response";
import type { TestSpeed } from "../lib/recorder-types";
import { useLlmChat } from "../lib/use-llm-chat";

function friendlyError(message: string): string {
  if (/no model selected/i.test(message)) {
    return `${message} Open Settings (⌘,) → AI provider to pick one.`;
  }
  if (/could not reach|abort|timeout|econnrefused|fetch failed|network/i.test(message)) {
    return `${message} Open Settings (⌘,) → AI provider to check the connection.`;
  }
  return message;
}

// A fenced code block from the response, rendered distinctly with its own copy.
function CodeBlock({ lang, content }: { lang: string; content: string }) {
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
function ModelPicker({
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
  /** Persist an AI-suggested full-file replacement of the test's script. */
  onApplyScript?: (source: string) => Promise<void>;
}) {
  const { content, status, error, start, stop } = useLlmChat();
  const [copied, setCopied] = React.useState(false);
  const [applied, setApplied] = React.useState(false);
  const [modelName, setModelName] = React.useState<string | null>(null);
  const [models, setModels] = React.useState<LlmModel[]>([]);
  const startedKeyRef = React.useRef<string | null>(null);

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

  // Poll the live configured model right before sending so the "Thinking with
  // {model}" placeholder reflects the model the backend will actually use,
  // even if the default changed (in Settings or another dialog) after this
  // dialog opened. Falls back to the cached `modelName` if the poll fails.
  const runDiagnosis = React.useCallback(async () => {
    let model = modelName ?? undefined;
    try {
      const cfg = await api.llm.getConfig();
      setModelName(cfg.model);
      model = cfg.model ?? undefined;
    } catch {
      // keep the cached name; the backend will fall back to its own config
    }
    void start(
      buildDebugMessages({ testName, testUrl, script, output, imported, speed }),
      { model },
    );
  }, [start, modelName, testName, testUrl, script, output, imported, speed]);

  // Auto-start a diagnosis the first time we see a given run output while the
  // dialog is open. We deliberately do NOT reset `startedKeyRef` on close, so
  // reopening the dialog for the same run shows the previously streamed
  // response (the `useLlmChat` state survives because the dialog stays
  // mounted). A new run produces a different `output.length`, which re-fires.
  React.useEffect(() => {
    if (!open) return;
    const key = `${testName}:${output.length}`;
    if (startedKeyRef.current === key) return;
    startedKeyRef.current = key;
    setApplied(false);
    void runDiagnosis();
  }, [open, testName, output.length, runDiagnosis]);

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
      description={testName}
      size="xl"
    >
      <div className="flex h-[50vh] flex-col gap-3">
        <div className="flex items-center gap-2">
          {status === "streaming" ? (
            <Status variant="loading">{modelName ? `Thinking with ${modelName}` : "Thinking"}</Status>
          ) : null}
          {status === "error" ? <Status variant="error">Error</Status> : null}
          {status === "done" ? <Status variant="success">Done</Status> : null}
          {status === "cancelled" ? <Status variant="neutral">Stopped</Status> : null}
          {status === "streaming" ? (
            <Button size="small" variant="muted" onClick={stop}>
              <Square className="size-3.5" /> Stop
            </Button>
          ) : (
            <Button size="small" variant="muted" onClick={runDiagnosis}>
              <RotateCcw className="size-3.5" /> Regenerate
            </Button>
          )}
          {correctedScript && onApplyScript ? (
            <AlertDialog
              trigger={
                <Button size="small" variant="accent" disabled={applied}>
                  <Wand2 className="size-3.5" /> {applied ? "Applied" : "Apply to script"}
                </Button>
              }
              title="Apply the suggested fix?"
              description={
                summary
                  ? `This replaces the test's current script with the AI's corrected version (+${summary.added} / -${summary.removed} lines). The Steps tab will update to reflect the new script. You can still edit or re-record the script afterward.`
                  : "This replaces the test's current script with the AI's corrected version. The Steps tab will update to reflect the new script. You can still edit or re-record the script afterward."
              }
              confirmLabel="Apply"
              confirmVariant="accent"
              size="xl"
              onConfirm={applyScript}
            >
              {diff ? <DiffView diff={diff} /> : null}
            </AlertDialog>
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
          className="min-h-0 flex-1 rounded-md border border-separator"
          autoScrollToBottom
          autoScrollDeps={[content.length]}
        >
          <div className="flex flex-col gap-1 p-3">
            {status === "error" && error ? (
              <pre className="text-small whitespace-pre-wrap break-words text-primary">{friendlyError(error)}</pre>
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
            ) : (
              <p className="text-small text-secondary">
                {status === "streaming" ? (modelName ? `Thinking with ${modelName}…` : "Thinking…") : ""}
              </p>
            )}
          </div>
        </ScrollArea>
      </div>
    </Dialog>
  );
}
