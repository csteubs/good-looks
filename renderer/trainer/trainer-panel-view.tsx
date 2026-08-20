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
import { Dialog, ScrollArea, Tooltip, TooltipContent, TooltipTrigger } from "@ui";
import { Btn, StatusChip } from "../theme";
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
import { urlAssertPrefill } from "../../shared/url-assert.mjs";
import { useRecorder } from "../main/recorder-store";
import { CursorGap, INSERT_HERE, StepRow } from "../main/step-row";
import { StepComposer, ADD_STEP_LABEL, type AddStepKind } from "../main/step-composer";
import { GenerateStepsDialog } from "../main/generate-steps-dialog";
import { RefineSelectorDialog } from "../main/refine-selector-dialog";
import { useViewportNarrowedNotice } from "../main/viewport-narrowed-notice";

/**
 * Copy for the dock control's tooltip.
 *
 * Exported because a Radix tooltip cannot be opened in jsdom — its trigger
 * tracks pointers with APIs jsdom does not implement — so the only way to test
 * this copy is to assert against the constant. `noRoom` is the one that has to
 * exist: a panel that opens beside the browser instead of docked to it looks
 * like the feature not working, and "the display is too small for this window
 * size" is the difference between a bug and a choice the user can act on.
 */
export const DOCK_TOOLTIP = {
  docked: "Undock from the training browser",
  undocked: "Dock to the training browser",
  noRoom: "No room to dock at this window size — the display is too narrow for both windows",
} as const;

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

/**
 * URL assertions, which need a typed value rather than an element click.
 *
 * The panel had no URL assertion at all until now — its assert menu offered
 * only the element kinds above, so the one trainer sitting against the training
 * browser was the one place you could not assert on the location. Offered here
 * with the live URL prefilled, same as the main window and the browser's own
 * URL strip.
 */
const ASSERT_PAGE: { kind: AssertKind; label: string }[] = [
  { kind: "url", label: "URL contains" },
  { kind: "urlEndsWith", label: "URL ends with" },
  { kind: "urlIs", label: "URL is" },
  // Prefill EMPTY, deliberately — this panel tracks the live URL but not the
  // live title, and `urlAssertPrefill` answers "" for any kind it cannot stand
  // behind. See the same note in renderer/main/recording-view.tsx.
  { kind: "title", label: "Page title is" },
  { kind: "titleContains", label: "Page title contains" },
];

/** Order matters: index === commandId in the native "+ Add step" menu. */
const ADD_STEP_KINDS: AddStepKind[] = [
  "assertion",
  "elementState",
  "condition",
  "wait",
  "goto",
  "press",
  "find",
  "viewport",
  "scroll",
  "capture",
  "runFlow",
  // Last, and deliberately: the discoverable route to it is the training
  // browser's right-click menu on the field being filled, which arrives here
  // as a `fill` context action with the element already resolved. This entry is
  // the keyboard-free fallback for someone already in the list.
  "fill",
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
 *  every control needs a name that is discoverable without one.
 *
 *  `tone` rather than a second component for the AI button: `Btn`'s `ai` tone
 *  is the holo border, and AI-adjacent chrome wears a treatment rather than a
 *  colour here (colour means outcome — see tokens.css). The main window's
 *  trainer makes the same call on its "AI steps" button, and the two rows are
 *  one hairline apart when docked, so they have to agree. */
function ToolButton({
  label,
  onClick,
  disabled,
  tone,
  children,
}: {
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  tone?: "ai";
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Btn tone={tone} onClick={onClick} disabled={disabled} aria-label={label}>
          {children}
        </Btn>
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
    lastAddedStepId,
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
    addVariable,
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
  /** Why the panel is not docked, when the backend has told us. */
  const [dockReason, setDockReason] = React.useState<string | null>(null);
  const [contextPick, setContextPick] = React.useState<{
    picked: PickedElement | null;
    assert?: AssertKind;
    waitMode?: WaitDialogMode;
    /** pseudo-state preselected by the right-click "Set element state" submenu */
    elementState?: "hover" | "focus";
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

  // See the mirror of this in recording-view.tsx: follow the bottom only while
  // the bottom is where the next captured step will actually land.
  const cursorAtEnd = state.cursor >= liveSteps.length;

  // Dock state is owned by the backend (it moves real windows), so the button
  // reflects what actually happened rather than an optimistic local guess —
  // docking can legitimately be REFUSED when the display is too small.
  //
  // ASK as well as listen. The first state is decided while this window is
  // still loading, so a session that opened undocked has already missed the
  // push that said so — and this control would then read "Undock" beside a
  // panel that is not docked, doing nothing when pressed. Same lesson as the
  // step list needing `recorder:getSteps`.
  React.useEffect(() => {
    let live = true;
    // The ask supplies the INITIAL value only. It was answered before it
    // resolved here, so a push that lands while it is in flight is the newer
    // fact — letting the reply win would undo a real dock change with a
    // snapshot taken before it happened.
    let pushed = false;
    void api.trainerPanel
      .getState()
      .then((s) => {
        if (!live || pushed) return;
        setDocked(s.docked);
        setDockReason(s.docked ? null : s.reason);
      })
      .catch(() => {
        /* the pushes below still carry every later change */
      });
    const offDocked = api.on("trainerPanel:docked", () => {
      pushed = true;
      setDocked(true);
      setDockReason(null);
    });
    const offUndocked = api.on<{ reason?: string } | undefined>(
      "trainerPanel:undocked",
      (payload) => {
        pushed = true;
        setDocked(false);
        setDockReason(payload?.reason ?? null);
      },
    );
    return () => {
      live = false;
      offDocked();
      offUndocked();
    };
  }, []);

  // Docking narrows the training browser. This window only ever hears the push
  // on the re-dock path — when the panel opens already docked it is sent before
  // this page exists — which is why the main window subscribes too, and why a
  // passing test here is not evidence the user was told. See the notice module.
  useViewportNarrowedNotice();

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
    } else if (a.kind === "elementState") {
      setContextPick({ picked: a.picked, elementState: a.elementState });
      setAddKind("elementState");
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
      // Offset by 100 for the URL group, the same encoding `recording-view.tsx`
      // uses — the two menus stay readable against each other, and a commandId
      // cannot silently mean an element assert in one and a URL assert in the
      // other.
      items: [
        ...ASSERT_PICKABLE.map((a, i) => ({ label: a.label, commandId: i })),
        { type: "separator" as const },
        ...ASSERT_PAGE.map((a, i) => ({ label: a.label, commandId: 100 + i })),
      ],
    });
    if (typeof res.commandId !== "number") return;
    if (res.commandId < 100) {
      const chosen = ASSERT_PICKABLE[res.commandId];
      if (chosen) setAssert(chosen.kind, false);
      return;
    }
    const urlKind = ASSERT_PAGE[res.commandId - 100];
    if (!urlKind) return;
    // A URL assertion takes a typed value, so it opens the Add-step dialog
    // rather than arming the element picker — prefilled from where the page is
    // now, via the one helper all three surfaces share.
    setContextPick({
      picked: null,
      assert: urlKind.kind,
      prefillValue: urlAssertPrefill(urlKind.kind, state.liveUrl ?? state.url ?? ""),
    });
    setAddKind("assertion");
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

  // The composer, at the cursor rather than over the list (§6.2). Same shape as
  // the main window's — see recording-view.tsx for why it is a function of the
  // gap index rather than one element hoisted out of the list.
  const composerAt = (index: number) =>
    addKind !== null && state.cursor === index ? (
      <StepComposer
        key={`${addKind}:${contextPick?.picked?.description ?? ""}`}
        kind={addKind}
        currentTestId={state?.testId ?? undefined}
        onCancel={() => {
          setAddKind(null);
          if (addStepPicking) {
            setAddStepPicking(false);
            endRefine();
            clearPicked();
          }
          setContextPick(null);
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
        initialState={contextPick?.elementState}
        prefillText={contextPick?.prefillText}
        prefillValue={contextPick?.prefillValue}
        variables={state.variables ?? []}
        onCreateVariable={addVariable}
      />
    ) : null;

  return (
    <div className="gl-panelwin">
      {/* Header. `drag-region` keeps the top strip draggable — with the traffic
          lights inset there is no title bar to grab, and an undocked panel that
          cannot be moved is a trap. */}
      <div className="gl-panelwin-head drag-region">
        {/* NONE OF THESE IS AN OUTCOME, so none takes a status hue — the same
            correction `recording-view.tsx` carries, and it has to be made in
            both places or the two trainers disagree about what red means while
            docked side by side. "Recording" was the SDK's `error` variant, i.e.
            the colour this palette spends on a failed run, on a surface where
            nothing has run. Recording/Replaying/Running are IN FLIGHT, which is
            what `StatusChip`'s running treatment says; Paused and the two
            loading states are neutral. */}
        {!state.pageReady ? (
          <StatusChip>Loading…</StatusChip>
        ) : !stepsLoaded ? (
          <StatusChip>Loading steps…</StatusChip>
        ) : running ? (
          <StatusChip running animated>
            {state.replaying ? "Replaying" : "Running"}
          </StatusChip>
        ) : state.paused ? (
          <StatusChip>Paused</StatusChip>
        ) : (
          // "Recording", not "Editing", for a session continuing an existing
          // test — capture is live in both, and the chip that says so is the
          // wrong place to carry that distinction. The Save Test button below
          // already does. See the mirror of this in recording-view.tsx.
          <StatusChip running animated>
            Recording
          </StatusChip>
        )}
        <span className="gl-chip">{liveSteps.length}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="gl-icon-btn"
                aria-label={docked ? "Undock panel" : "Dock panel to the browser"}
                onClick={() => {
                  // Deliberately no optimistic flip — the backend's push is the
                  // only thing that moves this, because a dock can be refused.
                  void (docked ? api.trainerPanel.undock() : api.trainerPanel.dock());
                }}
              >
                <Shrink className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {docked
                ? DOCK_TOOLTIP.docked
                : dockReason === "no-room"
                  ? DOCK_TOOLTIP.noRoom
                  : DOCK_TOOLTIP.undocked}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* `liveUrl` — where the page IS — not `url`, which is where the recording
          STARTED and is what gets saved as the test's URL. This line rendered
          `url` for its whole life, so it was right until the first navigation
          and quietly wrong from then on. `GenerateStepsDialog` below still
          takes `url`, correctly: it is asking about the test, not the page. */}
      <div className="gl-panelwin-url">
        <div className="gl-mono-value">{state.liveUrl ?? state.url}</div>
      </div>

      {state.assertMode ? (
        <div className="gl-panelwin-armed">
          <span className="gl-trainer-prompt min-w-0">Click an element in the browser…</span>
          <button
            type="button"
            className="gl-icon-btn ml-auto"
            onClick={() => setAssert(null)}
            aria-label="Cancel assertion"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      {state.refineMode ? (
        <div className="gl-panelwin-armed">
          <Crosshair className="gl-panelwin-armed-icon size-3.5" />
          <span className="gl-trainer-prompt min-w-0">Pick a component in the browser.</span>
          <button
            type="button"
            className="gl-icon-btn ml-auto"
            onClick={endRefine}
            aria-label="Cancel selector refine"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      <ScrollArea
        className="min-h-0 flex-1"
        autoScrollToBottom={cursorAtEnd}
        autoScrollDeps={[liveSteps.length]}
        scrollbars="both"
      >
        <div className="gl-step-list gl-step-list--tight gl-panelwin-list">
          {liveSteps.length === 0 ? (
            <>
              {/* No gaps to sit between yet, and the composer is the only way
                  to put a step into a session that has captured nothing. */}
              {composerAt(0)}
              <p className="gl-note gl-panelwin-empty">
                Interact with the site — steps appear here as you go.
              </p>
            </>
          ) : (
            <>
              <CursorGap
                active={state.cursor === 0}
                onClick={() => setCursor(0)}
                disabled={controlsDisabled}
                label={INSERT_HERE}
              />
              {composerAt(0)}
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
                    variables={state.variables ?? []}
                    runStatus={replayStepStatus[i]}
                    replayFlash={replayFlash[i]}
                    isNew={newStepIds.has(s.id)}
                    justAdded={s.id === lastAddedStepId}
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
                    label={i + 1 === liveSteps.length ? undefined : INSERT_HERE}
                  />
                  {composerAt(i + 1)}
                </React.Fragment>
              ))}
            </>
          )}
        </div>
      </ScrollArea>

      {replayStatus ? (
        <div className="gl-panelwin-status">
          <div className="gl-note truncate">{replayStatus}</div>
        </div>
      ) : null}

      {/* Tool row — mabl's icon strip. Ordered by how often it is reached for. */}
      <div className="gl-panelwin-tools">
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
          tone="ai"
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

      <div className="gl-panelwin-foot">
        {/* `stop` for Discard, `go` for Save: the two footer buttons are the
            one place in this panel where the action IS the outcome, which is
            what licenses a hue at all (tokens.css — colour means outcome). */}
        <Btn
          tone="stop"
          onClick={() => (liveSteps.length === 0 ? discardExit() : setExitOpen(true))}
        >
          Discard
        </Btn>
        <Btn
          tone="go"
          className="ml-auto"
          onClick={() => (liveSteps.length === 0 ? stop() : setExitOpen(true))}
        >
          {state.editing ? "Save Test" : "Generate Test"}
        </Btn>
      </div>

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
        <p className="gl-note">
          {`${liveSteps.length} step${liveSteps.length === 1 ? "" : "s"} will be saved when you choose "Save & Exit".`}
        </p>
      </Dialog>
    </div>
  );
}
