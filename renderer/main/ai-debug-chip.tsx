// The always-reachable handle on minimized AI debug jobs.
//
// The per-view icons (the run Output panel's sparkle, the trainer console's
// per-step sparkles) only exist while their view is on screen, and the whole
// point of minimizing is to go elsewhere — including into the trainer, which
// replaces the entire outlet. Without a global affordance, a minimized job
// would keep running with no way back to it.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button, Text } from "@ui";
import { Sparkles } from "lucide-react";

import { aggregateStatus } from "../lib/ai-debug-sessions";
import { toneFor } from "../lib/ai-debug-status";
import { useAiDebug } from "./ai-debug-store";

export function AiDebugChip() {
  const { sessions, expand } = useAiDebug();
  const navigate = useNavigate();
  const [listOpen, setListOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  const status = aggregateStatus(sessions);

  React.useEffect(() => {
    if (!listOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setListOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [listOpen]);

  if (status === null || sessions.length === 0) return null;

  const tone = toneFor(status);

  const restore = (key: string, kind: string, testId: string) => {
    setListOpen(false);
    // A run session belongs to a test detail view; go there first so the
    // dialog opens over its own context (script, run output) rather than
    // floating over an unrelated view with nothing behind it.
    if (kind === "run" && testId) {
      navigate({ to: "/test/$id", params: { id: testId } });
    }
    expand(key);
  };

  const single = sessions.length === 1 ? sessions[0] : null;

  return (
    <div ref={wrapRef} className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-1">
      {listOpen && !single ? (
        <div className="mb-1 w-72 overflow-hidden rounded-md border border-separator bg-popover p-1 shadow-lg">
          {sessions.map((s) => {
            const t = toneFor(s.status);
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => restore(s.key, s.kind, s.testId)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-background-secondary"
                title={t.label}
              >
                <Sparkles className={`size-3.5 shrink-0 ${t.className}`} />
                <span className="min-w-0 flex-1 truncate text-small text-primary">
                  {s.label}
                  {s.superseded ? " · previous run" : ""}
                </span>
                <span className="shrink-0 text-small text-tertiary">{t.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <Button
        size="small"
        variant="glass"
        radius="full"
        aria-label={`AI debug — ${tone.label}`}
        title={tone.label}
        onClick={() => {
          if (single) restore(single.key, single.kind, single.testId);
          else setListOpen((o) => !o);
        }}
      >
        <Sparkles className={`size-3.5 ${tone.className} ${tone.busy ? "animate-pulse" : ""}`} />
        <Text variant="small">
          {sessions.length === 1 ? "AI debug" : `AI debug (${sessions.length})`}
        </Text>
      </Button>
    </div>
  );
}
