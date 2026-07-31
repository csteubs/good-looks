// Streams an AI diagnosis of a failed test run (script + run output) via the
// local LLM chat API (main/services/llm-service.ts). Auto-starts when opened.

import * as React from "react";
import { Button, Dialog, ScrollArea, Status } from "@glaze/core/components";
import { Check, Copy, RotateCcw, Square } from "lucide-react";

import { buildDebugMessages } from "../lib/llm-prompts";
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

export function AiDebugDialog({
  open,
  onOpenChange,
  testName,
  testUrl,
  script,
  output,
  imported,
  speed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testName: string;
  testUrl: string;
  script: string;
  output: string;
  imported: boolean;
  speed?: TestSpeed;
}) {
  const { content, status, error, start, stop } = useLlmChat();
  const [copied, setCopied] = React.useState(false);
  const startedKeyRef = React.useRef<string | null>(null);

  const runDiagnosis = React.useCallback(
    () => start(buildDebugMessages({ testName, testUrl, script, output, imported, speed })),
    [start, testName, testUrl, script, output, imported, speed],
  );

  React.useEffect(() => {
    if (!open) {
      startedKeyRef.current = null;
      return;
    }
    const key = `${testName}:${output.length}`;
    if (startedKeyRef.current === key) return;
    startedKeyRef.current = key;
    void runDiagnosis();
  }, [open, testName, output.length, runDiagnosis]);

  const copyResponse = async () => {
    await window.glazeAPI.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Debug with AI" description={testName} size="xl">
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
          <pre className="text-small whitespace-pre-wrap break-words p-3 text-primary">
            {status === "error" && error
              ? friendlyError(error)
              : content || (status === "streaming" ? "Thinking…" : "")}
          </pre>
        </ScrollArea>
      </div>
    </Dialog>
  );
}
