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
//
// EXTENDED IN C §6.1. Two changes, both of which follow from the panel no
// longer being about failure alone.
//
// 4. THE PANEL RENDERS WITHOUT A LIVE RUN. It used to appear only once
//    something had executed in this session, so opening a test cold said
//    nothing whatsoever about it — not that it had never run, not that it
//    failed yesterday. Now the summary is computed from run history too, and the
//    panel drops the log (there is none) rather than the panel.
//
// 5. THE CHIP REPORTS THE SIX STATES, not two. `healed` in particular is its
//    own word and its own tone: a run that only passed because a locator was
//    silently substituted is not the same evidence as one that passed outright,
//    and reporting both as "Passed" is the app agreeing with the mis-heal.

import { ScrollArea } from "@ui";
import { Check, ChevronsDownUp, ChevronsUpDown, Copy, Sparkles } from "lucide-react";
import { useState } from "react";

import { StatusChip } from "../theme";
import type { ToneName } from "../theme";
import { toneFor } from "../lib/ai-debug-status";
import type { RunSummary } from "../lib/run-summary";
import type { AiDebugStatus } from "../lib/recorder-types";
import type { RunInfo } from "./recorder-store";
import { RunSummaryPanel } from "./run-summary-panel";
import { RunTriage } from "./run-triage";

/** The chip for each of the six states.
 *
 *  TWO OF THE SIX PASSED AND ARE NOT PHOS, which is the whole reason this is a
 *  table rather than `code === 0 ? "Passed" : "Failed"`. A healed run passed
 *  because Auto-Heal substituted a locator, and a mis-heal usually SUCCEEDS —
 *  clicking the wrong button rarely throws. A retry that recovered with nothing
 *  different about it is flake, not a fix. Both are amber: the run reported a
 *  pass and the pass is worth less than it looks, which is exactly what amber
 *  means everywhere else in this app.
 *
 *  `never` has no tone at all, for the same reason `Verdict` leaves "not enough
 *  evidence" colourless — it is a real state and it is not a result. */
export function chipFor(summary: RunSummary): { label: string; tone?: ToneName } {
  switch (summary.state) {
    case "never":
      return { label: "Never run" };
    case "running":
      return { label: "Running" };
    case "passed":
      return { label: "Passed", tone: "phos" };
    case "healed":
      return { label: "Healed", tone: "amber" };
    case "retry":
      return {
        label: "Recovered",
        tone: summary.differences.length === 0 ? "amber" : "phos",
      };
    case "failed":
      return { label: "Failed", tone: "red" };
  }
}

export function RunOutput({
  /** The live run, when one has happened in this session. Absent means the
   *  panel is reporting history — a summary with no log under it. */
  info,
  summary,
  onDebug,
  /** Opens the Heals tab, for the healed panel's review action. */
  onReview,
  /** Status of this test's AI debug session, or null when it has none. */
  aiStatus,
}: {
  info?: RunInfo | null;
  summary: RunSummary;
  onDebug?: () => void;
  onReview?: () => void;
  aiStatus?: AiDebugStatus | null;
}) {
  const [copied, setCopied] = useState(false);
  // Not persisted, and deliberately so: expanding is a thing you do to read one
  // failure, and a panel that stayed expanded would hide the step list on the
  // next test you opened, for a run you had not looked at yet.
  const [expanded, setExpanded] = useState(false);
  const failed = summary.state === "failed";
  const chip = chipFor(summary);

  async function copyOutput() {
    if (!info) return;
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
        {/* Named for what the panel IS. With a live run it is this session's
            output; without one it is the last thing that happened, and calling
            that "Output" over a panel with no log invites a hunt for the log. */}
        <span className="gl-section-title">
          {info ? "Output" : summary.state === "never" ? "Run" : "Last run"}
        </span>
        {summary.state === "running" ? (
          <StatusChip running animated>
            {chip.label}
          </StatusChip>
        ) : (
          <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
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
        {info && !info.running && info.lines.length > 0 ? (
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
            one nobody learns is there. Only with a log to expand, though — a
            drawer over an empty panel opens onto nothing. */}
        {info ? (
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
        ) : null}
      </div>
      {/* Only for a failed run: triage explains a failure, and there is nothing
          to explain until there is one. Keyed on recordId, which only exists
          once the run has been written to history — which is also when its
          metrics row exists for triage to read. Every OTHER state gets the
          panel its own question deserves (§6.1). */}
      {failed ? (
        <RunTriage runId={summary.state === "failed" ? summary.recordId : undefined} />
      ) : (
        <RunSummaryPanel summary={summary} onReview={onReview} />
      )}
      {info ? (
        <ScrollArea
          className="min-h-0 flex-1"
          autoScrollToBottom
          autoScrollDeps={[info.lines.length]}
        >
          {/* `.gl-console` carries the border everywhere else it is used; here
              the panel already has one on every side, so the log drops it and
              reaches the panel's own edges. A box inside a box at the same
              weight reads as a table. */}
          <pre className="gl-console gl-run-log">{info.lines.join("") || "Starting…"}</pre>
        </ScrollArea>
      ) : null}
    </div>
  );
}
