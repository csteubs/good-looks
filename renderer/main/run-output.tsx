import { Button, ScrollArea, Status, Text } from "@glaze/core/components";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

import type { RunInfo } from "./recorder-store";

export function RunOutput({ info }: { info: RunInfo }) {
  const [copied, setCopied] = useState(false);

  async function copyOutput() {
    await window.glazeAPI.clipboard.writeText(info.lines.join(""));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex h-56 shrink-0 flex-col border-t border-separator">
      <div className="flex items-center gap-2 border-b border-separator px-4 py-2">
        <Text variant="small-strong">Output</Text>
        {info.running ? (
          <Status variant="loading">Running</Status>
        ) : (
          <Status variant={info.code === 0 ? "success" : "error"}>
            {info.code === 0 ? "Passed" : "Failed"}
          </Status>
        )}
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
