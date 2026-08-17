import * as React from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertDialog, Dialog, ScrollArea, toast, Tooltip, TooltipContent, TooltipTrigger } from "@ui";

import {
  Btn,
  CRT,
  Panel,
  Segmented,
  StatusChip,
  TONE,
  insetRail,
  toneSurface,
  usePrefersReducedMotion,
  withAlpha,
} from "../theme";
import {
  Accessibility,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  Eye,
  ImageOff,
  MessageSquare,
  Pencil,
  RefreshCw,
  Send,
  SquareDashed,
  Stamp,
  TriangleAlert,
  X,
} from "lucide-react";

import { api } from "../lib/api";
import { countA11ySteps } from "../lib/a11y-format";
import { blinkIntervalMs, wipeAfterKey, wipeFromPointer } from "../lib/visual-compare";
import { baselineProvenance, isStale, provenanceLine } from "../lib/baseline-provenance";
import { dominantRegion, formatShare, regionPlace, regionsLine } from "../lib/diff-regions";
import {
  DRIFT_WINDOW,
  type DriftRun,
  barHeight,
  computeDrift,
  driftLine,
  driftPointsFor,
} from "../lib/baseline-drift";
import { A11yBadge, A11yViolationList } from "./a11y-violations";
import { IssueComposeDialog } from "../components/issue-compose-dialog";
import type {
  A11yResult,
  Annotation,
  ReplayStep,
  ReplayStepStatus,
  RunNoticeKind,
  DiffRegion,
  RunReplay,
  RunReplaySummary,
  VisualDiff,
  VisualDiffState,
  VisualMask,
  RunComparison,
  StepDelta,
} from "../lib/recorder-types";

// ── Formatting ─────────────────────────────────────────────────────────
function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtPct(ratio: number): string {
  const pct = ratio * 100;
  if (pct === 0) return "0%";
  if (pct < 0.01) return "<0.01%";
  return `${pct.toFixed(2)}%`;
}

// ── Status → colors/labels ─────────────────────────────────────────────
/** The frame rail's bar colour. COLOUR MEANS OUTCOME, so only the two real
 *  outcomes get a hue — an unrun or skipped frame stays neutral rather than
 *  borrowing one, because "not attempted" is not a result. */
function statusBarColor(status: ReplayStepStatus): string {
  switch (status) {
    case "passed":
      return TONE.phos;
    case "failed":
      return TONE.red;
    default:
      return "rgba(255, 255, 255, 0.14)";
  }
}

/** The step's outcome as a glyph. The hue comes from the stylesheet, keyed on
 *  `data-status`, for the same reason the bar's does: only the two real outcomes
 *  take one, and "not reported" stays neutral. */
function StatusIcon({ status }: { status: ReplayStepStatus }) {
  return (
    <span className="gl-visual-step-icon" data-status={status}>
      {status === "passed" ? (
        <Check aria-hidden="true" />
      ) : status === "failed" ? (
        <X aria-hidden="true" />
      ) : (
        <CircleSlash aria-hidden="true" />
      )}
    </span>
  );
}

function statusLabel(status: ReplayStepStatus): string {
  if (status === "passed") return "Passed";
  if (status === "failed") return "Failed";
  if (status === "skipped") return "Skipped";
  return "Not reported";
}

// ── Visual-diff → chip ──────────────────────────────────────────────────
/**
 * The tone a comparison's verdict takes, and only two of the four get one.
 *
 * `match` is an outcome — the frame is what it was — so it takes phos.
 * `changed` takes amber, which is caution and not a result: the frame moved and
 * the run still passed, and it is the same claim the frame rail's amber inset
 * makes about the same frame at a smaller size.
 *
 * THE OTHER TWO ARE NEUTRAL ON PURPOSE. `new-baseline` ("Baseline set") is a
 * fact about what the app did, and `unable` ("Can't compare") is the ABSENCE of
 * a comparison rather than a bad one — the same thing "Not reported" is for a
 * step's status. Spending a third hue on either would put a verdict on a frame
 * that was never judged, and the word in the chip already says which is which.
 */
function diffTone(state: VisualDiffState): "phos" | "amber" | undefined {
  if (state === "match") return "phos";
  if (state === "changed") return "amber";
  return undefined;
}

/** The violations themselves, listed under the step detail row: the shared list
 *  plus the controls that only make sense against a RUN — collapse, and accept.
 *  The Accessibility tab renders the same list with its own controls. */
function A11yDetail({
  result,
  onAccept,
  accepting,
  accepted,
}: {
  result: A11yResult;
  onAccept: () => void;
  accepting: boolean;
  accepted: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  if (result.violations.length === 0) return null;

  return (
    <>
      <div className="gl-visual-a11y">
        <Btn tone="ghost" onClick={() => setOpen((v) => !v)}>
          <Accessibility aria-hidden="true" />
          {open ? "Hide" : "Show"} accessibility ({result.violations.length})
        </Btn>
        <div className="flex-1" />
        {result.newKeys.length > 0 && !accepted ? (
          <AlertDialog
            trigger={
              <Btn tone="ghost" disabled={accepting}>
                <Stamp aria-hidden="true" />
                Accept these issues
              </Btn>
            }
            title="Accept this step's accessibility issues?"
            description="They stop being flagged for this step on future runs. Existing acceptances are kept — this only adds. Use Reset on the test to undo."
            confirmLabel="Accept"
            confirmVariant="accent"
            onConfirm={onAccept}
          />
        ) : null}
      </div>
      {open ? (
        <div className="gl-visual-a11y-body">
          <A11yViolationList result={result} />
        </div>
      ) : null}
    </>
  );
}

export function DiffBadge({ diff }: { diff: VisualDiff }) {
  let label: string;
  switch (diff.state) {
    case "new-baseline":
      label = "Baseline set";
      break;
    case "match":
      label = diff.scope === "element" ? "Element match" : "Visual match";
      break;
    case "changed":
      // Say what the percentage is a share OF — 2% of one button is a very
      // different claim from 2% of the page.
      label =
        diff.scope === "element"
          ? `Element changed ${fmtPct(diff.ratio ?? 0)}`
          : `Changed ${fmtPct(diff.ratio ?? 0)}`;
      break;
    default:
      label = "Can’t compare";
  }
  // Make it explicit when a result was measured with regions excluded —
  // otherwise a "Visual match" on a masked page looks like a full-page match.
  const masked = diff.maskedCount
    ? `${diff.maskedCount} ignored region${diff.maskedCount === 1 ? "" : "s"}`
    : null;
  const title = [diff.reason, masked].filter(Boolean).join(" · ") || undefined;
  const tone = diffTone(diff.state);
  return (
    <span
      className={tone ? "gl-chip-tone" : "gl-chip"}
      style={tone ? toneSurface(TONE[tone]) : undefined}
      title={title}
    >
      {label}
      {masked ? <SquareDashed className="gl-mini-icon" aria-hidden="true" /> : null}
    </span>
  );
}

// ── Screenshot pane (current / baseline / diff-overlay) ─────────────────
/** The five compare modes (§6.6 added the last two).
 *
 *  `wipe` and `blink` are the only two that need BOTH frames at once, which is
 *  why they get their own component rather than a branch inside
 *  `StepScreenshot` — that one resolves a single `src` from the mode, and
 *  threading a second query through it would make every single-image mode pay
 *  for a fetch it does not use. */
type ShotMode = "current" | "baseline" | "diff" | "wipe" | "blink";

/**
 * What this step's baseline IS, as one line. REDESIGN §6.6.
 *
 * Rendered into `CRT`'s `caption` — a prop that has existed since A3 documented
 * as "what this frame IS: which run, which viewport, which engine" and had no
 * consumer until now. It is shown on every frame the BASELINE participates in,
 * because "these two differ" means something completely different depending on
 * whether the baseline was pinned yesterday from the same engine or months ago
 * from another one, and until now the screen said nothing at all about it.
 *
 * Returns undefined rather than a placeholder when there is no baseline record:
 * a caption reading "unknown" under a frame is worse than no caption, because
 * it looks like a fact.
 */
function useBaselineCaption(testId: string, stepId: string): React.ReactNode {
  const baselines = useQuery({
    queryKey: ["baselines", testId],
    queryFn: () => api.visual.listBaselines(testId),
    staleTime: 60 * 1000,
  }).data;
  // Shares the ["runs"] cache the rest of the app already holds, so joining a
  // baseline to the run it came from costs nothing.
  const runs = useQuery({ queryKey: ["runs"], queryFn: api.runs.list }).data;

  const entry = baselines?.find((b) => b.stepId === stepId);
  if (!entry) return undefined;
  const p = baselineProvenance(entry, runs ?? [], Date.now());
  return (
    <span data-gl="baseline-provenance" data-stale={isStale(p) ? "" : undefined}>
      {provenanceLine(p)}
    </span>
  );
}

/**
 * "What moved" — the measured boxes, laid over the diff map. REDESIGN §6.6.
 *
 * DIFF MODE ONLY, and that is a decision rather than an omission. Current and
 * Baseline are the frames the user is being asked to JUDGE, and this screen's
 * standing rule is that anything on screen there is something the page put
 * there — the same rule the CRT bezel and the neutral mode switch exist for.
 * The diff map is already an annotation, so boxes belong on it; the list below
 * switches modes for you rather than drawing over evidence.
 */
function RegionBoxes({
  regions,
  active,
  onHover,
  scrollTo,
  onScrolled,
}: {
  regions: readonly DiffRegion[];
  active: number | null;
  onHover: (index: number | null) => void;
  /** A box the list asked to be shown, or null. */
  scrollTo: number | null;
  onScrolled: () => void;
}) {
  const boxes = React.useRef<(HTMLDivElement | null)[]>([]);

  // THE FRAME SCROLLS, so picking a row has to bring its box into view. A
  // full-page screenshot is routinely three times the height of the pane it is
  // shown in, which means most regions are off-screen at any moment: without
  // this, the list points confidently at things the user cannot see and reads
  // as broken. Cleared by the parent after, so re-picking the same row works.
  React.useEffect(() => {
    if (scrollTo === null) return;
    let frames = 0;
    let raf = 0;
    // WAITING FOR THE FRAME TO HAVE A SIZE IS THE WHOLE TRICK. Picking a row
    // also switches to Diff, which swaps the image `src`; until that loads the
    // plate has no height, every box is zero-tall, and `scrollIntoView` on a
    // zero-tall box silently does nothing at all. The bug is invisible — the
    // row highlights, the box highlights, and the frame just does not move —
    // and it only appears when the mode CHANGES, so it survives any amount of
    // testing from inside Diff.
    const tick = () => {
      const el = boxes.current[scrollTo];
      const screen = el?.closest("[data-gl-crt-screen]") as HTMLElement | null;
      if (el && screen && el.getBoundingClientRect().height > 0) {
        // THE FRAME MOVES, THE PAGE DOES NOT. `scrollIntoView` walks every
        // scrollable ancestor, so it also slid the whole view — which pulled
        // the row out from under the pointer, fired its `mouseleave`, and
        // dropped the highlight the click had just set. Scrolling the CRT's own
        // screen is both the narrower action and the one the user asked for.
        const er = el.getBoundingClientRect();
        const sr = screen.getBoundingClientRect();
        screen.scrollTop += er.top - sr.top - (sr.height - er.height) / 2;
        screen.scrollLeft += er.left - sr.left - (sr.width - er.width) / 2;
        onScrolled();
        return;
      }
      // Bounded: an image that never loads must not leave a frame loop running.
      if (frames++ < 30) raf = requestAnimationFrame(tick);
      else onScrolled();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [scrollTo, onScrolled]);

  return (
    <>
      {regions.map((r, i) => (
        <div
          key={`${r.x}:${r.y}:${i}`}
          ref={(el) => {
            boxes.current[i] = el;
          }}
          className="gl-region-box"
          data-active={active === i ? "" : undefined}
          style={{
            left: pctStr(r.x),
            top: pctStr(r.y),
            width: pctStr(r.w),
            height: pctStr(r.h),
          }}
          onMouseEnter={() => onHover(i)}
          onMouseLeave={() => onHover(null)}
          title={`${regionPlace(r)} — ${formatShare(r.share)} of the change`}
        >
          <span className="gl-region-tag">{i + 1}</span>
        </div>
      ))}
    </>
  );
}

/**
 * The ranked list, under the step row.
 *
 * The boxes on the frame say WHERE; this says which of them matters, in words,
 * for a reader who is not currently looking at the frame — the state anybody
 * scanning a run report is in. Rows are buttons: picking one is how you get
 * from "62% of it, top left" to the picture, and it switches to Diff itself
 * rather than leaving the user to work out which mode draws boxes.
 */
function RegionBreakdown({
  diff,
  active,
  onHover,
  onPick,
}: {
  diff: VisualDiff;
  active: number | null;
  onHover: (index: number | null) => void;
  onPick: (index: number) => void;
}) {
  const regions = diff.regions ?? [];
  if (regions.length === 0) return null;
  const omitted = diff.regionsOmitted ?? 0;
  const lead = dominantRegion(regions);

  return (
    <div className="gl-regions">
      <div className="gl-regions-head">
        <span className="gl-regions-line">{regionsLine(regions, omitted)}</span>
        {/* Only when one area really is the answer. A change that is spread
            evenly has no lead to name, and naming one anyway sends the reader
            to look at the wrong thing. Amber, matching the change it is
            pointing at rather than claiming an outcome of its own. */}
        {lead ? (
          <span className="gl-chip-tone" style={toneSurface(TONE.amber)}>
            mostly {regionPlace(lead)}
          </span>
        ) : null}
      </div>
      <div className="gl-regions-list">
        {regions.map((r, i) => (
          <button
            key={`${r.x}:${r.y}:${i}`}
            type="button"
            className="gl-region-row"
            data-active={active === i ? "" : undefined}
            onMouseEnter={() => onHover(i)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(i)}
            onBlur={() => onHover(null)}
            onClick={() => onPick(i)}
            aria-label={`Show area ${i + 1}, ${regionPlace(r)}, ${formatShare(r.share)} of the change`}
          >
            <span className="gl-region-rank">{i + 1}</span>
            <span className="gl-region-place">{regionPlace(r)}</span>
            <span className="gl-region-share">{formatShare(r.share)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Drift — this frame across its recent runs. REDESIGN §6.6.
 *
 * The rest of this screen answers "did this frame change?" for ONE run. Nothing
 * in the app could answer the question that follows: is it changing repeatedly?
 * Those have different fixes. A frame that changed once is a change to look at;
 * a frame over threshold in six of the last ten runs is a baseline nobody
 * re-pinned, and reading it one run at a time makes one standing problem look
 * like six separate small ones.
 *
 * WHAT IT COSTS. One replay read per run in the window, shared with the
 * `["replay", …]` cache the viewer already fills, so the selected run is free
 * and the rest are cached for the session. They are keyed per RUN, not per
 * step, so moving through the steps of a run costs nothing after the first.
 *
 * NOTHING IS DRAWN UNTIL THE WHOLE WINDOW HAS ARRIVED. A partial series has a
 * verdict of its own, and watching it read "drifting" and then settle as the
 * remaining runs land would be worse than a moment of nothing.
 */
function StepDrift({ testId, stepId }: { testId: string; stepId: string }) {
  const summaries = useQuery({ queryKey: ["replays"], queryFn: api.artifacts.list }).data;
  const recent = React.useMemo(
    () =>
      (summaries ?? [])
        .filter((s) => s.testId === testId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, DRIFT_WINDOW),
    [summaries, testId],
  );

  const replays = useQueries({
    queries: recent.map((s) => ({
      queryKey: ["replay", s.testId, s.runId],
      queryFn: () => api.artifacts.getReplay(s.testId, s.runId),
      staleTime: 5 * 60 * 1000,
    })),
  });

  // A strip of one run is not a series, and drawing it would imply it is.
  if (recent.length < 2 || replays.some((r) => r.isPending)) return null;

  const runs: DriftRun[] = replays
    .map((r) => r.data as RunReplay | null)
    .filter((r): r is RunReplay => r !== null)
    .map((r) => ({ runId: r.runId, startedAt: r.startedAt, steps: r.steps }));
  const drift = computeDrift(driftPointsFor(runs, stepId));

  return (
    <div className="gl-drift" data-verdict={drift.verdict}>
      <div className="gl-drift-strip" aria-hidden>
        {drift.points.map((p) => {
          const h = barHeight(p.ratio, drift.peak);
          return (
            <span key={p.runId} className="gl-drift-slot">
              {h === null ? (
                // A gap, not a bar. A run with no reading did not report an
                // identical frame — it reported nothing, and a zero-height bar
                // would be the app making a claim on its behalf.
                <span className="gl-drift-gap" />
              ) : (
                <span
                  className="gl-drift-bar"
                  data-changed={p.changed ? "" : undefined}
                  style={{ height: `${h * 100}%` }}
                />
              )}
            </span>
          );
        })}
      </div>
      <span className="gl-drift-line">{driftLine(drift)}</span>
    </div>
  );
}

/**
 * Wipe and Blink — the two modes that need BOTH frames at once. REDESIGN §6.6.
 *
 * A diff map is exact and nearly useless for triage: it lights every changed
 * pixel with equal weight, so a font-smoothing shift and a button that moved
 * 40px look the same. These put the two frames in the same PLACE instead and
 * let the eye do the comparison it is very good at.
 *
 * BOTH FRAMES GO IN A `CRT` AND NEITHER IS TREATED — the same rule the rest of
 * this screen obeys, and it binds harder here. The whole premise is that any
 * difference the user sees between the two images is a difference in the page;
 * a filter, a blend mode or an opacity on either layer would manufacture one.
 * Wipe therefore CLIPS rather than fading, and Blink swaps a whole frame rather
 * than cross-dissolving. `check:crt-untreated` pins it.
 */
function CompareShot({
  testId,
  runId,
  step,
  mode,
  children,
}: {
  testId: string;
  runId: string;
  step: ReplayStep;
  mode: "wipe" | "blink";
  children?: React.ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const caption = useBaselineCaption(testId, step.stepId);
  const [wipe, setWipe] = React.useState(50);
  const [showBaseline, setShowBaseline] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const boxRef = React.useRef<HTMLDivElement>(null);

  const currentQuery = useQuery({
    queryKey: ["shot", testId, runId, step.screenshot],
    queryFn: () => api.artifacts.readShot(testId, runId, step.screenshot as string),
    enabled: Boolean(step.screenshot),
    staleTime: 5 * 60 * 1000,
  });
  const baselineQuery = useQuery({
    queryKey: ["baselineShot", testId, step.stepId],
    queryFn: () => api.visual.baselineShot(testId, step.stepId),
    staleTime: 5 * 60 * 1000,
  });

  const interval = blinkIntervalMs(reduced);
  React.useEffect(() => {
    // `interval === null` is reduced motion, and it is a MANUAL toggle rather
    // than a stopped one — see `blinkIntervalMs`. Nothing is scheduled; the
    // button below does the swapping.
    if (mode !== "blink" || interval === null) return;
    const t = setInterval(() => setShowBaseline((v) => !v), interval);
    return () => clearInterval(t);
  }, [mode, interval]);

  const current = currentQuery.data;
  const baseline = baselineQuery.data;

  if (currentQuery.isLoading || baselineQuery.isLoading) {
    return <div className="gl-visual-loading" />;
  }
  if (!current || !baseline) {
    // Both modes need both frames by definition, so this says which is missing
    // rather than rendering half a comparison the user would read as a result.
    return (
      <div className="gl-visual-missing">
        <ImageOff aria-hidden="true" />
        <span className="gl-empty-title">
          {current ? "No baseline for this step" : "No screenshot for this step"}
        </span>
        <span className="gl-empty-note">
          Wipe and Blink compare two frames — both have to exist.
        </span>
      </div>
    );
  }

  if (mode === "blink") {
    return (
      <div className="relative flex h-full w-full flex-col items-center justify-center gap-2 overflow-hidden">
        <CRT
          className="gl-visual-frame"
          src={showBaseline ? baseline : current}
          alt={`${showBaseline ? "Baseline" : "Current"} frame for step ${step.index + 1}`}
          // Only under the baseline: the caption describes THAT frame, and
          // leaving it up while the current frame is showing would attribute
          // one frame's provenance to the other twice a second.
          caption={showBaseline ? caption : undefined}
        >
          {children}
        </CRT>
        {/* The label is not decoration: with the frames alternating, "which one
            am I looking at" is otherwise unanswerable, and a user who cannot
            answer it cannot say which direction the change went. */}
        <div className="gl-visual-blink-bar">
          <span className="gl-visual-blink-which">{showBaseline ? "Baseline" : "Current"}</span>
          {interval === null ? (
            <button
              type="button"
              className="gl-cost-edit"
              onClick={() => setShowBaseline((v) => !v)}
            >
              Swap
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
      <div ref={boxRef} className="gl-visual-wipe" data-gl="wipe">
        <CRT
          className="gl-visual-frame"
          src={baseline}
          alt={`Baseline for step ${step.index + 1}`}
          caption={caption}
        >
          {/* On the BASELINE plate, which is the one that is never clipped —
              an overlay on the top frame would be sliced in half by the
              divider, which makes it look like the change stops there. */}
          {children}
        </CRT>
        {/* The current frame on top, clipped. `clip-path` and not opacity: the
            premise of this mode is that any difference on screen is a
            difference in the page, and a partly-transparent layer invents one. */}
        <div
          className="gl-visual-wipe-top"
          style={{ clipPath: `inset(0 ${100 - wipe}% 0 0)` }}
          aria-hidden
        >
          <CRT className="gl-visual-frame" src={current} alt="" />
        </div>
        <div
          className="gl-visual-wipe-handle"
          style={{ left: `${wipe}%` }}
          role="slider"
          tabIndex={0}
          aria-label="Wipe between the current frame and the baseline"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(wipe)}
          aria-valuetext={`${Math.round(wipe)}% current`}
          data-dragging={dragging ? "" : undefined}
          onKeyDown={(e) => {
            const next = wipeAfterKey(wipe, e.key, e.shiftKey);
            if (next === null) return;
            e.preventDefault();
            setWipe(next);
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            setDragging(true);
          }}
          onPointerMove={(e) => {
            if (!dragging) return;
            const box = boxRef.current?.getBoundingClientRect();
            if (box) setWipe(wipeFromPointer(e.clientX, box));
          }}
          onPointerUp={(e) => {
            (e.target as HTMLElement).releasePointerCapture(e.pointerId);
            setDragging(false);
          }}
        />
        {/* Which side is which, on the frame. Without it the mode is a picture
            with a line through it. */}
        <span className="gl-visual-wipe-label gl-visual-wipe-left">Current</span>
        <span className="gl-visual-wipe-label gl-visual-wipe-right">Baseline</span>
      </div>
    </div>
  );
}

function StepScreenshot({
  testId,
  runId,
  step,
  mode,
  children,
}: {
  testId: string;
  runId: string;
  step: ReplayStep;
  mode: ShotMode;
  /** Overlay rendered on top of the image. Handed to `CRT` rather than laid
   *  beside it, because CRT's plate is the one box that IS the image — a
   *  sibling of the bezel is positioned against the pane, which drifts by
   *  however much a tall frame overflows its scroll viewport, i.e. most of it
   *  on any full-page screenshot. */
  children?: React.ReactNode;
}) {
  // Only in `baseline` mode — the caption says what the BASELINE is, and under
  // the current frame or the diff map it would be describing something else.
  const caption = useBaselineCaption(testId, step.stepId);
  // Resolve the image source for the active view mode.
  const file =
    mode === "diff" ? (step.diff?.diffFile ?? null) : mode === "current" ? step.screenshot : null;

  const runShotQuery = useQuery({
    queryKey: ["shot", testId, runId, file],
    queryFn: () => api.artifacts.readShot(testId, runId, file as string),
    enabled: mode !== "baseline" && Boolean(file),
    staleTime: 5 * 60 * 1000,
  });
  const baselineQuery = useQuery({
    queryKey: ["baselineShot", testId, step.stepId],
    queryFn: () => api.visual.baselineShot(testId, step.stepId),
    enabled: mode === "baseline",
    staleTime: 5 * 60 * 1000,
  });

  const query = mode === "baseline" ? baselineQuery : runShotQuery;

  if (mode === "current" && !file) {
    return (
      <div className="gl-visual-missing">
        <ImageOff aria-hidden="true" />
        <span className="gl-empty-title">No screenshot for this step</span>
        <span className="gl-empty-note">
          {step.status === "skipped" || step.status === "unknown"
            ? "This step didn’t run, so nothing was captured."
            : "Assertions and waits aren’t captured, and a capture can be skipped if it failed."}
        </span>
      </div>
    );
  }

  if (query.isLoading) {
    return <div className="gl-visual-loading" />;
  }

  const src = query.data;
  if (!src) {
    return (
      <div className="gl-visual-missing">
        <ImageOff aria-hidden="true" />
        <span className="gl-empty-title">
          {mode === "baseline" ? "No baseline for this step" : "Image not available"}
        </span>
        <span className="gl-empty-note">
          {mode === "baseline"
            ? "This step has no pinned baseline yet."
            : "The artifact may have been pruned by retention."}
        </span>
      </div>
    );
  }

  const alt =
    mode === "baseline"
      ? `Baseline for step ${step.index + 1}`
      : mode === "diff"
        ? `Visual diff for step ${step.index + 1}`
        : `Screenshot for step ${step.index + 1}`;
  // THE BEZEL IS `CRT`, AND WHAT IS INSIDE IT IS NEVER TREATED. This is the one
  // rule in the design system that is about correctness rather than taste, and
  // this screen is the reason it exists: every frame here is EVIDENCE, the whole
  // question being asked is "does this look right?", and an amber cast from our
  // own chrome is indistinguishable from an amber cast in the page under test —
  // a user would file the bug against their own site. The primitive sits at
  // z-index 610, above the global atmosphere at 600, because those overlays are
  // fixed and full-viewport so anything below them is tinted by definition.
  // `check:crt-untreated` pins that nothing here gains a filter or blend mode.
  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
      <CRT
        className="gl-visual-frame"
        src={src}
        alt={alt}
        caption={mode === "baseline" ? caption : undefined}
      >
        {children}
      </CRT>
    </div>
  );
}

// ── Ignore-mask overlay ─────────────────────────────────────────────────
// Masks are stored normalized (0–1), so they position directly as CSS
// percentages over the image regardless of its rendered size.

/** Smallest mask we'll keep, as a fraction of each axis. Anything below this
 *  is almost certainly a stray click rather than a deliberate drag. */
const MIN_MASK_SIZE = 0.005;

/** Normalized 0–1 → a CSS percentage string. */
function pctStr(n: number): string {
  return `${n * 100}%`;
}

function MaskLayer({
  masks,
  editing,
  onAdd,
  onRemove,
}: {
  masks: VisualMask[];
  editing: boolean;
  onAdd: (rect: { x: number; y: number; w: number; h: number }) => void;
  onRemove: (id: string) => void;
}) {
  const [drag, setDrag] = React.useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );

  // Pointer position as a fraction of the image box, clamped so a drag that
  // leaves the image still produces an in-bounds mask.
  const posOf = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  const rectOf = (d: { x0: number; y0: number; x1: number; y1: number }) => ({
    x: Math.min(d.x0, d.x1),
    y: Math.min(d.y0, d.y1),
    w: Math.abs(d.x1 - d.x0),
    h: Math.abs(d.y1 - d.y0),
  });

  const live = drag ? rectOf(drag) : null;

  return (
    <div
      className={`absolute inset-0 ${editing ? "cursor-crosshair" : "pointer-events-none"}`}
      onPointerDown={
        editing
          ? (e) => {
              const p = posOf(e);
              e.currentTarget.setPointerCapture(e.pointerId);
              setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
            }
          : undefined
      }
      onPointerMove={
        editing
          ? (e) => {
              if (!drag) return;
              const p = posOf(e);
              setDrag({ ...drag, x1: p.x, y1: p.y });
            }
          : undefined
      }
      onPointerUp={
        editing
          ? () => {
              if (drag) {
                const r = rectOf(drag);
                if (r.w >= MIN_MASK_SIZE && r.h >= MIN_MASK_SIZE) onAdd(r);
              }
              setDrag(null);
            }
          : undefined
      }
    >
      {masks.map((m) => (
        <div
          key={m.id}
          className="gl-mask-box"
          style={{ left: pctStr(m.x), top: pctStr(m.y), width: pctStr(m.w), height: pctStr(m.h) }}
          title={m.label ?? (m.stepId === null ? "Ignored on every step" : "Ignored on this step")}
        >
          {editing ? (
            <button
              type="button"
              aria-label="Remove ignore region"
              className="gl-mask-box-del"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onRemove(m.id)}
            >
              <X aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ))}
      {live && live.w > 0 && live.h > 0 ? (
        <div
          className="gl-mask-box gl-mask-box-live"
          style={{
            left: pctStr(live.x),
            top: pctStr(live.y),
            width: pctStr(live.w),
            height: pctStr(live.h),
          }}
        />
      ) : null}
    </div>
  );
}

// ── Per-test threshold control ──────────────────────────────────────────
const THRESHOLD_PRESETS = [0, 0.1, 0.5, 1, 5, 10] as const;
const THRESHOLD_LABELS = ["Strict", "Low", "Medium", "High", "Lenient", "Very lenient"] as const;

function nearestPresetIndex(value: number | undefined): number {
  if (value === undefined) return 0;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < THRESHOLD_PRESETS.length; i++) {
    const d = Math.abs(THRESHOLD_PRESETS[i] - value);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * How many of THIS RUN's frames a threshold would flag.
 *
 * Pure and exported so the arithmetic is testable without a slider: the whole
 * value of the readout is that the number is right, and an off-by-one on a
 * boundary ratio is invisible on screen.
 *
 * STRICTLY GREATER, matching the comparator that produced these ratios — a
 * frame exactly AT the threshold is not flagged. Guessing `>=` here would make
 * the preview disagree with the next run by one frame, which is worse than no
 * preview at all because it would be believed.
 */
export function framesOverThreshold(
  steps: { diff?: { ratio?: number } }[],
  thresholdPct: number,
): number {
  return steps.filter((s) => s.diff?.ratio !== undefined && s.diff.ratio * 100 > thresholdPct)
    .length;
}

function ThresholdControl({ testId, steps }: { testId: string; steps: ReplayStep[] }) {
  const qc = useQueryClient();
  const thresholdQuery = useQuery({
    queryKey: ["visualThreshold", testId],
    queryFn: () => api.visual.getThreshold(testId),
  });
  const setThreshold = useMutation({
    mutationFn: (v: number) => api.visual.setThreshold(testId, v),
    onSuccess: (v) => qc.setQueryData(["visualThreshold", testId], v),
  });

  const current = thresholdQuery.data;
  const [index, setIndex] = React.useState(() => nearestPresetIndex(current));
  const lastCommitted = React.useRef<number | null>(null);

  // Keep the slider in sync when the server value changes (e.g. on first load).
  React.useEffect(() => {
    if (current === undefined) return;
    const nearest = nearestPresetIndex(current);
    setIndex(nearest);
    lastCommitted.current = nearest;
  }, [current]);

  const handleChange = (v: number) => {
    setIndex(v);
    if (lastCommitted.current === v) return;
    lastCommitted.current = v;
    setThreshold.mutate(THRESHOLD_PRESETS[v]);
  };

  const pct = THRESHOLD_PRESETS[index];
  const label = THRESHOLD_LABELS[index];

  // DRAWN AGAINST THE ACTUAL FRAMES (REDESIGN §B8). The slider used to be a
  // number with no consequence on screen: "0.20%" says nothing about whether
  // moving it silences the change you are looking at or every change you have.
  // Counting THIS run's frames makes the setting concrete, and it updates from
  // local `index` rather than the committed value so it answers while you drag.
  const flagged = framesOverThreshold(steps, pct);
  const measured = steps.filter((s) => s.diff?.ratio !== undefined).length;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="gl-threshold">
          <span className="gl-threshold-label">Threshold</span>
          {/* A NATIVE RANGE INPUT, styled. The SDK's slider was the last blue
              thing on this screen and blue is not in this palette, but the
              swap is not only about the hue: the readout beside it is the whole
              point of B8's threshold work — it answers WHILE you drag — and a
              row of six preset buttons would turn a drag into six commits. */}
          <input
            type="range"
            className="gl-threshold-range"
            min={0}
            max={THRESHOLD_PRESETS.length - 1}
            step={1}
            value={index}
            disabled={thresholdQuery.isLoading}
            aria-label="Visual comparison threshold"
            aria-valuetext={`${label}, ${pct}%`}
            onChange={(e) => handleChange(Number(e.target.value))}
          />
          <span className="gl-threshold-value">
            {label} · {pct}%
          </span>
          {/* Only once something has been measured. On a run with no captured
              comparison this would read "0 of 0", which looks like a broken
              readout rather than an empty one. */}
          {measured > 0 ? (
            <span className="gl-threshold-readout" data-flagged={flagged > 0 ? "" : undefined}>
              {flagged === 0
                ? `silences all ${measured}`
                : `flags ${flagged} of ${measured}`}
            </span>
          ) : null}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[220px] leading-snug">
        Percent of pixels allowed to change before a step is flagged. Applies to future runs.
      </TooltipContent>
    </Tooltip>
  );
}

// ── Per-step freeform note (Phase 4) ─────────────────────────────────────
function StepAnnotation({
  annotation,
  onSave,
  saving,
}: {
  annotation: Annotation | null;
  onSave: (text: string) => void;
  saving: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(annotation?.text ?? "");

  if (editing) {
    return (
      <div className="gl-visual-note-edit">
        <textarea
          autoFocus
          className="gl-textarea"
          value={draft}
          placeholder="Add a note for this step…"
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="gl-visual-note-actions">
          <Btn tone="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Btn>
          <Btn
            tone="ghost"
            disabled={saving || draft.trim() === (annotation?.text ?? "")}
            onClick={() => {
              onSave(draft);
              setEditing(false);
            }}
          >
            Save
          </Btn>
        </div>
      </div>
    );
  }

  if (!annotation) {
    return (
      <div className="gl-visual-note">
        <Btn
          tone="ghost"
          onClick={() => {
            setDraft("");
            setEditing(true);
          }}
        >
          <MessageSquare aria-hidden="true" />
          Add note
        </Btn>
      </div>
    );
  }

  return (
    <div className="gl-visual-note">
      <span className="gl-visual-note-icon">
        <MessageSquare aria-hidden="true" />
      </span>
      <span className="gl-visual-note-text">{annotation.text}</span>
      <button
        type="button"
        className="gl-icon-btn"
        aria-label="Edit annotation"
        title="Edit annotation"
        onClick={() => {
          setDraft(annotation.text);
          setEditing(true);
        }}
      >
        <Pencil aria-hidden="true" />
      </button>
      <button
        type="button"
        className="gl-icon-btn"
        aria-label="Clear annotation"
        title="Clear annotation"
        disabled={saving}
        onClick={() => onSave("")}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
}


// ── Masks & baselines manager ───────────────────────────────────────────
// Both were previously only reachable one step at a time by scrubbing to the
// step they belong to. This is the per-test view: what's masked, what's pinned,
// and the ability to name, delete, or unpin without hunting for the step.

function MasksBaselinesDialog({
  testId,
  open,
  onOpenChange,
  stepLabelById,
}: {
  testId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** stepId → human label, for naming rows the user can recognize. */
  stepLabelById: Map<string, string>;
}) {
  const qc = useQueryClient();
  const masksQuery = useQuery({
    queryKey: ["visualMasks", testId],
    queryFn: () => api.visual.getMasks(testId),
    enabled: open,
  });
  const baselinesQuery = useQuery({
    queryKey: ["baselines", testId],
    queryFn: () => api.visual.listBaselines(testId),
    enabled: open,
  });
  const masks = masksQuery.data ?? [];
  const baselines = baselinesQuery.data ?? [];

  const saveMasks = useMutation({
    mutationFn: (next: VisualMask[]) => api.visual.setMasks(testId, next),
    onSuccess: (saved) => qc.setQueryData(["visualMasks", testId], saved),
    onError: (err) => toast.error(`Couldn't save ignore regions: ${err}`),
  });
  const clearBaseline = useMutation({
    mutationFn: (stepId: string) => api.visual.clearBaseline(testId, stepId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["baselines", testId] });
      qc.invalidateQueries({ queryKey: ["baselineShot", testId] });
      toast.success("Baseline unpinned. The next capture run will set a new one.");
    },
    onError: (err) => toast.error(`Couldn't unpin the baseline: ${err}`),
  });

  const [labelDraft, setLabelDraft] = React.useState<{ id: string; text: string } | null>(null);
  const commitLabel = () => {
    if (!labelDraft) return;
    const text = labelDraft.text.trim();
    saveMasks.mutate(
      masks.map((m) =>
        m.id === labelDraft.id ? { ...m, ...(text ? { label: text } : { label: undefined }) } : m,
      ),
    );
    setLabelDraft(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="large" title="Masks & baselines">
      <div className="flex flex-col gap-5">
        {/* Ignore regions */}
        <section className="flex flex-col gap-2">
          <span className="gl-section-title">Ignore regions ({masks.length})</span>
          {masks.length === 0 ? (
            <p className="gl-note">
              None yet. Open a captured run, click “Ignore regions”, and drag over anything that
              changes on its own — a clock, a carousel, an ad slot.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {masks.map((m) => (
                <div
                  key={m.id}
                  className="gl-mask-row"
                >
                  {/* Amber: a mask is a CAUTION about the comparison — pixels
                      deliberately not judged — rather than an outcome. */}
                  <SquareDashed className="gl-mini-icon" style={{ color: TONE.amber }} />
                  {labelDraft?.id === m.id ? (
                    <input
                      autoFocus
                      className="gl-input flex-1"
                      value={labelDraft.text}
                      placeholder="Name this region"
                      onChange={(e) => setLabelDraft({ id: m.id, text: e.target.value })}
                      onBlur={commitLabel}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitLabel();
                        if (e.key === "Escape") setLabelDraft(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="gl-mono-value flex-1 text-left"
                      style={m.label ? undefined : { color: "var(--gl-tx-3)" }}
                      onClick={() => setLabelDraft({ id: m.id, text: m.label ?? "" })}
                      title="Rename"
                    >
                      {m.label ?? "Unnamed region"}
                    </button>
                  )}
                  <span className="gl-chip">
                    {m.stepId === null
                      ? "All steps"
                      : (stepLabelById.get(m.stepId) ?? "One step")}
                  </span>
                  <span className="gl-mask-size">
                    {Math.round(m.w * 100)}×{Math.round(m.h * 100)}%
                  </span>
                  <button
                    type="button"
                    className="gl-icon-btn"
                    aria-label="Delete ignore region"
                    onClick={() => saveMasks.mutate(masks.filter((x) => x.id !== m.id))}
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Pinned baselines */}
        <section className="flex flex-col gap-2">
          <span className="gl-section-title">Pinned baselines ({baselines.length})</span>
          {baselines.length === 0 ? (
            <p className="gl-note">
              None yet. The first run that captures screenshots pins one per step.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {baselines.map((b) => (
                <div
                  key={b.stepId}
                  className="gl-mask-row"
                >
                  <Stamp className="gl-mini-icon" style={{ color: "var(--gl-tx-3)" }} />
                  <code className="gl-mono-value flex-1" title={b.label}>
                    {b.label}
                  </code>
                  {b.rect ? (
                    <span className="gl-chip">has geometry</span>
                  ) : null}
                  <span className="gl-mask-size">{fmtDateTime(b.at)}</span>
                  <Btn
                    className="shrink-0"
                    disabled={clearBaseline.isPending}
                    onClick={() => clearBaseline.mutate(b.stepId)}
                  >
                    Unpin
                  </Btn>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Dialog>
  );
}


// ── Re-run comparison (live re-execution) ───────────────────────────────
// Re-executing a past run only pays off if you can see what MOVED, so the
// result is framed as a then-vs-now delta per step rather than a fresh
// pass/fail. Note the deliberate wording on "changed since": a step that
// worked before and doesn't now might be a regression OR environment drift
// (site changed, auth expired, data gone) — we show the evidence and don't
// claim to know which.

/** The five deltas, and the three that report an outcome. `No result` is the
 *  absence of one — the two runs did not cover the same step — so it stays
 *  neutral rather than borrowing a hue to say nothing. */
function deltaChip(delta: StepDelta): { tone?: "phos" | "amber" | "red"; label: string } {
  switch (delta) {
    case "stable":
      return { tone: "phos", label: "Same" };
    case "fixed":
      return { tone: "phos", label: "Now passing" };
    case "changed-since":
      return { tone: "amber", label: "Changed since" };
    case "still-failing":
      return { tone: "red", label: "Still failing" };
    default:
      return { label: "No result" };
  }
}

function RunComparisonDialog({
  comparison,
  open,
  onOpenChange,
}: {
  comparison: RunComparison | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="large" title="Re-run comparison">
      {!comparison ? (
        <p className="gl-note">
          The comparison isn’t available — one of the two runs’ artifacts may have been pruned by
          retention.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {comparison.changedSinceCount > 0 ? (
              <span className="gl-chip-tone" style={toneSurface(TONE.amber)}>
                {comparison.changedSinceCount} changed since
              </span>
            ) : (
              <span className="gl-chip-tone" style={toneSurface(TONE.phos)}>
                Nothing broke
              </span>
            )}
            {comparison.fixedCount > 0 ? (
              <span className="gl-chip-tone" style={toneSurface(TONE.phos)}>
                {comparison.fixedCount} now passing
              </span>
            ) : null}
          </div>
          {comparison.changedSinceCount > 0 ? (
            <p className="gl-notice" style={{ boxShadow: insetRail(TONE.amber) }}>
              <span className="gl-visual-notice-icon">
                <TriangleAlert aria-hidden="true" />
              </span>
              <span>
                These steps worked in the original run and don’t now. That can be a real regression
                or environment drift — the site changed, a login expired, test data is gone. Compare
                the screenshots before deciding.
              </span>
            </p>
          ) : null}
          {comparison.stepsDiverged ? (
            <p className="gl-notice" style={{ boxShadow: insetRail(TONE.amber) }}>
              <span className="gl-visual-notice-icon">
                <TriangleAlert aria-hidden="true" />
              </span>
              <span>
                The two runs don’t cover the same steps, so some rows have nothing to compare
                against.
              </span>
            </p>
          ) : null}
          <div className="flex flex-col gap-1">
            {comparison.steps.map((s) => {
              const chip = deltaChip(s.delta);
              return (
                <div key={s.stepId} className="gl-compare-row">
                  <code className="gl-mono-value flex-1" title={s.label}>
                    {s.label}
                  </code>
                  <span className="gl-compare-move">
                    {statusLabel(s.before)} → {statusLabel(s.after)}
                  </span>
                  {s.visual === "changed" ? (
                    <span
                      className="gl-chip-tone"
                      style={toneSurface(TONE.amber)}
                      title="This step's screenshot changed too"
                    >
                      <Eye className="gl-mini-icon" aria-label="Screenshot changed too" />
                    </span>
                  ) : null}
                  <span
                    className={chip.tone ? "gl-chip-tone" : "gl-chip"}
                    style={chip.tone ? toneSurface(TONE[chip.tone]) : undefined}
                  >
                    {chip.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ── Right pane: the scrubber/timeline for one run ───────────────────────
function ReplayViewer({ summary }: { summary: RunReplaySummary }) {
  const qc = useQueryClient();
  const replayQuery = useQuery<RunReplay | null>({
    queryKey: ["replay", summary.testId, summary.runId],
    queryFn: () => api.artifacts.getReplay(summary.testId, summary.runId),
  });
  const replay = replayQuery.data;

  const annotationsQuery = useQuery({
    queryKey: ["annotations", summary.testId, summary.runId],
    queryFn: () => api.annotations.list(summary.testId, summary.runId),
  });
  const annotationsByStep = React.useMemo(() => {
    const map = new Map<string, Annotation>();
    for (const a of annotationsQuery.data ?? []) map.set(a.stepId, a);
    return map;
  }, [annotationsQuery.data]);
  const upsertAnnotation = useMutation({
    mutationFn: ({ stepId, text }: { stepId: string; text: string }) =>
      api.annotations.upsert(summary.testId, summary.runId, stepId, text),
    onSuccess: (saved, { stepId }) => {
      qc.setQueryData<Annotation[]>(["annotations", summary.testId, summary.runId], (prev) => {
        const rest = (prev ?? []).filter((a) => a.stepId !== stepId);
        return saved ? [...rest, saved] : rest;
      });
    },
  });

  // ── Ignore masks (per test, applied on the next capture run) ──────────
  const masksQuery = useQuery({
    queryKey: ["visualMasks", summary.testId],
    queryFn: () => api.visual.getMasks(summary.testId),
  });
  const allMasks = React.useMemo(() => masksQuery.data ?? [], [masksQuery.data]);
  const saveMasks = useMutation({
    mutationFn: (masks: VisualMask[]) => api.visual.setMasks(summary.testId, masks),
    onSuccess: (saved) => qc.setQueryData(["visualMasks", summary.testId], saved),
    onError: (err) => toast.error(`Couldn't save ignore regions: ${err}`),
  });
  // Steps compared element-scoped rather than page-wide (component-level).
  const elementStepsQuery = useQuery({
    queryKey: ["visualElementSteps", summary.testId],
    queryFn: () => api.visual.getElementSteps(summary.testId),
  });
  const elementSteps = React.useMemo(
    () => new Set(elementStepsQuery.data ?? []),
    [elementStepsQuery.data],
  );
  const setElementStep = useMutation({
    mutationFn: ({ stepId, element }: { stepId: string; element: boolean }) =>
      api.visual.setElementStep(summary.testId, stepId, element),
    onSuccess: (saved) => qc.setQueryData(["visualElementSteps", summary.testId], saved),
    onError: (err) => toast.error(`Couldn't change comparison scope: ${err}`),
  });

  const [managerOpen, setManagerOpen] = React.useState(false);
  // Live re-execution: kick off a re-run of THIS run's recorded steps, then
  // show the then-vs-now delta once it lands.
  const [rerunning, setRerunning] = React.useState(false);
  const [comparison, setComparison] = React.useState<RunComparison | null>(null);
  const [comparisonOpen, setComparisonOpen] = React.useState(false);
  const pendingRerun = React.useRef<string | null>(null);

  const startRerun = async () => {
    setRerunning(true);
    try {
      await api.runner.replayRun(summary.testId, summary.runId);
      pendingRerun.current = summary.runId;
      toast.success("Re-running this run — the comparison opens when it finishes.");
    } catch (err) {
      setRerunning(false);
      toast.error(String(err));
    }
  };

  // The re-run reports completion through the same runs:changed push the rest
  // of the view already listens to; find the newest run tagged as a re-run of
  // this one and compare against it.
  React.useEffect(() => {
    return api.on("runs:changed", () => {
      const base = pendingRerun.current;
      if (!base) return;
      void (async () => {
        const runs = await api.runs.list();
        const replayRun = runs.find((r) => r.replayOfRunId === base);
        if (!replayRun) return;
        pendingRerun.current = null;
        setRerunning(false);
        setComparison(await api.runner.compareRuns(summary.testId, base, replayRun.id));
        setComparisonOpen(true);
      })();
    });
  }, [summary.testId]);
  const [masking, setMasking] = React.useState(false);
  // New masks default to this step only; the toolbar switch widens them to the
  // whole test (for page chrome like a clock that appears on every screenshot).
  const [maskAllSteps, setMaskAllSteps] = React.useState(false);

  const [current, setCurrent] = React.useState(0);
  const [mode, setMode] = React.useState<ShotMode>("current");
  // Shared between the boxes on the frame and the ranked list below it: they
  // are two views of one set, and highlighting in only one direction reads as
  // the list being decorative. Keyed by the step that owns it — see `setActive`.
  const [activeRegion, setActiveRegion] = React.useState<{
    stepId: string;
    index: number;
  } | null>(null);
  /** A box the list asked to be shown. One-shot: cleared once scrolled to. */
  const [scrollToRegion, setScrollToRegion] = React.useState<number | null>(null);
  // Declared HERE, with the other hooks, because this component early-returns
  // twice below (loading, and no replay) — a `useCallback` after those is a
  // conditional hook, which React rejects outright and which took the whole
  // view down in the preview when this was first written further down.
  // Stable, because it is an effect dependency in `RegionBoxes`: an inline
  // arrow re-runs the scroll on every render and fights the user's own
  // scrolling.
  const clearRegionScroll = React.useCallback(() => setScrollToRegion(null), []);
  // Step IDs whose baseline was accepted in this session — used to hide the
  // per-step "Accept New Baseline" button after a run- or step-level accept.
  const [acceptedSteps, setAcceptedSteps] = React.useState<Set<string>>(() => new Set());
  // Which step the compose dialog is filing. One at a time — a visual change is
  // one defect on one step, and a bulk send would file issues nobody looked at.
  const [sendingStepId, setSendingStepId] = React.useState<string | null>(null);
  const onSendToTracker = (stepId: string) => setSendingStepId(stepId);
  // When a run first loads, jump straight to the failure — the main debugging
  // value — or to the first step for a passing run. Guard on runId so later
  // replay mutations (e.g. accepting a baseline) don't yank the user away from
  // the step they're on.
  const jumpedRunId = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!replay || jumpedRunId.current === replay.runId) return;
    jumpedRunId.current = replay.runId;
    setAcceptedSteps(new Set());
    setCurrent(replay.failedIndex ?? 0);
  }, [replay]);

  const steps = replay?.steps ?? [];

  // The frame rail's filter (B8). UP HERE WITH THE OTHER HOOKS, above the
  // `if (!replay || steps.length === 0)` early return below — a `useState`
  // placed after it runs on some renders and not others, which React reports as
  // "Rendered more hooks than during the previous render" and which takes the
  // whole view down. Nothing static caught that: type-check, lint and
  // `check:renderer-classes` were all green on the broken version, and only
  // opening the screen showed it.
  const [changedOnly, setChangedOnly] = React.useState(false);

  const clamp = React.useCallback(
    (i: number) => Math.max(0, Math.min(steps.length - 1, i)),
    [steps.length],
  );

  const patchReplay = React.useCallback(
    (next: RunReplay | null) => {
      if (!next) return;
      qc.setQueryData(["replay", summary.testId, summary.runId], next);
      // The baseline changed, so cached baseline images are stale.
      qc.invalidateQueries({ queryKey: ["baselineShot", summary.testId] });
      qc.invalidateQueries({ queryKey: ["replays"] });
    },
    [qc, summary.testId, summary.runId],
  );

  const [acceptedA11y, setAcceptedA11y] = React.useState<Set<string>>(new Set());
  const acceptA11yStep = useMutation({
    mutationFn: (stepId: string) => api.a11y.acceptStep(summary.testId, summary.runId, stepId),
    onSuccess: (replay, stepId) => {
      patchReplay(replay);
      setAcceptedA11y((prev) => new Set(prev).add(stepId));
      toast.success("Accessibility issues accepted for this step.");
    },
  });
  const acceptA11yRun = useMutation({
    mutationFn: () => api.a11y.acceptRun(summary.testId, summary.runId),
    onSuccess: (replay) => {
      patchReplay(replay);
      toast.success("Accessibility issues accepted for this run.");
    },
  });

  const acceptStep = useMutation({
    mutationFn: (stepId: string) => api.visual.acceptStep(summary.testId, summary.runId, stepId),
    onSuccess: (replay, stepId) => {
      patchReplay(replay);
      setAcceptedSteps((prev) => new Set(prev).add(stepId));
      toast.success("Screenshot pinned as new baseline. Logged in Stats.");
    },
  });
  const acceptVisualRun = useMutation({
    mutationFn: () => api.visual.acceptRun(summary.testId, summary.runId),
    onSuccess: (replay) => {
      patchReplay(replay);
      // Every step is pinned, so hide every per-step accept button at once —
      // the buttons are keyed off this set and the replay's diffs now read
      // "match", which would otherwise leave them offering a no-op.
      setAcceptedSteps(new Set(steps.map((s) => s.stepId)));
      toast.success("Every screenshot in this run pinned as the new baseline. Logged in Stats.");
    },
  });

  // Waving a banner off, as opposed to signing off on what it reports. The
  // undo is not a nicety: dismissing is one click on a control that sits beside
  // an irreversible one, and without a way back the two read as equally
  // dangerous.
  const restoreNotice = useMutation({
    mutationFn: (kind: RunNoticeKind) =>
      api.artifacts.restoreNotice(summary.testId, summary.runId, kind),
    onSuccess: (replay) => patchReplay(replay),
  });
  const dismissNotice = useMutation({
    mutationFn: (kind: RunNoticeKind) =>
      api.artifacts.dismissNotice(summary.testId, summary.runId, kind),
    onSuccess: (replay, kind) => {
      patchReplay(replay);
      toast.success(
        kind === "visual"
          ? "Visual changes dismissed for this run."
          : "Accessibility issues dismissed for this run.",
        {
          description: "Nothing was accepted — the findings are still on the run's steps.",
          action: {
            label: "Undo",
            onClick: () => restoreNotice.mutate(kind),
          },
        },
      );
    },
    onError: (err) => toast.error(`Couldn't dismiss: ${err}`),
  });

  if (replayQuery.isLoading) {
    return (
      <Panel title="Replay" className="gl-visual-viewer">
        <div className="gl-visual-loading" />
      </Panel>
    );
  }
  if (!replay || steps.length === 0) {
    return (
      <Panel title="Replay" className="gl-visual-viewer">
        <div className="gl-empty">
          <span className="gl-empty-title">Replay unavailable</span>
          <span className="gl-empty-note">
            This run’s artifacts couldn’t be loaded. They may have been removed.
          </span>
        </div>
      </Panel>
    );
  }

  const idx = clamp(current);
  const step = steps[idx];

  // A region highlight is an INDEX into ONE step's boxes, so it is stored with
  // the step it belongs to and read back only for that step. The obvious
  // alternative — an index plus an effect that clears it on step change — is a
  // hook below two early returns in this component, which React rejects
  // outright ("rendered more hooks than during the previous render") and which
  // took down the whole view in the preview. Carrying the owner makes a stale
  // highlight simply not match, with nothing to remember to clear.
  const activeIndex = activeRegion?.stepId === step.stepId ? activeRegion.index : null;
  const setActive = (index: number | null) =>
    setActiveRegion(index === null ? null : { stepId: step.stepId, index });
  // Test-wide masks (stepId null) plus any pinned to this step.
  const stepMasks = allMasks.filter((m) => m.stepId === null || m.stepId === step.stepId);
  const changedCount = steps.filter((s) => s.diff?.state === "changed").length;
  // The SELECTED frame is always kept, even when it does not match the filter:
  // dropping it from the rail while the viewer above still shows it would leave
  // the two disagreeing, and the user with no handle to move off it.
  const visibleSteps =
    changedOnly && changedCount > 0
      ? steps.filter((s) => s.diff?.state === "changed" || s.index === idx)
      : steps;
  const a11yCount = countA11ySteps(steps);
  // Read off the replay, not component state: the banner has to stay gone after
  // the user selects another run and comes back, which is where a local flag
  // would quietly reset.
  const dismissed = new Set(replay.dismissedNotices ?? []);
  const canDiff = Boolean(step.diff?.diffFile);
  const hasBaselineView =
    step.diff !== undefined && step.diff.state !== "unable" && Boolean(step.screenshot);

  // Reset the view mode when moving to a step that can't show the active mode.
  const effectiveMode: ShotMode =
    (mode === "diff" && !canDiff) || (mode === "baseline" && !hasBaselineView) ? "current" : mode;

  // WHAT THE RUN IS, IN THE PANEL HEADER — the verdict, the findings and the
  // stepper, all in the `right` slot.
  //
  // They were in the tool band below, and the band's width then depended on the
  // run's OUTCOME: a run with findings added a chip, which was enough to push
  // "Masks & baselines" onto a second line. A toolbar that reflows when a test
  // starts failing is a toolbar whose controls move exactly when someone is
  // reaching for them. Up here the two chips displace the test NAME instead,
  // which is the one cell in this design allowed to give — `.gl-panel-id`
  // truncates by definition — while `.gl-panel-right` cannot shrink, so the
  // verdict is never the thing that goes.
  const headline = (
    <>
      <StatusChip tone={replay.status === "passed" ? "phos" : "red"}>{replay.status}</StatusChip>
      {/* Amber, not red: frames moved and the run still passed. It is the same
          claim the frame rail makes about each one individually. */}
      {changedCount > 0 ? (
        <span className="gl-chip-tone" style={toneSurface(TONE.amber)}>
          {changedCount} visual {changedCount === 1 ? "change" : "changes"}
        </span>
      ) : null}
      <div className="gl-visual-stepper">
        <button
          type="button"
          className="gl-icon-btn"
          aria-label="Previous step"
          disabled={idx <= 0}
          onClick={() => setCurrent((c) => clamp(c - 1))}
        >
          <ChevronLeft aria-hidden="true" />
        </button>
        <span className="gl-visual-stepper-count">
          {idx + 1} / {steps.length}
        </span>
        <button
          type="button"
          className="gl-icon-btn"
          aria-label="Next step"
          disabled={idx >= steps.length - 1}
          onClick={() => setCurrent((c) => clamp(c + 1))}
        >
          <ChevronRight aria-hidden="true" />
        </button>
      </div>
    </>
  );

  return (
    <Panel
      title="Replay"
      // The time joins the name rather than standing beside the chips: together
      // they are what this panel is ABOUT — that test, on that run — which is
      // exactly what the `id` slot is for, and it means the timestamp truncates
      // with the name instead of competing with the verdict for the space. The
      // run list on the left carries the same time per row, so nothing is lost
      // when a narrow window eats it.
      id={`${replay.testName} · ${fmtDateTime(replay.startedAt)}`}
      right={headline}
      className="gl-visual-viewer"
    >
      <div
        className="gl-visual-body"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            setCurrent((c) => clamp(c - 1));
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            setCurrent((c) => clamp(c + 1));
          }
        }}
      >
      {/* The tool band — WHAT YOU CAN DO to this run, and nothing about what it
          found. Its width is now the same on every run, which is the point: the
          threshold reads from the left, the two buttons sit at the right, and
          neither moves because a frame changed. */}
      <div className="gl-visual-head">
        <ThresholdControl testId={summary.testId} steps={steps} />
        <div className="gl-visual-head-tools">
          <Btn
            tone="ghost"
            disabled={rerunning}
            onClick={startRerun}
            title="Re-execute this run's recorded steps against the live site"
          >
            <RefreshCw className={rerunning ? "animate-spin" : undefined} aria-hidden="true" />
            {rerunning ? "Re-running…" : "Re-run"}
          </Btn>
          <Btn tone="ghost" onClick={() => setManagerOpen(true)}>
            Masks &amp; baselines
          </Btn>
        </div>
      </div>

      <RunComparisonDialog
        comparison={comparison}
        open={comparisonOpen}
        onOpenChange={setComparisonOpen}
      />
      <MasksBaselinesDialog
        testId={summary.testId}
        open={managerOpen}
        onOpenChange={setManagerOpen}
        stepLabelById={new Map(steps.map((st) => [st.stepId, st.label]))}
      />

      {/* THE THREE NOTICES, in one band. A run can carry all three at once — it
          failed, frames changed, and axe found something — and each is a
          `.gl-notice` with an inset rail in the tone the finding takes, rather
          than the SDK callout's filled rounded box. Three of those stacked over
          a screenshot is a wall of colour above the one thing this screen
          exists to show. */}
      {replay.failedIndex !== null || (changedCount > 0 && !dismissed.has("visual")) ||
      (a11yCount > 0 && !dismissed.has("a11y")) ? (
        <div className="gl-visual-notices">
          {replay.failedIndex !== null ? (
            <div className="gl-notice gl-visual-notice" style={{ boxShadow: insetRail(TONE.red) }}>
              <span className="gl-visual-notice-icon">
                <TriangleAlert aria-hidden="true" />
              </span>
              <div className="gl-visual-notice-body">
                <span>
                  Run failed at step {replay.failedIndex + 1}:{" "}
                  <code className="gl-mono-value">{steps[replay.failedIndex]?.label}</code>
                </span>
                {idx !== replay.failedIndex ? (
                  <Btn tone="ghost" onClick={() => setCurrent(replay.failedIndex as number)}>
                    Jump to failure
                  </Btn>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Two exits, and they mean different things — which is the reason
              both are here. "Accept all" REPINS every baseline and changes what
              every later run compares against; dismissing changes nothing but
              the notice. Offering only the first would have made signing off
              blind the cheapest way to clear the screen — so the accept stays
              `ghost`, and the affirmative tone is spent on the per-step button
              this very sentence points at. */}
          {changedCount > 0 && !dismissed.has("visual") ? (
            <div className="gl-notice gl-visual-notice" style={{ boxShadow: insetRail(TONE.amber) }}>
              <span className="gl-visual-notice-icon">
                <Eye aria-hidden="true" />
              </span>
              <div className="gl-visual-notice-body">
                <span>
                  Visual change detected in {changedCount} {changedCount === 1 ? "step" : "steps"}{" "}
                  (over {fmtPct((replay.visualThreshold ?? 0) / 100)} threshold). Use the per-step
                  "Accept New Baseline" button to re-pin a step.
                </span>
                <AlertDialog
                  trigger={
                    <Btn tone="ghost" disabled={acceptVisualRun.isPending}>
                      <Stamp aria-hidden="true" />
                      Accept all for this run
                    </Btn>
                  }
                  title="Pin every screenshot in this run as the new baseline?"
                  description="Every step's current screenshot replaces its baseline, including steps that matched. Later runs are compared against these frames, so anything wrong in them becomes the expected result."
                  confirmLabel="Accept all"
                  confirmVariant="accent"
                  onConfirm={() => acceptVisualRun.mutate()}
                />
              </div>
              <button
                type="button"
                className="gl-icon-btn gl-visual-notice-dismiss"
                aria-label="Dismiss visual changes for this run"
                onClick={() => dismissNotice.mutate("visual")}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ) : null}

          {/* Accessibility, as its own notice rather than folded into the visual
              one: they are different kinds of finding, and a run can easily have
              one without the other. Never affects the run's pass/fail, which is
              why it is amber and not red. */}
          {a11yCount > 0 && !dismissed.has("a11y") ? (
            <div className="gl-notice gl-visual-notice" style={{ boxShadow: insetRail(TONE.amber) }}>
              <span className="gl-visual-notice-icon">
                <Accessibility aria-hidden="true" />
              </span>
              <div className="gl-visual-notice-body">
                <span>
                  {a11yCount} {a11yCount === 1 ? "step has" : "steps have"} accessibility issues that
                  aren't accepted yet. This doesn't affect whether the run passed.
                </span>
                <AlertDialog
                  trigger={
                    <Btn tone="ghost" disabled={acceptA11yRun.isPending}>
                      <Stamp aria-hidden="true" />
                      Accept all for this run
                    </Btn>
                  }
                  title="Accept every accessibility issue in this run?"
                  description="They stop being flagged on future runs. Use this to establish a starting point on a site with pre-existing issues — new problems introduced later will still show up."
                  confirmLabel="Accept all"
                  confirmVariant="accent"
                  onConfirm={() => acceptA11yRun.mutate()}
                />
              </div>
              <button
                type="button"
                className="gl-icon-btn gl-visual-notice-dismiss"
                aria-label="Dismiss accessibility issues for this run"
                onClick={() => dismissNotice.mutate("a11y")}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* The stage */}
      <div className="gl-visual-stage">
        {/* ONE ROW HOLDS BOTH CONTROLS, and that is what stops them colliding.
            They used to be two absolutely-positioned corners — the mask toggle
            pinned left, the compare switch pinned right — which is fine until
            the stage is narrower than the two together. At this app's own
            minimum window they overlapped by 12px, and since both sit at the
            same z-index the later one won: the right-hand edge of "Ignore
            regions" was painted over by "Current" and stopped taking clicks.
            A flex row that wraps cannot do that at any width.

            The ROW takes no pointer events and its children take them back:
            a full-width transparent bar over the frame would otherwise swallow
            the start of every ignore-region drag along the top of the image. */}
        <div className="gl-visual-stage-chrome">
          {/* Ignore-region editor toggle */}
          {step.screenshot ? (
            <div className="gl-visual-stage-tools">
              <Btn
                tone="ghost"
                aria-pressed={masking}
                onClick={() => setMasking((v) => !v)}
                title="Exclude regions of the page from visual diffing"
              >
                <SquareDashed aria-hidden="true" />
                {masking ? "Done" : "Ignore regions"}
              </Btn>
              {masking ? (
                <label className="gl-visual-mask-all">
                  <input
                    type="checkbox"
                    checked={maskAllSteps}
                    onChange={(e) => setMaskAllSteps(e.target.checked)}
                  />
                  Apply to all steps
                </label>
              ) : null}
            </div>
          ) : null}
          {/* View-mode toggle — only when there's a baseline to compare against */}
          {hasBaselineView ? (
            // ABOVE THE BEZEL. `CRT` sits at z-index 610 so the global
            // atmosphere overlays (600) cannot tint a frame the user is judging;
            // this control is chrome laid ON that frame, so it has to clear the
            // same bar. At `z-10` it rendered behind the bezel and vanished —
            // which is not a styling nit, it is the compare-mode switch on the
            // compare screen. The bar is on the row above now; the class stays
            // because it is what pins the switch to the trailing edge, and what
            // `visual-view.test.tsx` reads to prove it still opts in.
            <div className="gl-visual-modes">
              {/* The theme's `Segmented`: its active item is NEUTRAL, which
                  matters more here than anywhere else in the app. This control
                  sits on top of a frame the user is being asked to judge, and an
                  accent-coloured segment over a screenshot is a colour the page
                  did not put there. */}
              <Segmented
                label="Compare mode"
                value={effectiveMode}
                onChange={(v) => setMode(v as ShotMode)}
                options={[
                  { value: "current", label: "Current" },
                  { value: "baseline", label: "Baseline" },
                  ...(canDiff ? [{ value: "diff", label: "Diff" }] : []),
                  // §6.6. Offered only when there is a CURRENT frame to compare
                  // against the baseline — `hasBaselineView` already guarantees
                  // the other half. A mode that opens on "both have to exist"
                  // is a mode that should not have been offered.
                  ...(step.screenshot
                    ? [
                        { value: "wipe", label: "Wipe" },
                        { value: "blink", label: "Blink" },
                      ]
                    : []),
                ]}
              />
            </div>
          ) : null}
        </div>
          {/* The overlays that ride ON the frame — the element-scope box and
              the mask layer — are the same in every mode, so they are built
              once and handed to whichever frame component the mode selects.
              Duplicating them into both branches is how the two would drift. */}
          {(() => {
            const overlays = (
              <>
                  {step.rect && elementSteps.has(step.stepId) ? (
                    <div
                      className="gl-element-box"
                      style={{
                        left: pctStr(step.rect.x),
                        top: pctStr(step.rect.y),
                        width: pctStr(step.rect.w),
                        height: pctStr(step.rect.h),
                      }}
                      title="Only this region is compared"
                    />
                  ) : null}
                  {/* §6.6's measured boxes, on the diff map only — see
                      `RegionBoxes`. */}
                  {effectiveMode === "diff" && step.diff?.regions ? (
                    <RegionBoxes
                      regions={step.diff.regions}
                      active={activeIndex}
                      onHover={setActive}
                      scrollTo={scrollToRegion}
                      onScrolled={clearRegionScroll}
                    />
                  ) : null}
                  <MaskLayer
                    masks={stepMasks}
                    editing={masking}
                    onAdd={(rect) =>
                      saveMasks.mutate([
                        ...allMasks,
                        {
                          id: crypto.randomUUID(),
                          stepId: maskAllSteps ? null : step.stepId,
                          ...rect,
                        },
                      ])
                    }
                    onRemove={(id) => saveMasks.mutate(allMasks.filter((m) => m.id !== id))}
                  />
              </>
            );
            return effectiveMode === "wipe" || effectiveMode === "blink" ? (
              <CompareShot
                testId={summary.testId}
                runId={summary.runId}
                step={step}
                mode={effectiveMode}
              >
                {overlays}
              </CompareShot>
            ) : (
              <StepScreenshot
                testId={summary.testId}
                runId={summary.runId}
                step={step}
                mode={effectiveMode}
              >
                {overlays}
              </StepScreenshot>
            );
          })()}
      </div>
      {masking ? (
        <span className="gl-note gl-visual-hint">
          Drag on the screenshot to exclude a region from visual diffing. Regions are ignored from
          the next capture run onward — this run's results don't change.
        </span>
      ) : null}

      {/* Current step detail */}
      <div className="gl-visual-step">
        <StatusIcon status={step.status} />
        <span className="gl-chip">{step.type}</span>
        <code className="gl-mono-value flex-1" title={step.label}>
          {step.label}
        </code>
        {/* Comparison scope — only meaningful for a step with a captured
            element rectangle to crop to. */}
        {step.screenshot && step.rect ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Segmented
                label="Comparison scope"
                value={elementSteps.has(step.stepId) ? "element" : "page"}
                onChange={(v) =>
                  setElementStep.mutate({ stepId: step.stepId, element: v === "element" })
                }
                options={[
                  { value: "page", label: "Page" },
                  { value: "element", label: "Element" },
                ]}
              />
            </TooltipTrigger>
            <TooltipContent>
              Compare the whole page, or only the element this step acted on. Applies from the next
              capture run.
            </TooltipContent>
          </Tooltip>
        ) : null}
        {step.diff ? <DiffBadge diff={step.diff} /> : null}
        {step.a11y ? <A11yBadge result={step.a11y} /> : null}
        {/* Beside "Accept New Baseline", because they are the two answers to
            the same question: this changed, was it meant to? Accepting says
            yes; filing says no, and hands someone the three pictures that
            show it. Only offered for a CHANGED step — there is nothing to
            report about a step that matched. */}
        <div className="gl-visual-step-tools">
          {step.diff?.state === "changed" && onSendToTracker ? (
            <Btn
              tone="ghost"
              aria-label={`Send step ${step.index + 1}'s visual change to the issue tracker`}
              onClick={() => onSendToTracker(step.stepId)}
            >
              <Send aria-hidden="true" />
              Send
            </Btn>
          ) : null}
          {step.screenshot && step.diff?.state === "changed" && !acceptedSteps.has(step.stepId) ? (
            // THE ONE `go` ON THIS SCREEN. Phosphor means "this is the right
            // answer", and re-pinning a baseline is the affirmative action the
            // whole view is built to reach — every notice above points at this
            // button by name. The bulk accepts stay `ghost` so that signing off
            // on a run blind is never the brightest thing on screen.
            <AlertDialog
              trigger={
                <Btn tone="go" disabled={acceptStep.isPending}>
                  <Stamp aria-hidden="true" />
                  Accept New Baseline
                </Btn>
              }
              title="Accept this screenshot as the new baseline?"
              description="This pins this step's screenshot as the new comparison standard for future runs. The button will be hidden afterward. This is logged in Stats."
              confirmLabel="Accept"
              confirmVariant="accent"
              onConfirm={() => acceptStep.mutate(step.stepId)}
            />
          ) : (
            <span className="gl-visual-step-state">{statusLabel(step.status)}</span>
          )}
        </div>
      </div>

      {/* Drift, under the step row and above everything the step row leads to:
          it is context for the badge directly above it, not a finding of its
          own. Offered only for a step that was actually compared — a step with
          no `diff` has no series to have. */}
      {step.diff ? (
        <RegionBreakdown
          diff={step.diff}
          active={activeIndex}
          onHover={setActive}
          onPick={(index) => {
            setMode("diff");
            setActive(index);
            setScrollToRegion(index);
          }}
        />
      ) : null}

      {step.diff ? <StepDrift testId={summary.testId} stepId={step.stepId} /> : null}

      <IssueComposeDialog
        source={
          sendingStepId
            ? {
                kind: "visual",
                testId: summary.testId,
                runId: summary.runId,
                stepId: sendingStepId,
              }
            : null
        }
        open={sendingStepId !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setSendingStepId(null);
        }}
        onFiled={(issue) => toast.success(`Filed as ${issue.identifier}.`)}
        onCommented={(link) => toast.success(`Added to ${link.identifier}.`)}
      />

      {/* Accessibility, under the step row: reported, never fatal — the run's
          pass/fail is decided purely by its assertions. */}
      {step.a11y ? (
        <A11yDetail
          result={step.a11y}
          accepting={acceptA11yStep.isPending}
          accepted={acceptedA11y.has(step.stepId)}
          onAccept={() => acceptA11yStep.mutate(step.stepId)}
        />
      ) : null}

      {/* Step note (Phase 4) */}
      <StepAnnotation
        key={step.stepId}
        annotation={annotationsByStep.get(step.stepId) ?? null}
        saving={upsertAnnotation.isPending}
        onSave={(text) => upsertAnnotation.mutate({ stepId: step.stepId, text })}
      />

      {/* THE FRAME RAIL (B8). Every captured frame, its outcome, and — new here —
          its diff PERCENTAGE, plus a filter that drops everything unchanged.

          The percentage is the point. A run with forty frames and three real
          changes was previously a row of forty near-identical bars: the strip
          could say THAT a frame changed but never BY HOW MUCH, so triage meant
          clicking through frames one at a time to find the one that mattered.
          A 0.01% antialiasing shift and a 40% layout break looked the same. */}
      <div className="gl-frame-rail">
        <div className="gl-frame-rail-head">
          <span className="gl-section-title">Frames</span>
          <span className="gl-note">
            {changedCount === 0
              ? "None changed"
              : `${changedCount} of ${steps.length} changed`}
          </span>
          {/* Only offered when it would DO something. A filter that is always
              present and usually a no-op teaches people it does nothing. */}
          {changedCount > 0 ? (
            <Segmented
              className="ml-auto"
              label="Which frames to show"
              value={changedOnly ? "changed" : "all"}
              onChange={(v) => setChangedOnly(v === "changed")}
              options={[
                { value: "all", label: "All" },
                { value: "changed", label: "Changed" },
              ]}
            />
          ) : null}
        </div>
        {/* THE STRIP'S HEIGHT IS SET, and the wrapper is what sets it. The SDK's
            ScrollArea carries `h-full` in its own class list, so inside an
            auto-height parent its percentage resolves circularly: the rail is
            measured with the viewport at content height, the viewport then
            grows into the rail, and the rail ends up ~20px shorter than what is
            inside it. The overflow leaks to the panel body, which scrolls — and
            the first thing that scrolls out of sight is the run's verdict. A
            filmstrip is a band of known height anyway. */}
        <div className="gl-frame-strip">
        <ScrollArea className="w-full">
          <div className="flex items-end gap-1 pb-1">
            {visibleSteps.map((s) => {
              const active = s.index === idx;
              const failed = s.index === replay.failedIndex;
              const changed = s.diff?.state === "changed";
              const a11yNew = (s.a11y?.newKeys.length ?? 0) > 0;
              const noted = annotationsByStep.has(s.stepId);
              return (
                <button
                  key={s.index}
                  type="button"
                  onClick={() => setCurrent(s.index)}
                  aria-label={`Step ${s.index + 1}: ${statusLabel(s.status)}${
                    changed ? ", visual change" : ""
                  }${a11yNew ? ", accessibility issues" : ""}${noted ? ", has a note" : ""}`}
                  aria-current={active ? "true" : undefined}
                  title={`${s.index + 1}. ${s.label}${changed ? " · visual change" : ""}${
                    a11yNew ? " · accessibility" : ""
                  }${noted ? " · note" : ""}`}
                  className="gl-frame-btn"
                  data-selected={active ? "" : undefined}
                >
                  <span className="gl-frame-mark">
                    {failed ? (
                      <TriangleAlert style={{ color: TONE.red }} />
                    ) : changed ? (
                      <Eye style={{ color: TONE.amber }} />
                    ) : a11yNew ? (
                      <Accessibility style={{ color: TONE.amber }} />
                    ) : noted ? (
                      <MessageSquare style={{ color: "var(--gl-tx-3)" }} />
                    ) : null}
                  </span>
                  <span
                    className="gl-frame-bar"
                    style={{
                      background: statusBarColor(s.status),
                      height: failed || changed ? 28 : 20,
                      // Amber marks a CHANGE, which is caution rather than an
                      // outcome — the frame still passed. An inset rail, so it
                      // does not resize the bar it sits on.
                      boxShadow:
                        changed && !failed ? `inset 0 0 0 1px ${withAlpha(TONE.amber, "bf")}` : undefined,
                    }}
                  />
                  <span className="gl-frame-index" data-active={active ? "" : undefined}>
                    {s.index + 1}
                  </span>
                  {/* THE NUMBER THIS RAIL EXISTED WITHOUT. Only on a changed
                      frame: printing "0%" under forty unchanged ones would bury
                      the three that matter in noise, which is the problem this
                      is here to solve rather than restate. */}
                  {changed && s.diff?.ratio !== undefined ? (
                    <span className="gl-frame-pct">{fmtPct(s.diff.ratio)}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </ScrollArea>
        </div>
      </div>
      </div>
    </Panel>
  );
}

// ── Left pane: the list of runs that have artifacts ─────────────────────
function RunList({
  runs,
  selectedRunId,
  onSelect,
}: {
  runs: RunReplaySummary[];
  selectedRunId: string | null;
  onSelect: (r: RunReplaySummary) => void;
}) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col">
        {runs.map((r) => {
          const selected = r.runId === selectedRunId;
          return (
            <button
              key={r.runId}
              type="button"
              onClick={() => onSelect(r)}
              className="gl-visual-run"
              aria-current={selected ? "true" : undefined}
              // What the stylesheet selects on, and what
              // `check:selection-neutral` reads to prove this row's chosen
              // state carries no status hue — which matters here because the
              // row already reports one.
              data-selected={selected ? "" : undefined}
            >
              <span className="gl-visual-run-text">
                <span className="gl-visual-run-name">{r.testName}</span>
                <span className="gl-visual-run-when">
                  {fmtDateTime(r.startedAt)} · {r.stepCount} steps
                </span>
              </span>
              <span className="gl-visual-run-meta">
                <StatusChip tone={r.status === "passed" ? "phos" : "red"}>{r.status}</StatusChip>
                <span className="gl-visual-run-marks">
                  {r.changedSteps > 0 ? <Eye aria-label="visual change" /> : null}
                  {/* The summary has carried this count since the feature landed
                      and nothing read it, so a run whose only finding was an
                      accessibility one looked identical to a clean one — you had
                      to open every run to find out. Its own icon, not a shared
                      one: "something changed visually" and "something is
                      inaccessible" send you to different places. */}
                  {(r.a11yNewSteps ?? 0) > 0 ? (
                    <Accessibility aria-label="accessibility issues" />
                  ) : null}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}

// ── The Visual tab: replay hub over Phase 1 artifacts ───────────────────
export function VisualView() {
  const runsQuery = useQuery({ queryKey: ["replays"], queryFn: api.artifacts.list });
  const runs = React.useMemo(() => runsQuery.data ?? [], [runsQuery.data]);
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null);

  // NO `runs:changed` SUBSCRIPTION HERE, deliberately — see `run-derived-cache`.
  // Invalidating ["replays"] from this route component meant the Stats board's
  // Visual tile, which reads the same cache, only ever saw a new run by being
  // remounted. `RecorderProvider` owns it now.

  // Default to the newest run once the list loads (or when the selection
  // disappears, e.g. after retention pruning).
  const selected =
    runs.find((r) => r.runId === selectedRunId) ?? (runs.length > 0 ? runs[0] : null);

  // How many of these have something to look at. It goes in the panel's `id`
  // slot, which is where this design puts what a panel is ABOUT — and it is the
  // count the retired toolbar never showed, so the list answers "is there
  // anything here?" before you scroll it.
  const withFindings = runs.filter(
    (r) => r.changedSteps > 0 || (r.a11yNewSteps ?? 0) > 0,
  ).length;

  // THE TOOLBAR IS GONE, like Heals'. The top strip's breadcrumb already says
  // VISUAL, so a title bar under it was the screen's name twice — in a band
  // taken off the frame, which is the one thing on this screen that cannot be
  // read at half size.
  return (
    <div className="gl-visual">
      <Panel
        title="Runs"
        id={
          runs.length === 0
            ? undefined
            : `${runs.length} captured${withFindings > 0 ? ` · ${withFindings} with findings` : ""}`
        }
        className="gl-visual-runs"
      >
        {runs.length === 0 ? (
          <p className="gl-panel-note">
            Nothing captured yet. Turn on “Capture screenshots” when you run a test.
          </p>
        ) : (
          <RunList
            runs={runs}
            selectedRunId={selected?.runId ?? null}
            onSelect={(r) => setSelectedRunId(r.runId)}
          />
        )}
      </Panel>

      {runs.length === 0 ? (
        <Panel title="Replay" className="gl-visual-viewer">
          <div className="gl-empty">
            <span className="gl-empty-title">No captured runs yet</span>
            <span className="gl-empty-note">
              Turn on “Capture screenshots” when you run a test, then come back here to replay it
              step by step, compare against a baseline, and see where it failed.
            </span>
          </div>
        </Panel>
      ) : selected ? (
        <ReplayViewer key={selected.runId} summary={selected} />
      ) : (
        <Panel title="Replay" className="gl-visual-viewer">
          <p className="gl-panel-note">Select a run to replay it.</p>
        </Panel>
      )}
    </div>
  );
}
