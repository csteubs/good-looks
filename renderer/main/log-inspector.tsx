// The raw-console-output dialog for a finished run.
//
// Extracted from stats-view so the Batch view can open the same inspector from
// a row's pass/fail badge — one dialog, one query key, wherever a runId shows
// up in the UI.

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Dialog, ScrollArea } from "@glaze/core/components";
import { Check, Copy } from "lucide-react";

import { api } from "../lib/api";

function clipboard(): { writeText: (t: string) => void } {
  return (window as unknown as { glazeAPI: { clipboard: { writeText: (t: string) => void } } })
    .glazeAPI.clipboard;
}

export function LogInspector({
  runId,
  title,
  onClose,
}: {
  runId: string;
  title: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const logQuery = useQuery({
    queryKey: ["run-log", runId],
    queryFn: () => api.runs.getLog(runId),
  });
  const text = logQuery.data ?? "";

  const copy = () => {
    clipboard().writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size="2xl"
      title={title}
      description="Raw console output for this run."
    >
      <div className="flex flex-col gap-2">
        <div className="flex justify-end">
          <Button variant="glass" size="small" onClick={copy}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "Copied" : "Copy log"}
          </Button>
        </div>
        <ScrollArea className="h-[55vh] rounded-md border border-separator bg-well">
          <pre className="whitespace-pre-wrap break-words p-3 text-mono font-mono text-secondary">
            {logQuery.isLoading ? "Loading…" : text || "(empty log)"}
          </pre>
        </ScrollArea>
      </div>
    </Dialog>
  );
}
