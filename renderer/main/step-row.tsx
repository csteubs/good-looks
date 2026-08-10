// A single recorded step row. Shared by the read-only test detail view (just
// index + description) and the live trainer (drag-to-reorder, inline edit,
// per-step replay). All editing affordances are gated behind optional props, so
// the detail view stays a plain presentational list.

import * as React from "react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ui";
import { Check, GripVertical, Loader2, MoreHorizontal, Pencil, Play, X } from "lucide-react";
import type { RunStepStatus } from "./recorder-store";

import { TONE, TypeChip } from "../theme";
import { describeStep } from "../lib/describe-step";
import { DEFAULT_WAIT_TIMEOUT_MS } from "../lib/recorder-types";
import { clampViewportAxis } from "../lib/viewport-presets";
import type { Step } from "../lib/recorder-types";

/* `badgeColor` and `badgeLabel` were here, and `TypeChip` replaces both.
 *
 * They mapped a step type onto one of the SDK's five badge colours and
 * shortened two names. The theme's chip owns the same two jobs from one map, and
 * its palette is DELIBERATELY NOT the status palette: a step's type is not an
 * outcome — an `assert` step is not "failing" because assertions are what fail —
 * so the type colours are desaturated categories while the four status hues stay
 * reserved for results. The old mapping used `green` for `assert`, which is the
 * pass colour, on every assertion in every list. */

/**
 * Parse a hand-typed `WIDTHxHEIGHT` into a viewport patch, or null.
 *
 * Accepts `x`, `×` and `,` as the separator because all three are what people
 * actually type for a size, and rejects anything that doesn't yield two usable
 * numbers — an unparseable draft leaves the step alone rather than resizing to
 * something nobody asked for. The backend clamps the result again on write.
 */
export function parseSizeDraft(draft: string): { width: number; height: number } | null {
  const m = draft.trim().match(/^(\d+)\s*[x×,]\s*(\d+)$/i);
  if (!m) return null;
  const width = clampViewportAxis(m[1], 0);
  const height = clampViewportAxis(m[2], 0);
  if (!width || !height) return null;
  return { width, height };
}

/** The single field a step exposes for quick inline editing, if any. */
function editableField(
  step: Step,
): { key: "value" | "text" | "url" | "waitMs" | "timeoutMs" | "size"; label: string; value: string } | null {
  switch (step.type) {
    case "goto":
      return { key: "url", label: "URL", value: step.url ?? "" };
    case "viewport":
      // One field for both axes: a resize is a single decision ("make it
      // mobile"), and two inputs in a row this narrow would each be about
      // four characters wide.
      return {
        key: "size",
        label: "Size (width×height)",
        value: `${step.width ?? 1280}x${step.height ?? 800}`,
      };
    case "fill":
    case "select":
    case "press":
      return { key: "value", label: "Value", value: step.value ?? "" };
    case "wait":
      // A conditional wait's editable number is its TIMEOUT, not a duration —
      // it has no waitMs at all. Without this the one number the user can see
      // on the row would be the only one they couldn't change inline.
      if (step.waitUntil)
        return {
          key: "timeoutMs",
          label: "Timeout (ms)",
          value: String(step.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
        };
      return typeof step.waitMs === "number"
        ? { key: "waitMs", label: "Wait (ms)", value: String(step.waitMs) }
        : null;
    case "assert":
      if (step.assert === "text" || step.assert === "exactText")
        return { key: "text", label: "Text", value: step.text ?? "" };
      if (step.assert === "value" || step.assert === "url" || step.assert === "urlEndsWith" || step.assert === "urlIs" || step.assert === "title")
        return { key: "value", label: "Expected", value: step.value ?? "" };
      if (step.assert === "attribute")
        return { key: "value", label: "Expected", value: step.value ?? "" };
      // The expected value is the half of a CSS assert most likely to need a
      // tweak (a brand colour changes; the property doesn't), so it gets the
      // same inline edit `attribute` has. The property name and match mode are
      // not inline-editable — one is validated, the other is an enum, and
      // neither fits a bare text field on a row this narrow.
      if (step.assert === "css")
        return { key: "value", label: "Expected", value: step.value ?? "" };
      return null;
    case "if":
      // Page-condition substring is inline-editable; element conditions edit via Refine.
      if (step.cond === "urlContains" || step.cond === "titleContains")
        return { key: "value", label: "Contains", value: step.value ?? "" };
      return null;
    default:
      return null;
  }
}

/**
 * Thin clickable strip between rows that moves the insert cursor.
 *
 * Lives beside StepRow rather than in either view because BOTH step lists —
 * the main window's trainer and the docked panel's — need it, and an insert
 * cursor that behaves differently in the two would be a confusing bug: the
 * cursor decides where the next captured step lands.
 */
export function CursorGap({
  active,
  onClick,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="gl-cursor-gap"
      data-active={active ? "" : undefined}
      aria-label="Move insert point here"
    >
      <span className="gl-cursor-gap-rule" aria-hidden="true" />
    </button>
  );
}

export interface StepDragProps {
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  isDragging: boolean;
  isOver: boolean;
}

export function StepRow({
  index,
  step,
  selected,
  onSelect,
  onDelete,
  onReplay,
  onRefine,
  onEdit,
  drag,
  runStatus,
  isNew,
  replayFlash,
  indent = 0,
}: {
  index: number;
  step: Step;
  selected?: boolean;
  onSelect?: () => void;
  onDelete?: () => void;
  onReplay?: () => Promise<{ ok: boolean; error?: string }>;
  onRefine?: () => void;
  onEdit?: (patch: Partial<Step>) => void;
  drag?: StepDragProps;
  /** Live run status of this step during a test run, for highlight. */
  runStatus?: RunStepStatus;
  /** This step was just added to the list by something other than the user
   *  typing it — an applied AI-debug fix, an inserted AI-generated flow — and
   *  gets a pulsing green border until the list changes again. Only ADDED
   *  steps are marked; removals are deliberately unstyled. */
  isNew?: boolean;
  /** This step just finished replaying, and whether it passed. Ephemeral — the
   *  store clears it after REPLAY_FLASH_MS. Drawn as an outline, which is why
   *  it and `isNew` are mutually exclusive below rather than additive. */
  replayFlash?: "pass" | "fail";
  /** Nesting depth inside conditional blocks, for left indentation. */
  indent?: number;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [replay, setReplay] = React.useState<{
    status: "idle" | "running" | "ok" | "fail";
    error?: string;
  }>({ status: "idle" });

  const field = onEdit ? editableField(step) : null;

  function beginEdit() {
    if (!field) return;
    setDraft(field.value);
    setEditing(true);
  }

  function commitEdit() {
    if (!field || !onEdit) return setEditing(false);
    if (field.key === "size") {
      // An unparseable size commits NOTHING rather than a partial patch: a
      // resize with only a width is not a smaller edit, it's a broken step.
      const size = parseSizeDraft(draft);
      if (size) onEdit(size);
      return setEditing(false);
    }
    // The remaining numeric fields are parsed here rather than stored as the
    // typed string: they are emitted into the spec as bare numerals, and a
    // string reaching the generator is the shape of the original injection bug.
    const patch: Partial<Step> =
      field.key === "waitMs"
        ? { waitMs: Number(draft) || 0 }
        : field.key === "timeoutMs"
          ? { timeoutMs: Number(draft) || DEFAULT_WAIT_TIMEOUT_MS }
          : { [field.key]: draft };
    onEdit(patch);
    setEditing(false);
  }

  async function doReplay() {
    if (!onReplay) return;
    setReplay({ status: "running" });
    try {
      const res = await onReplay();
      setReplay({ status: res.ok ? "ok" : "fail", error: res.error });
    } catch (err) {
      setReplay({ status: "fail", error: String(err) });
    }
    setTimeout(() => setReplay({ status: "idle" }), 2500);
  }

  // Run highlight takes precedence over the per-row replay flash and hover.
  const runFlash =
    runStatus === "running"
      ? "bg-accent-10 ring-1 ring-inset ring-accent"
      : runStatus === "passed"
        ? "bg-support-green-10"
        : runStatus === "failed"
          ? "bg-support-red/15 ring-1 ring-inset ring-support-red/40"
          : "";

  const flash = runFlash
    ? runFlash
    : replay.status === "ok"
      ? "bg-support-green-10"
      : replay.status === "fail"
        ? "bg-support-red-10"
        : "hover:bg-control-subtle";

  // Additive rather than another arm of the `flash` chain above: run status and
  // selection are transient states of a row, this is a claim about where the
  // row came from, and a step can be new AND failing — which is the single most
  // interesting row on the screen, so neither highlight may hide the other.
  // `.step-new` animates only `outline-color`, which nothing else here touches
  // (see renderer/styles.css), so the two compose instead of fighting.
  //
  // The replay flash and `.step-new` both draw an OUTLINE, so unlike the pair
  // above these cannot compose — two outline rules on one element resolve by
  // stylesheet order, which is not a decision either component made. The flash
  // wins while it lasts: it is the newer fact and the one the user is waiting
  // on, and it expires on its own, so `.step-new` comes back underneath rather
  // than being lost.
  const outlineClass = replayFlash
    ? replayFlash === "pass"
      ? "step-replay-pass"
      : "step-replay-fail"
    : isNew
      ? "step-new"
      : "";

  return (
    <div
      data-new-step={isNew ? "true" : undefined}
      data-replay-flash={replayFlash}
      className={`group flex items-center gap-2 rounded-md px-2 py-1 ${flash} ${outlineClass} ${
        selected && !runStatus ? "ring-1 ring-inset ring-accent" : ""
      } ${drag?.isOver ? "border-t-2 border-accent" : ""} ${
        drag?.isDragging ? "opacity-50" : ""
      } ${onSelect ? "cursor-pointer" : ""}`}
      style={indent ? { marginLeft: indent * 20 } : undefined}
      onDragEnter={drag ? () => drag.onDragEnter() : undefined}
      onDragOver={drag ? (e) => e.preventDefault() : undefined}
      onDrop={drag ? (e) => e.preventDefault() : undefined}
      onClick={onSelect ? (e) => {
        // Don't select when clicking an interactive control inside the row.
        const target = e.target as HTMLElement;
        if (target.closest("button, input, [contenteditable]")) return;
        onSelect();
      } : undefined}
      aria-selected={selected ? true : undefined}
      role={onSelect ? "option" : undefined}
    >
      {drag ? (
        <span
          draggable
          onDragStart={drag.onDragStart}
          onDragEnd={drag.onDragEnd}
          className="shrink-0 cursor-grab text-tertiary opacity-0 group-hover:opacity-100 active:cursor-grabbing"
          aria-label="Drag to reorder"
        >
          <GripVertical className="size-4" />
        </span>
      ) : null}

      {/* 1-based, and tabular so a column of them does not shimmy as it
          scrolls. A reader counts from one, and a failure report that says
          "step 0" costs someone a minute. */}
      <span className="gl-row-index shrink-0">{index + 1}</span>
      <TypeChip type={step.type} />
      {/* Neutral chips, all three: soft / continue-on-fail / disabled are facts
          about how the step is CONFIGURED, not results, and giving any of them
          a status hue would make every configured step look like a verdict. */}
      {step.soft ? <span className="gl-chip">soft</span> : null}
      {step.continueOnFailure ? (
        <span className="gl-chip" title="Continue on Failure — swallow this step's error and keep running">
          continue on fail
        </span>
      ) : null}
      {step.disabled ? (
        <span className="gl-chip" title="Disabled — skipped during runs and commented out in the spec">
          disabled
        </span>
      ) : null}

      {editing && field ? (
        <input
          type="text"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="gl-input flex-1"
          aria-label={`Edit ${field.label}`}
        />
      ) : (
        <span
          className="gl-mono-value flex-1"
          // The failing row's description is the one place a status hue belongs
          // on this text: it IS the outcome, on the row that has it.
          style={runStatus === "failed" ? { color: TONE.red } : undefined}
          title={replay.error || describeStep(step)}
        >
          {describeStep(step)}
        </span>
      )}

      {!editing ? (
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {runStatus ? (
            <span
              className="flex shrink-0 items-center [&_svg]:size-3.5"
              aria-label={`Step ${runStatus}`}
              // COLOUR MEANS OUTCOME, and this is the one place on the row that
              // is reporting one. `running` is cyan rather than the SDK accent,
              // which is the token the palette declares for "running / live".
              style={{
                color:
                  runStatus === "running"
                    ? TONE.cyan
                    : runStatus === "passed"
                      ? TONE.phos
                      : TONE.red,
              }}
            >
              {runStatus === "running" ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : runStatus === "passed" ? (
                <Check aria-hidden="true" />
              ) : (
                <X aria-hidden="true" />
              )}
            </span>
          ) : null}
          {/* `viewport` IS replayable on its own — it resizes the training
              window, which is exactly the thing worth previewing before
              trusting the step. `goto`/`endif` still aren't: one restarts the
              session's navigation, the other is a block delimiter.

              A lone `press` isn't either: replaying it holds the left mouse
              button down in the live training window with no `release` coming,
              so the user's next click there would be a drag. It only means
              anything as part of the run that also releases it. */}
          {onReplay &&
          step.type !== "goto" &&
          step.type !== "endif" &&
          !(step.type === "state" && step.elementState === "press") ? (
            <button
              type="button"
              className="gl-icon-btn opacity-0 group-hover:opacity-100"
              onClick={doReplay}
              disabled={replay.status === "running"}
              aria-label="Replay step"
              style={
                replay.status === "ok"
                  ? { color: TONE.phos }
                  : replay.status === "fail"
                    ? { color: TONE.red }
                    : undefined
              }
            >
              {replay.status === "running" ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : replay.status === "ok" ? (
                <Check aria-hidden="true" />
              ) : replay.status === "fail" ? (
                <X aria-hidden="true" />
              ) : (
                <Play aria-hidden="true" />
              )}
            </button>
          ) : null}
          {field ? (
            <button
              type="button"
              className="gl-icon-btn opacity-0 group-hover:opacity-100"
              onClick={beginEdit}
              aria-label="Edit step"
            >
              <Pencil aria-hidden="true" />
            </button>
          ) : null}
          {(() => {
            // "Test step utilities" submenu: groups per-step tools beneath the
            // row. Currently "Refine Selection" (needs a locator) and "Continue
            // on Failure" (a toggle for action/assert steps). The kebab trigger
            // only renders when at least one utility applies to this step.
            const canRefine = onRefine && step.locator;
            const canContinue = onEdit && step.type !== "if" && step.type !== "endif";
            if (!canRefine && !canContinue) return null;
            return (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="gl-icon-btn opacity-0 group-hover:opacity-100"
                    aria-label="Step utilities"
                    title="Step utilities"
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="end">
                  {canRefine ? (
                    <DropdownMenuItem onSelect={onRefine} icon="crosshair">
                      Refine Selection
                    </DropdownMenuItem>
                  ) : null}
                  {canRefine && canContinue ? <DropdownMenuSeparator /> : null}
                  {canContinue ? (
                    <DropdownMenuCheckboxItem
                      checked={!!step.continueOnFailure}
                      onCheckedChange={(checked) => onEdit?.({ continueOnFailure: checked })}
                    >
                      Continue on Failure
                    </DropdownMenuCheckboxItem>
                  ) : null}
                  {canContinue ? (
                    <DropdownMenuCheckboxItem
                      checked={!!step.disabled}
                      onCheckedChange={(checked) => onEdit?.({ disabled: checked })}
                    >
                      Disable Step
                    </DropdownMenuCheckboxItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            );
          })()}
          {onDelete ? (
            <button
              type="button"
              className="gl-icon-btn opacity-0 group-hover:opacity-100"
              onClick={onDelete}
              aria-label="Delete step"
            >
              <X aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
