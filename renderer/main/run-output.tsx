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
//    failed yesterday. Now the summary is computed from run history too. The
//    log AREA stays either way (the bar says why it is empty); only its
//    contents need a live run.
//
// 5. THE CHIP REPORTS THE SIX STATES, not two. `healed` in particular is its
//    own word and its own tone: a run that only passed because a locator was
//    silently substituted is not the same evidence as one that passed outright,
//    and reporting both as "Passed" is the app agreeing with the mis-heal.
//
// TABBED LIKE THE TRAINER'S CONSOLE (2026-09-01). This strip and the trainer's
// bottom panel are the same surface in the user's head — "the console area" —
// and they had drifted into two designs a screen apart. Same tab strip in the
// head now, same status bar over the log, same auto-scroll toggle: Console (the
// verdict, the triage, the log), Step details (each step's outcome from this
// session's run, with its locator), and History (past runs plus the latest
// captured run's screenshots — `run-history-panel.tsx`). Cookies is
// deliberately NOT carried over: that tab edits the live training browser's
// cookies over recorder IPC, and outside a recording session there is no
// browser to edit — a tab that could only ever be empty is worse than no tab.
//
// ONE HEIGHT, AND THE USER'S TO SET. The panel keeps the same height on every
// tab — the first cut shrank the Console tab to its summary when no run was
// live, which made the three tabs three different panels and the console the
// cramped one. The top edge is a drag handle (SplitView's pointer idiom, plus
// arrow keys and a double-click reset), clamped so the panel can neither
// vanish nor evict the step list, and the dragged height is remembered in
// localStorage the way SplitView remembers its pane widths. The EXPAND toggle
// stays deliberately unpersisted (a panel that stayed expanded would hide the
// step list on the next test opened); a dragged height is different — it is a
// layout preference, not a glance at one failure.

import {
  Checkbox,
  ScrollArea,
  Tabs,
  TabsContent,
  TabsRoot,
  TabsTrigger,
} from "@ui";
import {
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Film,
  Loader2,
  Minus,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { Fragment, useRef, useState, type ReactNode } from "react";

import { StatusChip, TONE } from "../theme";
import type { ToneName } from "../theme";
import { toneFor } from "../lib/ai-debug-status";
import { hitRateTone } from "../lib/hit-rate";
import { describeStep, locatorExpr } from "../lib/describe-step";
import type { RunSummary } from "../lib/run-summary";
import type { AiDebugStatus, RunRecord, Step } from "../lib/recorder-types";
import type { RunInfo, RunStepStatus } from "./recorder-store";
import { RunFailureReason } from "./run-failure-reason";
import { RunHistoryPanel } from "./run-history-panel";
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

/** The panel's resting height, its floor, and where a dragged height is
 *  remembered — the same best-effort localStorage idiom as SplitView's pane
 *  widths (renderer/ui/layout.tsx): guarded on both sides, because storage can
 *  be absent or full and the panel must render either way. */
const PANEL_DEFAULT_HEIGHT = 224;
const PANEL_MIN_HEIGHT = 140;
const PANEL_HEIGHT_KEY = "runpanel:height";

/** Clamp so the panel can neither vanish nor evict the step list — the window
 *  keeps at least ~220px for the toolbar and tab strip above it. `Math.max`
 *  around the ceiling so a tiny window degrades to the floor, never to a
 *  negative ceiling that would invert the clamp. */
function clampPanelHeight(h: number): number {
  const max = Math.max(PANEL_MIN_HEIGHT, window.innerHeight - 220);
  return Math.min(max, Math.max(PANEL_MIN_HEIGHT, Math.round(h)));
}

function readPanelHeight(): number {
  try {
    const raw = window.localStorage.getItem(PANEL_HEIGHT_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? clampPanelHeight(n) : PANEL_DEFAULT_HEIGHT;
  } catch {
    return PANEL_DEFAULT_HEIGHT;
  }
}

function writePanelHeight(h: number): void {
  try {
    window.localStorage.setItem(PANEL_HEIGHT_KEY, String(Math.round(h)));
  } catch {
    /* persistence is best-effort */
  }
}

/** The glyph for one step's outcome in the Step details tab. `undefined` is a
 *  step the run has not reached (or no run at all) — a dash, never a verdict. */
/** The Step details row for a tab the run's browser opened. Exported so the
 *  copy is asserted directly rather than re-typed in a test. */
export function tabOpenedLabel(count: number): string {
  return `New Tab Opened (#${count})`;
}

function stepGlyph(status: RunStepStatus | undefined) {
  if (status === "passed") return <Check className="size-3 shrink-0 text-support-green" aria-hidden="true" />;
  if (status === "failed") return <X className="size-3 shrink-0 text-support-red" aria-hidden="true" />;
  if (status === "running") {
    return (
      <Loader2 className="size-3 shrink-0 animate-spin" style={{ color: TONE.cyan }} aria-hidden="true" />
    );
  }
  return <Minus className="size-3 shrink-0 text-tertiary" aria-hidden="true" />;
}

export function RunOutput({
  /** The live run, when one has happened in this session. Absent means the
   *  panel is reporting history — a summary with no log under it. */
  info,
  summary,
  onDebug,
  /** Opens the Heals tab, for the healed panel's review action. */
  onReview,
  onSendToTracker,
  hasTrace,
  onOpenTrace,
  /** Status of this test's AI debug session, or null when it has none. */
  aiStatus,
  testId,
  steps,
  runs,
  onOpenVisual,
}: {
  info?: RunInfo | null;
  summary: RunSummary;
  onDebug?: () => void;
  onReview?: () => void;
  /** Absent where filing makes no sense (no tracker surface in the trainer). */
  onSendToTracker?: (runId: string) => void;
  /** the latest failed run salvaged a Playwright trace */
  hasTrace?: boolean;
  onOpenTrace?: (runId: string) => void;
  aiStatus?: AiDebugStatus | null;
  /** The test behind the panel — what the History tab lists runs and reads
   *  screenshots for. Optional so a fixture without a test still renders. */
  testId?: string;
  /** The test's steps, for the Step details rows and the console's N/M line. */
  steps?: Step[];
  /** Every recorded run, unfiltered — the History tab filters through
   *  `runsForTest`, whose rules live with the summary's. */
  runs?: RunRecord[];
  /** Opens the Visual view, from the History tab's screenshots. */
  onOpenVisual?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  // Not persisted, and deliberately so: expanding is a thing you do to read one
  // failure, and a panel that stayed expanded would hide the step list on the
  // next test you opened, for a run you had not looked at yet. The tab resets
  // for the same reason — the console is the panel's answer to "what just
  // happened", and that is the question a freshly opened test asks.
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState("console");
  const [autoScroll, setAutoScroll] = useState(true);
  // The dragged height, seeded from the last drag. ONE height for all three
  // tabs — the panel must not change size under the pointer when a tab is
  // clicked, and a console shorter than its siblings reads as the cramped one.
  const [height, setHeight] = useState<number>(readPanelHeight);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const failed = summary.state === "failed";
  const chip = chipFor(summary);

  // The console bar's numbers, read the way the trainer reads its replay: how
  // many steps have SETTLED (passed or failed), how many of those passed, and
  // the hit rate over what actually ran — never over steps the run never
  // reached, which would grade a crash as a low score instead of a short one.
  const statuses = Object.values(info?.stepStatus ?? {});
  const ran = statuses.filter((s) => s === "passed" || s === "failed").length;
  const stepsPassed = statuses.filter((s) => s === "passed").length;
  const total = steps && steps.length > 0 ? steps.length : statuses.length;
  const hitRate = ran > 0 ? Math.round((stepsPassed / ran) * 100) : null;
  // The one thing tab handling shows: a row under the step that opened a tab.
  // The run follows the newest tab on its own (shared/tabs-fixture-source.mjs);
  // this is how a person watching knows it happened. `afterIndex` -1 is a tab
  // the page opened before any step began, shown above the first row.
  const tabRows = (afterIndex: number): ReactNode =>
    (info?.tabEvents ?? [])
      .filter((t) => t.afterIndex === afterIndex)
      .map((t, n) => (
        <div
          key={`tab-${afterIndex}-${n}`}
          className="flex items-center gap-1.5 py-0.5 pl-5 text-tertiary"
          data-gl="tab-event"
          data-count={t.count}
        >
          <span aria-hidden="true">&gt;</span>
          <span>{tabOpenedLabel(t.count)}</span>
        </div>
      ));
  const failedIndexes = Object.entries(info?.stepStatus ?? {})
    .filter(([, status]) => status === "failed")
    .map(([index]) => Number(index));
  const firstFailed = failedIndexes.length > 0 ? Math.min(...failedIndexes) : null;

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
    <div
      ref={panelRef}
      className={`gl-run-panel${expanded ? " gl-run-panel-expanded" : ""}`}
      data-gl="run-panel"
      style={expanded ? undefined : { flexBasis: height }}
    >
      {/* The whole top edge is the resize grip. Pointer mechanics mirror
          SplitView's ResizeHandle; arrow keys move it for a keyboard, and
          double-click puts the resting height back. A drag that starts from
          the EXPANDED panel measures where the edge actually is and leaves
          expanded — grabbing an edge means "put it where I drop it". */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the console"
        aria-valuenow={height}
        aria-valuemin={PANEL_MIN_HEIGHT}
        tabIndex={0}
        className="gl-run-resize"
        title="Drag to resize the console — double-click to reset"
        onPointerDown={(down) => {
          down.preventDefault();
          const start = panelRef.current?.getBoundingClientRect().height || height;
          if (expanded) setExpanded(false);
          const startY = down.clientY;
          try {
            down.currentTarget.setPointerCapture(down.pointerId);
          } catch {
            /* jsdom has no pointer capture; the window listeners carry the drag */
          }
          let latest = clampPanelHeight(start);
          const move = (e: PointerEvent) => {
            latest = clampPanelHeight(start + (startY - e.clientY));
            setHeight(latest);
          };
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            writePanelHeight(latest);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
        onDoubleClick={() => {
          setExpanded(false);
          setHeight(PANEL_DEFAULT_HEIGHT);
          writePanelHeight(PANEL_DEFAULT_HEIGHT);
        }}
        onKeyDown={(e) => {
          const step = e.key === "ArrowUp" ? 24 : e.key === "ArrowDown" ? -24 : 0;
          if (step === 0) return;
          e.preventDefault();
          setExpanded(false);
          setHeight((h) => {
            const next = clampPanelHeight(h + step);
            writePanelHeight(next);
            return next;
          });
        }}
      />
      <TabsRoot value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <div className="gl-run-head gl-tabs">
          <Tabs variant="filled" size="small">
            <TabsTrigger value="console">Console</TabsTrigger>
            <TabsTrigger value="steps">Step details</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </Tabs>
          <div className="gl-run-head-actions">
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
            {/* Beside Debug with AI, because they are the two things you do with a
                failure: work out why, or hand it to someone. Only for a failure
                that reached history — `recordId` is what identifies the run on
                disk, and without it there is no evidence to assemble. */}
            {/* The trace is the richest failure artifact Playwright makes — every
                action, snapshot and network call on a timeline — and runs have
                quietly salvaged one per failure since 2026-08-19. Only offered
                when THIS run actually kept one; the opener still answers "no
                trace" gracefully if retention pruned it since. */}
            {failed && summary.state === "failed" && summary.recordId && hasTrace && onOpenTrace ? (
              <button
                type="button"
                className="gl-icon-btn"
                onClick={() => onOpenTrace(summary.recordId as string)}
                aria-label="Open this failure's Playwright trace"
                title="Open trace"
              >
                <Film className="size-3.5" />
              </button>
            ) : null}
            {failed && summary.state === "failed" && summary.recordId && onSendToTracker ? (
              <button
                type="button"
                className="gl-icon-btn"
                onClick={() => onSendToTracker(summary.recordId as string)}
                aria-label="Send this failure to the issue tracker"
                title="Send to issue tracker"
              >
                <Send className="size-3.5" />
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
            {/* Same toggle, same spot as the trainer console's. Only on the
                Console tab — it governs the log's follow behaviour and nothing
                else scrolls on its own. */}
            {tab === "console" && info ? (
              <label className="gl-run-option shrink-0">
                <Checkbox
                  checked={autoScroll}
                  onCheckedChange={(v) => setAutoScroll(v === true)}
                  aria-label="Auto-scroll console"
                />
                Auto-scroll
              </label>
            ) : null}
            {/* Trailing edge, and always present rather than only when the log is
                long: a control that appears once the output happens to overflow
                is one nobody learns is there. */}
            <button
              type="button"
              className="gl-icon-btn"
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
        </div>

        <TabsContent value="console" className="flex min-h-0 flex-1 flex-col">
          {/* Only for a failed run: triage explains a failure, and there is nothing
              to explain until there is one. Keyed on recordId, which only exists
              once the run has been written to history — which is also when its
              metrics row exists for triage to read. Every OTHER state gets the
              panel its own question deserves (§6.1). The reason row sits above the
              triage line: the label is the answer someone files, the triage line
              is the evidence for (or against) it. */}
          {failed ? (
            <>
              <RunFailureReason runId={summary.state === "failed" ? summary.recordId : undefined} />
              <RunTriage runId={summary.state === "failed" ? summary.recordId : undefined} />
            </>
          ) : (
            <RunSummaryPanel summary={summary} onReview={onReview} />
          )}
          {/* The bar and the log surface render with or without a live run —
              the tab keeps the panel's shared height either way, and a black
              area with a bar saying why it is empty reads as a console where
              bare panel background reads as a rendering bug. Only the CONTENTS
              need a run. */}
          <div className="gl-run-console-bar">
            {info?.running ? (
              <Loader2
                className="size-3.5 shrink-0 animate-spin"
                style={{ color: TONE.cyan }}
                aria-hidden="true"
              />
            ) : null}
            <span className="min-w-0 truncate text-[11px] text-secondary">
              {!info
                ? summary.state === "never"
                  ? "No runs yet — output streams here when you press Run test."
                  : "No run this session — output streams here when you run the test."
                : info.running
                  ? `Running… ${ran}/${total} steps`
                  : ran === 0
                    ? "No per-step results — the log below is the whole story."
                    : firstFailed !== null
                      ? `Stopped at step ${firstFailed + 1} — ${stepsPassed}/${ran} passed`
                      : `Done — ${stepsPassed}/${ran} passed`}
            </span>
            {hitRate !== null ? (
              <span className={`ml-auto shrink-0 text-[11px] font-medium ${hitRateTone(hitRate)}`}>
                {hitRate}% hit rate
              </span>
            ) : null}
          </div>
          {/* `min-h-16`, not `min-h-0`: the summary above yields when the strip
              is short (`.gl-run-summary` shrinks and scrolls), and this floor
              is what it yields TO — without it a tall summary flexes the log
              to zero height and the console surface vanishes. */}
          {info ? (
            <ScrollArea
              className="min-h-16 flex-1"
              autoScrollToBottom={autoScroll}
              autoScrollDeps={[info.lines.length]}
            >
              {/* `.gl-console` carries the border everywhere else it is used; here
                  the panel already has one on every side, so the log drops it and
                  reaches the panel's own edges. A box inside a box at the same
                  weight reads as a table. */}
              <pre className="gl-console gl-run-log">{info.lines.join("") || "Starting…"}</pre>
            </ScrollArea>
          ) : (
            <div className="min-h-16 flex-1">
              <pre className="gl-console gl-run-log" aria-hidden="true" />
            </div>
          )}
        </TabsContent>

        {/* Step details: each step's outcome from this session's run, beside the
            locator it stands on. Statuses are session-scoped on purpose — run
            history stores no per-step results, and inventing them from the log
            would be a guess wearing a checkmark. */}
        <TabsContent value="steps" className="flex min-h-0 flex-1 flex-col">
          <div className="gl-run-console-bar">
            <span className="min-w-0 truncate text-[11px] text-secondary">
              {info
                ? ran > 0
                  ? `${stepsPassed}/${ran} passed this run`
                  : "No step has reported yet."
                : "Statuses fill in as a run reports each step."}
            </span>
            {hitRate !== null ? (
              <span className={`ml-auto shrink-0 text-[11px] font-medium ${hitRateTone(hitRate)}`}>
                {hitRate}% hit rate
              </span>
            ) : null}
          </div>
          {steps && steps.length > 0 ? (
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-3 py-2 font-mono text-[11px] leading-relaxed">
                {tabRows(-1)}
                {steps.map((step, i) => {
                  const status = info?.stepStatus[i];
                  return (
                    <Fragment key={step.id}>
                    <div
                      className="flex items-center gap-1.5 py-0.5"
                      data-gl="step-detail"
                      data-status={status ?? "idle"}
                      title={status ?? "not run"}
                    >
                      {stepGlyph(status)}
                      <span
                        className={`shrink-0 font-semibold ${
                          status === "failed"
                            ? "text-support-red"
                            : status === "passed"
                              ? "text-support-green"
                              : "text-secondary"
                        }`}
                      >
                        Step {i + 1}
                      </span>
                      <span className="truncate text-secondary">· {describeStep(step)}</span>
                      {step.locator ? (
                        <span className="ml-auto max-w-[45%] shrink-0 truncate text-tertiary">
                          {locatorExpr(step.locator)}
                        </span>
                      ) : null}
                    </div>
                    {tabRows(i)}
                    </Fragment>
                  );
                })}
              </div>
            </ScrollArea>
          ) : (
            <div className="flex flex-1 items-center justify-center px-4 text-center">
              <span className="text-[11px] text-tertiary">
                No tracked steps — an imported test runs its spec file as written.
              </span>
            </div>
          )}
        </TabsContent>

        <TabsContent value="history" className="flex min-h-0 flex-1 flex-col">
          <RunHistoryPanel testId={testId} runs={runs ?? []} onOpenVisual={onOpenVisual} />
        </TabsContent>
      </TabsRoot>
    </div>
  );
}
