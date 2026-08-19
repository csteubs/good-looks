// The argument form for a parameterized flow call, shared by the two places a
// call's arguments are set: the Add-step composer (at insert) and the step
// row's "Edit Flow Arguments…" dialog (afterwards).
//
// The one rule both surfaces must agree on lives in `collectFlowArgs`: a BLANK
// field is an argument the caller is not supplying, so its key is omitted and
// the flow's own default applies at generation time. Sending "" instead would
// override the default with an empty string — `expandSteps` treats any
// supplied string as the caller's answer — and the difference is invisible in
// the UI, which is exactly why the rule is centralized here and pinned by
// tests.

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, Field, Input, Text } from "@ui";

import { api, type FlowInfo } from "../lib/api";
import type { Step } from "../lib/recorder-types";

/** Arguments to store on a `runFlow` step: only the parameters the user
 *  actually filled in, and only names the flow declares. */
export function collectFlowArgs(
  params: string[],
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of params) {
    const v = values[p];
    if (typeof v === "string" && v !== "") out[p] = v;
  }
  return out;
}

export function FlowArgsFields({
  params,
  defaults,
  values,
  onChange,
}: {
  params: string[];
  defaults: Record<string, string>;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  if (params.length === 0) return null;
  return (
    <>
      {params.map((p) => (
        <Field key={p} label={p} orientation="vertical">
          <Input
            size="small"
            value={values[p] ?? ""}
            onChange={(e) => onChange({ ...values, [p]: e.target.value })}
            placeholder={defaults[p] ? `Default: ${defaults[p]}` : "Uses the flow's default"}
            aria-label={`Flow argument ${p}`}
          />
        </Field>
      ))}
      <Text variant="small" color="tertiary">
        Blank arguments use the flow's own defaults. Values may reference this test's variables
        with {"${name}"}.
      </Text>
    </>
  );
}

/** Edit the arguments of an already-inserted `runFlow` step.
 *
 *  Fetches the flow list itself rather than taking it from the composer: the
 *  step row is the only caller, and the flow's parameter list may have changed
 *  since the step was inserted. Saving prunes arguments for parameters the
 *  flow no longer declares — they were stored but bound to nothing. */
export function FlowArgsDialog({
  step,
  open,
  onOpenChange,
  onSave,
}: {
  step: Step;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (args: Record<string, string>) => void;
}) {
  const flowsQuery = useQuery({
    queryKey: ["flows"],
    queryFn: () => api.tests.listFlows(),
    enabled: open,
  });
  const flow: FlowInfo | undefined = (flowsQuery.data ?? []).find((f) => f.id === step.flowId);
  const [values, setValues] = React.useState<Record<string, string>>(() => step.flowArgs ?? {});
  // Re-seed from the step each time the dialog opens: the step may have been
  // edited in the meantime (two live windows mirror the same list).
  const [seededOpen, setSeededOpen] = React.useState<boolean>(open);
  if (seededOpen !== open) {
    setSeededOpen(open);
    if (open) setValues(step.flowArgs ?? {});
  }
  if (!open) return null;
  const name = step.label || step.flowId || "flow";
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={`Arguments for ${name}`}
      size="small"
      confirmLabel="Save"
      confirmDisabled={!flow}
      onConfirm={() => {
        onSave(collectFlowArgs(flow?.flowParams ?? [], values));
        onOpenChange(false);
      }}
    >
      <div className="flex flex-col gap-3">
        {flow ? (
          flow.flowParams.length > 0 ? (
            <FlowArgsFields
              params={flow.flowParams}
              defaults={flow.paramDefaults}
              values={values}
              onChange={setValues}
            />
          ) : (
            <Text variant="small" color="secondary">
              This flow declares no parameters. Mark variables as parameters on the flow's
              Variables tab to make it configurable.
            </Text>
          )
        ) : (
          <Text variant="small" color="secondary">
            {flowsQuery.isLoading
              ? "Loading flow…"
              : "This flow is no longer available — it may have been deleted or unmarked as a reusable flow."}
          </Text>
        )}
      </div>
    </Dialog>
  );
}
