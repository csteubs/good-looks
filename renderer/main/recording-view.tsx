import * as React from "react";
import {
  Button,
  ScrollArea,
  SegmentedControl,
  SegmentedControlItem,
  Status,
  Text,
  Toolbar,
  ToolbarActions,
  ToolbarContent,
  ToolbarTitle,
} from "@glaze/core/components";
import { ChevronDown, ListPlus, Pause, Play, Plus, Wand2, X } from "lucide-react";

import type { AssertKind, RawStep } from "../lib/recorder-types";
import { useRecorder } from "./recorder-store";
import { StepRow } from "./step-row";
import { AddStepDialog, ADD_STEP_LABEL, type AddStepKind } from "./add-step-dialog";
import { GenerateStepsDialog } from "./generate-steps-dialog";

// Assertions that can be captured by clicking an element in the page. Operand
// assertions (value/attribute/count/url/title) need typed input, so they live in
// the "+ Add step" → Assertion form instead.
const ASSERT_PICKABLE: { kind: AssertKind; label: string }[] = [
  { kind: "visible", label: "Is visible" },
  { kind: "hidden", label: "Is hidden" },
  { kind: "text", label: "Contains text" },
  { kind: "exactText", label: "Has exact text" },
  { kind: "enabled", label: "Is enabled" },
  { kind: "disabled", label: "Is disabled" },
  { kind: "checked", label: "Is checked" },
  { kind: "unchecked", label: "Is unchecked" },
];

const ASSERT_LABEL: Record<AssertKind, string> = {
  visible: "Is visible",
  hidden: "Is hidden",
  text: "Contains text",
  exactText: "Has exact text",
  enabled: "Is enabled",
  disabled: "Is disabled",
  checked: "Is checked",
  unchecked: "Is unchecked",
  value: "Has value",
  attribute: "Has attribute",
  count: "Has count",
  url: "Page URL is",
  title: "Page title is",
};

// Order matters: index === commandId in the native "+ Add step" menu.
const ADD_STEP_KINDS: AddStepKind[] = ["assertion", "wait", "goto", "press", "find", "viewport"];

interface MenuPopupItem {
  label?: string;
  type?: "normal" | "separator";
  commandId?: number;
}
interface NativeMenu {
  popup: (options: { items: MenuPopupItem[]; x?: number; y?: number }) => Promise<{ commandId?: number }>;
}
function nativeMenu(): NativeMenu {
  return (window as unknown as { glazeAPI: { Menu: NativeMenu } }).glazeAPI.Menu;
}

/** Thin clickable strip between rows that moves the insert cursor. */
function CursorGap({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/gap flex h-2 w-full items-center px-2"
      aria-label="Move insert point here"
    >
      <span
        className={`h-0.5 w-full rounded-full ${
          active ? "bg-accent" : "bg-transparent group-hover/gap:bg-separator"
        }`}
      />
    </button>
  );
}

export function RecordingView() {
  const {
    state,
    liveSteps,
    pause,
    resume,
    stop,
    setAssert,
    deleteStep,
    insertStep,
    reorderStep,
    updateStep,
    setCursor,
    replayStep,
  } = useRecorder();

  const [soft, setSoft] = React.useState(false);
  const [addKind, setAddKind] = React.useState<AddStepKind | null>(null);
  const [aiOpen, setAiOpen] = React.useState(false);

  // Drag-to-reorder bookkeeping.
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overIndex, setOverIndex] = React.useState<number | null>(null);

  const openAssertMenu = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const res = await nativeMenu().popup({
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
      items: [
        ...ASSERT_PICKABLE.map((a, i) => ({ label: a.label, commandId: i })),
        { type: "separator" as const },
        { label: state.assertMode ? "Cancel assertion" : "— pick a kind above —", commandId: 99 },
      ],
    });
    if (res.commandId === 99) setAssert(null);
    else if (typeof res.commandId === "number" && ASSERT_PICKABLE[res.commandId]) {
      setAssert(ASSERT_PICKABLE[res.commandId].kind, soft);
    }
  };

  const openAddStepMenu = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const res = await nativeMenu().popup({
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
      items: ADD_STEP_KINDS.map((k, i) => ({ label: ADD_STEP_LABEL[k], commandId: i })),
    });
    if (typeof res.commandId === "number" && ADD_STEP_KINDS[res.commandId]) {
      setAddKind(ADD_STEP_KINDS[res.commandId]);
    }
  };

  const onSoftChange = (v: string) => {
    const next = v === "soft";
    setSoft(next);
    if (state.assertMode) setAssert(state.assertMode, next);
  };

  const commitDrag = () => {
    if (dragId && overIndex != null) reorderStep(dragId, overIndex);
    setDragId(null);
    setOverIndex(null);
  };

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <ToolbarContent>
          <ToolbarTitle>{state.editing ? "Editing recording" : "Recording"}</ToolbarTitle>
        </ToolbarContent>
        <ToolbarActions>
          <Button variant="destructive" onClick={stop}>
            Stop &amp; generate
          </Button>
        </ToolbarActions>
      </Toolbar>

      <div className="flex items-center gap-3 border-b border-separator px-4 py-3">
        <Status variant={state.paused ? "warning" : "error"}>
          {state.paused ? "Paused" : state.editing ? "Editing" : "Recording"}
        </Status>
        <Text variant="small" color="secondary" truncate className="min-w-0">
          {state.url}
        </Text>
        <div className="ml-auto shrink-0">
          {state.paused ? (
            <Button size="small" onClick={resume}>
              <Play className="size-4" /> Resume
            </Button>
          ) : (
            <Button size="small" onClick={pause}>
              <Pause className="size-4" /> Pause
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-separator px-4 py-2">
        <Text variant="small" color="secondary" className="shrink-0">
          Add assertion:
        </Text>
        <Button size="small" variant="muted" onClick={openAssertMenu}>
          {state.assertMode ? ASSERT_LABEL[state.assertMode] : "Choose…"}
          <ChevronDown className="size-3.5" />
        </Button>
        <SegmentedControl size="small" value={soft ? "soft" : "hard"} onValueChange={onSoftChange}>
          <SegmentedControlItem value="hard">Hard</SegmentedControlItem>
          <SegmentedControlItem value="soft">Soft</SegmentedControlItem>
        </SegmentedControl>
        {state.assertMode ? (
          <>
            <Text variant="small" color="blue" className="shrink-0">
              Click an element in the browser…
            </Text>
            <Button
              iconOnly
              variant="transparent"
              size="small"
              onClick={() => setAssert(null)}
              aria-label="Cancel assertion"
            >
              <X className="size-4" />
            </Button>
          </>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button size="small" variant="muted" onClick={openAddStepMenu}>
            <Plus className="size-3.5" /> Add step
          </Button>
          <Button size="small" variant="muted" onClick={() => setAiOpen(true)}>
            <Wand2 className="size-3.5" /> AI steps
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1" autoScrollToBottom autoScrollDeps={[liveSteps.length]}>
        <div className="flex flex-col p-3">
          {liveSteps.length === 0 ? (
            <div className="flex flex-col items-start gap-2 px-2 py-1">
              <Text variant="small" color="secondary">
                Interact with the site — steps appear here as you go.
              </Text>
              <Text variant="small" color="tertiary">
                Or use <ListPlus className="inline size-3.5 align-text-bottom" /> “Add step” / “AI steps”.
              </Text>
            </div>
          ) : (
            <>
              <CursorGap active={state.cursor === 0} onClick={() => setCursor(0)} />
              {liveSteps.map((s, i) => (
                <React.Fragment key={s.id}>
                  <StepRow
                    index={i}
                    step={s}
                    onDelete={() => deleteStep(s.id)}
                    onReplay={() => replayStep(s.id)}
                    onEdit={(patch) => updateStep(s.id, patch)}
                    drag={{
                      onDragStart: () => setDragId(s.id),
                      onDragEnter: () => setOverIndex(i),
                      onDragEnd: commitDrag,
                      isDragging: dragId === s.id,
                      isOver: overIndex === i && dragId !== null && dragId !== s.id,
                    }}
                  />
                  <CursorGap active={state.cursor === i + 1} onClick={() => setCursor(i + 1)} />
                </React.Fragment>
              ))}
            </>
          )}
        </div>
      </ScrollArea>

      {addKind ? (
        <AddStepDialog
          open={addKind !== null}
          kind={addKind}
          onOpenChange={(o) => !o && setAddKind(null)}
          onAdd={(step: RawStep) => insertStep(step)}
        />
      ) : null}
      <GenerateStepsDialog
        open={aiOpen}
        url={state.url}
        onOpenChange={setAiOpen}
        onInsert={(steps) => steps.forEach((s) => insertStep(s))}
      />
    </div>
  );
}
