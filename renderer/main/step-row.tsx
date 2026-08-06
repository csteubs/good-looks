// A single recorded step row. Shared by the read-only test detail view (just
// index + description) and the live trainer (drag-to-reorder, inline edit,
// per-step replay). All editing affordances are gated behind optional props, so
// the detail view stays a plain presentational list.

import * as React from "react";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Text,
} from "@glaze/core/components";
import { Check, GripVertical, Loader2, MoreHorizontal, Pencil, Play, X } from "lucide-react";
import type { RunStepStatus } from "./recorder-store";

import { describeStep } from "../lib/describe-step";
import type { Step, StepType } from "../lib/recorder-types";

function badgeColor(type: StepType): "green" | "blue" | "secondary" | "purple" {
  if (type === "if" || type === "endif") return "purple";
  if (type === "assert") return "green";
  // Environment/setup steps share a colour: navigation, viewport, waits, cookies.
  if (type === "goto" || type === "viewport" || type === "wait" || type === "cookie") return "blue";
  return "secondary";
}

/** Compact badge label — logic delimiters read better than the raw type name. */
function badgeLabel(type: StepType): string {
  if (type === "endif") return "end if";
  return type;
}

/** The single field a step exposes for quick inline editing, if any. */
function editableField(
  step: Step,
): { key: "value" | "text" | "url" | "waitMs"; label: string; value: string } | null {
  switch (step.type) {
    case "goto":
      return { key: "url", label: "URL", value: step.url ?? "" };
    case "fill":
    case "select":
    case "press":
      return { key: "value", label: "Value", value: step.value ?? "" };
    case "wait":
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
      className="group/gap flex h-2 w-full items-center px-2 disabled:cursor-default"
      aria-label="Move insert point here"
    >
      <span
        className={`h-0.5 w-full rounded-full ${
          active ? "bg-accent" : disabled ? "bg-transparent" : "bg-transparent group-hover/gap:bg-separator"
        }`}
      />
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
    const patch: Partial<Step> =
      field.key === "waitMs" ? { waitMs: Number(draft) || 0 } : { [field.key]: draft };
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

  return (
    <div
      className={`group flex items-center gap-2 rounded-md px-2 py-1 ${flash} ${
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

      <Text variant="small-mono" color="tertiary" className="w-6 shrink-0 text-right tabular-nums">
        {index + 1}
      </Text>
      <Badge color={badgeColor(step.type)} className="shrink-0">
        {badgeLabel(step.type)}
      </Badge>
      {step.soft ? (
        <Badge color="secondary" className="shrink-0">
          soft
        </Badge>
      ) : null}
      {step.continueOnFailure ? (
        <Badge color="secondary" className="shrink-0" title="Continue on Failure — swallow this step's error and keep running">
          continue on fail
        </Badge>
      ) : null}
      {step.disabled ? (
        <Badge color="secondary" className="shrink-0" title="Disabled — skipped during runs and commented out in the spec">
          disabled
        </Badge>
      ) : null}

      {editing && field ? (
        <Input
          autoFocus
          size="small"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="min-w-0 flex-1"
          aria-label={`Edit ${field.label}`}
        />
      ) : (
        <Text
          variant="small-mono"
          className={`min-w-0 flex-1 truncate ${runStatus === "failed" ? "text-support-red" : ""}`}
          title={replay.error || describeStep(step)}
        >
          {describeStep(step)}
        </Text>
      )}

      {!editing ? (
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {runStatus ? (
            <span className="shrink-0" aria-label={`Step ${runStatus}`}>
              {runStatus === "running" ? (
                <Loader2 className="size-3.5 animate-spin text-accent" />
              ) : runStatus === "passed" ? (
                <Check className="size-3.5 text-support-green" />
              ) : (
                <X className="size-4 text-support-red" />
              )}
            </span>
          ) : null}
          {onReplay && step.type !== "goto" && step.type !== "viewport" && step.type !== "endif" ? (
            <Button
              iconOnly
              variant="transparent"
              size="small"
              className="opacity-0 group-hover:opacity-100"
              onClick={doReplay}
              disabled={replay.status === "running"}
              aria-label="Replay step"
            >
              {replay.status === "running" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : replay.status === "ok" ? (
                <Check className="size-3.5 text-support-green" />
              ) : replay.status === "fail" ? (
                <X className="size-3.5 text-support-red" />
              ) : (
                <Play className="size-3.5" />
              )}
            </Button>
          ) : null}
          {field ? (
            <Button
              iconOnly
              variant="transparent"
              size="small"
              className="opacity-0 group-hover:opacity-100"
              onClick={beginEdit}
              aria-label="Edit step"
            >
              <Pencil className="size-3.5" />
            </Button>
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
                  <Button
                    iconOnly
                    variant="transparent"
                    size="small"
                    className="opacity-0 group-hover:opacity-100"
                    aria-label="Step utilities"
                    title="Step utilities"
                  >
                    <MoreHorizontal className="size-3.5" />
                  </Button>
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
            <Button
              iconOnly
              variant="transparent"
              size="small"
              className="opacity-0 group-hover:opacity-100"
              onClick={onDelete}
              aria-label="Delete step"
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
