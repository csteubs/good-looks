// "Edit Steps" mode for the test detail view — add, rearrange, and remove
// steps without opening the training browser. Operates on a local draft of
// the Step[] and commits to the backend via tests:updateSteps, which
// regenerates the spec from the new step list. When the script is NOT
// generated from steps, the owning view asks the user what to do with it on
// save — this editor's job is to warn up front that saving alone won't change
// the run. Only locator-free step types can be added here; element-targeted
// steps still need the trainer's browser picker.

import * as React from "react";
import {
  Button,
  Callout,
  Dialog,
  Field,
  Input,
  SegmentedControl,
  SegmentedControlItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
} from "@ui";
import { Plus, ListPlus, TriangleAlert } from "lucide-react";

import type { AssertKind, RawStep, Step } from "../lib/recorder-types";
import { StepRow } from "./step-row";
import { computeStepDepths } from "../lib/describe-step";
import { clampViewportAxis, RESIZE_PRESETS } from "../lib/viewport-presets";

// Locator-free step kinds offered in the "+ Add step" menu. Element-targeted
// steps (most assertions, find, element conditions, wait-for-element) need
// the trainer's browser picker and are intentionally excluded here.
type EditStepKind = "goto" | "wait" | "viewport" | "press" | "assertUrl" | "assertTitle";

const KIND_LABEL: Record<EditStepKind, string> = {
  goto: "Go to URL",
  wait: "Wait (duration)",
  viewport: "Set viewport",
  press: "Press key",
  assertUrl: "Assert page URL",
  assertTitle: "Assert page title",
};

const KINDS: EditStepKind[] = ["goto", "wait", "viewport", "press", "assertUrl", "assertTitle"];

interface NativeMenu {
  popup: (options: {
    items: { label?: string; type?: "normal" | "separator"; commandId?: number }[];
    x?: number;
    y?: number;
    coordinateSpace?: "screen" | "view";
  }) => Promise<{ commandId?: number }>;
}
function nativeMenu(): NativeMenu {
  return (window as unknown as { glazeAPI: { Menu: NativeMenu } }).glazeAPI.Menu;
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export interface EditStepsViewProps {
  steps: Step[];
  /** True when the script is NOT generated from these steps — hand-edited,
   *  imported, or written by the model. Saving then can't quietly update what
   *  runs, so say so BEFORE the user spends time editing, not only at save. */
  scriptEdited?: boolean;
  /** True for an imported test, whose verbatim spec is never regenerated —
   *  editing steps here can only ever change the list, not the run. */
  imported?: boolean;
  onCancel: () => void;
  onSave: (steps: Step[]) => Promise<void>;
}

export function EditStepsView({
  steps: initialSteps,
  scriptEdited,
  imported,
  onCancel,
  onSave,
}: EditStepsViewProps) {
  const [draft, setDraft] = React.useState<Step[]>(initialSteps);
  const [saving, setSaving] = React.useState(false);
  const [addKind, setAddKind] = React.useState<EditStepKind | null>(null);
  // Drag-to-reorder bookkeeping — mirrors the trainer's recording-view pattern.
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overIndex, setOverIndex] = React.useState<number | null>(null);

  const depths = computeStepDepths(draft);

  const deleteStep = (id: string) => {
    setDraft((prev) => prev.filter((s) => s.id !== id));
  };

  const updateStep = (id: string, patch: Partial<Step>) => {
    setDraft((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const commitDrag = () => {
    if (dragId && overIndex != null) {
      setDraft((prev) => {
        const fromIndex = prev.findIndex((s) => s.id === dragId);
        if (fromIndex < 0 || fromIndex === overIndex) return prev;
        const next = [...prev];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(overIndex, 0, moved);
        return next;
      });
    }
    setDragId(null);
    setOverIndex(null);
  };

  const openAddMenu = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const res = await nativeMenu().popup({
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
      coordinateSpace: "view",
      items: KINDS.map((k, i) => ({ label: KIND_LABEL[k], commandId: i })),
    });
    if (typeof res.commandId === "number" && KINDS[res.commandId]) {
      setAddKind(KINDS[res.commandId]);
    }
  };

  const handleAdd = (rawSteps: RawStep[]) => {
    const newSteps: Step[] = rawSteps.map((r) => ({
      ...r,
      id: uid(),
      timestamp: Date.now(),
    }));
    setDraft((prev) => [...prev, ...newSteps]);
    setAddKind(null);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-end gap-3 border-b border-separator px-4 py-2">
        <Text variant="small" color="tertiary" className="mr-auto">
          Reorder by dragging, click the value to edit, or remove with ✕. Element-targeted steps need the trainer.
        </Text>
        <Button size="small" variant="glass" onClick={openAddMenu}>
          <Plus className="size-3.5" /> Add step
        </Button>
        <Button size="small" variant="glass" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="small" variant="accent" onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {scriptEdited ? (
        <div className="px-4 pt-2">
          <Callout color="yellow" icon={<TriangleAlert className="size-4" />}>
            <Callout.Text>
              {imported
                ? "This test runs its imported script, and that file is never regenerated. Saving updates this step list only — the run won't change."
                : "This test's script isn't generated from these steps — it was edited directly. Saving asks whether to rebuild the script from these steps or leave it as it is."}
            </Callout.Text>
          </Callout>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {draft.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
            <ListPlus className="size-6 text-tertiary" />
            <Text variant="small" color="secondary">
              No steps. Add one below.
            </Text>
          </div>
        ) : (
          <div className="flex flex-col gap-1 p-3">
            {draft.map((step, i) => (
              <StepRow
                key={step.id}
                index={i}
                step={step}
                indent={depths[i]}
                onDelete={() => deleteStep(step.id)}
                onEdit={(patch) => updateStep(step.id, patch)}
                drag={{
                  onDragStart: () => setDragId(step.id),
                  onDragEnter: () => setOverIndex(i),
                  onDragEnd: commitDrag,
                  isDragging: dragId === step.id,
                  isOver: overIndex === i && dragId !== null && dragId !== step.id,
                }}
              />
            ))}
          </div>
        )}
      </div>
      <EditStepAddDialog
        open={addKind !== null}
        kind={addKind}
        onOpenChange={(o) => !o && setAddKind(null)}
        onAdd={handleAdd}
      />
    </div>
  );
}

// ── Add-step dialog (locator-free types only) ───────────────────────────

function EditStepAddDialog({
  open,
  kind,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  kind: EditStepKind | null;
  onOpenChange: (open: boolean) => void;
  onAdd: (steps: RawStep[]) => void;
}) {
  const [url, setUrl] = React.useState("");
  const [waitMs, setWaitMs] = React.useState("1000");
  const [key, setKey] = React.useState("Enter");
  const [viewport, setViewport] = React.useState("desktop");
  const [vw, setVw] = React.useState("1280");
  const [vh, setVh] = React.useState("800");
  const [assertValue, setAssertValue] = React.useState("");
  const [soft, setSoft] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setUrl("");
      setWaitMs("1000");
      setKey("Enter");
      setViewport("desktop");
      setVw("1280");
      setVh("800");
      setAssertValue("");
      setSoft(false);
    }
  }, [open, kind]);

  function build(): RawStep[] | null {
    if (!kind) return null;
    switch (kind) {
      case "goto":
        return url.trim() ? [{ type: "goto", url: url.trim() }] : null;
      case "wait":
        return [{ type: "wait", waitMs: Number(waitMs) || 0 }];
      case "press":
        return [{ type: "press", value: key || "Enter" }];
      case "viewport": {
        if (viewport === "custom") {
          return [
            {
              type: "viewport",
              width: clampViewportAxis(vw, 1280),
              height: clampViewportAxis(vh, 800),
            },
          ];
        }
        const p = RESIZE_PRESETS.find((v) => v.id === viewport);
        return [{ type: "viewport", width: p?.w ?? 1280, height: p?.h ?? 800 }];
      }
      case "assertUrl":
        return assertValue.trim()
          ? [{ type: "assert", assert: "url" as AssertKind, value: assertValue.trim(), soft: soft || undefined }]
          : null;
      case "assertTitle":
        return assertValue.trim()
          ? [{ type: "assert", assert: "title" as AssertKind, value: assertValue.trim(), soft: soft || undefined }]
          : null;
      default:
        return null;
    }
  }

  function submit() {
    const steps = build();
    if (!steps || steps.length === 0) return;
    onAdd(steps);
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={kind ? KIND_LABEL[kind] : "Add step"}
      onConfirm={submit}
      confirmLabel="Add step"
    >
      <div className="flex flex-col gap-3">
        {kind === "goto" ? (
          <Field label="URL" orientation="vertical">
            <Input
              autoFocus
              placeholder="https://example.com/page"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
        ) : null}

        {kind === "wait" ? (
          <Field label="Duration (ms)" orientation="vertical">
            <Input
              autoFocus
              size="small"
              type="number"
              value={waitMs}
              onChange={(e) => setWaitMs(e.target.value)}
            />
          </Field>
        ) : null}

        {kind === "press" ? (
          <Field label="Key" orientation="vertical">
            <Input autoFocus size="small" value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
        ) : null}

        {kind === "viewport" ? (
          <>
            <Field label="Viewport" orientation="vertical">
              <Select value={viewport} onValueChange={setViewport}>
                <SelectTrigger size="small">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESIZE_PRESETS.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.label}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">Custom…</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {viewport === "custom" ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Width" orientation="vertical">
                  <Input size="small" type="number" value={vw} onChange={(e) => setVw(e.target.value)} />
                </Field>
                <Field label="Height" orientation="vertical">
                  <Input size="small" type="number" value={vh} onChange={(e) => setVh(e.target.value)} />
                </Field>
              </div>
            ) : null}
          </>
        ) : null}

        {kind === "assertUrl" || kind === "assertTitle" ? (
          <>
            <Field
              label={kind === "assertUrl" ? "Expected (substring or regex)" : "Expected (substring or regex)"}
              orientation="vertical"
            >
              <Input
                autoFocus
                size="small"
                value={assertValue}
                onChange={(e) => setAssertValue(e.target.value)}
              />
            </Field>
            <Field label="Type" orientation="vertical">
              <SegmentedControl size="small" value={soft ? "soft" : "hard"} onValueChange={(v) => setSoft(v === "soft")}>
                <SegmentedControlItem value="hard">Hard</SegmentedControlItem>
                <SegmentedControlItem value="soft">Soft</SegmentedControlItem>
              </SegmentedControl>
            </Field>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
