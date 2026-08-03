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
import { Bug, ChevronDown, Crosshair, ListPlus, Pause, Play, Plus, Wand2, X } from "lucide-react";

import type { AssertKind, DebugEntry, PickedElement, RawStep, Step } from "../lib/recorder-types";
import { computeStepDepths, describeStep } from "../lib/describe-step";
import { useRecorder } from "./recorder-store";
import { StepRow } from "./step-row";
import { AddStepDialog, ADD_STEP_LABEL, type AddStepKind } from "./add-step-dialog";
import { GenerateStepsDialog } from "./generate-steps-dialog";
import { RefineSelectorDialog } from "./refine-selector-dialog";

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
const ADD_STEP_KINDS: AddStepKind[] = [
  "assertion",
  "condition",
  "wait",
  "goto",
  "press",
  "find",
  "viewport",
];

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

/** Bottom panel showing verbose, persisted replay diagnostics for the selected step. */
function StepDebugPanel({
  step,
  selectedIndex,
  entry,
  onClear,
}: {
  step: Step | null;
  selectedIndex: number;
  entry: DebugEntry | null;
  onClear: () => void;
}) {
  if (!step) {
    return (
      <div className="flex h-24 items-center justify-center gap-2 border-t border-separator px-4">
        <Bug className="size-4 text-tertiary" />
        <Text variant="small" color="tertiary">
          Select a step to see replay diagnostics.
        </Text>
      </div>
    );
  }
  const label = `Step ${selectedIndex + 1}: ${describeStep(step)}`;
  let status: { text: string; tone: "ok" | "fail" | "pending" };
  if (!entry) {
    status = { text: "not yet replayed", tone: "pending" };
  } else if (entry.ok) {
    status = { text: "replayed successfully", tone: "ok" };
  } else {
    status = { text: entry.error || "failed", tone: "fail" };
  }
  const toneClass =
    status.tone === "ok"
      ? "text-support-green"
      : status.tone === "fail"
        ? "text-support-red"
        : "text-tertiary";
  const time = entry ? new Date(entry.at).toLocaleTimeString() : null;
  return (
    <div className="flex h-56 flex-col border-t border-separator">
      <div className="flex items-center justify-between gap-2 px-4 pt-2.5 pb-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <Bug className={`size-4 shrink-0 ${toneClass}`} />
          <Text variant="small" className="truncate" title={label}>
            {label}
          </Text>
          <Text variant="small" color="tertiary" className="shrink-0">
            <span className={toneClass}>
              {status.tone === "fail"
                ? `Step ${selectedIndex + 1}: ${status.text}`
                : status.text}
            </span>
            {time ? ` · ${time}` : ""}
          </Text>
        </div>
        {entry ? (
          <Button
            iconOnly
            variant="transparent"
            size="small"
            className="shrink-0"
            onClick={onClear}
            aria-label="Clear replay diagnostic"
            title="Clear replay diagnostic"
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-4 pb-3 pt-0.5">
          {entry && entry.logs.length > 0 ? (
            <div className="font-mono text-[11px] leading-relaxed">
              {entry.logs.map((ln) => {
                const tone =
                  ln.level === "error"
                    ? "text-support-red"
                    : ln.level === "warn"
                      ? "text-support-yellow"
                      : "text-secondary";
                return (
                  <div key={ln.i} className="flex gap-2">
                    <span className="shrink-0 select-none text-tertiary">
                      {new Date(ln.t).toLocaleTimeString(undefined, {
                        hour12: false,
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </span>
                    <span className={`shrink-0 select-none uppercase ${tone}`}>
                      {ln.level}
                    </span>
                    <span className={`whitespace-pre-wrap break-words ${tone}`}>
                      {ln.m}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <Text variant="small" color="tertiary">
              No diagnostic lines. Run ▶ replay to capture verbose output.
            </Text>
          )}
        </div>
      </ScrollArea>
    </div>
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
    replayFromStart,
    replayAll,
    replayStepStatus,
    debugEntries,
    clearDebugEntry,
    picked,
    refiningStepId,
    startRefine,
    endRefine,
    clearPicked,
    contextAction,
    clearContextAction,
  } = useRecorder();

  const [soft, setSoft] = React.useState(false);
  const [addKind, setAddKind] = React.useState<AddStepKind | null>(null);
  const [aiOpen, setAiOpen] = React.useState(false);
  const [replayStatus, setReplayStatus] = React.useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = React.useState<string | null>(null);
  // Auto-run state for "Edit in Trainer": controls stay disabled while the
  // browser window is loading and while the automatic replay is in flight,
  // then re-enable. `autoRunStarted` guards so we only fire once per session.
  const [autoRunBusy, setAutoRunBusy] = React.useState(false);
  const autoRunStartedRef = React.useRef<string | null>(null);
  // True while the Add-step dialog's "Target element" picker is active. The
  // picked element arrives via the shared `picked` state from the recorder store;
  // this flag tells us it belongs to the Add-step flow (not a step refine).
  const [addStepPicking, setAddStepPicking] = React.useState(false);
  // The element captured by a right-click test-tools menu action, with the
  // assert kind / wait mode / prefills to seed the Add-step dialog. Cleared
  // when the dialog closes.
  const [contextPick, setContextPick] = React.useState<{
    picked: PickedElement | null;
    assert?: AssertKind;
    waitMode?: "element" | "hidden" | "time";
    prefillText?: string;
    prefillValue?: string;
  } | null>(null);

  // A right-click test-tools action arrives from the backend: open the Add-step
  // dialog prefilled. "refine" opens the Refine Selector flow for that element
  // instead (it updates an existing step, not the Add-step dialog).
  React.useEffect(() => {
    if (!contextAction) return;
    const a = contextAction;
    if (a.kind === "refine") {
      // Hand the context-picked element to the Refine Selector flow: seed the
      // shared `picked` state and enter refine mode targeting a fresh insert.
      if (a.picked) {
        // No existing step to refine — treat as "find element": insert a visible
        // assertion at the cursor via the Add-step dialog instead.
        setContextPick({ picked: a.picked, assert: "visible", prefillText: a.prefillText, prefillValue: a.prefillValue });
        setAddKind("assertion");
      }
    } else if (a.kind === "assertion") {
      setContextPick({ picked: a.picked, assert: a.assert, prefillText: a.prefillText, prefillValue: a.prefillValue });
      setAddKind("assertion");
    } else if (a.kind === "wait") {
      setContextPick({ picked: a.picked, waitMode: a.waitMode, prefillText: a.prefillText, prefillValue: a.prefillValue });
      setAddKind("wait");
    } else {
      setContextPick({ picked: a.picked, prefillText: a.prefillText, prefillValue: a.prefillValue });
      setAddKind(a.kind as AddStepKind);
    }
    clearContextAction();
  }, [contextAction, clearContextAction]);

  const onReplayFromStart = async () => {
    setReplayStatus("Replaying from start…");
    const res = await replayFromStart();
    if (res.stoppedAtIndex < 0) {
      setReplayStatus(res.ok ? "No steps to replay." : res.error || "Replay failed.");
    } else {
      setReplayStatus(
        res.ok
          ? `Replayed through step ${res.stoppedAtIndex + 1} — paused. Iterate manually.`
          : `Paused at step ${res.stoppedAtIndex + 1}: ${res.error || "failed"}`,
      );
    }
    // Clear the status after a few seconds so it doesn't linger.
    window.setTimeout(() => setReplayStatus(null), 6000);
  };

  // Edit in Trainer auto-run: once the browser window has finished loading its
  // first page, replay every step automatically and highlight each by progress.
  // Controls stay disabled while the page is loading and while the run is in
  // flight; they re-enable when it finishes. Fires once per editing session.
  React.useEffect(() => {
    if (!state.editing || !state.pageReady || !state.testId) return;
    if (autoRunStartedRef.current === state.testId) return;
    autoRunStartedRef.current = state.testId;
    let cancelled = false;
    (async () => {
      setAutoRunBusy(true);
      const res = await replayAll();
      if (!cancelled) {
        setAutoRunBusy(false);
        if (!res.ok && res.failedAtIndex >= 0) {
          setReplayStatus(
            `Auto-run stopped at step ${res.failedAtIndex + 1}: ${res.error || "failed"}`,
          );
          window.setTimeout(() => setReplayStatus(null), 6000);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.editing, state.pageReady, state.testId, replayAll]);

  // While loading or auto-running, every editing control is inert.
  const controlsDisabled = !state.pageReady || autoRunBusy;

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

  // Indentation level for each row, so conditional block bodies nest visually.
  const stepDepths = computeStepDepths(liveSteps);

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
        {controlsDisabled ? (
          <Status variant={autoRunBusy ? "loading" : "warning"}>
            {autoRunBusy ? "Running test…" : "Loading page…"}
          </Status>
        ) : (
          <Status variant={state.paused ? "warning" : "error"}>
            {state.paused ? "Paused" : state.editing ? "Editing" : "Recording"}
          </Status>
        )}
        <Text variant="small" color="secondary" truncate className="min-w-0">
          {state.url}
        </Text>
        <div className="ml-auto shrink-0">
          {controlsDisabled ? null : state.paused ? (
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
        <Button
          size="small"
          variant="muted"
          onClick={onReplayFromStart}
          disabled={controlsDisabled}
          aria-label="Replay steps from the beginning"
          title="Replay steps from the beginning, pausing after the first success"
        >
          <Play className="size-3.5" /> Replay from start
        </Button>
        {replayStatus ? (
          <Text variant="small" color="secondary" className="shrink-0">
            {replayStatus}
          </Text>
        ) : null}
        <Text variant="small" color="secondary" className="shrink-0">
          Add assertion:
        </Text>
        <Button
          size="small"
          variant="muted"
          onClick={openAssertMenu}
          disabled={controlsDisabled}
        >
          {state.assertMode ? ASSERT_LABEL[state.assertMode] : "Choose…"}
          <ChevronDown className="size-3.5" />
        </Button>
        <SegmentedControl
          size="small"
          value={soft ? "soft" : "hard"}
          onValueChange={onSoftChange}
          disabled={controlsDisabled}
        >
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
          <Button
            size="small"
            variant="muted"
            onClick={openAddStepMenu}
            disabled={controlsDisabled}
          >
            <Plus className="size-3.5" /> Add step
          </Button>
          <Button
            size="small"
            variant="muted"
            onClick={() => setAiOpen(true)}
            disabled={controlsDisabled}
          >
            <Wand2 className="size-3.5" /> AI steps
          </Button>
        </div>
      </div>

      {state.refineMode ? (
        <div className="flex items-center gap-2 border-b border-separator bg-accent/5 px-4 py-2">
          <Crosshair className="size-4 text-accent" />
          <Text variant="small" color="blue" className="min-w-0">
            Refine selector active — hover a component in the browser and click it to capture its
            selector. The page won’t respond to clicks.
          </Text>
          <Button size="small" variant="transparent" className="ml-auto" onClick={endRefine}>
            <X className="size-4" /> Cancel
          </Button>
        </div>
      ) : null}

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
                    selected={selectedStepId === s.id}
                    onSelect={controlsDisabled ? undefined : () => setSelectedStepId(s.id)}
                    onDelete={controlsDisabled ? undefined : () => deleteStep(s.id)}
                    onReplay={controlsDisabled ? undefined : () => replayStep(s.id)}
                    onRefine={controlsDisabled ? undefined : () => startRefine(s.id)}
                    onEdit={controlsDisabled ? undefined : (patch) => updateStep(s.id, patch)}
                    runStatus={replayStepStatus[i]}
                    indent={stepDepths[i]}
                    drag={controlsDisabled ? undefined : {
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

      <StepDebugPanel
        step={
          selectedStepId ? liveSteps.find((s) => s.id === selectedStepId) ?? null : null
        }
        selectedIndex={selectedStepId ? liveSteps.findIndex((s) => s.id === selectedStepId) : -1}
        entry={
          selectedStepId
            ? debugEntries.find((e) => e.stepId === selectedStepId) ?? null
            : null
        }
        onClear={() => {
          if (selectedStepId) clearDebugEntry(selectedStepId);
        }}
      />

      {addKind ? (
        <AddStepDialog
          open={addKind !== null}
          kind={addKind}
          onOpenChange={(o) => {
            if (!o) {
              setAddKind(null);
              // Leaving the Add-step dialog: tear down any in-flight pick and
              // the context-menu prefill state.
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
          // Use the context-menu's pre-resolved element when present (it was
          // captured at the right-click point); otherwise the in-dialog picker.
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
        onInsert={(steps) => steps.forEach((s) => insertStep(s))}
      />
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
    </div>
  );
}
