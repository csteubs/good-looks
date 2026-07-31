// AI "generate steps" for the trainer — mabl's Test Creation Agent. The user
// describes a flow; the local LLM returns the recorder's structured Step[] which
// is inserted into the live, editable step list for refinement (reorder / edit /
// replay) before the spec is generated. Unlike GenerateTestDialog (which emits a
// whole spec), this produces editable steps.

import * as React from "react";
import {
  Button,
  Dialog,
  Field,
  ScrollArea,
  Status,
  Text,
  Textarea,
  toast,
} from "@glaze/core/components";
import { Square, Wand2 } from "lucide-react";

import { buildGenerateStepsMessages } from "../lib/llm-prompts";
import { extractStepsJson } from "../lib/parse-llm-response";
import type { RawStep } from "../lib/recorder-types";
import { useLlmChat } from "../lib/use-llm-chat";

function friendlyError(message: string): string {
  if (/no model selected/i.test(message)) {
    return `${message} Open Settings (⌘,) → AI provider to pick one.`;
  }
  if (/could not reach|abort|timeout|econnrefused|fetch failed|network/i.test(message)) {
    return `${message} Open Settings (⌘,) → AI provider to check the connection.`;
  }
  return message;
}

export function GenerateStepsDialog({
  open,
  url,
  onOpenChange,
  onInsert,
}: {
  open: boolean;
  url: string | null;
  onOpenChange: (open: boolean) => void;
  onInsert: (steps: RawStep[]) => void;
}) {
  const { content, status, error, start, stop } = useLlmChat();
  const [prompt, setPrompt] = React.useState("");
  const [added, setAdded] = React.useState(false);

  React.useEffect(() => {
    if (open) setAdded(false);
  }, [open]);

  const generate = React.useCallback(() => {
    if (!prompt.trim()) return;
    setAdded(false);
    void start(
      buildGenerateStepsMessages({ prompt: prompt.trim(), url: url ?? "" }),
    );
  }, [prompt, url, start]);

  const steps = status === "done" ? extractStepsJson(content) : null;

  const addSteps = () => {
    if (!steps || steps.length === 0) return;
    onInsert(steps);
    setAdded(true);
    toast.success(steps.length === 1 ? "Added 1 step." : `Added ${steps.length} steps.`);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Generate steps with AI"
      description="Describe the flow. The local LLM proposes trainer steps you can reorder, edit, and replay before generating the spec."
      size="large"
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-md border border-separator bg-control-subtle p-3">
          <Text variant="small" color="secondary">
            <strong className="font-medium text-primary">Tip:</strong> describe the flow step by step and
            name elements by their visible label or role (e.g. “click the ‘Sign in’ button”). Steps are added at
            the trainer’s insert cursor.
          </Text>
        </div>

        <Field label="Describe the test flow" orientation="vertical">
          <Textarea
            size="medium"
            autoFocus
            placeholder={"e.g. Fill the email field with “test@example.com”, fill the password, click “Sign in”, then check that the “Welcome” heading is visible."}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>

        <div className="flex items-center gap-2">
          {status === "streaming" ? <Status variant="loading">Generating</Status> : null}
          {status === "error" ? <Status variant="error">Error</Status> : null}
          {status === "done" ? (
            <Status variant={steps ? "success" : "warning"}>
              {steps ? `${steps.length} steps` : "No steps parsed"}
            </Status>
          ) : null}
          <div className="flex-1" />
          {status === "streaming" ? (
            <Button size="small" variant="muted" onClick={stop}>
              <Square className="size-3.5" /> Stop
            </Button>
          ) : (
            <Button size="small" variant="accent" onClick={generate} disabled={!prompt.trim()}>
              <Wand2 className="size-3.5" /> {content ? "Regenerate" : "Generate"}
            </Button>
          )}
          {steps && steps.length > 0 ? (
            <Button size="small" variant="accent" onClick={addSteps} disabled={added}>
              {added ? "Added" : `Add ${steps.length} steps`}
            </Button>
          ) : null}
        </div>

        {status !== "idle" || content ? (
          <ScrollArea
            className="max-h-[36vh] min-h-0 rounded-md border border-separator"
            autoScrollToBottom
            autoScrollDeps={[content.length]}
          >
            <div className="flex flex-col gap-1 p-3">
              {status === "error" && error ? (
                <pre className="text-small whitespace-pre-wrap break-words text-primary">
                  {friendlyError(error)}
                </pre>
              ) : steps ? (
                steps.map((s, i) => (
                  <Text key={i} variant="small-mono" className="truncate">
                    {i + 1}. {s.type}
                    {s.locator ? ` · ${s.locator.k}:${s.locator.v ?? s.locator.role ?? ""}` : ""}
                    {s.value ? ` = ${s.value}` : ""}
                    {s.assert ? ` (${s.assert})` : ""}
                  </Text>
                ))
              ) : (
                <pre className="text-small-mono whitespace-pre-wrap break-words text-secondary">
                  {content || (status === "streaming" ? "Generating…" : "")}
                </pre>
              )}
            </div>
          </ScrollArea>
        ) : null}
      </div>
    </Dialog>
  );
}
