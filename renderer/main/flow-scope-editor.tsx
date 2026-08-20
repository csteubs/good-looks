// The editable inline-flow region: what an expanded `runFlow` row becomes once
// the user enters its flow's scope. Rendered by BOTH trainers — the rows, the
// cursor gaps and the banner must not differ between the two windows showing
// one session, the same argument the step list itself makes.
//
// Everything here edits the scope's WORKING COPY through the ordinary store
// actions (the backend routes by step id), and nothing commits until the Done
// button — or any save/replay path — calls exitFlowScope. The banner says so,
// with the caller count, because the whole risk of inline editing is a user
// who believes they are editing THIS test.

import * as React from "react";
import { Check, Workflow } from "lucide-react";

import { Btn } from "../theme";
import { api } from "../lib/api";
import { computeStepDepths } from "../lib/describe-step";
import { CursorGap, INSERT_HERE, StepRow } from "./step-row";
import type { FlowScopePayload, Step, TestVariable } from "../lib/recorder-types";

export function FlowScopeEditor({
  scope,
  controlsDisabled,
  onExit,
  composerAt,
  onDelete,
  onEdit,
  onReplay,
  onReorder,
  onSetCursor,
  indent = 1,
}: {
  scope: FlowScopePayload;
  controlsDisabled: boolean;
  /** Commit and close — the host's exitFlowScope. */
  onExit: () => void;
  /** The host's Add-step composer, rendered at the scope's cursor gap so an
   *  Add-step submit lands where the caret shows it landing. */
  composerAt: (index: number) => React.ReactNode;
  onDelete: (stepId: string) => void;
  onEdit: (stepId: string, patch: Partial<Step>) => void;
  onReplay: (stepId: string) => Promise<{ ok: boolean; error?: string }>;
  onReorder: (stepId: string, toIndex: number) => void;
  onSetCursor: (index: number) => void;
  /** Indent level of the call row, so the editor nests one deeper. */
  indent?: number;
}) {
  // The flow's own declarations, for the rows' variable-insert button — a step
  // inside the flow interpolates the FLOW's variables, not the caller's.
  const [variables, setVariables] = React.useState<TestVariable[]>([]);
  React.useEffect(() => {
    let live = true;
    try {
      void api.tests
        .get(scope.flowId)
        .then((rec) => {
          if (live) setVariables(rec?.variables ?? []);
        })
        .catch(() => {});
    } catch {
      /* preview bridges without the channel — the insert button just hides */
    }
    return () => {
      live = false;
    };
  }, [scope.flowId]);

  // How many tests this commit will reach — the number that makes the banner a
  // warning rather than a label.
  const [callers, setCallers] = React.useState<number | null>(null);
  React.useEffect(() => {
    let live = true;
    try {
      void api.tests
        .flowUsage(scope.flowId)
        .then((list) => {
          if (live) setCallers(list.length);
        })
        .catch(() => {});
    } catch {
      /* same degradation */
    }
    return () => {
      live = false;
    };
  }, [scope.flowId]);

  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overIndex, setOverIndex] = React.useState<number | null>(null);
  const commitDrag = () => {
    if (dragId && overIndex != null) onReorder(dragId, overIndex);
    setDragId(null);
    setOverIndex(null);
  };

  const depths = computeStepDepths(scope.steps);

  return (
    <div
      className="flex flex-col"
      style={{ marginLeft: indent * 20 + 4, borderLeft: "2px solid #b9a6e0", paddingLeft: 6 }}
      role="group"
      aria-label={`Editing flow ${scope.name}`}
    >
      <div className="flex items-center gap-2 px-2 py-1 text-[12px]">
        <Workflow className="size-3.5 shrink-0" style={{ color: "#b9a6e0" }} aria-hidden="true" />
        <span className="min-w-0">
          Recording into <strong>“{scope.name}”</strong>
          {callers !== null
            ? ` — edits apply to ${callers} test${callers === 1 ? "" : "s"} on Done`
            : " — edits apply to every test that calls it"}
        </span>
        <Btn className="ml-auto shrink-0" onClick={onExit} disabled={controlsDisabled}>
          <Check className="size-3.5" /> Done editing flow
        </Btn>
      </div>
      <CursorGap
        active={scope.cursor === 0}
        onClick={() => onSetCursor(0)}
        disabled={controlsDisabled}
        label={INSERT_HERE}
      />
      {composerAt(0)}
      {scope.steps.map((s, i) => (
        <React.Fragment key={s.id}>
          <StepRow
            index={i}
            step={s}
            indent={depths[i]}
            variables={variables}
            onDelete={controlsDisabled ? undefined : () => onDelete(s.id)}
            onReplay={controlsDisabled ? undefined : () => onReplay(s.id)}
            onEdit={controlsDisabled ? undefined : (patch) => onEdit(s.id, patch)}
            drag={
              controlsDisabled
                ? undefined
                : {
                    onDragStart: () => setDragId(s.id),
                    onDragEnter: () => setOverIndex(i),
                    onDragEnd: commitDrag,
                    isDragging: dragId === s.id,
                    isOver: overIndex === i && dragId !== null && dragId !== s.id,
                  }
            }
          />
          <CursorGap
            active={scope.cursor === i + 1}
            onClick={() => onSetCursor(i + 1)}
            disabled={controlsDisabled}
            label={i + 1 === scope.steps.length ? undefined : INSERT_HERE}
          />
          {composerAt(i + 1)}
        </React.Fragment>
      ))}
    </div>
  );
}
