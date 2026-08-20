// Read-only inline preview of a flow's steps, rendered beneath an expanded
// `runFlow` row in the trainer — "see what this call does without leaving the
// caller". The rows are the same StepRow the rest of the app draws, with every
// editing affordance withheld: these steps belong to the FLOW record, and
// until inline flow editing exists the flow's own trainer is where they
// change. Values render as recorded (`${email}`, not the bound value), the
// same no-variable-context rule describeStep follows everywhere.

import * as React from "react";
import { Text } from "@ui";

import { api } from "../lib/api";
import { computeStepDepths } from "../lib/describe-step";
import { StepRow } from "./step-row";
import type { TestRecord } from "../lib/recorder-types";

export function FlowStepsPreview({
  flowId,
  indent = 1,
  onEditFlow,
}: {
  flowId: string;
  /** Indent level of the call row, so the preview nests one deeper. */
  indent?: number;
  /** Enter the flow's inline-editing scope. Offered only where a host can
   *  (the trainers); the detail view's preview stays purely a quotation. */
  onEditFlow?: () => void;
}) {
  const [flow, setFlow] = React.useState<TestRecord | null | undefined>(undefined);

  React.useEffect(() => {
    let live = true;
    setFlow(undefined);
    // Try/catch as well as .catch: a bridge without the channel throws
    // synchronously, and a preview must degrade to "can't be found" rather
    // than take the trainer down with an uncaught effect error.
    try {
      void api.tests
        .get(flowId)
        .then((rec) => {
          if (live) setFlow(rec ?? null);
        })
        .catch(() => {
          if (live) setFlow(null);
        });
    } catch {
      setFlow(null);
    }
    return () => {
      live = false;
    };
  }, [flowId]);

  const depths = flow ? computeStepDepths(flow.steps) : [];

  return (
    // A left rail in the flow chip's own hue, so the borrowed rows read as a
    // quotation from another test rather than more of this one.
    <div
      className="ml-6 flex flex-col"
      style={{ borderLeft: "2px solid #b9a6e055", paddingLeft: 6 }}
      role="group"
      aria-label="Flow steps (read-only)"
    >
      {flow === undefined ? (
        <Text size="small" className="px-2 py-1 text-tertiary">
          Loading flow steps…
        </Text>
      ) : flow === null ? (
        <Text size="small" className="px-2 py-1 text-support-red">
          This flow can&apos;t be found — it may have been deleted.
        </Text>
      ) : flow.steps.length === 0 ? (
        <Text size="small" className="px-2 py-1 text-tertiary">
          “{flow.name}” has no steps yet.
        </Text>
      ) : (
        <>
          {flow.steps.map((s, i) => (
            <StepRow key={s.id} index={i} step={s} indent={indent - 1 + depths[i]} />
          ))}
          {onEditFlow ? (
            <div className="px-2 py-1">
              <button
                type="button"
                className="cursor-pointer text-[12px] underline decoration-dotted underline-offset-2"
                onClick={onEditFlow}
              >
                Edit “{flow.name}” here — changes reach every test that calls it
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
