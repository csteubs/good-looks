// The raw-console-output dialog for a finished run.
//
// Extracted from stats-view so the Batch view can open the same inspector from
// a row's pass/fail badge — one dialog, one query key, wherever a runId shows
// up in the UI.

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, ScrollArea } from "@ui";
import { Check, Copy } from "lucide-react";

import { Btn } from "../theme";
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
          <Btn tone="ghost" onClick={copy}>
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? "Copied" : "Copy log"}
          </Btn>
        </div>
        {/* `--gl-black` via `.gl-console`, the only true #000 in the palette and
            reserved for exactly this and the backing behind a captured frame:
            anything lighter reads as a surface the app drew rather than as
            output it captured. The ScrollArea stays — it is structural, it owns
            the auto-follow behaviour, and it is on the SDK's keep list. */}
        <ScrollArea className="h-[55vh]">
          <pre className="gl-console">
            {logQuery.isLoading ? "Loading…" : text || "(empty log)"}
          </pre>
        </ScrollArea>
      </div>
    </Dialog>
  );
}
