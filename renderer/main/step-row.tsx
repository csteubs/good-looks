// A single recorded step row. Shared by the read-only test detail view (just
// index + description) and the live trainer (drag-to-reorder, inline edit,
// per-step replay). All editing affordances are gated behind optional props, so
// the detail view stays a plain presentational list.

import * as React from "react";
import { Badge, Button, Input, Text } from "@glaze/core/components";
import { Check, GripVertical, Loader2, Pencil, Play, X } from "lucide-react";

import { describeStep } from "../lib/describe-step";
import type { Step, StepType } from "../lib/recorder-types";

function badgeColor(type: StepType): "green" | "blue" | "secondary" {
  if (type === "assert") return "green";
  if (type === "goto" || type === "viewport" || type === "wait") return "blue";
  return "secondary";
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
      if (step.assert === "value" || step.assert === "url" || step.assert === "title")
        return { key: "value", label: "Expected", value: step.value ?? "" };
      if (step.assert === "attribute")
        return { key: "value", label: "Expected", value: step.value ?? "" };
      return null;
    default:
      return null;
  }
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
  onDelete,
  onReplay,
  onEdit,
  drag,
}: {
  index: number;
  step: Step;
  onDelete?: () => void;
  onReplay?: () => Promise<{ ok: boolean; error?: string }>;
  onEdit?: (patch: Partial<Step>) => void;
  drag?: StepDragProps;
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

  const flash =
    replay.status === "ok"
      ? "bg-support-green-10"
      : replay.status === "fail"
        ? "bg-support-red-10"
        : "hover:bg-control-subtle";

  return (
    <div
      className={`group flex items-center gap-2 rounded-md px-2 py-1 ${flash} ${
        drag?.isOver ? "border-t-2 border-accent" : ""
      } ${drag?.isDragging ? "opacity-50" : ""}`}
      onDragEnter={drag ? () => drag.onDragEnter() : undefined}
      onDragOver={drag ? (e) => e.preventDefault() : undefined}
      onDrop={drag ? (e) => e.preventDefault() : undefined}
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
        {step.type}
      </Badge>
      {step.soft ? (
        <Badge color="secondary" className="shrink-0">
          soft
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
          className="min-w-0 flex-1 truncate"
          title={replay.error || describeStep(step)}
        >
          {describeStep(step)}
        </Text>
      )}

      {!editing ? (
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {onReplay && step.type !== "goto" && step.type !== "viewport" ? (
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
