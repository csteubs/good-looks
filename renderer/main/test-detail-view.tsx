import * as React from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Button,
  Callout,
  Checkbox,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  Input,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsRoot,
  TabsTrigger,
  Text,
  Toolbar,
  ToolbarActions,
  ToolbarContent,
  ToolbarDescription,
  ToolbarTitle,
} from "@glaze/core/components";
import { ChevronDown, Pencil, TriangleAlert, Trash2 } from "lucide-react";

import { api } from "../lib/api";
import { useRecorder } from "./recorder-store";
import {
  runSessionKey,
  useAiDebug,
  useAiDebugStatus,
  type AiDebugRunContext,
} from "./ai-debug-store";
import { EditStepsView } from "./edit-steps-view";
import { RunOutput } from "./run-output";
import { ScriptEditor, ScriptView } from "./script-view";
import { StepRow } from "./step-row";
import { VariablesPanel } from "./variables-panel";
import { HealsPanel } from "./heals-panel";
import { A11yPanel } from "./a11y-panel";
import { computeStepDepths } from "../lib/describe-step";
import { newStepIds as computeNewStepIds } from "../lib/diff-steps";
import { latestA11yRun } from "../lib/a11y-format";
import {
  RUN_BROWSERS,
  RUN_BROWSER_LABELS,
  type RunBrowser,
  type Step,
  type TestRecord,
} from "../lib/recorder-types";

/** Compact ms for the inline capture-cost hint next to the toggle. */
function fmtCaptureMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** What to say when a record admits its steps and its script disagree. Three
 *  cases, not one: a warning that prescribes a fix the test can't perform is
 *  its own bug, and an imported spec is never regenerated from steps. The
 *  reason is absent on records written before it was tracked — back then a
 *  lossy parse was the only way to get here. */
function divergedMessage(test: TestRecord): string {
  if (test.stepsDivergedReason !== "unapplied") {
    return "Steps may not reflect the script — some statements in it couldn't be parsed back into steps.";
  }
  if (test.sourceDir) {
    return "These steps aren't in the script — this test runs the file it was imported with, and that file is never regenerated from steps.";
  }
  return "These steps aren't in the script — they were saved without regenerating it, so runs still use the script as it was. Edit Steps, save, then choose “Regenerate script” to apply them.";
}

export function TestDetailView() {
  const { id } = useParams({ from: "/test/$id" });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { runs, run, stopRun, start } = useRecorder();
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState("");
  const [editingName, setEditingName] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState("");
  const [editingScript, setEditingScript] = React.useState(false);
  const [scriptDraft, setScriptDraft] = React.useState("");
  const [editingSteps, setEditingSteps] = React.useState(false);
  // Edited steps waiting on the "what about the script?" question. Only set for
  // a test whose script isn't generated from its steps; null the rest of the
  // time, which is also what closes the dialog.
  const [pendingSteps, setPendingSteps] = React.useState<Step[] | null>(null);
  const [trainerConfirmOpen, setTrainerConfirmOpen] = React.useState(false);
  // Per-test visual-testing gate — remembers the user's "Capture screenshots"
  // choice between sessions. Falls back to the global Settings default when the
  // test has no saved preference yet.
  const [captureArtifacts, setCaptureArtifacts] = React.useState(false);
  const [captureInited, setCaptureInited] = React.useState(false);
  // Per-test accessibility gate. Independent of screenshots: axe usually costs
  // more per step than the rest of the step does, so asking for pictures must
  // not silently buy an a11y audit as well.
  const [a11yChecks, setA11yChecks] = React.useState(false);
  const [a11yInited, setA11yInited] = React.useState(false);
  // Per-test console+network recording. Independent of screenshots again: this
  // one persists page-controlled text and request URLs, which is a different
  // decision from persisting pictures.
  const [recordLogs, setRecordLogs] = React.useState(false);
  const [recordLogsInited, setRecordLogsInited] = React.useState(false);
  // Per-test "Run headless" choice — remembers whether this test's runs open a
  // visible browser. Falls back to the global Settings default. Runs only; the
  // trainer/"Edit in Trainer" flow is always headed.
  const [runHeadless, setRunHeadless] = React.useState(false);
  const [headlessInited, setHeadlessInited] = React.useState(false);
  // Per-test browser engine — same fall-back chain as the toggles above.
  const [runBrowser, setRunBrowser] = React.useState<RunBrowser>("chromium");
  const [browserInited, setBrowserInited] = React.useState(false);

  // Ids of steps an applied AI-debug fix just ADDED, so the Steps tab can glow
  // them. Held here rather than on the step records because it is a fact about
  // this view's session, not about the test: reopening the test later should
  // show a settled list, not a stale "look what changed".
  //
  // Not on a timer, deliberately. Applying happens from the AI debug panel,
  // which is usually open over the Run tab — a timeout would expire before the
  // user ever switched to Steps to look. It clears when the list changes again
  // for some other reason instead (see the two callers of setNewStepIds below).
  const [newStepIds, setNewStepIds] = React.useState<Set<string>>(() => new Set());
  // Controlled so the active tab can be forced off "steps" when an apply
  // deletes the last step and the trigger disappears out from under it.
  const [tab, setTab] = React.useState<string | null>(null);

  const testQuery = useQuery({ queryKey: ["test", id], queryFn: () => api.tests.get(id) });
  const scriptQuery = useQuery({ queryKey: ["script", id], queryFn: () => api.tests.getScript(id) });
  // Badged on the Heals tab. Fetched here rather than inside the panel so the
  // count is visible without opening the tab — an unreviewed heal means the
  // test may already have been changed underneath the user.
  const healsQuery = useQuery({ queryKey: ["heals", id], queryFn: () => api.heals.list(id) });
  // Badged on the Accessibility tab, from the most recent run that actually
  // checked — same reasoning as the Heals count: an unaccepted violation the
  // user has to open a tab to discover is one they won't discover. Shares the
  // ["runs"] key with Stats and the panel itself, so this is usually free.
  const runsQuery = useQuery({ queryKey: ["runs"], queryFn: api.runs.list });
  // What capture costs FOR THIS TEST — the fair comparison, since different
  // tests do different amounts of work. Absent until this test has an
  // instrumented capture run to measure.
  const overheadQuery = useQuery({
    queryKey: ["captureOverhead", id],
    queryFn: () => api.runs.captureOverhead(id),
  });
  const settingsQuery = useQuery({
    queryKey: ["recorder-settings"],
    queryFn: () => api.recorder.getSettings(),
  });
  const test = testQuery.data;
  const pendingHeals = (healsQuery.data ?? []).filter((h) => h.status === "pending").length;
  const a11yNewSteps = latestA11yRun(runsQuery.data ?? [], id)?.a11yNewSteps ?? 0;
  const runInfo = runs[id];

  // Initialize the toggle from the test record (or the global default) once.
  React.useEffect(() => {
    if (captureInited || !test) return;
    const fallback = settingsQuery.data?.defaultCaptureArtifacts ?? false;
    setCaptureArtifacts(test.captureArtifacts ?? fallback);
    setCaptureInited(true);
  }, [captureInited, test, settingsQuery.data]);
  // Same one-shot init for the accessibility toggle.
  React.useEffect(() => {
    if (a11yInited || !test) return;
    const fallback = settingsQuery.data?.defaultA11yChecks ?? false;
    setA11yChecks(test.a11yChecks ?? fallback);
    setA11yInited(true);
  }, [a11yInited, test, settingsQuery.data]);
  // Same one-shot init for the console+network toggle.
  React.useEffect(() => {
    if (recordLogsInited || !test) return;
    const fallback = settingsQuery.data?.defaultRecordLogs ?? false;
    setRecordLogs(test.recordLogs ?? fallback);
    setRecordLogsInited(true);
  }, [recordLogsInited, test, settingsQuery.data]);
  // Initialize the headless toggle from the test record (or the global default) once.
  React.useEffect(() => {
    if (headlessInited || !test) return;
    const fallback = settingsQuery.data?.defaultRunHeadless ?? false;
    setRunHeadless(test.runHeadless ?? fallback);
    setHeadlessInited(true);
  }, [headlessInited, test, settingsQuery.data]);
  // Initialize the browser picker from the test record (or the global default) once.
  React.useEffect(() => {
    if (browserInited || !test) return;
    const fallback = settingsQuery.data?.defaultRunBrowser ?? "chromium";
    setRunBrowser(test.runBrowser ?? fallback);
    setBrowserInited(true);
  }, [browserInited, test, settingsQuery.data]);
  // Earliest step the run reported as failed, if any — lets the AI debug
  // prompt skip steps after it, since Playwright never ran them.
  const failedStepIndex = React.useMemo(() => {
    if (!runInfo) return undefined;
    const failed = Object.entries(runInfo.stepStatus)
      .filter(([, status]) => status === "failed")
      .map(([index]) => Number(index));
    return failed.length > 0 ? Math.min(...failed) : undefined;
  }, [runInfo]);

  // ── AI debug session ─────────────────────────────────────────────
  // The session lives in the global store, so it survives leaving this view.
  // This view's job is to (a) supply the prompt context, and (b) re-supply it
  // when a session restored from disk is reopened here.
  const aiDebug = useAiDebug();
  const aiKey = runSessionKey(id);
  const script = scriptQuery.data ?? "";
  const runOutput = runInfo?.lines.join("") ?? "";
  const recordId = runInfo?.recordId;
  // Identifies the execution being debugged, STABLY for its whole life. Hashing
  // the output instead would change on every streamed line, so a session opened
  // mid-run would look like it belonged to a different run one chunk later.
  const runKey = runInfo ? (recordId ?? `t${runInfo.startedAt}`) : null;
  const keepRunningJobs = settingsQuery.data?.keepRunningAiDebugJobs ?? false;
  // Scoped to THIS run: a session from a previous run of the same test must not
  // colour the icon, or it promises an answer about output that is gone.
  const aiStatus = useAiDebugStatus(aiKey, runKey);

  // A session belongs to ONE run. When the run changes, drop it outright rather
  // than waiting for the panel to be reopened: leaving it in the store meant it
  // was still reachable — and still showing the previous run's answer — from
  // the global chip, which restores a session without going through
  // openSession's reset. Discarding also cancels any request still answering
  // about output that is no longer on screen.
  React.useEffect(() => {
    if (!runKey) return;
    const existing = aiDebug.sessions.find((s) => s.key === aiKey);
    // Only on a DEFINITE mismatch. A session restored from disk before run
    // identities existed has none, and treating unknown as "different" would
    // delete every restored diagnosis the moment its test was opened.
    if (!existing || existing.runKey == null || existing.runKey === runKey) return;
    // Already kept by an explicit opt-in. It must survive FINISHING, too —
    // discarding it the moment its answer arrived would defeat the entire
    // point of preserving it. It now lives until the user discards it.
    if (existing.superseded) return;

    // EXPERIMENTAL opt-in: a job that is still STREAMING survives the re-run
    // rather than being thrown away mid-answer. It stops colouring this run's
    // icon either way (useAiDebugStatus is run-scoped) and is reachable only
    // from the global chip, marked as belonging to the previous run.
    //
    // A FINISHED session is discarded regardless of the setting: the thing
    // worth protecting is work in progress, not a stale answer — and keeping
    // stale answers around is the exact complaint this whole path exists to
    // fix.
    if (existing.status === "streaming" && keepRunningJobs) {
      aiDebug.markSuperseded(aiKey);
      return;
    }
    aiDebug.discard(aiKey);
  }, [aiDebug, aiKey, runKey, keepRunningJobs]);

  // Whether the finished run recorded console/network. Asked once per run
  // rather than assumed from the toggle: the toggle can be flipped after a run,
  // and what matters is what THIS run actually wrote.
  const logsQuery = useQuery({
    queryKey: ["run-logs-available", id, recordId],
    queryFn: () => (recordId ? api.artifacts.hasLogs(id, recordId) : Promise.resolve({ hasLogs: false })),
    enabled: Boolean(recordId),
  });

  // Write an edited step list back. `regenerate` is what the save-time question
  // resolves to; it's ignored for a test whose script is generated from steps
  // anyway, and refused backend-side for an imported one.
  const commitSteps = React.useCallback(
    async (steps: Step[], regenerate: boolean) => {
      await api.tests.updateSteps(id, steps, { regenerate });
      // The user has now edited the list themselves, so "these are the steps
      // the AI added" is no longer a claim this view can make about it — the
      // indexes and ids it was tracking may not even exist any more.
      setNewStepIds(new Set());
      qc.invalidateQueries({ queryKey: ["test", id] });
      qc.invalidateQueries({ queryKey: ["script", id] });
      qc.invalidateQueries({ queryKey: ["tests"] });
      setPendingSteps(null);
      setEditingSteps(false);
    },
    [id, qc],
  );

  const applyScript = React.useCallback(
    async (source: string) => {
      // Snapshot the steps BEFORE the write. Applying a fix goes through
      // `tests:updateScript`, which re-parses the whole spec and replaces the
      // step list wholesale — so this is the only moment the previous list
      // still exists anywhere.
      const before = qc.getQueryData<TestRecord | null>(["test", id])?.steps ?? [];
      const updated = await api.tests.updateScript(id, source);
      // Diff off the handler's return value rather than a refetch: the refetch
      // is async and the highlight would race it, and the record it returns is
      // the same one the invalidation is about to put in the cache anyway.
      setNewStepIds(computeNewStepIds(before, updated?.steps ?? []));
      qc.invalidateQueries({ queryKey: ["script", id] });
      qc.invalidateQueries({ queryKey: ["test", id] });
    },
    [id, qc],
  );

  const runContext = React.useMemo<AiDebugRunContext | null>(() => {
    if (!test) return null;
    return {
      kind: "run",
      testName: test.name,
      testUrl: test.url,
      script,
      output: runOutput,
      imported: Boolean(test.sourceDir),
      speed: test.speed,
      failedStepIndex,
      recordId,
      logsAvailable: Boolean(logsQuery.data?.hasLogs),
      onApplyScript: applyScript,
    };
  }, [test, script, runOutput, failedStepIndex, applyScript, recordId, logsQuery.data?.hasLogs]);

  // Keep a live session's context fresh (the script or run output can change
  // under it) and re-ground one restored from disk, which has no context at all
  // until the view that owns it renders again.
  // Deliberately NOT gated on aiStatus: that is now scoped to the current run,
  // and a session from a previous run still needs the live script attached so
  // its diff is computed against what applying would actually overwrite.
  // "Which icon colour" and "does this session need context" are different
  // questions and must not share a condition.
  const hasSession = aiDebug.sessions.some((s) => s.key === aiKey);
  React.useEffect(() => {
    if (!runContext || !hasSession) return;
    aiDebug.attachContext(aiKey, runContext);
  }, [aiDebug, aiKey, runContext, hasSession]);

  const openAiDebug = React.useCallback(() => {
    if (!test || !runContext) return;
    aiDebug.openSession({
      key: aiKey,
      kind: "run",
      testId: id,
      label: test.name,
      testName: test.name,
      runKey,
      context: runContext,
    });
  }, [aiDebug, aiKey, id, test, runContext, runKey]);

  const saveName = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === test?.name) return;
    await api.tests.rename(id, trimmed);
    qc.invalidateQueries({ queryKey: ["tests"] });
    qc.invalidateQueries({ queryKey: ["test", id] });
    qc.invalidateQueries({ queryKey: ["script", id] });
  };

  const saveScript = async () => {
    await api.tests.updateScript(id, scriptDraft);
    qc.invalidateQueries({ queryKey: ["script", id] });
    qc.invalidateQueries({ queryKey: ["test", id] });
    setEditingScript(false);
  };

  if (!test) {
    return (
      <div className="flex h-full flex-col">
        <Toolbar>
          <ToolbarContent>
            <ToolbarTitle> </ToolbarTitle>
          </ToolbarContent>
        </Toolbar>
      </div>
    );
  }

  // Save any in-progress script edits, then open the trainer so the manually
  // edited script is preserved on disk before the trainer can regenerate it.
  const saveAndEditInTrainer = async () => {
    if (editingScript) {
      await api.tests.updateScript(id, scriptDraft);
      qc.invalidateQueries({ queryKey: ["script", id] });
      qc.invalidateQueries({ queryKey: ["test", id] });
      setEditingScript(false);
    }
    start(test.url, test.name, test.id);
  };

  return (
    <div className="flex h-full flex-col">
      <Toolbar className="pt-2">
        <ToolbarContent>
          {editingName ? (
            <Input
              size="small"
              variant="filled"
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              className="h-6 pl-1.5 -ml-1.5 text-[15px] font-medium"
              onBlur={() => {
                setEditingName(false);
                saveName(nameDraft);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setEditingName(false);
                  saveName(nameDraft);
                } else if (e.key === "Escape") {
                  setEditingName(false);
                }
              }}
            />
          ) : (
            <ToolbarTitle
              className="cursor-text no-drag inline-flex items-center gap-1.5"
              onClick={() => {
                setNameDraft(test.name);
                setEditingName(true);
              }}
            >
              {test.name}
              <Pencil className="size-3.5 text-tertiary" />
            </ToolbarTitle>
          )}
          <ToolbarDescription>{test.url}</ToolbarDescription>
        </ToolbarContent>
        <ToolbarActions>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="glass">
                Edit Test
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end">
              <DropdownMenuItem onSelect={() => {
                if (test.scriptEdited) setTrainerConfirmOpen(true);
                else start(test.url, test.name, test.id);
              }}>
                Edit in Trainer
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setEditingSteps(true)}>
                Edit Steps
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {test.scriptEdited ? (
            <Dialog
              open={trainerConfirmOpen}
              onOpenChange={setTrainerConfirmOpen}
              title="Edit in Trainer"
              description="This test has manual script edits. Opening the trainer will regenerate the script from the recorded steps when you stop, overwriting those edits."
              confirmLabel="Save & continue"
              confirmVariant="accent"
              onConfirm={saveAndEditInTrainer}
              destructiveAction={{
                label: "Continue without saving",
                onClick: () => start(test.url, test.name, test.id),
              }}
            />
          ) : null}
          <AlertDialog
            trigger={
              <Button iconOnly variant="glass" size="large" aria-label="Delete test">
                <Trash2 className="size-5" />
              </Button>
            }
            title="Delete this test?"
            description="This removes the recording and its generated script. This can't be undone."
            confirmLabel="Delete"
            confirmVariant="destructive"
            onConfirm={async () => {
              await api.tests.remove(id);
              qc.invalidateQueries({ queryKey: ["tests"] });
              navigate({ to: "/" });
            }}
          />
          <Select
            value={runBrowser}
            onValueChange={(v) => {
              const next = v as RunBrowser;
              setRunBrowser(next);
              api.tests.setBrowser(id, next).catch(() => {
                /* best-effort persist; the choice still applies to this run */
              });
            }}
            disabled={runInfo?.running}
          >
            <SelectTrigger
              variant="filled"
              size="small"
              className="w-32"
              aria-label="Browser engine for this test's runs"
            >
              <SelectValue placeholder="Chromium" />
            </SelectTrigger>
            <SelectContent>
              {RUN_BROWSERS.map((b) => (
                <SelectItem key={b} value={b}>
                  {RUN_BROWSER_LABELS[b]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex cursor-pointer select-none items-center gap-1.5 pr-1 text-small text-secondary">
            <Checkbox
              checked={runHeadless}
              onCheckedChange={(v) => {
                const next = v === true;
                setRunHeadless(next);
                api.tests.setHeadless(id, next).catch(() => {
                  /* best-effort persist; the toggle still applies to this run */
                });
              }}
              disabled={runInfo?.running}
              aria-label="Run this test headless (no visible browser)"
            />
            Run headless
          </label>
          <label className="flex cursor-pointer select-none items-center gap-1.5 pr-1 text-small text-secondary">
            {/* Independent of "Run headless". Headless Chromium renders to an
                offscreen surface, so page.screenshot() works exactly the same —
                it's how visual regression testing is normally done. Headless is
                arguably the BETTER mode for it, since a headed run drags in
                window chrome, focus rings and whatever display it landed on,
                all of which read as visual changes nobody made. */}
            <Checkbox
              checked={captureArtifacts}
              onCheckedChange={(v) => {
                const next = v === true;
                setCaptureArtifacts(next);
                api.tests.setCaptureArtifacts(id, next).catch(() => {
                  /* best-effort persist; the toggle still applies to this run */
                });
              }}
              disabled={runInfo?.running}
              aria-label="Capture screenshots on this run"
            />
            Capture screenshots
            {overheadQuery.data && overheadQuery.data.capturedRuns > 0 ? (
              <Text variant="small" color="tertiary">
                (adds ~{fmtCaptureMs(overheadQuery.data.meanCaptureMs)}
                {overheadQuery.data.captureShareOfRun > 0
                  ? `, ${Math.round(overheadQuery.data.captureShareOfRun * 100)}%`
                  : ""}
                )
              </Text>
            ) : null}
          </label>
          <label className="flex items-center gap-1.5 text-small text-secondary">
            {/* Separate from screenshots on purpose: this writes page console
                output and request URLs to disk. Off by default, and the model
                can only ASK for the result — it is never attached automatically. */}
            <Checkbox
              checked={recordLogs}
              onCheckedChange={(v) => {
                const next = v === true;
                setRecordLogs(next);
                api.tests.setRecordLogs(id, next).catch(() => {
                  /* best-effort persist; the toggle still applies to this run */
                });
              }}
              disabled={runInfo?.running}
              aria-label="Record console and network on this run"
            />
            Record console &amp; network
          </label>
          <label className="flex cursor-pointer select-none items-center gap-1.5 pr-1 text-small text-secondary">
            <Checkbox
              checked={a11yChecks}
              onCheckedChange={(v) => {
                const next = v === true;
                setA11yChecks(next);
                api.tests.setA11yChecks(id, next).catch(() => {
                  /* best-effort persist; the toggle still applies to this run */
                });
              }}
              disabled={runInfo?.running}
              aria-label="Check accessibility on this run"
            />
            Check accessibility
          </label>
          {runInfo?.running ? (
            <Button variant="destructive" onClick={() => stopRun(id)}>
              Stop
            </Button>
          ) : (
            <Button variant="accent" onClick={() => run(id, captureArtifacts, runHeadless, runBrowser)}>
              Run test
            </Button>
          )}
        </ToolbarActions>
      </Toolbar>

      {test.stepsDiverged ? (
        <div className="px-4 pt-2">
          <Callout color="yellow" icon={<TriangleAlert className="size-4" />}>
            <Callout.Text>{divergedMessage(test)}</Callout.Text>
          </Callout>
        </div>
      ) : null}

      {/* Imported tests (sourceDir set) are script-only; the verbatim file is
          the source of truth. Tests created in the app show Steps AND Script. */}
      {editingSteps ? (
        <EditStepsView
          steps={test.steps}
          scriptEdited={Boolean(test.scriptEdited)}
          imported={Boolean(test.sourceDir)}
          onCancel={() => setEditingSteps(false)}
          onSave={async (steps) => {
            // A script that isn't generated from steps can't be updated behind
            // the user's back, and it can't be silently left behind either —
            // ask, with both outcomes spelled out. Everything else saves and
            // regenerates as it always did.
            if (test.scriptEdited) {
              setPendingSteps(steps);
              return;
            }
            await commitSteps(steps, false);
          }}
        />
      ) : (() => {
        const imported = Boolean(test.sourceDir);
        const showSteps = !imported && test.steps.length > 0;
        // An apply can delete the last step, which removes the Steps trigger.
        // With an uncontrolled TabsRoot the value stayed "steps" and the user
        // was left staring at an empty pane with no tab selected in the bar.
        const value = tab === "steps" && !showSteps ? "script" : (tab ?? (showSteps ? "steps" : "script"));
        return (
          <TabsRoot value={value} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <div className="px-4 pt-2">
              <Tabs variant="filled" size="large">
                {showSteps ? <TabsTrigger value="steps">Steps ({test.steps.length})</TabsTrigger> : null}
                <TabsTrigger value="script">Script</TabsTrigger>
                {/* Imported tests have no generated spec to parameterize — the
                    stored script is their source of truth, so a variable
                    declared here would never reach it. */}
                {imported ? null : (
                  <TabsTrigger value="variables">
                    Variables
                    {(test.variables?.length ?? 0) > 0 ? ` (${test.variables?.length})` : ""}
                  </TabsTrigger>
                )}
                {imported ? null : (
                  <TabsTrigger value="heals">
                    Heals
                    {pendingHeals > 0 ? ` (${pendingHeals})` : ""}
                  </TabsTrigger>
                )}
                {/* Same imported-test exclusion as the two above, and for the
                    same reason: the check runs from the capture fixture, which
                    an imported spec never loads. A tab that could only ever be
                    empty is worse than no tab. */}
                {imported ? null : (
                  <TabsTrigger value="a11y">
                    Accessibility
                    {a11yNewSteps > 0 ? ` (${a11yNewSteps})` : ""}
                  </TabsTrigger>
                )}
              </Tabs>
            </div>
            <TabsContent value="steps" className="min-h-0 flex-1">
              <ScrollArea className="h-full">
                <div className="flex flex-col gap-1 p-3">
                  {computeStepDepths(test.steps).map((depth, i) => (
                    <StepRow
                      key={test.steps[i].id}
                      index={i}
                      step={test.steps[i]}
                      indent={depth}
                      runStatus={runInfo?.stepStatus[i]}
                      isNew={newStepIds.has(test.steps[i].id)}
                    />
                  ))}
                </div>
              </ScrollArea>
            </TabsContent>
            <TabsContent value="script" className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-end gap-2 border-b border-separator px-4 py-2">
                {editingScript ? (
                  <>
                    <Button size="small" variant="glass" onClick={() => setEditingScript(false)}>
                      Cancel
                    </Button>
                    <Button size="small" variant="accent" onClick={saveScript}>
                      Save
                    </Button>
                  </>
                ) : (
                  <>
                    {test.scriptEdited ? (
                      <Text variant="small" color="secondary">
                        Edited manually
                      </Text>
                    ) : null}
                    <Button
                      size="small"
                      variant="glass"
                      onClick={() => {
                        setScriptDraft(scriptQuery.data ?? "");
                        setEditingScript(true);
                      }}
                    >
                      Edit script
                    </Button>
                  </>
                )}
              </div>
              {editingScript ? (
                <ScriptEditor value={scriptDraft} onChange={setScriptDraft} />
              ) : (
                <ScriptView code={scriptQuery.data ?? ""} />
              )}
            </TabsContent>
            {imported ? null : (
              <TabsContent value="variables" className="min-h-0 flex-1">
                <VariablesPanel test={test} />
              </TabsContent>
            )}
            {imported ? null : (
              <TabsContent value="heals" className="min-h-0 flex-1">
                <HealsPanel test={test} />
              </TabsContent>
            )}
            {imported ? null : (
              <TabsContent value="a11y" className="min-h-0 flex-1">
                <A11yPanel test={test} />
              </TabsContent>
            )}
          </TabsRoot>
        );
      })()}

      {/* The dialog itself is rendered by AiDebugHost above the router, so a
          minimized session outlives this view. */}
      {runInfo ? <RunOutput info={runInfo} onDebug={openAiDebug} aiStatus={aiStatus} /> : null}

      {/* Asked at SAVE, not when Edit Steps is opened: this is a question about
          what to do with the edits, and it can only be answered once they
          exist. Cancelling returns to the editor with the draft intact. */}
      {pendingSteps ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingSteps(null);
          }}
          title={
            test.sourceDir ? "Save steps without changing the script?" : "Apply these steps to the script?"
          }
          description={
            test.sourceDir
              ? "This test runs the file it was imported with, and that file is never regenerated — a generated spec would lose the imports and anything else the step list can't express. The edited steps are saved as this test's step list, and the test is flagged as out of sync with its script."
              : "This test's script was edited directly, so it isn't generated from these steps. Regenerating rebuilds it from the step list and discards anything the steps can't express. Saving without regenerating leaves the script — and every run — exactly as it is, and flags the test as out of sync."
          }
          confirmLabel={test.sourceDir ? "Save steps" : "Regenerate script"}
          confirmVariant="accent"
          onConfirm={() => commitSteps(pendingSteps, !test.sourceDir)}
          secondaryAction={
            test.sourceDir
              ? undefined
              : { label: "Save steps only", onClick: () => commitSteps(pendingSteps, false) }
          }
        />
      ) : null}

      <Dialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="Rename test"
        confirmLabel="Save"
        confirmDisabled={renameValue.trim().length === 0}
        onConfirm={() => saveName(renameValue)}
      >
        <Field label="Name" orientation="vertical">
          <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus />
        </Field>
      </Dialog>
    </div>
  );
}
