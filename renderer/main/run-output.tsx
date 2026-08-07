import { Button, ScrollArea, Status, Text } from "@ui";
import { Check, Copy, Sparkles } from "lucide-react";
import { useState } from "react";

import { toneFor } from "../lib/ai-debug-status";
import type { AiDebugStatus } from "../lib/recorder-types";
import type { RunInfo } from "./recorder-store";

export function RunOutput({
  info,
  onDebug,
  /** Status of this test's AI debug session, or null when it has none. */
  aiStatus,
}: {
  info: RunInfo;
  onDebug?: () => void;
  aiStatus?: AiDebugStatus | null;
}) {
  const [copied, setCopied] = useState(false);
  const failed = !info.running && info.code !== null && info.code !== 0;

  async function copyOutput() {
    await window.glazeAPI.clipboard.writeText(info.lines.join(""));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // Once a session exists the icon is how you get BACK to it, so it must stay
  // put — showing it only for a failed run would make a minimized job vanish
  // the moment the test is re-run and passes.
  const tone = aiStatus ? toneFor(aiStatus) : null;
  const showDebug = Boolean(onDebug) && (failed || tone !== null);

  return (
    <div className="bg-background flex h-56 shrink-0 flex-col border-t border-separator">
      <div className="flex items-center gap-2 border-b border-separator px-4 py-2">
        <Text variant="small-strong">Output</Text>
        {info.running ? (
          <Status variant="loading">Running</Status>
        ) : (
          <Status variant={info.code === 0 ? "success" : "error"}>
            {info.code === 0 ? "Passed" : "Failed"}
          </Status>
        )}
        {showDebug ? (
          <Button
            iconOnly
            variant="transparent"
            size="small"
            onClick={onDebug}
            aria-label={tone ? tone.label : "Debug with AI"}
            title={tone ? tone.label : "Debug with AI"}
          >
            <Sparkles
              className={`size-3.5 ${tone ? tone.className : ""} ${tone?.busy ? "animate-pulse" : ""}`}
            />
          </Button>
        ) : null}
        {!info.running && info.lines.length > 0 ? (
          <Button
            iconOnly
            variant="transparent"
            size="small"
            onClick={copyOutput}
            aria-label="Copy output to clipboard"
            title="Copy output"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1" autoScrollToBottom autoScrollDeps={[info.lines.length]}>
        <pre className="text-small-mono whitespace-pre-wrap break-words px-4 py-2 text-secondary">
          {info.lines.join("") || "Starting…"}
        </pre>
      </ScrollArea>
    </div>
  );
}
