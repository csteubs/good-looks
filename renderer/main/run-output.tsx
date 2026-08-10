// The run panel: what happened, why, and the raw log.
//
// RESKINNED IN B5a. Three changes, each of which fixes something rather than
// restyling it.
//
// 1. THE VERDICT IS A `StatusChip`, not an SDK `Status` badge. One shape, one
//    width, the palette's tones — and `running` takes the holo treatment rather
//    than a hue, because running is the ABSENCE of an outcome and a colour there
//    makes a run still in flight look like one that finished and reported.
//
// 2. THE LOG IS A CONSOLE, on `--gl-black`. That is the only true #000 in the
//    palette and it is reserved for exactly this and the backing behind a
//    captured frame: anything lighter reads as a surface the app drew rather
//    than as output it captured. Playwright's output is evidence, same as a
//    screenshot, and it should not look like our chrome.
//
// 3. THE LOG EXPANDS. The panel is a fixed 224px strip, which is about eight
//    lines — enough to see that something failed and never enough to read the
//    stack. Anyone diagnosing a failure was scrolling a viewport the size of a
//    business card while the step list above sat idle. Expanding hands the whole
//    panel to the log; it is a drawer rather than a separate window because the
//    verdict, the triage line and the log are one thought, and a modal would
//    make the user choose between the explanation and the evidence for it.

import { ScrollArea } from "@ui";
import { Check, ChevronsDownUp, ChevronsUpDown, Copy, Sparkles } from "lucide-react";
import { useState } from "react";

import { StatusChip } from "../theme";
import { toneFor } from "../lib/ai-debug-status";
import type { AiDebugStatus } from "../lib/recorder-types";
import type { RunInfo } from "./recorder-store";
import { RunTriage } from "./run-triage";

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
  // Not persisted, and deliberately so: expanding is a thing you do to read one
  // failure, and a panel that stayed expanded would hide the step list on the
  // next test you opened, for a run you had not looked at yet.
  const [expanded, setExpanded] = useState(false);
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
    <div className={`gl-run-panel${expanded ? " gl-run-panel-expanded" : ""}`} data-gl="run-panel">
      <div className="gl-run-head">
        <span className="gl-section-title">Output</span>
        {info.running ? (
          <StatusChip running animated>
            Running
          </StatusChip>
        ) : (
          <StatusChip tone={info.code === 0 ? "phos" : "red"}>
            {info.code === 0 ? "Passed" : "Failed"}
          </StatusChip>
        )}
        {showDebug ? (
          <button
            type="button"
            className="gl-icon-btn"
            onClick={onDebug}
            aria-label={tone ? tone.label : "Debug with AI"}
            title={tone ? tone.label : "Debug with AI"}
          >
            <Sparkles
              className={`size-3.5 ${tone ? tone.className : ""} ${tone?.busy ? "animate-pulse" : ""}`}
            />
          </button>
        ) : null}
        {!info.running && info.lines.length > 0 ? (
          <button
            type="button"
            className="gl-icon-btn"
            onClick={copyOutput}
            aria-label="Copy output to clipboard"
            title="Copy output"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        ) : null}
        {/* Trailing edge, and always present rather than only when the log is
            long: a control that appears once the output happens to overflow is
            one nobody learns is there. */}
        <button
          type="button"
          className="gl-icon-btn gl-run-expand"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse the run output" : "Expand the run output"}
          title={expanded ? "Collapse output" : "Expand output"}
        >
          {expanded ? (
            <ChevronsDownUp className="size-3.5" />
          ) : (
            <ChevronsUpDown className="size-3.5" />
          )}
        </button>
      </div>
      {/* Only for a finished, failed run: triage explains a failure, and there
          is nothing to explain until there is one. Keyed on recordId, which
          only exists once the run has been written to history — which is also
          when its metrics row exists for triage to read. */}
      {failed && info.recordId ? <RunTriage runId={info.recordId} /> : null}
      <ScrollArea className="min-h-0 flex-1" autoScrollToBottom autoScrollDeps={[info.lines.length]}>
        {/* `.gl-console` carries the border everywhere else it is used; here the
            panel already has one on every side, so the log drops it and reaches
            the panel's own edges. A box inside a box at the same weight reads as
            a table. */}
        <pre className="gl-console gl-run-log">{info.lines.join("") || "Starting…"}</pre>
      </ScrollArea>
    </div>
  );
}
