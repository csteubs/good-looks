import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Dialog,
  EmptyState,
  Input,
  ScrollArea,
  SegmentedControl,
  SegmentedControlItem,
  Slider,
  Switch,
  Text,
  Textarea,
  Toolbar,
  ToolbarContent,
  ToolbarTitle,
  toast,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@ui";

import { Btn, CRT, Segmented, TONE, withAlpha } from "../theme";
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
import { A11yBadge, A11yViolationList } from "./a11y-violations";
import { IssueComposeDialog } from "../components/issue-compose-dialog";
import type {
  A11yResult,
  Annotation,
  ReplayStep,
  ReplayStepStatus,
  RunNoticeKind,
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

function StatusIcon({ status, className }: { status: ReplayStepStatus; className?: string }) {
  const cls = className ?? "size-3.5";
  if (status === "passed") return <Check className={`${cls} text-support-green`} />;
  if (status === "failed") return <X className={`${cls} text-support-red`} />;
  return <CircleSlash className={`${cls} text-tertiary`} />;
}

function statusLabel(status: ReplayStepStatus): string {
  if (status === "passed") return "Passed";
  if (status === "failed") return "Failed";
  if (status === "skipped") return "Skipped";
  return "Not reported";
}

// ── Visual-diff → badge ─────────────────────────────────────────────────
function diffBadgeColor(state: VisualDiffState): "green" | "orange" | "yellow" | "secondary" {
  switch (state) {
    case "match":
      return "green";
    case "changed":
      return "orange";
    case "unable":
      return "yellow";
    default:
      return "secondary";
  }
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
    <div className="border-t border-separator px-4 py-2">
      <div className="flex items-center gap-2">
        <Button size="small" variant="ghost" onClick={() => setOpen((v) => !v)}>
          <Accessibility className="size-3.5" />
          {open ? "Hide" : "Show"} accessibility ({result.violations.length})
        </Button>
        <div className="flex-1" />
        {result.newKeys.length > 0 && !accepted ? (
          <AlertDialog
            trigger={
              <Button size="small" variant="glass" disabled={accepting}>
                <Stamp className="size-3.5" />
                Accept these issues
              </Button>
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
        <div className="pt-2">
          <A11yViolationList result={result} />
        </div>
      ) : null}
    </div>
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
  return (
    <Badge color={diffBadgeColor(diff.state)} className="shrink-0" title={title}>
      {label}
      {masked ? <SquareDashed className="ml-1 size-3" /> : null}
    </Badge>
  );
}

// ── Screenshot pane (current / baseline / diff-overlay) ─────────────────
type ShotMode = "current" | "baseline" | "diff";

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
  /** Overlay rendered on top of the image, aligned to its rendered box (the
   *  wrapper shrinks to the image), so percentage-positioned children line up
   *  with normalized mask coordinates. */
  children?: React.ReactNode;
}) {
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
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <ImageOff className="size-8 text-tertiary" />
        <Text color="secondary">No screenshot for this step</Text>
        <Text variant="small" color="tertiary" className="max-w-sm">
          {step.status === "skipped" || step.status === "unknown"
            ? "This step didn’t run, so nothing was captured."
            : "Assertions and waits aren’t captured, and a capture can be skipped if it failed."}
        </Text>
      </div>
    );
  }

  if (query.isLoading) {
    return <div className="h-full w-full animate-pulse rounded-md bg-control-subtle" />;
  }

  const src = query.data;
  if (!src) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <ImageOff className="size-8 text-tertiary" />
        <Text color="secondary">
          {mode === "baseline" ? "No baseline for this step" : "Image not available"}
        </Text>
        <Text variant="small" color="tertiary">
          {mode === "baseline"
            ? "This step has no pinned baseline yet."
            : "The artifact may have been pruned by retention."}
        </Text>
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
      <CRT className="gl-visual-frame" src={src} alt={alt} />
      {children}
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
          className="absolute border-2 border-dashed border-support-orange bg-support-orange/25"
          style={{ left: pctStr(m.x), top: pctStr(m.y), width: pctStr(m.w), height: pctStr(m.h) }}
          title={m.label ?? (m.stepId === null ? "Ignored on every step" : "Ignored on this step")}
        >
          {editing ? (
            <button
              type="button"
              aria-label="Remove ignore region"
              className="pointer-events-auto absolute -right-2 -top-2 rounded-full bg-support-orange p-0.5 text-white shadow-sm"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onRemove(m.id)}
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      ))}
      {live && live.w > 0 && live.h > 0 ? (
        <div
          className="absolute border-2 border-support-orange bg-support-orange/20"
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

  const handleChange = ([v]: number[]) => {
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
        <div className="flex items-center gap-2">
          <Text variant="small" color="tertiary" className="shrink-0">
            Threshold
          </Text>
          <Slider
            variant="filled"
            size="small"
            min={0}
            max={THRESHOLD_PRESETS.length - 1}
            step={1}
            ticks={THRESHOLD_PRESETS.length}
            value={[index]}
            startContent={label}
            endContent={`${pct}%`}
            onValueChange={handleChange}
            disabled={thresholdQuery.isLoading}
            className="w-44"
          />
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
      <div className="flex flex-col gap-2 border-t border-separator px-4 py-2">
        <Textarea
          autoFocus
          size="small"
          value={draft}
          placeholder="Add a note for this step…"
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="flex justify-end gap-1.5">
          <Button size="small" variant="transparent" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button
            size="small"
            variant="glass"
            disabled={saving || draft.trim() === (annotation?.text ?? "")}
            onClick={() => {
              onSave(draft);
              setEditing(false);
            }}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }

  if (!annotation) {
    return (
      <div className="border-t border-separator px-4 py-2">
        <Button
          size="small"
          variant="transparent"
          onClick={() => {
            setDraft("");
            setEditing(true);
          }}
        >
          <MessageSquare className="size-3.5" />
          Add note
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 border-t border-separator px-4 py-2">
      <MessageSquare className="size-3.5 shrink-0 text-tertiary" />
      <Text variant="small" color="secondary" className="min-w-0 flex-1 whitespace-pre-wrap">
        {annotation.text}
      </Text>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="small"
            variant="transparent"
            className="shrink-0"
            onClick={() => {
              setDraft(annotation.text);
              setEditing(true);
            }}
          >
            <Pencil className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Edit annotation</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="small"
            variant="transparent"
            className="shrink-0"
            disabled={saving}
            onClick={() => onSave("")}
          >
            <X className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Clear annotation</TooltipContent>
      </Tooltip>
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
                  <SquareDashed className="size-3.5 shrink-0" style={{ color: TONE.amber }} />
                  {labelDraft?.id === m.id ? (
                    <Input
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
                      className="min-w-0 flex-1 truncate text-left"
                      onClick={() => setLabelDraft({ id: m.id, text: m.label ?? "" })}
                      title="Rename"
                    >
                      <Text variant="small" color={m.label ? undefined : "tertiary"}>
                        {m.label ?? "Unnamed region"}
                      </Text>
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
                    <X className="size-3.5" />
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
                  <Stamp className="size-3.5 shrink-0" style={{ color: "var(--gl-tx-3)" }} />
                  <Text variant="small-mono" className="min-w-0 flex-1 truncate" title={b.label}>
                    {b.label}
                  </Text>
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

function deltaBadge(delta: StepDelta): { color: "green" | "orange" | "red" | "secondary"; label: string } {
  switch (delta) {
    case "stable":
      return { color: "green", label: "Same" };
    case "fixed":
      return { color: "green", label: "Now passing" };
    case "changed-since":
      return { color: "orange", label: "Changed since" };
    case "still-failing":
      return { color: "red", label: "Still failing" };
    default:
      return { color: "secondary", label: "No result" };
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
        <Text color="secondary">
          The comparison isn’t available — one of the two runs’ artifacts may have been pruned by
          retention.
        </Text>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {comparison.changedSinceCount > 0 ? (
              <Badge color="orange">
                {comparison.changedSinceCount} changed since
              </Badge>
            ) : (
              <Badge color="green">Nothing broke</Badge>
            )}
            {comparison.fixedCount > 0 ? (
              <Badge color="green">{comparison.fixedCount} now passing</Badge>
            ) : null}
          </div>
          {comparison.changedSinceCount > 0 ? (
            <Callout color="orange" icon={<TriangleAlert className="size-4" />}>
              These steps worked in the original run and don’t now. That can be a real regression or
              environment drift — the site changed, a login expired, test data is gone. Compare the
              screenshots before deciding.
            </Callout>
          ) : null}
          {comparison.stepsDiverged ? (
            <Callout color="yellow" icon={<TriangleAlert className="size-4" />}>
              The two runs don’t cover the same steps, so some rows have nothing to compare against.
            </Callout>
          ) : null}
          <div className="flex flex-col gap-1">
            {comparison.steps.map((s) => {
              const badge = deltaBadge(s.delta);
              return (
                <div
                  key={s.stepId}
                  className="flex items-center gap-2 rounded-md border border-separator px-2 py-1.5"
                >
                  <Text variant="small-mono" className="min-w-0 flex-1 truncate" title={s.label}>
                    {s.label}
                  </Text>
                  <Text variant="small" color="tertiary" className="shrink-0">
                    {statusLabel(s.before)} → {statusLabel(s.after)}
                  </Text>
                  {s.visual === "changed" ? (
                    <Badge color="orange" className="shrink-0">
                      <Eye className="size-3" />
                    </Badge>
                  ) : null}
                  <Badge color={badge.color} className="shrink-0">
                    {badge.label}
                  </Badge>
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
      <div className="min-w-0 flex-1 p-4">
        <div className="h-full animate-pulse rounded-lg bg-control-subtle" />
      </div>
    );
  }
  if (!replay || steps.length === 0) {
    return (
      <div className="relative min-w-0 flex-1">
        <EmptyState
          title="Replay unavailable"
          description="This run’s artifacts couldn’t be loaded. They may have been removed."
        />
      </div>
    );
  }

  const idx = clamp(current);


  const step = steps[idx];
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

  return (
    <div
      className="flex h-full min-w-0 flex-1 flex-col outline-none"
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
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-separator px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Text className="truncate font-medium">{replay.testName}</Text>
            <Badge color={replay.status === "passed" ? "green" : "red"} className="shrink-0">
              {replay.status}
            </Badge>
            {changedCount > 0 ? (
              <Badge color="orange" className="shrink-0">
                {changedCount} visual {changedCount === 1 ? "change" : "changes"}
              </Badge>
            ) : null}
          </div>
          <Text variant="small" color="tertiary">
            {fmtDateTime(replay.startedAt)}
          </Text>
        </div>
        <Button
          size="small"
          variant="glass"
          className="shrink-0"
          disabled={rerunning}
          onClick={startRerun}
          title="Re-execute this run's recorded steps against the live site"
        >
          <RefreshCw className={`size-3.5 ${rerunning ? "animate-spin" : ""}`} />
          {rerunning ? "Re-running…" : "Re-run"}
        </Button>
        <Button
          size="small"
          variant="glass"
          className="shrink-0"
          onClick={() => setManagerOpen(true)}
        >
          Masks & baselines
        </Button>
        <ThresholdControl testId={summary.testId} steps={steps} />
        <div className="flex shrink-0 items-center gap-1">
          <Button
            iconOnly
            variant="glass"
            size="small"
            aria-label="Previous step"
            disabled={idx <= 0}
            onClick={() => setCurrent((c) => clamp(c - 1))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Text variant="small-mono" color="secondary" className="w-16 text-center tabular-nums">
            {idx + 1} / {steps.length}
          </Text>
          <Button
            iconOnly
            variant="glass"
            size="small"
            aria-label="Next step"
            disabled={idx >= steps.length - 1}
            onClick={() => setCurrent((c) => clamp(c + 1))}
          >
            <ChevronRight className="size-4" />
          </Button>
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

      {/* Failure banner */}
      {replay.failedIndex !== null ? (
        <div className="px-4 pt-3">
          <Callout
            color="red"
            icon={<TriangleAlert className="size-4" />}
            actions={
              idx !== replay.failedIndex ? (
                <Button
                  size="small"
                  variant="glass"
                  onClick={() => setCurrent(replay.failedIndex as number)}
                >
                  Jump to failure
                </Button>
              ) : undefined
            }
          >
            Run failed at step {replay.failedIndex + 1}:{" "}
            <span className="font-mono">{steps[replay.failedIndex]?.label}</span>
          </Callout>
        </div>
      ) : null}

      {/* Visual-change banner.
          Two exits, and they mean different things — which is the reason both
          are here. "Accept all" REPINS every baseline and changes what every
          later run compares against; dismissing changes nothing but the banner.
          Offering only the first would have made signing off blind the cheapest
          way to clear the screen. */}
      {changedCount > 0 && !dismissed.has("visual") ? (
        <div className="px-4 pt-3">
          <Callout
            color="orange"
            icon={<Eye className="size-4" />}
            onDismiss={() => dismissNotice.mutate("visual")}
            dismissLabel="Dismiss visual changes for this run"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span>
                Visual change detected in {changedCount} {changedCount === 1 ? "step" : "steps"}{" "}
                (over {fmtPct((replay.visualThreshold ?? 0) / 100)} threshold). Use the per-step
                "Accept New Baseline" button to re-pin a step.
              </span>
              <AlertDialog
                trigger={
                  <Button size="small" variant="glass" disabled={acceptVisualRun.isPending}>
                    <Stamp className="size-3.5" />
                    Accept all for this run
                  </Button>
                }
                title="Pin every screenshot in this run as the new baseline?"
                description="Every step's current screenshot replaces its baseline, including steps that matched. Later runs are compared against these frames, so anything wrong in them becomes the expected result."
                confirmLabel="Accept all"
                confirmVariant="accent"
                onConfirm={() => acceptVisualRun.mutate()}
              />
            </div>
          </Callout>
        </div>
      ) : null}

      {/* Accessibility, as its own callout rather than folded into the visual
          one: they are different kinds of finding, and a run can easily have
          one without the other. Never affects the run's pass/fail. */}
      {a11yCount > 0 && !dismissed.has("a11y") ? (
        <div className="px-4 pt-3">
          <Callout
            color="orange"
            icon={<Accessibility className="size-4" />}
            onDismiss={() => dismissNotice.mutate("a11y")}
            dismissLabel="Dismiss accessibility issues for this run"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span>
                {a11yCount} {a11yCount === 1 ? "step has" : "steps have"} accessibility issues that
                aren't accepted yet. This doesn't affect whether the run passed.
              </span>
              <AlertDialog
                trigger={
                  <Button size="small" variant="glass" disabled={acceptA11yRun.isPending}>
                    <Stamp className="size-3.5" />
                    Accept all for this run
                  </Button>
                }
                title="Accept every accessibility issue in this run?"
                description="They stop being flagged on future runs. Use this to establish a starting point on a site with pre-existing issues — new problems introduced later will still show up."
                confirmLabel="Accept all"
                confirmVariant="accent"
                onConfirm={() => acceptA11yRun.mutate()}
              />
            </div>
          </Callout>
        </div>
      ) : null}

      {/* Screenshot */}
      <div className="min-h-0 flex-1 p-4">
        <div className="relative flex h-full items-center justify-center overflow-hidden rounded-lg border border-separator bg-well p-3">
          {/* Ignore-region editor toggle */}
          {step.screenshot ? (
            <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
              <Button
                size="small"
                variant={masking ? "accent" : "glass"}
                onClick={() => setMasking((v) => !v)}
                title="Exclude regions of the page from visual diffing"
              >
                <SquareDashed className="size-3.5" />
                {masking ? "Done" : "Ignore regions"}
              </Button>
              {masking ? (
                <div className="flex items-center gap-1.5 rounded-md bg-popover px-2 py-1 shadow-sm">
                  <Switch
                    id="mask-all-steps"
                    checked={maskAllSteps}
                    onCheckedChange={setMaskAllSteps}
                  />
                  <label htmlFor="mask-all-steps" className="cursor-pointer">
                    <Text variant="small">Apply to all steps</Text>
                  </label>
                </div>
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
            // compare screen.
            <div className="gl-visual-modes absolute right-3 top-3">
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
                ]}
              />
            </div>
          ) : null}
          <StepScreenshot
            testId={summary.testId}
            runId={summary.runId}
            step={step}
            mode={effectiveMode}
          >
            {step.rect && elementSteps.has(step.stepId) ? (
              <div
                className="pointer-events-none absolute border-2 border-accent"
                style={{
                  left: pctStr(step.rect.x),
                  top: pctStr(step.rect.y),
                  width: pctStr(step.rect.w),
                  height: pctStr(step.rect.h),
                }}
                title="Only this region is compared"
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
          </StepScreenshot>
        </div>
        {masking ? (
          <Text variant="small" color="tertiary" className="mt-2 block text-center">
            Drag on the screenshot to exclude a region from visual diffing. Regions are ignored from
            the next capture run onward — this run's results don't change.
          </Text>
        ) : null}
      </div>

      {/* Current step detail */}
      <div className="flex items-center gap-2 border-t border-separator px-4 py-2">
        <StatusIcon status={step.status} />
        <Badge color="secondary" className="shrink-0">
          {step.type}
        </Badge>
        <Text variant="small-mono" className="min-w-0 flex-1 truncate" title={step.label}>
          {step.label}
        </Text>
        {/* Comparison scope — only meaningful for a step with a captured
            element rectangle to crop to. */}
        {step.screenshot && step.rect ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <SegmentedControl
                type="single"
                size="small"
                variant="filled"
                className="shrink-0"
                value={elementSteps.has(step.stepId) ? "element" : "page"}
                onValueChange={(v) =>
                  v &&
                  setElementStep.mutate({ stepId: step.stepId, element: v === "element" })
                }
              >
                <SegmentedControlItem value="page">Page</SegmentedControlItem>
                <SegmentedControlItem value="element">Element</SegmentedControlItem>
              </SegmentedControl>
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
        {step.diff?.state === "changed" && onSendToTracker ? (
          <Button
            size="small"
            variant="glass"
            className="shrink-0"
            aria-label={`Send step ${step.index + 1}'s visual change to the issue tracker`}
            onClick={() => onSendToTracker(step.stepId)}
          >
            <Send className="size-3.5" />
            Send
          </Button>
        ) : null}
        {step.screenshot && step.diff?.state === "changed" && !acceptedSteps.has(step.stepId) ? (
          <AlertDialog
            trigger={
              <Button size="small" variant="glass" className="shrink-0" disabled={acceptStep.isPending}>
                <Stamp className="size-3.5" />
                Accept New Baseline
              </Button>
            }
            title="Accept this screenshot as the new baseline?"
            description="This pins this step's screenshot as the new comparison standard for future runs. The button will be hidden afterward. This is logged in Stats."
            confirmLabel="Accept"
            confirmVariant="accent"
            onConfirm={() => acceptStep.mutate(step.stepId)}
          />
        ) : (
          <Text variant="small" color="tertiary" className="shrink-0">
            {statusLabel(step.status)}
          </Text>
        )}
      </div>

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
                  <span className="flex h-4 items-center justify-center">
                    {failed ? (
                      <TriangleAlert className="size-3.5" style={{ color: TONE.red }} />
                    ) : changed ? (
                      <Eye className="size-3.5" style={{ color: TONE.amber }} />
                    ) : a11yNew ? (
                      <Accessibility className="size-3.5" style={{ color: TONE.amber }} />
                    ) : noted ? (
                      <MessageSquare className="size-3.5 text-tertiary" />
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
    <ScrollArea className="h-full w-64 shrink-0 border-r border-separator">
      <div className="flex flex-col gap-0.5 p-2">
        {runs.map((r) => {
          const selected = r.runId === selectedRunId;
          return (
            <button
              key={r.runId}
              type="button"
              onClick={() => onSelect(r)}
              className={`flex flex-col gap-1 rounded-md px-2.5 py-2 text-left ${
                selected ? "bg-accent-10 ring-1 ring-inset ring-accent" : "hover:bg-control-subtle"
              }`}
              aria-current={selected ? "true" : undefined}
            >
              <div className="flex items-center gap-2">
                <Badge color={r.status === "passed" ? "green" : "red"} className="shrink-0">
                  {r.status}
                </Badge>
                <Text variant="small" className="min-w-0 flex-1 truncate font-medium">
                  {r.testName}
                </Text>
                {r.changedSteps > 0 ? (
                  <Eye className="size-3.5 shrink-0 text-support-orange" aria-label="visual change" />
                ) : null}
                {/* The summary has carried this count since the feature landed
                    and nothing read it, so a run whose only finding was an
                    accessibility one looked identical to a clean one — you had
                    to open every run to find out. Its own icon, not a shared
                    one: "something changed visually" and "something is
                    inaccessible" send you to different places. */}
                {(r.a11yNewSteps ?? 0) > 0 ? (
                  <Accessibility
                    className="size-3.5 shrink-0 text-support-orange"
                    aria-label="accessibility issues"
                  />
                ) : null}
              </div>
              <Text variant="small" color="tertiary">
                {fmtDateTime(r.startedAt)} · {r.stepCount} steps
              </Text>
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}

// ── The Visual tab: replay hub over Phase 1 artifacts ───────────────────
export function VisualView() {
  const qc = useQueryClient();
  const runsQuery = useQuery({ queryKey: ["replays"], queryFn: api.artifacts.list });
  const runs = React.useMemo(() => runsQuery.data ?? [], [runsQuery.data]);
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null);

  // Live-refresh when a run completes.
  React.useEffect(() => {
    return api.on("runs:changed", () => {
      qc.invalidateQueries({ queryKey: ["replays"] });
    });
  }, [qc]);

  // Default to the newest run once the list loads (or when the selection
  // disappears, e.g. after retention pruning).
  const selected =
    runs.find((r) => r.runId === selectedRunId) ?? (runs.length > 0 ? runs[0] : null);

  return (
    <div className="relative flex h-full flex-col">
      <Toolbar>
        <ToolbarContent>
          <ToolbarTitle>Visual</ToolbarTitle>
        </ToolbarContent>
      </Toolbar>

      {runs.length === 0 ? (
        <EmptyState
          title="No captured runs yet"
          description="Turn on “Capture screenshots” when you run a test, then come back here to replay it step by step, compare against a baseline, and see where it failed."
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <RunList
            runs={runs}
            selectedRunId={selected?.runId ?? null}
            onSelect={(r) => setSelectedRunId(r.runId)}
          />
          {selected ? (
            <ReplayViewer key={selected.runId} summary={selected} />
          ) : (
            <div className="flex-1" />
          )}
        </div>
      )}
    </div>
  );
}
