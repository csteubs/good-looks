import * as React from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Button,
  Dialog,
  Field,
  Input,
  ScrollArea,
  Tabs,
  TabsContent,
  TabsRoot,
  TabsTrigger,
  Toolbar,
  ToolbarActions,
  ToolbarContent,
  ToolbarDescription,
  ToolbarTitle,
} from "@glaze/core/components";
import { Pencil, Trash2 } from "lucide-react";

import { api } from "../lib/api";
import { useRecorder } from "./recorder-store";
import { RunOutput } from "./run-output";
import { StepRow } from "./step-row";

export function TestDetailView() {
  const { id } = useParams({ from: "/test/$id" });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { runs, run, stopRun } = useRecorder();
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState("");

  const testQuery = useQuery({ queryKey: ["test", id], queryFn: () => api.tests.get(id) });
  const scriptQuery = useQuery({ queryKey: ["script", id], queryFn: () => api.tests.getScript(id) });
  const test = testQuery.data;
  const runInfo = runs[id];

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

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <ToolbarContent>
          <ToolbarTitle>{test.name}</ToolbarTitle>
          <ToolbarDescription>{test.url}</ToolbarDescription>
        </ToolbarContent>
        <ToolbarActions>
          <Button
            iconOnly
            variant="glass"
            size="large"
            aria-label="Rename test"
            onClick={() => {
              setRenameValue(test.name);
              setRenameOpen(true);
            }}
          >
            <Pencil className="size-5" />
          </Button>
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
          {runInfo?.running ? (
            <Button variant="destructive" onClick={() => stopRun(id)}>
              Stop
            </Button>
          ) : (
            <Button variant="accent" onClick={() => run(id)}>
              Run test
            </Button>
          )}
        </ToolbarActions>
      </Toolbar>

      <TabsRoot defaultValue="steps" className="flex min-h-0 flex-1 flex-col">
        <div className="px-4 pt-2">
          <Tabs variant="filled" size="large">
            <TabsTrigger value="steps">Steps ({test.steps.length})</TabsTrigger>
            <TabsTrigger value="script">Script</TabsTrigger>
          </Tabs>
        </div>
        <TabsContent value="steps" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-1 p-3">
              {test.steps.map((s, i) => (
                <StepRow key={s.id} index={i} step={s} />
              ))}
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="script" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <pre className="text-small-mono whitespace-pre-wrap break-words p-4 text-primary">
              {scriptQuery.data ?? ""}
            </pre>
          </ScrollArea>
        </TabsContent>
      </TabsRoot>

      {runInfo ? <RunOutput info={runInfo} /> : null}

      <Dialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="Rename test"
        confirmLabel="Save"
        confirmDisabled={renameValue.trim().length === 0}
        onConfirm={async () => {
          await api.tests.rename(id, renameValue.trim());
          qc.invalidateQueries({ queryKey: ["tests"] });
          qc.invalidateQueries({ queryKey: ["test", id] });
          qc.invalidateQueries({ queryKey: ["script", id] });
        }}
      >
        <Field label="Name" orientation="vertical">
          <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus />
        </Field>
      </Dialog>
    </div>
  );
}
