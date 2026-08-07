// The docked trainer panel: mabl's Trainer, in one narrow column pinned beside
// the training browser.
//
// SCOPE. This is deliberately the essentials — status, the step list, the tool
// row, replay, save/discard — and NOT a second copy of the whole trainer. The
// Console, Step details and Cookies tabs stay in the main window: at ~360px a
// tabbed log pane is unreadable, and the panel's job is the loop you repeat
// hundreds of times per test (click in the page, add a step, adjust it), not
// the one you do when something has already gone wrong.
//
// MIRRORING. The main window's `RecordingView` stays live and shows the same
// session. That works because the BACKEND owns step ordering and broadcasts the
// whole list after every change (`recorder:steps`), so neither window holds
// authoritative state that the other could contradict — they are two renderings
// of one list. The pieces that must NOT be shared are the ones that are already
// per-window React state in the store: `refiningStepId` and the local dialog
// flags. That is what stops a Refine started here from also opening a dialog
// over there.
//
// The one genuine conflict is `recorder:contextAction` — a right-click in the
// training browser is broadcast to both windows, and both would open a
// prefilled Add-step dialog. The backend addresses it (`target`), and each view
// ignores what is not for it. See the effect below.

import * as React from "react";
import {
  Badge,
  Button,
  Dialog,
  ScrollArea,
  Status,
  Text,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@ui";
import {
  CheckSquare,
  ChevronDown,
  Crosshair,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Shrink,
  Wand2,
  X,
} from "lucide-react";

import { api } from "../lib/api";
import type { AssertKind, PickedElement, RawStep, WaitDialogMode } from "../lib/recorder-types";
import { computeStepDepths, describeStep } from "../lib/describe-step";
import { useRecorder } from "../main/recorder-store";
import { CursorGap, StepRow } from "../main/step-row";
import { AddStepDialog, ADD_STEP_LABEL, type AddStepKind } from "../main/add-step-dialog";
import { GenerateStepsDialog } from "../main/generate-steps-dialog";
import { RefineSelectorDialog } from "../main/refine-selector-dialog";

/** Assertions capturable by clicking an element — same set as the main trainer. */
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

/** Order matters: index === commandId in the native "+ Add step" menu. */
const ADD_STEP_KINDS: AddStepKind[] = [
  "assertion",
  "condition",
  "wait",
  "goto",
  "press",
  "find",
  "viewport",
  "capture",
  "runFlow",
];

interface MenuPopupItem {
  label?: string;
  type?: "normal" | "separator";
  commandId?: number;
}
interface NativeMenu {
  popup: (options: {
    items: MenuPopupItem[];
    x?: number;
    y?: number;
    coordinateSpace?: "screen" | "view";
  }) => Promise<{ commandId?: number }>;
}
function nativeMenu(): NativeMenu {
  return (window as unknown as { glazeAPI: { Menu: NativeMenu } }).glazeAPI.Menu;
}

/** Icon button with a tooltip — the tool row is icon-only to fit the width, so
 *  every control needs a name that is discoverable without one. */
function ToolButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="small"
          variant="muted"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function TrainerPanelView() {
  const {
    state,
    stepsLoaded,
    liveSteps,
    newStepIds,
    pause,
    resume,
    stop,
    discardExit,
    setAssert,
    deleteStep,
    insertStep,
    insertGeneratedSteps,
    reorderStep,
    updateStep,
    setCursor,
    replayStep,
    replayFromCurrent,
    replayRun,
    executing,
    replayStepStatus,
    replayFlash,
    picked,
    refiningStepId,
    startRefine,
    endRefine,
    clearPicked,
    contextAction,
    clearContextAction,
  } = useRecorder();

  const [addKind, setAddKind] = React.useState<AddStepKind | null>(null);
  const [aiOpen, setAiOpen] = React.useState(false);
  const [exitOpen, setExitOpen] = React.useState(false);
  const [selectedStepId, setSelectedStepId] = React.useState<string | null>(null);
  const [replayStatus, setReplayStatus] = React.useState<string | null>(null);
  const [addStepPicking, setAddStepPicking] = React.useState(false);
  const [docked, setDocked] = React.useState(true);
  const [contextPick, setContextPick] = React.useState<{
    picked: PickedElement | null;
    assert?: AssertKind;
    waitMode?: WaitDialogMode;
    prefillText?: string;
    prefillValue?: string;
  } | null>(null);

  // `state.replaying` is what makes this true for a replay started in the MAIN
  // window: `executing` and `replayRun` are both local to the window that asked
  // for the run. Without it this panel stays on "Recording" with live controls
  // while the browser beside it is being driven by a replay. See the mirror of
  // this comment in recording-view.tsx.
  const running = executing || !!replayRun?.running || state.replaying;
  // Controls stay inert until the training browser has loaded its first page,
  // until THIS window actually holds the step list, and while a replay is in
  // flight. The steps clause matters for a window that opened mid-session and
  // missed the initial `recorder:steps` push: editing against a list you have
  // not received yet inserts at the wrong position, and the insert cursor the
  // backend sent means nothing without the rows it points between.
  const controlsDisabled = !state.pageReady || !stepsLoaded || running;

  // Dock state is owned by the backend (it moves real windows), so the button
  // reflects what actually happened rather than an optimistic local guess —
  // docking can legitimately be REFUSED when the display is too small.
  React.useEffect(() => {
    const offDocked = api.on("trainerPanel:docked", () => setDocked(true));
    const offUndocked = api.on("trainerPanel:undocked", () => setDocked(false));
    return () => {
      offDocked();
      offUndocked();
    };
  }, []);

  // A right-click test-tools action from the training browser. The backend
  // addresses it to whichever trainer should handle it; ignoring the ones meant
  // for the main window is what stops two prefilled dialogs opening at once.
  React.useEffect(() => {
    if (!contextAction) return;
    const a = contextAction;
    if (a.target && a.target !== "panel") {
      clearContextAction();
      return;
    }
    if (a.kind === "refine") {
      if (a.picked) {
        setContextPick({
          picked: a.picked,
          assert: "visible",
          prefillText: a.prefillText,
          prefillValue: a.prefillValue,
        });
        setAddKind("assertion");
      }
    } else if (a.kind === "assertion") {
      setContextPick({
        picked: a.picked,
        assert: a.assert,
        prefillText: a.prefillText,
        prefillValue: a.prefillValue,
      });
      setAddKind("assertion");
    } else if (a.kind === "wait") {
      setContextPick({ picked: a.picked, waitMode: a.waitMode });
      setAddKind("wait");
    } else {
      setContextPick({ picked: a.picked });
      setAddKind(a.kind as AddStepKind);
    }
    clearContextAction();
  }, [contextAction, clearContextAction]);

  // Follow the streamed replay so the highlighted row tracks progress.
  React.useEffect(() => {
    if (!replayRun?.running || replayRun.steps.length === 0) return;
    const last = replayRun.steps[replayRun.steps.length - 1];
    const s = liveSteps[last.index];
    if (s) setSelectedStepId(s.id);
  }, [replayRun, liveSteps]);

  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overIndex, setOverIndex] = React.useState<number | null>(null);
  const commitDrag = () => {
    if (dragId && overIndex != null) reorderStep(dragId, overIndex);
    setDragId(null);
    setOverIndex(null);
  };

  const openAssertMenu = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const res = await nativeMenu().popup({
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
      // View-relative, not screen: absolute coordinates put the menu on the
      // primary display regardless of which one the panel is on.
      coordinateSpace: "view",
      items: ASSERT_PICKABLE.map((a, i) => ({ label: a.label, commandId: i })),
    });
    if (typeof res.commandId !== "number") return;
    const chosen = ASSERT_PICKABLE[res.commandId];
    if (chosen) setAssert(chosen.kind, false);
  };

  const openAddStepMenu = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const res = await nativeMenu().popup({
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
      coordinateSpace: "view",
      items: ADD_STEP_KINDS.map((k, i) => ({ label: ADD_STEP_LABEL[k], commandId: i })),
    });
    if (typeof res.commandId === "number" && ADD_STEP_KINDS[res.commandId]) {
      setAddKind(ADD_STEP_KINDS[res.commandId]);
    }
  };

  const onReplayFromCurrent = async () => {
    const startIndex = selectedStepId
      ? Math.max(0, liveSteps.findIndex((s) => s.id === selectedStepId))
      : 0;
    setReplayStatus("Replaying…");
    const res = await replayFromCurrent(startIndex);
    if (res.ranCount === 0) {
      setReplayStatus(res.ok ? "No steps to replay." : res.error || "Replay failed.");
    } else if (res.ok) {
      setReplayStatus(`${res.passedCount}/${res.ranCount} passed`);
    } else {
      setReplayStatus(`Stopped at step ${res.failedAtIndex + 1}`);
    }
    window.setTimeout(() => setReplayStatus(null), 6000);
  };

  const stepDepths = computeStepDepths(liveSteps);

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header. `drag-region` keeps the top strip draggable — with the traffic
          lights inset there is no title bar to grab, and an undocked panel that
          cannot be moved is a trap. */}
      <div className="drag-region flex items-center gap-2 border-b border-separator px-3 pb-2 pt-9">
        {!state.pageReady ? (
          <Status variant="warning">Loading…</Status>
        ) : !stepsLoaded ? (
          <Status variant="warning">Loading steps…</Status>
        ) : running ? (
          <Status variant="loading">{state.replaying ? "Replaying" : "Running"}</Status>
        ) : (
          <Status variant={state.paused ? "warning" : "error"}>
            {state.paused ? "Paused" : state.editing ? "Editing" : "Recording"}
          </Status>
        )}
        <Badge color="secondary">{liveSteps.length}</Badge>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                iconOnly
                size="small"
                variant="transparent"
                aria-label={docked ? "Undock panel" : "Dock panel to the browser"}
                onClick={() => {
                  // Deliberately no optimistic flip — the backend's push is the
                  // only thing that moves this, because a dock can be refused.
                  void (docked ? api.trainerPanel.undock() : api.trainerPanel.dock());
                }}
              >
                <Shrink className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {docked ? "Undock from the training browser" : "Dock to the training browser"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="border-b border-separator px-3 py-1.5">
        <Text variant="small" color="secondary" truncate className="min-w-0">
          {state.url}
        </Text>
      </div>

      {state.assertMode ? (
        <div className="flex items-center gap-2 border-b border-separator bg-accent/5 px-3 py-2">
          <Text variant="small" color="blue" className="min-w-0">
            Click an element in the browser…
          </Text>
          <Button
            iconOnly
            variant="transparent"
            size="small"
            className="ml-auto"
            onClick={() => setAssert(null)}
            aria-label="Cancel assertion"
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : null}

      {state.refineMode ? (
        <div className="flex items-center gap-2 border-b border-separator bg-accent/5 px-3 py-2">
          <Crosshair className="size-4 shrink-0 text-accent" />
          <Text variant="small" color="blue" className="min-w-0">
            Pick a component in the browser.
          </Text>
          <Button
            size="small"
            variant="transparent"
            className="ml-auto"
            onClick={endRefine}
            aria-label="Cancel selector refine"
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1" autoScrollToBottom autoScrollDeps={[liveSteps.length]}>
        <div className="flex flex-col p-2">
          {liveSteps.length === 0 ? (
            <Text variant="small" color="secondary" className="px-1 py-2">
              Interact with the site — steps appear here as you go.
            </Text>
          ) : (
            <>
              <CursorGap
                active={state.cursor === 0}
                onClick={() => setCursor(0)}
                disabled={controlsDisabled}
              />
              {liveSteps.map((s, i) => (
                <React.Fragment key={s.id}>
                  <StepRow
                    index={i}
                    step={s}
                    selected={selectedStepId === s.id}
                    onSelect={controlsDisabled ? undefined : () => setSelectedStepId(s.id)}
                    onDelete={controlsDisabled ? undefined : () => deleteStep(s.id)}
                    onReplay={controlsDisabled ? undefined : () => replayStep(s.id)}
                    onRefine={controlsDisabled ? undefined : () => startRefine(s.id)}
                    onEdit={controlsDisabled ? undefined : (patch) => updateStep(s.id, patch)}
                    runStatus={replayStepStatus[i]}
                    replayFlash={replayFlash[i]}
                    isNew={newStepIds.has(s.id)}
                    indent={stepDepths[i]}
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
                    active={state.cursor === i + 1}
                    onClick={() => setCursor(i + 1)}
                    disabled={controlsDisabled}
                  />
                </React.Fragment>
              ))}
            </>
          )}
        </div>
      </ScrollArea>

      {replayStatus ? (
        <div className="border-t border-separator px-3 py-1.5">
          <Text variant="small" color="secondary" truncate>
            {replayStatus}
          </Text>
        </div>
      ) : null}

      {/* Tool row — mabl's icon strip. Ordered by how often it is reached for. */}
      <div className="flex items-center gap-1 border-t border-separator px-2 py-2">
        {/* Icons follow mabl's strip: ☑ assert, + add step, wand for AI. */}
        <ToolButton label="Add assertion" onClick={openAssertMenu} disabled={controlsDisabled}>
          <CheckSquare className="size-3.5" />
          <ChevronDown className="size-3" />
        </ToolButton>
        <ToolButton label="Add step" onClick={openAddStepMenu} disabled={controlsDisabled}>
          <Plus className="size-3.5" />
          <ChevronDown className="size-3" />
        </ToolButton>
        <ToolButton
          label="Generate steps with AI"
          onClick={() => setAiOpen(true)}
          disabled={controlsDisabled}
        >
          <Wand2 className="size-3.5" />
        </ToolButton>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* Replay is a RETURN arrow, not a play triangle. The control beside
              it is a pause/resume TOGGLE, so the moment the user pauses it
              becomes a play triangle too — leaving two identical glyphs side by
              side, each doing something quite different (replay the recorded
              steps vs. carry on recording). Both are icon-only at this width,
              so the label is a tooltip and the glyph is all there is to go on. */}
          <ToolButton
            label="Replay from the current step"
            onClick={onReplayFromCurrent}
            disabled={controlsDisabled}
          >
            <RotateCcw className="size-3.5" />
          </ToolButton>
          {controlsDisabled ? null : state.paused ? (
            <ToolButton label="Resume recording" onClick={resume}>
              <Play className="size-3.5" />
            </ToolButton>
          ) : (
            <ToolButton label="Pause recording" onClick={pause}>
              <Pause className="size-3.5" />
            </ToolButton>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-separator px-3 py-2">
        <Button
          size="small"
          variant="transparent"
          onClick={() => (liveSteps.length === 0 ? discardExit() : setExitOpen(true))}
        >
          Discard
        </Button>
        <Button
          size="small"
          variant="accent"
          className="ml-auto"
          onClick={() => (liveSteps.length === 0 ? stop() : setExitOpen(true))}
        >
          {state.editing ? "Save Test" : "Generate Test"}
        </Button>
      </div>

      {addKind ? (
        <AddStepDialog
          open={addKind !== null}
          kind={addKind}
          currentTestId={state?.testId ?? undefined}
          onOpenChange={(o) => {
            if (!o) {
              setAddKind(null);
              if (addStepPicking) {
                setAddStepPicking(false);
                endRefine();
                clearPicked();
              }
              setContextPick(null);
            }
          }}
          onAdd={(steps: RawStep[]) => {
            steps.forEach((s) => insertStep(s));
            if (addStepPicking) {
              setAddStepPicking(false);
              endRefine();
              clearPicked();
            }
            setContextPick(null);
          }}
          picked={contextPick?.picked ?? (addStepPicking ? picked : null)}
          onStartPick={() => {
            setAddStepPicking(true);
            startRefine(null);
          }}
          onClearPick={() => {
            setAddStepPicking(false);
            endRefine();
            clearPicked();
          }}
          initialAssert={contextPick?.assert}
          initialWaitMode={contextPick?.waitMode}
          prefillText={contextPick?.prefillText}
          prefillValue={contextPick?.prefillValue}
        />
      ) : null}

      <GenerateStepsDialog
        open={aiOpen}
        url={state.url}
        onOpenChange={setAiOpen}
        onInsert={(steps) => void insertGeneratedSteps(steps)}
      />

      {/* `refiningStepId` is per-WINDOW state in the store, which is exactly why
          a refine started in the main window does not also open this dialog. */}
      {picked && refiningStepId ? (
        <RefineSelectorDialog
          picked={picked}
          stepLabel={(() => {
            const s = liveSteps.find((x) => x.id === refiningStepId);
            return s ? describeStep(s) : undefined;
          })()}
          onApply={(loc) => {
            if (refiningStepId) updateStep(refiningStepId, { locator: loc });
          }}
          onClose={() => {
            clearPicked();
            endRefine();
          }}
        />
      ) : null}

      <Dialog
        open={exitOpen}
        onOpenChange={setExitOpen}
        title={state.editing ? "Save changes to this test?" : "Save this test?"}
        description={
          state.editing
            ? "You have unsaved edits to this test's steps. Save them, or discard your edits and exit."
            : "You have unsaved recorded steps. Save them as a test, or discard them and exit."
        }
        confirmLabel="Save & Exit"
        confirmVariant="accent"
        onConfirm={() => {
          setExitOpen(false);
          stop();
        }}
        destructiveAction={{
          label: "Discard Edits",
          onClick: () => {
            setExitOpen(false);
            discardExit();
          },
        }}
      >
        <Text variant="small" color="secondary">
          {`${liveSteps.length} step${liveSteps.length === 1 ? "" : "s"} will be saved when you choose "Save & Exit".`}
        </Text>
      </Dialog>
    </div>
  );
}
