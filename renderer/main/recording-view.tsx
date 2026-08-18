import * as React from "react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  ScrollArea,
  Tabs,
  TabsContent,
  TabsRoot,
  TabsTrigger,
  Text,
  Toolbar,
  ToolbarActions,
  ToolbarContent,
  ToolbarTitle,
} from "@ui";
import { Bug, Check, ChevronDown, Crosshair, ListPlus, Loader2, Pause, Play, Plus, RotateCcw, Sparkles, Wand2, X } from "lucide-react";

import { Btn, Segmented, StatusChip, TONE } from "../theme";
import type { AiDebugStatus, AssertKind, DebugEntry, HealSuggestion, Locator, PickedElement, RawStep, Step, WaitDialogMode } from "../lib/recorder-types";
import { computeStepDepths, describeStep } from "../lib/describe-step";
import { urlAssertPrefill } from "../../shared/url-assert.mjs";
import { locatorToPrompt } from "../lib/llm-prompts";
import { useRecorder, type ReplayRun } from "./recorder-store";
import { CursorGap, INSERT_HERE, StepRow } from "./step-row";
import { StepComposer, ADD_STEP_LABEL, type AddStepKind } from "./step-composer";
import { stepSessionKey, useAiDebug } from "./ai-debug-store";
import { parseSessionKey } from "../lib/ai-debug-sessions";
import { toneFor } from "../lib/ai-debug-status";
import { GenerateStepsDialog } from "./generate-steps-dialog";
import { RefineSelectorDialog, formatLocator, KIND_LABEL } from "./refine-selector-dialog";
import { CookiesPanel } from "./cookies-panel";
import { useViewportNarrowedNotice } from "./viewport-narrowed-notice";

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

// Page-level assertions need a typed string (not an element click), so
// selecting one from the dropdown opens the Add-step → Assertion dialog
// prefilled. The two title kinds prefill EMPTY here on purpose: this window
// tracks the page's live URL but not its live title, and `urlAssertPrefill`
// already answers "" for any kind it cannot stand behind. An empty field the
// user knows to fill beats a plausible value they do not check — the training
// browser's own right-click menu, which can read the real title, prefills it.
const ASSERT_PAGE: { kind: AssertKind; label: string }[] = [
  { kind: "url", label: "URL contains" },
  { kind: "urlEndsWith", label: "URL ends with" },
  { kind: "urlIs", label: "URL is" },
  { kind: "title", label: "Page title is" },
  { kind: "titleContains", label: "Page title contains" },
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
  titleContains: "Page title contains",
  css: "Has CSS property",
};

// Order matters: index === commandId in the native "+ Add step" menu.
const ADD_STEP_KINDS: AddStepKind[] = [
  "assertion",
  "elementState",
  "condition",
  "wait",
  "goto",
  "press",
  "find",
  "viewport",
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
    <div className="gl-trainer-console">
      <TabsRoot value={tab} onValueChange={onTabChange} className="flex min-h-0 flex-1 flex-col">
        <div className="gl-tabs gl-trainer-console-head">
          <Tabs variant="filled" size="small">
            <TabsTrigger value="console">Console</TabsTrigger>
            <TabsTrigger value="steps">Step details</TabsTrigger>
            <TabsTrigger value="cookies">Cookies</TabsTrigger>
          </Tabs>
          {tab === "console" ? (
            <label className="gl-run-option shrink-0">
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
          <div className="gl-trainer-console-bar">
            {replayRun?.running ? (
              // Cyan — "running / live / focus", the token's own definition. It
              // was the SDK accent, which is a different blue that means
              // nothing in this palette.
              <Loader2 className="size-3.5 shrink-0 animate-spin" style={{ color: TONE.cyan }} />
            ) : null}
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
    applyHeal,
    setCursor,
    replayStep,
    replayFromCurrent,
    replayRun,
    executing,
    replayStepStatus,
    replayFlash,
    debugEntries,
    clearDebugEntry,
    picked,
    refiningStepId,
    startRefine,
    endRefine,
    clearPicked,
    addVariable,
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
    waitMode?: WaitDialogMode;
    /** pseudo-state preselected by the right-click "Set element state" submenu */
    elementState?: "hover" | "focus";
    prefillText?: string;
    prefillValue?: string;
  } | null>(null);

  // Docking the panel narrows the training browser. This window is the one that
  // can be relied on to hear about it: the push is sent before the panel's page
  // loads, so the panel misses it on the ordinary path. See the notice module.
  useViewportNarrowedNotice();

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
    } else if (a.kind === "elementState") {
      setContextPick({ picked: a.picked, elementState: a.elementState, prefillText: a.prefillText, prefillValue: a.prefillValue });
      setAddKind("elementState");
    } else {
      setContextPick({ picked: a.picked, prefillText: a.prefillText, prefillValue: a.prefillValue });
      setAddKind(a.kind as AddStepKind);
    }
    clearContextAction();
  }, [contextAction, clearContextAction]);

  // "Running" covers ANY in-flight replay (single step or from-current), not
  // just the streamed run — so the status reads "Running" and step editing is
  // locked whenever the test is executing.
  //
  // `state.replaying` is the term that makes this true for a replay THIS window
  // did not start. The other two are local: `executing` is set by this window's
  // own store call and `replayRun` only streams to the window that asked. With
  // both trainers open on one session, that left the other one showing
  // "Recording" with live controls during a run — and an Add step there lands
  // mid-replay, in a session whose whole premise right now is that capture is
  // off. The backend broadcasts `replaying` precisely so both windows agree.
  const running = executing || !!replayRun?.running || state.replaying;

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

  // Whether the next captured step will land under the last row. True for the
  // whole of an ordinary new recording, and that is why "scroll to the bottom"
  // looked like the right rule for years — it is, right up until the session is
  // a continued test, where the cursor opens mid-list.
  const cursorAtEnd = state.cursor >= liveSteps.length;

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
        ...ASSERT_PAGE.map((a, i) => ({ label: a.label, commandId: 100 + i })),
      ],
    });
    if (typeof res.commandId !== "number") return;
    if (res.commandId < 100 && ASSERT_PICKABLE[res.commandId]) {
      setAssert(ASSERT_PICKABLE[res.commandId].kind, soft);
    } else if (res.commandId >= 100) {
      const urlKind = ASSERT_PAGE[res.commandId - 100];
      if (urlKind) {
        // Prefilled with where the page actually is. This used to open with an
        // EMPTY field, which meant the user had to know the URL — and the only
        // legible copy of it was outside the app, because the trainer showed
        // the session's start URL and the training window's title showed the
        // site's own `document.title`. `urlAssertPrefill` decides what each
        // kind gets (a path for the substring kinds, the whole URL for `is`),
        // and it is the same function the training browser's own URL strip and
        // right-click menu call.
        setContextPick({
          picked: null,
          assert: urlKind.kind,
          prefillValue: urlAssertPrefill(urlKind.kind, state.liveUrl ?? state.url ?? ""),
        });
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

  // The composer, rendered AT THE CURSOR rather than over the list (§6.2).
  //
  // A function of the gap index rather than one element hoisted out of the
  // list: the panel has to sit between the two steps the new one will land
  // between, and "between" is a position in this map, not a place in the tree.
  // It renders at most once — `state.cursor` is a single index.
  const composerAt = (index: number) =>
    addKind !== null && state.cursor === index ? (
      <StepComposer
        // Remounts when the caller re-targets it from the context menu, so a
        // half-filled draft for one element never carries over to another.
        key={`${addKind}:${contextPick?.picked?.description ?? ""}`}
        kind={addKind}
        currentTestId={state?.testId ?? undefined}
        onCancel={() => {
          setAddKind(null);
          // Leaving the composer: tear down any in-flight pick and the
          // context-menu prefill state.
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
        // Use the context-menu's pre-resolved element when present (it was
        // captured at the right-click point); otherwise the in-panel picker.
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
    <div className="flex h-full flex-col">
      <Toolbar>
        <ToolbarContent>
          <ToolbarTitle>{state.editing ? "Editing recording" : "Recording"}</ToolbarTitle>
        </ToolbarContent>
        <ToolbarActions>
          {/* `go`, not `stop`. This button ENDS the recording, which reads as
              destructive, but what it does is produce the test — the affirmative
              action the whole session exists for. The SDK variant it replaces
              was `destructive`, i.e. red, which in this palette means FAILED. */}
          <Btn
            tone="go"
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
          </Btn>
        </ToolbarActions>
      </Toolbar>

      {/* NONE OF THESE STATES IS AN OUTCOME, so none of them takes a status
          hue. That is a real change: `Recording` was the SDK's `error` variant,
          i.e. RED — the colour this palette spends on a failed run — on the one
          screen where nothing has run yet. Recording, Replaying and Running are
          all IN FLIGHT, which is exactly what `StatusChip`'s `running` treatment
          means ("a treatment says this is not a result"); the word is what
          separates them, and the word is the primary signal anyway. Paused and
          the two loading states are neutral: real, not results, not live. */}
      <div className="gl-trainer-status">
        {!state.pageReady ? (
          <StatusChip>Loading page…</StatusChip>
        ) : !stepsLoaded ? (
          // Disabled controls with a "Recording" badge reads as the trainer
          // being broken. Name the wait instead.
          <StatusChip>Loading steps…</StatusChip>
        ) : running ? (
          // "Replaying" rather than "Running" when the backend says a replay
          // owns the window: it is the state that explains why capture is off
          // and why the controls are inert, and it is the one the user just
          // caused. "Running" stays for a real Playwright run.
          <StatusChip running animated>
            {state.replaying ? "Replaying" : "Running"}
          </StatusChip>
        ) : state.paused ? (
          <StatusChip>Paused</StatusChip>
        ) : (
          // "Recording" WHETHER OR NOT this session is continuing an existing
          // test, and that is a fix rather than a simplification. It used to
          // read "Editing" for a continued session — while capture was fully
          // live — so the one indicator whose job is to say whether the trainer
          // is listening said it was not. Reported as "it doesn't record any
          // manual page interaction". That this is an existing test is said
          // twice already, by the title above and by "Save Test" beside it.
          <StatusChip running animated>
            Recording
          </StatusChip>
        )}
        <span className="gl-mono-value min-w-0 truncate">{state.url}</span>
        <div className="ml-auto shrink-0">
          {controlsDisabled ? null : state.paused ? (
            <Btn onClick={resume}>
              <Play className="size-3.5" /> Resume
            </Btn>
          ) : (
            <Btn onClick={pause}>
              <Pause className="size-3.5" /> Pause
            </Btn>
          )}
        </div>
      </div>

      <div className="gl-trainer-tools">
        <Btn
          onClick={onReplayFromCurrent}
          disabled={controlsDisabled}
          aria-label="Replay from the current step"
          title="Replay slowly from the selected step (or the first step) through the end, streaming each step's output to the Console"
        >
          {/* Return arrow, matching the docked panel — the same action must not
              wear a different glyph in the two trainers. Here a text label
              disambiguates it from Pause/Resume; in the panel nothing does. */}
          <RotateCcw className="size-3.5" /> Replay from current step
        </Btn>
        {replayStatus ? <span className="gl-note shrink-0">{replayStatus}</span> : null}
        <Btn
          onClick={openAssertMenu}
          disabled={controlsDisabled}
          title="Add an assertion step by picking an element in the browser"
        >
          {state.assertMode ? ASSERT_LABEL[state.assertMode] : "New Assertion"}
          <ChevronDown className="size-3.5" />
        </Btn>
        {/* The theme's `Segmented`, which is plain buttons with `aria-pressed`
            rather than a Radix control: `fireEvent.click` works on it, so the
            hard/soft choice can be driven in a test instead of asserted at the
            IPC layer. Its active item is neutral, like every selection here. */}
        <Segmented
          label="Assertion strictness"
          value={soft ? "soft" : "hard"}
          onChange={(v) => onSoftChange(v)}
          options={[
            {
              value: "hard",
              label: "Hard",
              disabled: controlsDisabled,
              title:
                "Hard — a failed assertion stops the test run immediately. Use for conditions the test depends on.",
            },
            {
              value: "soft",
              label: "Soft",
              disabled: controlsDisabled,
              title:
                "Soft — a failed assertion is reported but the run continues. Use for non-critical checks.",
            },
          ]}
        />
        {state.assertMode ? (
          <>
            {/* CYAN, not the SDK's blue. The palette declares cyan as
                "running / live / focus", and this line is exactly that: the app
                is waiting on the user to click something in the other window. */}
            <span className="gl-trainer-prompt shrink-0">Click an element in the browser…</span>
            <button
              type="button"
              className="gl-icon-btn"
              onClick={() => setAssert(null)}
              aria-label="Cancel assertion"
            >
              <X className="size-3.5" />
            </button>
          </>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Btn onClick={openAddStepMenu} disabled={controlsDisabled}>
            <Plus className="size-3.5" /> Add step
          </Btn>
          {/* `ai`, the holo border. AI is not an outcome, so it gets a
              treatment rather than a colour — and this is the one button in the
              row that hands the job to a model. */}
          <Btn tone="ai" onClick={() => setAiOpen(true)} disabled={controlsDisabled}>
            <Wand2 className="size-3.5" /> AI steps
          </Btn>
        </div>
      </div>

      {state.refineMode ? (
        <div className="gl-notice gl-trainer-refine">
          <Crosshair className="size-4 shrink-0" style={{ color: TONE.cyan }} />
          <span className="min-w-0">
            Refine selector active — hover a component in the browser and click it to capture its
            selector. The page won’t respond to clicks.
          </span>
          <Btn className="ml-auto shrink-0" onClick={endRefine}>
            <X className="size-3.5" /> Cancel
          </Btn>
        </div>
      ) : null}

      <ScrollArea
        className="min-h-0 flex-1"
        // Follow the bottom only while the bottom IS the insert point. A
        // continued test opens its cursor just past the navigation, so a
        // captured step lands mid-list — and a view that jumps to the end on
        // every capture scrolls away from the one row that changed, which is
        // indistinguishable from nothing having been recorded. When the cursor
        // is elsewhere the arriving row scrolls itself into view instead
        // (StepRow's `justAdded`), and these two must never both be on.
        autoScrollToBottom={cursorAtEnd}
        autoScrollDeps={[liveSteps.length]}
        scrollbars="both"
      >
        {/* `--tight` because the trainer's rows are separated by their own
            insert cursors rather than by a gap — the two together would double
            the space between every step. */}
        <div className="gl-step-list gl-step-list--tight">
          {liveSteps.length === 0 ? (
            <>
              {/* The empty list has no gaps to sit between, and the composer
                  still has to land somewhere — it is the ONLY way to put a step
                  into a session where nothing has been captured yet. */}
              {composerAt(0)}
              <div className="flex flex-col items-start gap-2 px-2 py-1">
                <Text variant="small" color="secondary">
                  Interact with the site — steps appear here as you go.
                </Text>
                <Text variant="small" color="tertiary">
                  Or use <ListPlus className="inline size-3.5 align-text-bottom" /> “Add step” / “AI steps”.
                </Text>
              </div>
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
                    drag={controlsDisabled ? undefined : {
                      onDragStart: () => setDragId(s.id),
                      onDragEnter: () => setOverIndex(i),
                      onDragEnd: commitDrag,
                      isDragging: dragId === s.id,
                      isOver: overIndex === i && dragId !== null && dragId !== s.id,
                    }}
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

      <GenerateStepsDialog
        open={aiOpen}
        url={state.url}
        onOpenChange={setAiOpen}
        onInsert={(steps) => void insertGeneratedSteps(steps)}
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

      {/* The load-failed dialog used to be here, gated on `state.loadFailed`.
          It has moved to `load-failed-dialog.tsx`, mounted from RootView and
          driven by the `recorder:loadFailed` push — this component is unmounted
          by the time a failed load reports itself, and that field never arrives
          true. See the note at the top of that file. */}

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
