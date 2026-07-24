// A single recorded step row, shared by the live recording view and the test
// detail view.

import { Badge, Button, Text } from "@glaze/core/components";
import { X } from "lucide-react";

import { describeStep } from "../lib/describe-step";
import type { Step, StepType } from "../lib/recorder-types";

function badgeColor(type: StepType): "green" | "blue" | "secondary" {
  if (type === "assert") return "green";
  if (type === "goto") return "blue";
  return "secondary";
}

export function StepRow({
  index,
  step,
  onDelete,
}: {
  index: number;
  step: Step;
  onDelete?: () => void;
}) {
  return (
    <div className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-control-subtle">
      <Text variant="small-mono" color="tertiary" className="w-6 shrink-0 text-right tabular-nums">
        {index + 1}
      </Text>
      <Badge color={badgeColor(step.type)} className="shrink-0">
        {step.type}
      </Badge>
      <Text variant="small-mono" className="min-w-0 truncate" title={describeStep(step)}>
        {describeStep(step)}
      </Text>
      {onDelete ? (
        <Button
          iconOnly
          variant="transparent"
          size="small"
          className="ml-auto shrink-0 opacity-0 group-hover:opacity-100"
          onClick={onDelete}
          aria-label="Delete step"
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
