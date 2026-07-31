// Streams an AI diagnosis of a failed test run (script + run output) via the
// local LLM chat API (main/services/llm-service.ts). Auto-starts when opened.
// Renders the response with code changes as distinct, copyable blocks, and — when
// the model returns a complete corrected spec — offers to apply it to the script.

import * as React from "react";
import { AlertDialog, Button, Dialog, ScrollArea, Status, toast } from "@glaze/core/components";
import { Check, Copy, RotateCcw, Square, Wand2 } from "lucide-react";

import { api } from "../lib/api";
import { diffLines, diffSummary, type DiffLine } from "../lib/line-diff";
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
  const startedKeyRef = React.useRef<string | null>(null);

  // Fetch the configured LLM model name for the dialog title.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.llm
      .getConfig()
      .then((cfg) => {
        if (!cancelled) setModelName(cfg.model);
      })
      .catch(() => {
        if (!cancelled) setModelName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const runDiagnosis = React.useCallback(
    () => start(buildDebugMessages({ testName, testUrl, script, output, imported, speed })),
    [start, testName, testUrl, script, output, imported, speed],
  );

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
      title={modelName ? `Debugging with ${modelName}` : "Debugging with AI"}
      description={testName}
      size="xl"
    >
      <div className="flex h-[50vh] flex-col gap-3">
        <div className="flex items-center gap-2">
          {status === "streaming" ? <Status variant="loading">Thinking</Status> : null}
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
              <p className="text-small text-secondary">{status === "streaming" ? "Thinking…" : ""}</p>
            )}
          </div>
        </ScrollArea>
      </div>
    </Dialog>
  );
}
