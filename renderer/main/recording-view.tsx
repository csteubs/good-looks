import * as React from "react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  ScrollArea,
  SegmentedControl,
  SegmentedControlItem,
  Status,
  Tabs,
  TabsContent,
  TabsRoot,
  TabsTrigger,
  Text,
  Toolbar,
  ToolbarActions,
  ToolbarContent,
  ToolbarTitle,
} from "@glaze/core/components";
import { Bug, Check, ChevronDown, Crosshair, ListPlus, Loader2, Pause, Play, Plus, RotateCcw, Sparkles, Wand2, X } from "lucide-react";

import type { AiDebugStatus, AssertKind, DebugEntry, HealSuggestion, Locator, PickedElement, RawStep, Step } from "../lib/recorder-types";
import { computeStepDepths, describeStep } from "../lib/describe-step";
import { locatorToPrompt } from "../lib/llm-prompts";
import { useRecorder, type ReplayRun } from "./recorder-store";
import { CursorGap, StepRow } from "./step-row";
import { AddStepDialog, ADD_STEP_LABEL, type AddStepKind } from "./add-step-dialog";
import { stepSessionKey, useAiDebug } from "./ai-debug-store";
import { parseSessionKey } from "../lib/ai-debug-sessions";
import { toneFor } from "../lib/ai-debug-status";
import { GenerateStepsDialog } from "./generate-steps-dialog";
import { RefineSelectorDialog, formatLocator, KIND_LABEL } from "./refine-selector-dialog";
import { CookiesPanel } from "./cookies-panel";

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

// URL assertions need a typed string (not an element click), so selecting one
// from the dropdown opens the Add-step → Assertion dialog prefilled.
const ASSERT_URL: { kind: AssertKind; label: string }[] = [
  { kind: "url", label: "URL contains" },
  { kind: "urlEndsWith", label: "URL ends with" },
  { kind: "urlIs", label: "URL is" },
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
  url: "URL contains",
  urlEndsWith: "URL ends with",
  urlIs: "URL is",
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

const LEVEL_TONE: Record<"info" | "warn" | "error", string> = {
  info: "text-secondary",
  warn: "text-support-yellow",
  error: "text-support-red",
};

const timeHms = (t: number) =>
  new Date(t).toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** Renders an ordered set of verbose replay diagnostic lines (timestamp · level · message). */
function LogLines({ logs, indent }: { logs: DebugEntry["logs"]; indent?: boolean }) {
  return (
    <>
      {logs.map((ln) => (
        <div key={ln.i} className={`flex gap-2 ${indent ? "pl-4" : ""}`}>
          <span className="shrink-0 select-none text-tertiary">{timeHms(ln.t)}</span>
          <span className={`shrink-0 select-none uppercase ${LEVEL_TONE[ln.level]}`}>{ln.level}</span>
          <span className={`whitespace-pre-wrap break-words ${LEVEL_TONE[ln.level]}`}>{ln.m}</span>
        </div>
      ))}
    </>
  );
}

/** A one-line, human-readable summary of a step's locator (element location). */
function locatorSummary(step: Step): string | null {
  const l = step.locator;
  if (!l) return null;
  const parts: string[] = [l.k];
  if (l.role) parts.push(l.role);
  if (l.name) parts.push(`“${l.name}”`);
  if (l.v) parts.push(l.v);
  return parts.join(" ");
}

/** Percent hit-rate pill color by score. */
function hitRateTone(rate: number): string {
  if (rate >= 100) return "text-support-green";
  if (rate >= 50) return "text-support-yellow";
  return "text-support-red";
}

/** Inline list of Auto-Heal candidate locators for a failed step. The user can
 *  click any candidate to apply it to the step (updating its locator). Shown
 *  in the Console tab under the step's error. */
function HealCandidates({
  heal,
  onApply,
}: {
  heal: HealSuggestion;
  onApply: (locator: Locator) => void;
}) {
  const [open, setOpen] = React.useState(true);
  if (heal.autoApplied) return null; // auto-applied — no manual menu needed
  const hasPastMatch = heal.candidates.some((c) => c.matchedPastRun);
  return (
    <div className="mt-1 pl-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-accent hover:underline"
      >
        <Wand2 className="size-3" />
        <span>
          Auto-Heal found {heal.candidates.length} candidate{heal.candidates.length === 1 ? "" : "s"}
          {hasPastMatch ? " (incl. past-run matches)" : ""}
        </span>
        <ChevronDown className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div className="mt-1 flex flex-col gap-1">
          {heal.candidates.map((c, i) => (
            <button
              key={`${c.locator.k}-${i}`}
              type="button"
              onClick={() => onApply(c.locator)}
              className="flex items-center gap-2 rounded-md border border-separator px-2 py-1.5 text-left transition-colors hover:border-accent hover:bg-accent/5"
            >
              <Badge color="blue" className="shrink-0 text-[10px]">
                {KIND_LABEL[c.locator.k]}
              </Badge>
              <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-primary">
                {formatLocator(c.locator)}
              </code>
              {c.matchedPastRun ? (
                <span className="shrink-0 text-[10px] text-support-green" title="Matched a past run">
                  past
                </span>
              ) : null}
              <span className="shrink-0 text-[10px] text-tertiary">{c.description}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Bottom debug panel with two tabs:
 *  - Console: live streaming output of a "Replay from current step" run — each
 *    step's result + verbose logs as it runs, with an auto-scroll toggle.
 *  - Step details: the selected step's element-location details, replay status,
 *    and persisted diagnostics, plus the run's pass/fail % hit rate.
 */
function DebugPanel({
  step,
  selectedIndex,
  entry,
  onClear,
  replayRun,
  tab,
  onTabChange,
  autoScroll,
  onAutoScrollChange,
  onDebugStep,
  aiStatusByStep,
  onApplyHeal,
  onInsertCookieStep,
}: {
  step: Step | null;
  selectedIndex: number;
  entry: DebugEntry | null;
  onClear: () => void;
  replayRun: ReplayRun | null;
  tab: string;
  onTabChange: (v: string) => void;
  autoScroll: boolean;
  onAutoScrollChange: (v: boolean) => void;
  onDebugStep: (index: number) => void;
  /** Status of each step's AI debug session, keyed by step index. A step with
   *  no session is absent — the icon then shows its plain, unstarted state. */
  aiStatusByStep: Record<number, AiDebugStatus>;
  onApplyHeal: (stepId: string, locator: Locator) => void;
  onInsertCookieStep: (step: RawStep) => void;
}) {
  const consoleSteps = replayRun?.steps ?? [];
  const ran = replayRun?.ran ?? 0;
  const passed = replayRun?.passed ?? 0;
  const hitRate = ran > 0 ? Math.round((passed / ran) * 100) : null;
  const logCount = consoleSteps.reduce((n, s) => n + s.logs.length, 0);

  return (
    <div className="flex h-56 flex-col border-t border-separator">
      <TabsRoot value={tab} onValueChange={onTabChange} className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 px-3 pt-2">
          <Tabs variant="filled" size="small">
            <TabsTrigger value="console">Console</TabsTrigger>
            <TabsTrigger value="steps">Step details</TabsTrigger>
            <TabsTrigger value="cookies">Cookies</TabsTrigger>
          </Tabs>
          {tab === "console" ? (
            <label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 pr-1 text-[11px] text-secondary">
              <Checkbox
                checked={autoScroll}
                onCheckedChange={(v) => onAutoScrollChange(v === true)}
                aria-label="Auto-scroll console"
              />
              Auto-scroll
            </label>
          ) : null}
        </div>

        {/* Cookies: edit the training browser's cookies, optionally recording
            each change as a test step. */}
        <TabsContent value="cookies" className="flex min-h-0 flex-1 flex-col">
          <CookiesPanel onInsertStep={onInsertCookieStep} />
        </TabsContent>

        {/* Console: live run output. */}
        <TabsContent value="console" className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-separator px-3 py-1.5">
            {replayRun?.running ? <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" /> : null}
            <Text variant="small" color="secondary" className="min-w-0 truncate">
              {!replayRun
                ? "No run yet — click “Replay from current step”."
                : replayRun.running
                  ? `Running… ${ran}/${replayRun.total} steps`
                  : replayRun.failedAtIndex >= 0
                    ? `Stopped at step ${replayRun.failedAtIndex + 1} — ${passed}/${ran} passed`
                    : `Done — ${passed}/${ran} passed`}
            </Text>
            {hitRate !== null ? (
              <span className={`ml-auto shrink-0 text-[11px] font-medium ${hitRateTone(hitRate)}`}>
                {hitRate}% hit rate
              </span>
            ) : null}
          </div>
          <ScrollArea
            className="min-h-0 flex-1"
            autoScrollToBottom={autoScroll}
            autoScrollDeps={[logCount, consoleSteps.length]}
          >
            <div className="px-3 py-2 font-mono text-[11px] leading-relaxed">
              {consoleSteps.length === 0 ? (
                <Text variant="small" color="tertiary">
                  Each step streams its result and verbose output here as the test runs.
                </Text>
              ) : (
                consoleSteps.map((s) => (
                  <div key={s.index} className="mb-2">
                    <div
                      className={`flex items-center gap-1.5 ${s.ok ? "text-support-green" : "text-support-red"}`}
                    >
                      {s.ok ? <Check className="size-3 shrink-0" /> : <X className="size-3 shrink-0" />}
                      <span className="font-semibold">Step {s.index + 1}</span>
                      <span className="truncate text-secondary">· {s.stepLabel}</span>
                      {s.ok && s.heal?.autoApplied ? (
                        <span className="shrink-0 rounded bg-support-green/15 px-1 text-[10px] font-medium text-support-green">
                          Healed ✓
                        </span>
                      ) : null}
                    </div>
                    <LogLines logs={s.logs} indent />
                    {!s.ok && s.error ? (
                      <div className="flex items-start gap-2 pl-4">
                        <span className="min-w-0 flex-1 text-support-red">{s.error}</span>
                        {(() => {
                          // Once a session exists for this step, the icon is
                          // the way back to it — so it carries that session's
                          // colour rather than the generic "start one" look.
                          const st = aiStatusByStep[s.index];
                          const tone = st ? toneFor(st) : null;
                          return (
                            <button
                              type="button"
                              onClick={() => onDebugStep(s.index)}
                              className={`shrink-0 rounded p-0.5 transition-colors hover:bg-background-secondary ${
                                tone ? tone.className : "text-tertiary hover:text-accent"
                              }`}
                              aria-label={tone ? tone.label : "Debug this step with AI"}
                              title={tone ? tone.label : "Debug with AI"}
                            >
                              <Sparkles
                                className={`size-3.5 ${tone?.busy ? "animate-pulse" : ""}`}
                              />
                            </button>
                          );
                        })()}
                      </div>
                    ) : null}
                    {s.heal && s.heal.candidates.length > 0 ? (
                      <HealCandidates
                        heal={s.heal}
                        onApply={(locator) => onApplyHeal(s.heal!.stepId, locator)}
                      />
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Step details: element location + persisted diagnostics for the selected step. */}
        <TabsContent value="steps" className="flex min-h-0 flex-1 flex-col">
          {!step ? (
            <div className="flex flex-1 items-center justify-center gap-2 px-4">
              <Bug className="size-4 text-tertiary" />
              <Text variant="small" color="tertiary">
                Select a step to see its element details and replay diagnostics.
              </Text>
            </div>
          ) : (
            (() => {
              const label = `Step ${selectedIndex + 1}: ${describeStep(step)}`;
              const status: { text: string; tone: string } = !entry
                ? { text: "not yet replayed", tone: "text-tertiary" }
                : entry.ok
                  ? { text: "replayed successfully", tone: "text-support-green" }
                  : { text: entry.error || "failed", tone: "text-support-red" };
              const loc = locatorSummary(step);
              return (
                <>
                  <div className="flex items-center justify-between gap-2 border-b border-separator px-3 py-1.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <Bug className={`size-4 shrink-0 ${status.tone}`} />
                      <Text variant="small" className="truncate" title={label}>
                        {label}
                      </Text>
                      <Text variant="small" color="tertiary" className="shrink-0">
                        <span className={status.tone}>{status.text}</span>
                        {entry ? ` · ${new Date(entry.at).toLocaleTimeString()}` : ""}
                      </Text>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {hitRate !== null ? (
                        <span className={`text-[11px] font-medium ${hitRateTone(hitRate)}`}>
                          {hitRate}% hit rate
                        </span>
                      ) : null}
                      {entry ? (
                        <Button
                          iconOnly
                          variant="transparent"
                          size="small"
                          onClick={onClear}
                          aria-label="Clear replay diagnostic"
                          title="Clear replay diagnostic"
                        >
                          <X className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {loc ? (
                    <div className="border-b border-separator px-3 py-1.5 text-[11px]">
                      <span className="text-tertiary">Element locator: </span>
                      <span className="font-mono text-secondary">{loc}</span>
                    </div>
                  ) : null}
                  <ScrollArea className="min-h-0 flex-1">
                    <div className="px-3 pb-3 pt-1">
                      {entry && entry.logs.length > 0 ? (
                        <div className="font-mono text-[11px] leading-relaxed">
                          <LogLines logs={entry.logs} />
                        </div>
                      ) : (
                        <Text variant="small" color="tertiary">
                          No diagnostic lines. Run ▶ replay (or “Replay from current step”) to
                          capture verbose output.
                        </Text>
                      )}
                    </div>
                  </ScrollArea>
                </>
              );
            })()
          )}
        </TabsContent>
      </TabsRoot>
    </div>
  );
}

export function RecordingView() {
  const {
    state,
    stepsLoaded,
    liveSteps,
    pause,
    resume,
    stop,
    discardExit,
    setAssert,
    deleteStep,
    insertStep,
    reorderStep,
    updateStep,
    applyHeal,
    setCursor,
    replayStep,
    replayFromCurrent,
    replayRun,
    executing,
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
  // Debug panel: which tab is showing, and whether the Console auto-scrolls to
  // the latest output (on by default; a checkbox lets the user scroll manually).
  const [debugTab, setDebugTab] = React.useState("steps");
  const [autoScroll, setAutoScroll] = React.useState(true);
  // Per-step AI debugging is a session in the global store (see
  // ai-debug-store.tsx), not local state: minimizing one has to survive this
  // view, and the trainer replaces the whole outlet while it is open.
  const aiDebug = useAiDebug();
  // A brand-new recording has no test id yet, so its step sessions are keyed
  // under a stable placeholder rather than "null" — otherwise every unsaved
  // trainer session would collide with every other one.
  const aiTestId = state.testId ?? "trainer";
  // Status per step index, for the Console's per-step sparkle icons.
  const aiStatusByStep = React.useMemo(() => {
    const out: Record<number, AiDebugStatus> = {};
    for (const s of aiDebug.sessions) {
      const parsed = parseSessionKey(s.key);
      if (parsed?.kind === "step" && parsed.testId === aiTestId && parsed.stepIndex !== null) {
        out[parsed.stepIndex] = s.status;
      }
    }
    return out;
  }, [aiDebug.sessions, aiTestId]);

  const openStepDebug = React.useCallback(
    (index: number) => {
      const failed = replayRun?.steps.find((x) => x.index === index) ?? null;
      const live = liveSteps[index];
      const stepLabel = failed?.stepLabel ?? `Step ${index + 1}`;
      aiDebug.openSession({
        key: stepSessionKey(aiTestId, index),
        kind: "step",
        testId: aiTestId,
        label: `Step ${index + 1}: ${stepLabel}`,
        testName: state.name ?? "Test",
        context: {
          kind: "step",
          testName: state.name ?? "Test",
          url: state.url ?? "",
          stepLabel,
          locator: live?.locator ? locatorToPrompt(live.locator) : undefined,
          error: failed?.error ?? "Replay did not complete.",
          logs: (failed?.logs ?? []).map((l) => ({ level: l.level, message: l.m })),
        },
      });
    },
    [aiDebug, aiTestId, replayRun, liveSteps, state.name, state.url],
  );
  // Exit confirmation: the "Save Test" / "Generate Test" toolbar button opens
  // this modal only when there are unsaved steps; with no steps it saves/exits
  // directly. Two options: discard edits (close without saving) or save & exit.
  const [exitOpen, setExitOpen] = React.useState(false);
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
    // Addressed to the docked panel: the user right-clicked in the training
    // browser and the panel is the trainer beside it. Both windows receive the
    // broadcast, so without this check one right-click opens two prefilled
    // dialogs — and the one back here is behind the browser anyway.
    if (a.target === "panel") {
      clearContextAction();
      return;
    }
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

  // "Running" covers ANY in-flight replay (single step or from-current), not
  // just the streamed run — so the status reads "Running" and step editing is
  // locked whenever the test is executing.
  const running = executing || !!replayRun?.running;

  // "Replay from current step": run slowly from the currently selected step
  // (or the first step if none is selected) through the end, streaming each
  // step's output to the Console tab.
  const onReplayFromCurrent = async () => {
    const startIndex = selectedStepId
      ? Math.max(0, liveSteps.findIndex((s) => s.id === selectedStepId))
      : 0;
    setDebugTab("console");
    setReplayStatus("Replaying…");
    const res = await replayFromCurrent(startIndex);
    if (res.ranCount === 0) {
      setReplayStatus(res.ok ? "No steps to replay." : res.error || "Replay failed.");
    } else if (res.ok) {
      setReplayStatus(`Replayed ${res.ranCount} step${res.ranCount === 1 ? "" : "s"} — ${res.passedCount} passed.`);
    } else {
      setReplayStatus(`Stopped at step ${res.failedAtIndex + 1}: ${res.error || "failed"}`);
    }
    // Clear the status after a few seconds so it doesn't linger.
    window.setTimeout(() => setReplayStatus(null), 6000);
  };

  // Follow the streamed run: auto-select the step currently being replayed so
  // the Step details tab and the row highlight track progress.
  React.useEffect(() => {
    if (!replayRun?.running || replayRun.steps.length === 0) return;
    const last = replayRun.steps[replayRun.steps.length - 1];
    const s = liveSteps[last.index];
    if (s) setSelectedStepId(s.id);
  }, [replayRun, liveSteps]);

  // Controls stay inert until the training browser has loaded its first page,
  // until THIS window actually holds the step list, and while a replay is in
  // flight. The steps clause matters for a window that opened mid-session and
  // missed the initial `recorder:steps` push: editing against a list you have
  // not received yet inserts at the wrong position, and the insert cursor the
  // backend sent means nothing without the rows it points between.
  const controlsDisabled = !state.pageReady || !stepsLoaded || running;

  // Drag-to-reorder bookkeeping.
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overIndex, setOverIndex] = React.useState<number | null>(null);

  const openAssertMenu = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const res = await nativeMenu().popup({
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
      coordinateSpace: "view",
      items: [
        ...ASSERT_PICKABLE.map((a, i) => ({ label: a.label, commandId: i })),
        { type: "separator" as const },
        ...ASSERT_URL.map((a, i) => ({ label: a.label, commandId: 100 + i })),
      ],
    });
    if (typeof res.commandId !== "number") return;
    if (res.commandId < 100 && ASSERT_PICKABLE[res.commandId]) {
      setAssert(ASSERT_PICKABLE[res.commandId].kind, soft);
    } else if (res.commandId >= 100) {
      const urlKind = ASSERT_URL[res.commandId - 100];
      if (urlKind) {
        // URL assertions need a typed string — open the Add-step dialog prefilled.
        setContextPick({ picked: null, assert: urlKind.kind });
        setAddKind("assertion");
      }
    }
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
          <Button
            variant="destructive"
            onClick={() => {
              // No recorded steps = nothing to lose: save/exit directly without
              // the confirmation warning. Otherwise open the warning so the
              // user can choose to save or discard their edits.
              if (liveSteps.length === 0) {
                stop();
              } else {
                setExitOpen(true);
              }
            }}
          >
            {state.editing ? "Save Test" : "Generate Test"}
          </Button>
        </ToolbarActions>
      </Toolbar>

      <div className="flex items-center gap-3 border-b border-separator px-4 py-3">
        {!state.pageReady ? (
          <Status variant="warning">Loading page…</Status>
        ) : !stepsLoaded ? (
          // Disabled controls with a "Recording" badge reads as the trainer
          // being broken. Name the wait instead.
          <Status variant="warning">Loading steps…</Status>
        ) : running ? (
          <Status variant="loading">Running</Status>
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
          onClick={onReplayFromCurrent}
          disabled={controlsDisabled}
          aria-label="Replay from the current step"
          title="Replay slowly from the selected step (or the first step) through the end, streaming each step's output to the Console"
        >
          {/* Return arrow, matching the docked panel — the same action must not
              wear a different glyph in the two trainers. Here a text label
              disambiguates it from Pause/Resume; in the panel nothing does. */}
          <RotateCcw className="size-3.5" /> Replay from current step
        </Button>
        {replayStatus ? (
          <Text variant="small" color="secondary" className="shrink-0">
            {replayStatus}
          </Text>
        ) : null}
        <Button
          size="small"
          variant="muted"
          onClick={openAssertMenu}
          disabled={controlsDisabled}
          title="Add an assertion step by picking an element in the browser"
        >
          {state.assertMode ? ASSERT_LABEL[state.assertMode] : "New Assertion"}
          <ChevronDown className="size-3.5" />
        </Button>
        <SegmentedControl
          size="small"
          value={soft ? "soft" : "hard"}
          onValueChange={onSoftChange}
          disabled={controlsDisabled}
        >
          <SegmentedControlItem
            value="hard"
            title="Hard — a failed assertion stops the test run immediately. Use for conditions the test depends on."
          >
            Hard
          </SegmentedControlItem>
          <SegmentedControlItem
            value="soft"
            title="Soft — a failed assertion is reported but the run continues. Use for non-critical checks."
          >
            Soft
          </SegmentedControlItem>
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
              <CursorGap active={state.cursor === 0} onClick={() => setCursor(0)} disabled={controlsDisabled} />
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
                  <CursorGap active={state.cursor === i + 1} onClick={() => setCursor(i + 1)} disabled={controlsDisabled} />
                </React.Fragment>
              ))}
            </>
          )}
        </div>
      </ScrollArea>

      <DebugPanel
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
        replayRun={replayRun}
        tab={debugTab}
        onTabChange={setDebugTab}
        onInsertCookieStep={(step) => insertStep(step)}
        autoScroll={autoScroll}
        onAutoScrollChange={setAutoScroll}
        onDebugStep={openStepDebug}
        aiStatusByStep={aiStatusByStep}
        onApplyHeal={applyHeal}
      />

      {addKind ? (
        <AddStepDialog
          open={addKind !== null}
          kind={addKind}
          currentTestId={state?.testId ?? undefined}
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

      {/* Loading overlay: while the training browser window is opening but
          hasn't finished loading, show a full-area modal with a spinner and
          copy explaining what's happening. Disappears once pageReady. */}
      {state.loading ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/80">
          <div className="flex max-w-sm flex-col items-center gap-4 px-8 text-center">
            <Loader2 className="size-8 animate-spin text-accent" />
            <div className="flex flex-col gap-1">
              <Text variant="strong">Opening training browser…</Text>
              <Text variant="small" color="secondary">
                Loading <span className="truncate">{state.url}</span>
              </Text>
            </div>
            <Text variant="small" color="tertiary">
              The training window opens in a separate browser. If it doesn't
              appear within a few seconds, check your network connection.
            </Text>
          </div>
        </div>
      ) : null}

      {/* Load-failed error dialog: the training window didn't open within the
          10s timeout. The failure is logged to Stats; prompt the user to try
          again or check the run history for details. */}
      <Dialog
        open={state.loadFailed}
        onOpenChange={() => {
          /* non-dismissible until the user acknowledges via the button */
        }}
        title="Couldn't open the training browser"
        description="The training window couldn't open. This can happen on a slow network, a redirect loop, or if the site is unreachable."
        confirmLabel="Try again"
        confirmVariant="accent"
        onConfirm={() => {
          // Reset by navigating away and back — the user can click Edit in
          // Trainer / New recording again.
          stop();
        }}
        destructiveAction={{
          label: "Check Stats",
          onClick: () => {
            stop();
            // Navigate to Stats via the router (the sidebar handles this).
            window.location.hash = "#/stats";
          },
        }}
      >
        <Text variant="small" color="secondary">
          The failure has been logged to Stats → Run history. You can try
          again, or check the logs for more details.
        </Text>
      </Dialog>

      {/* Exit confirmation: shown only when there are unsaved training edits
          (live steps). Two options: discard the edits (close without saving) or
          save & exit (finalize + close). */}
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
          {`${liveSteps.length} step${liveSteps.length === 1 ? "" : "s"} will be saved when you choose "Save & Exit". "Discard Edits" closes the trainer without saving.`}
        </Text>
      </Dialog>
    </div>
  );
}
