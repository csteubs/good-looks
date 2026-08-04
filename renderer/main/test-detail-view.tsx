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
import { AiDebugDialog } from "./ai-debug-panel";
import { EditStepsView } from "./edit-steps-view";
import { RunOutput } from "./run-output";
import { ScriptEditor, ScriptView } from "./script-view";
import { StepRow } from "./step-row";
import { computeStepDepths } from "../lib/describe-step";

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
  const [aiDebugOpen, setAiDebugOpen] = React.useState(false);
  const [editingSteps, setEditingSteps] = React.useState(false);
  const [trainerConfirmOpen, setTrainerConfirmOpen] = React.useState(false);
  // Per-test visual-testing gate — remembers the user's "Capture screenshots"
  // choice between sessions. Falls back to the global Settings default when the
  // test has no saved preference yet.
  const [captureArtifacts, setCaptureArtifacts] = React.useState(false);
  const [captureInited, setCaptureInited] = React.useState(false);
  // Per-test "Run headless" choice — remembers whether this test's runs open a
  // visible browser. Falls back to the global Settings default. Runs only; the
  // trainer/"Edit in Trainer" flow is always headed.
  const [runHeadless, setRunHeadless] = React.useState(false);
  const [headlessInited, setHeadlessInited] = React.useState(false);

  const testQuery = useQuery({ queryKey: ["test", id], queryFn: () => api.tests.get(id) });
  const scriptQuery = useQuery({ queryKey: ["script", id], queryFn: () => api.tests.getScript(id) });
  const settingsQuery = useQuery({
    queryKey: ["recorder-settings"],
    queryFn: () => api.recorder.getSettings(),
  });
  const test = testQuery.data;
  const runInfo = runs[id];

  // Initialize the toggle from the test record (or the global default) once.
  React.useEffect(() => {
    if (captureInited || !test) return;
    const fallback = settingsQuery.data?.defaultCaptureArtifacts ?? false;
    setCaptureArtifacts(test.captureArtifacts ?? fallback);
    setCaptureInited(true);
  }, [captureInited, test, settingsQuery.data]);
  // Initialize the headless toggle from the test record (or the global default) once.
  React.useEffect(() => {
    if (headlessInited || !test) return;
    const fallback = settingsQuery.data?.defaultRunHeadless ?? false;
    setRunHeadless(test.runHeadless ?? fallback);
    setHeadlessInited(true);
  }, [headlessInited, test, settingsQuery.data]);
  // Earliest step the run reported as failed, if any — lets the AI debug
  // prompt skip steps after it, since Playwright never ran them.
  const failedStepIndex = React.useMemo(() => {
    if (!runInfo) return undefined;
    const failed = Object.entries(runInfo.stepStatus)
      .filter(([, status]) => status === "failed")
      .map(([index]) => Number(index));
    return failed.length > 0 ? Math.min(...failed) : undefined;
  }, [runInfo]);

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
            <Checkbox
              checked={runHeadless ? false : captureArtifacts}
              onCheckedChange={(v) => {
                if (runHeadless) return; // disabled when headless — ignore stray toggles
                const next = v === true;
                setCaptureArtifacts(next);
                api.tests.setCaptureArtifacts(id, next).catch(() => {
                  /* best-effort persist; the toggle still applies to this run */
                });
              }}
              disabled={runInfo?.running || runHeadless}
              aria-label="Capture screenshots on this run"
            />
            Capture screenshots
          </label>
          {runInfo?.running ? (
            <Button variant="destructive" onClick={() => stopRun(id)}>
              Stop
            </Button>
          ) : (
            <Button variant="accent" onClick={() => run(id, captureArtifacts, runHeadless)}>
              Run test
            </Button>
          )}
        </ToolbarActions>
      </Toolbar>

      {test.stepsDiverged ? (
        <div className="px-4 pt-2">
          <Callout color="yellow" icon={<TriangleAlert className="size-4" />}>
            <Callout.Text>
              Steps may not reflect the script — some statements from the last edit couldn&apos;t be
              parsed back into steps.
            </Callout.Text>
          </Callout>
        </div>
      ) : null}

      {/* Imported tests (sourceDir set) are script-only; the verbatim file is
          the source of truth. Tests created in the app show Steps AND Script. */}
      {editingSteps ? (
        <EditStepsView
          steps={test.steps}
          onCancel={() => setEditingSteps(false)}
          onSave={async (steps) => {
            await api.tests.updateSteps(id, steps);
            qc.invalidateQueries({ queryKey: ["test", id] });
            qc.invalidateQueries({ queryKey: ["script", id] });
            qc.invalidateQueries({ queryKey: ["tests"] });
            setEditingSteps(false);
          }}
        />
      ) : (() => {
        const imported = Boolean(test.sourceDir);
        const showSteps = !imported && test.steps.length > 0;
        const defaultValue = showSteps ? "steps" : "script";
        return (
          <TabsRoot defaultValue={defaultValue} className="flex min-h-0 flex-1 flex-col">
            <div className="px-4 pt-2">
              <Tabs variant="filled" size="large">
                {showSteps ? <TabsTrigger value="steps">Steps ({test.steps.length})</TabsTrigger> : null}
                <TabsTrigger value="script">Script</TabsTrigger>
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
          </TabsRoot>
        );
      })()}

      {runInfo ? <RunOutput info={runInfo} onDebug={() => setAiDebugOpen(true)} /> : null}

      <AiDebugDialog
        open={aiDebugOpen}
        onOpenChange={setAiDebugOpen}
        testName={test.name}
        testUrl={test.url}
        script={scriptQuery.data ?? ""}
        output={runInfo?.lines.join("") ?? ""}
        imported={Boolean(test.sourceDir)}
        speed={test.speed}
        failedStepIndex={failedStepIndex}
        onApplyScript={async (source) => {
          await api.tests.updateScript(id, source);
          qc.invalidateQueries({ queryKey: ["script", id] });
          qc.invalidateQueries({ queryKey: ["test", id] });
        }}
      />

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
