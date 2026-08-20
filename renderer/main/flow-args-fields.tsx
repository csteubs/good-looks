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
import { Dialog, Field, Input, SegmentedControl, SegmentedControlItem, Text } from "@ui";

import { api, type FlowInfo } from "../lib/api";
import type { Step } from "../lib/recorder-types";

/** Mirror of `isValidVariableName` in main/recorder/types.ts — UI-side only,
 *  the backend re-validates on write (same duplication note as
 *  variables-panel.tsx). */
function isValidName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.length <= 40;
}

type RepeatMode = "once" | "count" | "variable";

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

/** Edit the arguments — and the call-site loop — of an already-inserted
 *  `runFlow` step.
 *
 *  Fetches the flow list itself rather than taking it from the composer: the
 *  step row is the only caller, and the flow's parameter list may have changed
 *  since the step was inserted. Saving prunes arguments for parameters the
 *  flow no longer declares — they were stored but bound to nothing.
 *
 *  `onSave` receives a step PATCH with the loop fields ALWAYS present, so the
 *  "Once" choice actually clears an existing repeat — a patch that omitted
 *  them would leave the old loop on the step. */
export function FlowArgsDialog({
  step,
  open,
  onOpenChange,
  onSave,
}: {
  step: Step;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (patch: { flowArgs: Record<string, string>; repeat?: number; repeatVar?: string }) => void;
}) {
  const flowsQuery = useQuery({
    queryKey: ["flows"],
    queryFn: () => api.tests.listFlows(),
    enabled: open,
  });
  const flow: FlowInfo | undefined = (flowsQuery.data ?? []).find((f) => f.id === step.flowId);
  const [values, setValues] = React.useState<Record<string, string>>(() => step.flowArgs ?? {});
  const [repeatMode, setRepeatMode] = React.useState<RepeatMode>("once");
  const [repeatCount, setRepeatCount] = React.useState("2");
  const [repeatName, setRepeatName] = React.useState("");
  const seedRepeat = () => {
    if (step.repeatVar) {
      setRepeatMode("variable");
      setRepeatName(step.repeatVar);
      setRepeatCount("2");
    } else if (typeof step.repeat === "number" && step.repeat > 1) {
      setRepeatMode("count");
      setRepeatCount(String(step.repeat));
      setRepeatName("");
    } else {
      setRepeatMode("once");
      setRepeatCount("2");
      setRepeatName("");
    }
  };
  // Re-seed from the step each time the dialog opens: the step may have been
  // edited in the meantime (two live windows mirror the same list).
  const [seededOpen, setSeededOpen] = React.useState<boolean>(false);
  if (seededOpen !== open) {
    setSeededOpen(open);
    if (open) {
      setValues(step.flowArgs ?? {});
      seedRepeat();
    }
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
        const count = Math.max(2, Math.min(100, Math.trunc(Number(repeatCount) || 2)));
        onSave({
          flowArgs: collectFlowArgs(flow?.flowParams ?? [], values),
          repeat: repeatMode === "count" ? count : undefined,
          repeatVar:
            repeatMode === "variable" && isValidName(repeatName) ? repeatName : undefined,
        });
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
        {flow ? (
          <>
            <Field label="Repeat" orientation="vertical">
              <SegmentedControl
                size="small"
                value={repeatMode}
                onValueChange={(v) => setRepeatMode(v as RepeatMode)}
              >
                <SegmentedControlItem value="once">Once</SegmentedControlItem>
                <SegmentedControlItem value="count">N times</SegmentedControlItem>
                <SegmentedControlItem value="variable">By variable</SegmentedControlItem>
              </SegmentedControl>
            </Field>
            {repeatMode === "count" ? (
              <Field label="Times" orientation="vertical">
                <Input
                  size="small"
                  type="number"
                  min={2}
                  max={100}
                  value={repeatCount}
                  aria-label="Repeat count"
                  onChange={(e) => setRepeatCount(e.target.value)}
                />
              </Field>
            ) : null}
            {repeatMode === "variable" ? (
              <>
                <Field label="Count variable" orientation="vertical">
                  <Input
                    size="small"
                    className="font-mono"
                    value={repeatName}
                    placeholder="resultCount"
                    aria-label="Repeat count variable"
                    onChange={(e) => setRepeatName(e.target.value)}
                  />
                </Field>
                <Text variant="small" className={isValidName(repeatName) || repeatName === "" ? "text-secondary" : "text-support-red"}>
                  {isValidName(repeatName) || repeatName === ""
                    ? "The variable's value at run time decides how many times the flow runs (capped at 100). Each iteration uses the same argument values."
                    : "Use letters, numbers and underscores, starting with a letter."}
                </Text>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
