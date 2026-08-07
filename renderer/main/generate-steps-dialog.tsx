// AI "generate steps" for the trainer — mabl's Test Creation Agent. The user
// describes a flow; the local LLM returns the recorder's structured Step[] which
// is inserted into the live, editable step list for refinement (reorder / edit /
// replay) before the spec is generated. Unlike GenerateTestDialog (which emits a
// whole spec), this produces editable steps.
//
// Optionally, the user can pick a selector with the same "Refine Selector" picker
// used on step rows: clicking the crosshair enters pick mode in the training
// browser, the chosen element's candidate locators are reviewed here, and the
// selected locator is passed to the LLM as context so it can target the exact
// element the user pointed at.

import * as React from "react";
import {
  Badge,
  Button,
  Dialog,
  Field,
  ScrollArea,
  Status,
  Text,
  Textarea,
  toast,
} from "@ui";
import { Crosshair, Square, Wand2, X } from "lucide-react";

import { api } from "../lib/api";
import { friendlyError } from "../lib/llm-errors";
import { buildGenerateStepsMessages } from "../lib/llm-prompts";
import { extractStepsJson } from "../lib/parse-llm-response";
import type { Locator, PickedElement, RawStep } from "../lib/recorder-types";
import { useLlmChat } from "../lib/use-llm-chat";
import { formatLocator, KIND_LABEL } from "./refine-selector-dialog";
import { useRecorder } from "./recorder-store";

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
  const { content, status, error, errorKind, start, stop } = useLlmChat();
  const [prompt, setPrompt] = React.useState("");
  const [added, setAdded] = React.useState(false);
  // Optional selector the user picked to give the LLM as context. Null means
  // "no selector provided" — generation proceeds without one.
  const [selector, setSelector] = React.useState<Locator | null>(null);
  // While the user is reviewing a freshly-picked element's candidates, we hold
  // the PickedElement here before promoting the chosen candidate to `selector`.
  const [reviewing, setReviewing] = React.useState<PickedElement | null>(null);
  const [candidateIdx, setCandidateIdx] = React.useState(0);
  // Configured default model name, shown in the "Thinking with {model}…"
  // placeholder while the LLM is generating.
  const [modelName, setModelName] = React.useState<string | null>(null);

  const recorder = useRecorder();

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.llm
      .getConfig()
      .then((cfg) => {
        if (!cancelled) setModelName(cfg.model);
      })
      .catch(() => {
        if (!cancelled) setModelName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  // True when THIS dialog triggered pick mode (so we don't clobber a step-refine
  // session). Distinguishes our pick from a step-row Refine Selector pick.
  const [pickingForAi, setPickingForAi] = React.useState(false);

  React.useEffect(() => {
    if (open) setAdded(false);
  }, [open]);

  // When a pick arrives and we're the one who asked for it, take over the
  // review instead of letting the step-refine dialog handle it.
  React.useEffect(() => {
    if (pickingForAi && recorder.picked) {
      setReviewing(recorder.picked);
      setCandidateIdx(0);
      setPickingForAi(false);
      // Acknowledge the pick so the step-refine dialog (gated on refiningStepId)
      // never sees it; we keep refine mode on only while reviewing.
      recorder.clearPicked();
    }
  }, [pickingForAi, recorder.picked, recorder]);

  // Cancel any in-flight pick if the dialog closes.
  React.useEffect(() => {
    if (!open && pickingForAi) {
      setPickingForAi(false);
      recorder.endRefine();
    }
    if (!open && reviewing) {
      setReviewing(null);
      recorder.endRefine();
    }
  }, [open, pickingForAi, reviewing, recorder]);

  const beginPick = () => {
    setPickingForAi(true);
    recorder.startRefine(null);
  };

  const cancelPick = () => {
    setPickingForAi(false);
    setReviewing(null);
    recorder.endRefine();
  };

  const confirmSelector = () => {
    const c = reviewing?.candidates?.[candidateIdx];
    if (c) setSelector(c);
    setReviewing(null);
    recorder.endRefine();
  };

  const generate = React.useCallback(() => {
    if (!prompt.trim()) return;
    setAdded(false);
    // Poll the live configured model right before sending so the "Thinking
    // with {model}…" placeholder matches the model the backend actually uses,
    // even if the default changed after this dialog opened.
    void api.llm
      .getConfig()
      .then((cfg) => {
        setModelName(cfg.model);
        return cfg.model ?? undefined;
      })
      .catch(() => modelName ?? undefined)
      .then((model) =>
        start(
          buildGenerateStepsMessages({
            prompt: prompt.trim(),
            url: url ?? "",
            selector: selector ?? undefined,
          }),
          { model },
        ),
      );
  }, [prompt, url, selector, start, modelName]);

  const steps = status === "done" ? extractStepsJson(content) : null;
  // Step 1 ("Navigate to URL") is a test-level setting the user controls in the
  // Step 1 URL editor — the AI must only add the steps that come AFTER it. Drop
  // any goto the model emits despite the prompt telling it not to.
  const flowSteps = steps ? steps.filter((s) => s.type !== "goto") : null;

  const addSteps = () => {
    if (!flowSteps || flowSteps.length === 0) return;
    onInsert(flowSteps);
    setAdded(true);
    toast.success(
      flowSteps.length === 1 ? "Added 1 step." : `Added ${flowSteps.length} steps.`,
    );
    onOpenChange(false);
  };

  const candidates = reviewing?.candidates ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Generate steps with AI"
      description="Describe the flow after the starting URL. The local LLM proposes trainer steps (the test already navigates to its URL as Step 1) you can reorder, edit, and replay before generating the spec."
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

        {/* Optional: pick a selector to give the LLM exact context. */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Text variant="small" color="secondary">
              Target element (optional)
            </Text>
            <div className="flex-1" />
            {selector ? (
              <div className="flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/5 px-2 py-1">
                <Badge color="blue" className="shrink-0">
                  {KIND_LABEL[selector.k]}
                </Badge>
                <code className="min-w-0 truncate font-mono text-xs text-primary">
                  {formatLocator(selector)}
                </code>
                <button
                  type="button"
                  onClick={() => setSelector(null)}
                  className="ml-0.5 shrink-0 rounded p-0.5 text-tertiary hover:bg-background-secondary hover:text-primary"
                  aria-label="Remove selector"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ) : pickingForAi ? (
              <Button size="small" variant="muted" onClick={cancelPick}>
                <X className="size-3.5" /> Cancel pick
              </Button>
            ) : reviewing ? null : (
              <Button size="small" variant="transparent" onClick={beginPick}>
                <Crosshair className="size-3.5" /> Refine selector
              </Button>
            )}
          </div>

          {pickingForAi ? (
            <div className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent/5 px-3 py-2">
              <Crosshair className="size-4 shrink-0 text-accent" />
              <Text variant="small" color="blue" className="min-w-0">
                Hover a component in the browser and click it to capture its selector. The page won’t respond
                to clicks.
              </Text>
            </div>
          ) : null}

          {reviewing ? (
            <div className="flex flex-col gap-2 rounded-md border border-separator p-3">
              <div className="flex items-center gap-2">
                <Text variant="small" color="secondary">
                  Picked element
                </Text>
                <code className="min-w-0 flex-1 truncate rounded bg-background-secondary px-2 py-0.5 font-mono text-xs text-primary">
                  {reviewing.description || reviewing.tag || "element"}
                </code>
              </div>
              {candidates.length === 0 ? (
                <Text variant="small" color="tertiary">
                  No locator could be derived for this element.
                </Text>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {candidates.map((l, i) => {
                    const active = i === candidateIdx;
                    return (
                      <button
                        key={`${l.k}-${i}`}
                        type="button"
                        onClick={() => setCandidateIdx(i)}
                        className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${
                          active
                            ? "border-accent bg-accent/10"
                            : "border-separator hover:bg-background-secondary"
                        }`}
                      >
                        <span
                          className={`size-3.5 shrink-0 rounded-full border ${
                            active ? "border-accent bg-accent" : "border-separator"
                          }`}
                        />
                        <Badge color={active ? "blue" : "secondary"} className="shrink-0">
                          {KIND_LABEL[l.k]}
                        </Badge>
                        <code className="min-w-0 flex-1 truncate font-mono text-xs text-primary">
                          {formatLocator(l)}
                        </code>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                <Button size="small" variant="transparent" onClick={cancelPick}>
                  Cancel
                </Button>
                <Button
                  size="small"
                  variant="accent"
                  onClick={confirmSelector}
                  disabled={candidates.length === 0}
                >
                  Use this selector
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          {status === "streaming" ? (
            <Status variant="loading">{modelName ? `Thinking with ${modelName}` : "Thinking"}</Status>
          ) : null}
          {status === "error" ? <Status variant="error">Error</Status> : null}
          {status === "done" ? (
            <Status variant={flowSteps ? "success" : "warning"}>
              {flowSteps ? `${flowSteps.length} steps` : "No steps parsed"}
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
          {flowSteps && flowSteps.length > 0 ? (
            <Button size="small" variant="accent" onClick={addSteps} disabled={added}>
              {added ? "Added" : `Add ${flowSteps.length} steps`}
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
                  {friendlyError(error, errorKind)}
                </pre>
              ) : flowSteps ? (
                flowSteps.map((s, i) => (
                  <Text key={i} variant="small-mono" className="truncate">
                    {i + 1}. {s.type}
                    {s.locator ? ` · ${s.locator.k}:${s.locator.v ?? s.locator.role ?? ""}` : ""}
                    {s.value ? ` = ${s.value}` : ""}
                    {s.assert ? ` (${s.assert})` : ""}
                  </Text>
                ))
              ) : (
                <pre className="text-small-mono whitespace-pre-wrap break-words text-secondary">
                  {content || (status === "streaming" ? (modelName ? `Thinking with ${modelName}…` : "Thinking…") : "")}
                </pre>
              )}
            </div>
          </ScrollArea>
        ) : null}
      </div>
    </Dialog>
  );
}
