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
import { Btn, StatusChip, ToolTile } from "../theme";
import { CheckSquare, Plus, RotateCcw, Shrink, Wand2 } from "lucide-react";

import { api } from "../lib/api";
import type { AssertKind, PickedElement, RawStep, WaitDialogMode } from "../lib/recorder-types";
import { computeStepDepths, describeStep } from "../lib/describe-step";
import { usePlayStepShortcut } from "../lib/use-play-step-shortcut";
import { prettyKey } from "../lib/editor-keymap-table";
import { urlAssertPrefill } from "../../shared/url-assert.mjs";
import { useRecorder } from "../main/recorder-store";
import { createFlowGate, pickAddStepFromMenu, pickAssertFromMenu } from "../main/trainer-actions";
import { BarContextZone, TILE_COPY, useNextAction } from "../main/trainer-bar-controls";
import { suggestFlowName } from "../lib/next-action";
import { CursorGap, INSERT_HERE, StepRow } from "../main/step-row";
import { CreateFlowDialog } from "../main/create-flow-dialog";
import { FlowStepsPreview } from "../main/flow-steps-preview";
import { FlowScopeEditor } from "../main/flow-scope-editor";
import {
  emptySelection,
  pruneSelection,
  selectionAfterClick,
} from "../lib/step-selection";
import { StepComposer, type AddStepKind } from "../main/step-composer";
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

// The assert and add-step vocabularies and the native menus live in
// ../main/trainer-actions now — ONE copy for both trainers, retiring this
// file's hand-synced duplicates and the comment that asked the next person to
// keep the commandId encodings agreeing. The URL-assert group's history is
// worth keeping: the panel had NO URL assertion until 2026-08-27, and NO soft
// assertions until the 2026-09-01 reorganisation put the Hard/Soft control in
// the shared context band.

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
    extractFlow,
    flowScope,
    enterFlowScope,
    exitFlowScope,
    setFlowCursor,
    verifyGeneratedSteps,
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
  // Hard/Soft, REAL state here at last: this view hard-coded `soft: false`
  // into its assert menu handler for its whole life, which made soft
  // assertions unreachable from the surface most sessions are driven from.
  const [soft, setSoft] = React.useState(false);
  // Multi-selection shared with the main trainer through lib/step-selection —
  // the anchor is what the single-selection code called selectedStepId.
  const [selection, setSelection] = React.useState(emptySelection());
  const selectedStepId = selection.anchorId;
  const selectAnchor = React.useCallback(
    (id: string) => setSelection({ ids: [id], anchorId: id }),
    [],
  );
  const [expandedFlows, setExpandedFlows] = React.useState<Set<string>>(new Set());
  const [createFlowOpen, setCreateFlowOpen] = React.useState(false);
  React.useEffect(() => {
    setSelection((prev) => pruneSelection(prev, liveSteps));
  }, [liveSteps]);
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

  // ⌘P plays the selected step — same wiring as recording-view.tsx, resolved
  // against THIS window's selection. ⌘R (pause/resume) is not handled here:
  // the main process claims it on this window's webContents, where the View
  // menu's Reload can be beaten. See renderer/lib/use-play-step-shortcut.ts.
  // Inert while a picker is armed, for the reason the mirror comment gives.
  usePlayStepShortcut(
    controlsDisabled || !!state.assertMode || state.refineMode || !selectedStepId
      ? null
      : () => void replayStep(selectedStepId),
  );

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
    if (s) selectAnchor(s.id);
  }, [replayRun, liveSteps, selectAnchor]);

  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overIndex, setOverIndex] = React.useState<number | null>(null);
  const commitDrag = () => {
    if (dragId && overIndex != null) reorderStep(dragId, overIndex);
    setDragId(null);
    setOverIndex(null);
  };

  const openAssertMenu = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const choice = await pickAssertFromMenu(e);
    if (!choice) return;
    if (choice.group === "element") {
      setAssert(choice.kind, soft);
      return;
    }
    // A URL assertion takes a typed value, so it opens the Add-step dialog
    // rather than arming the element picker — prefilled from where the page is
    // now, via the one helper all three surfaces share.
    setContextPick({
      picked: null,
      assert: choice.kind,
      prefillValue: urlAssertPrefill(choice.kind, state.liveUrl ?? state.url ?? ""),
    });
    setAddKind("assertion");
  };

  const openAddStepMenu = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const kind = await pickAddStepFromMenu(e);
    if (kind) setAddKind(kind);
  };

  const onSoftChange = (next: boolean) => {
    setSoft(next);
    // Re-arm a live assert with the new strictness, the same move the main
    // trainer makes — flipping the toggle mid-arm must change the step that
    // is about to be captured, not the one after it.
    if (state.assertMode) setAssert(state.assertMode, next);
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

  // The create-flow gate, live rather than click-time — the button is always
  // mounted in the context band and disabled-gated, never render-gated. See
  // trainer-actions.createFlowGate.
  const flowGate = createFlowGate(liveSteps, selection.ids);

  // The mechanical next-action suggestion (lib/next-action.ts) — same hook,
  // same rules as the main trainer, resolved against THIS window's dismissal
  // state. See the mirror comment in recording-view.tsx.
  const { suggestion, dismiss: dismissSuggestion } = useNextAction(
    liveSteps,
    state.cursor,
    state.liveUrl ?? state.url ?? "",
  );

  // The composer, at the cursor rather than over the list (§6.2). Same shape as
  // the main window's — see recording-view.tsx for why it is a function of the
  // gap index rather than one element hoisted out of the list.
  const composerAt = (index: number, inScope = false) =>
    addKind !== null &&
    (inScope ? flowScope?.cursor === index : !flowScope && state.cursor === index) ? (
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
          // THE CHIP IS THE PAUSE TOGGLE, here as in recording-view.tsx — it
          // replaced the Pause/Resume ToolButton that sat in the tools row,
          // because users kept clicking the chip anyway. Safe by branch order:
          // either word only renders when the old button was enabled. ⌘R does
          // the same from the keyboard (claimed in the main process — see
          // attachRecorderShortcuts in recorder-service.ts). Passive while
          // the Refine picker is armed: refine owns the pause, and a resume
          // here would run capture live behind the pick.
          state.refineMode ? (
            <StatusChip>Paused</StatusChip>
          ) : (
            <StatusChip onClick={resume} title={`Resume recording (${prettyKey("Mod-r")})`}>
              Paused
            </StatusChip>
          )
        ) : (
          // "Recording", not "Editing", for a session continuing an existing
          // test — capture is live in both, and the chip that says so is the
          // wrong place to carry that distinction. The Save Test button below
          // already does. See the mirror of this in recording-view.tsx.
          <StatusChip running animated onClick={pause} title={`Pause recording (${prettyKey("Mod-r")})`}>
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

      {/* THE TILE STRIP (Direction A, 2026-09-01), above the list as in the
          main trainer — the two dock edge to edge and must agree on where the
          tools live. ALWAYS FOLDED: at 360px the unfolded posture has no room,
          which is exactly what the folded one is for. No carets, deliberately:
          four tiles share ~332px here, and the caret is the difference between
          a name and an ellipsis — the menus still open, and the folded tile's
          hover title carries the description. Membership and order never
          change; disabled-gated only. The replay tile keeps its long-standing
          accessible name and the return-arrow glyph the main trainer wears. */}
      <div className="gl-panelwin-tiles">
        <ToolTile
          folded
          mark={<CheckSquare />}
          name={TILE_COPY.assert.name}
          what={TILE_COPY.assert.what}
          onClick={openAssertMenu}
          disabled={controlsDisabled}
        />
        <ToolTile
          folded
          mark={<Plus />}
          name={TILE_COPY.add.shortName}
          what={TILE_COPY.add.what}
          aria-label={TILE_COPY.add.name}
          onClick={openAddStepMenu}
          disabled={controlsDisabled}
        />
        <ToolTile
          folded
          mark={<RotateCcw />}
          name={TILE_COPY.replay.name}
          what={TILE_COPY.replay.what}
          aria-label="Replay from the current step"
          onClick={() => void onReplayFromCurrent()}
          disabled={controlsDisabled}
        />
        <ToolTile
          folded
          tone="ai"
          mark={<Wand2 />}
          name={TILE_COPY.ai.name}
          what={TILE_COPY.ai.what}
          onClick={() => setAiOpen(true)}
          disabled={controlsDisabled}
        />
      </div>

      {/* The reserved context band — every transient this panel used to spread
          over three conditional bands (armed assert, armed refine, the replay
          status line) lives here now, over a height that never changes. Also
          where Hard/Soft finally becomes reachable from this surface. */}
      <BarContextZone
        className="gl-panelwin-context"
        assertMode={state.assertMode ?? null}
        soft={soft}
        onSoftChange={onSoftChange}
        onCancelAssert={() => setAssert(null)}
        refineMode={state.refineMode}
        onCancelRefine={endRefine}
        note={replayStatus}
        suggestion={
          suggestion && !controlsDisabled && addKind === null
            ? {
                label: suggestion.label,
                title: suggestion.title,
                onAccept: () => {
                  setContextPick({
                    picked: suggestion.picked,
                    assert: suggestion.assert,
                    prefillValue: suggestion.prefillValue,
                  });
                  setAddKind("assertion");
                },
                onDismiss: dismissSuggestion,
              }
            : null
        }
        createFlow={{
          ...flowGate,
          disabled: flowGate.disabled || controlsDisabled,
          onClick: () => setCreateFlowOpen(true),
          shortLabel: true,
        }}
      />

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
                    selected={selection.ids.includes(s.id)}
                    onSelect={
                      controlsDisabled
                        ? undefined
                        : (e) =>
                            setSelection((prev) =>
                              selectionAfterClick(prev, liveSteps, s.id, {
                                shift: e.shiftKey,
                                toggle: e.metaKey || e.ctrlKey,
                              }),
                            )
                    }
                    expanded={s.type === "runFlow" ? expandedFlows.has(s.id) : undefined}
                    onToggleExpand={
                      s.type === "runFlow" && s.flowId
                        ? () =>
                            setExpandedFlows((prev) => {
                              const next = new Set(prev);
                              if (next.has(s.id)) next.delete(s.id);
                              else next.add(s.id);
                              return next;
                            })
                        : undefined
                    }
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
                  {s.type === "runFlow" && s.flowId && expandedFlows.has(s.id) ? (
                    flowScope && flowScope.callStepId === s.id ? (
                      <FlowScopeEditor
                        scope={flowScope}
                        controlsDisabled={controlsDisabled}
                        onExit={() => void exitFlowScope()}
                        composerAt={(index) => composerAt(index, true)}
                        onDelete={deleteStep}
                        onEdit={updateStep}
                        onReplay={replayStep}
                        onReorder={reorderStep}
                        onSetCursor={setFlowCursor}
                        indent={stepDepths[i] + 1}
                      />
                    ) : (
                      <FlowStepsPreview
                        // Remounted when a scope opens or closes, so the
                        // read-only view refetches the just-committed steps
                        // instead of quoting the pre-edit record.
                        key={`${s.flowId}:${flowScope ? "scoped" : "plain"}`}
                        flowId={s.flowId}
                        indent={stepDepths[i] + 1}
                        onEditFlow={
                          controlsDisabled || flowScope
                            ? undefined
                            : () => void enterFlowScope(s.id)
                        }
                      />
                    )
                  ) : null}
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

      <CreateFlowDialog
        open={createFlowOpen}
        onOpenChange={setCreateFlowOpen}
        count={selection.ids.length}
        suggestedName={suggestFlowName(liveSteps, selection.ids)}
        onCreate={async (name) => {
          await extractFlow(selection.ids, name);
          setSelection(emptySelection());
        }}
      />

      <GenerateStepsDialog
        open={aiOpen}
        url={state.url}
        onOpenChange={setAiOpen}
        onVerify={verifyGeneratedSteps}
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
