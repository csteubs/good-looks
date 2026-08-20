// Per-call-site editor for a `runFlow` step's parameter overrides.
//
// A flow call has two layers of values: the flow's own defaults (its variables,
// managed on the flow's Variables tab) and this call's overrides (`flowArgs`).
// This dialog edits ONLY the overrides — an empty field means "use the flow's
// default", so clearing a field is how a call reverts to following the flow.
//
// A dialog rather than StepRow's inline editor because a call has one field PER
// PARAMETER: the row's single-field idiom cannot hold it, and a multi-field
// popover anchored to a row this narrow would clip. Used from the trainer's
// step rows and from Edit Steps — both hand the patch back through their own
// `onEdit`, so the same component edits a live session step and a local draft.

import * as React from "react";
import { Dialog, Field, Input, SegmentedControl, SegmentedControlItem, Text } from "@ui";

import { api } from "../lib/api";
import type { Step, TestRecord } from "../lib/recorder-types";

/** Mirror of `isValidVariableName` in main/recorder/types.ts — UI-side only,
 *  the backend re-validates on write (same duplication note as
 *  variables-panel.tsx). */
function isValidName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.length <= 40;
}

type RepeatMode = "once" | "count" | "variable";

/** The editable view of one flow call: each parameter with its default and the
 *  call's current override. Derived from the FLOW record, not the step — the
 *  step may carry stale keys for parameters the flow no longer declares, and
 *  those are dropped on save rather than offered as fields. */
export interface FlowParamField {
  name: string;
  defaultValue: string | null;
}

/** Which of a flow's parameters can take a textual override, with the default
 *  an unoverridden call will use. A secret or captured parameter resolves at
 *  run time and is deliberately not offered — an override would put a
 *  plaintext value where the runtime one belongs. */
export function paramFields(flow: Pick<TestRecord, "flowParams" | "variables">): FlowParamField[] {
  return (flow.flowParams ?? []).map((name) => {
    const declared = (flow.variables ?? []).find((v) => v.name === name);
    if (declared && declared.kind !== "plain") return { name, defaultValue: null };
    return { name, defaultValue: declared?.value ?? "" };
  });
}

export function FlowCallDialog({
  step,
  open,
  onOpenChange,
  onSave,
}: {
  step: Step;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the next call-site patch: `flowArgs` holds only non-empty
   *  overrides (possibly empty — every parameter following the default), and
   *  the loop fields are ALWAYS present so clearing a repeat actually clears
   *  it — a patch that omitted them would leave the old loop in place. */
  onSave: (patch: { flowArgs: Record<string, string>; repeat?: number; repeatVar?: string }) => void;
}) {
  const [flow, setFlow] = React.useState<TestRecord | null | undefined>(undefined);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [repeatMode, setRepeatMode] = React.useState<RepeatMode>("once");
  const [repeatCount, setRepeatCount] = React.useState("2");
  const [repeatName, setRepeatName] = React.useState("");

  // Fetched on open rather than held by the host: the flow's parameter set can
  // change in another window while this list is on screen, and the dialog must
  // describe the flow as it IS, not as it was when the row rendered.
  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setFlow(undefined);
    setDrafts(step.flowArgs ? { ...step.flowArgs } : {});
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
    if (!step.flowId) {
      setFlow(null);
      return;
    }
    void api.tests
      .get(step.flowId)
      .then((rec) => {
        if (live) setFlow(rec ?? null);
      })
      .catch(() => {
        if (live) setFlow(null);
      });
    return () => {
      live = false;
    };
  }, [open, step.flowId, step.flowArgs, step.repeat, step.repeatVar]);

  const fields = flow ? paramFields(flow) : [];
  const name = flow?.name ?? step.label ?? "flow";
  const repeatNameOk = repeatMode !== "variable" || isValidName(repeatName);

  const save = () => {
    const next: Record<string, string> = {};
    for (const field of fields) {
      if (field.defaultValue === null) continue;
      const draft = drafts[field.name];
      if (typeof draft === "string" && draft !== "") next[field.name] = draft;
    }
    const count = Math.max(2, Math.min(100, Math.trunc(Number(repeatCount) || 2)));
    onSave({
      flowArgs: next,
      repeat: repeatMode === "count" ? count : undefined,
      repeatVar: repeatMode === "variable" && isValidName(repeatName) ? repeatName : undefined,
    });
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Parameters for “${name}”`}
      description="Overrides apply to this call only. Leave a field empty to follow the flow's default."
      confirmLabel="Save"
      onConfirm={save}
    >
      <div className="flex flex-col gap-3">
        {flow === undefined ? (
          <Text size="small" className="text-tertiary">
            Loading…
          </Text>
        ) : flow === null ? (
          <Text size="small" className="text-support-red">
            This flow can&apos;t be found — it may have been deleted. The call will say so in the
            generated script until it points at an existing flow.
          </Text>
        ) : (
          <>
            {fields.length === 0 ? (
              <Text size="small" className="text-tertiary">
                “{name}” declares no parameters. Add some on the flow&apos;s Variables tab to make
                calls like this one configurable.
              </Text>
            ) : (
              fields.map((field) => (
                <Field key={field.name} label={field.name} orientation="vertical">
                  {field.defaultValue === null ? (
                    <Text size="small" className="text-tertiary">
                      Resolved at run time (secret or captured) — not overridable here.
                    </Text>
                  ) : (
                    <Input
                      size="small"
                      className="font-mono"
                      value={drafts[field.name] ?? ""}
                      placeholder={
                        field.defaultValue === ""
                          ? "default: (empty)"
                          : `default: ${field.defaultValue}`
                      }
                      aria-label={`Override for ${field.name}`}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [field.name]: e.target.value }))
                      }
                    />
                  )}
                </Field>
              ))
            )}
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
                <Text size="small" className={repeatNameOk ? "text-secondary" : "text-support-red"}>
                  {repeatNameOk
                    ? "The variable's value at run time decides how many times the flow runs (capped at 100). Each iteration uses the same parameter values."
                    : "Use letters, numbers and underscores, starting with a letter — the name becomes a property in the generated spec."}
                </Text>
              </>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}
