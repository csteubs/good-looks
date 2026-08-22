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
import type {
  Locator,
  PickedElement,
  RawStep,
  VerifiedStepResult,
  VerifiedStepsResult,
} from "../lib/recorder-types";
import { useLlmChat } from "../lib/use-llm-chat";
import { formatLocator, KIND_LABEL } from "./refine-selector-dialog";
import { useRecorder } from "./recorder-store";

/** The activity log's one-word verdicts, exported so a test can assert the
 *  copy. `unchecked` is deliberately not "passed": the replayer declined to
 *  run that step, and calling it verified is the claim this feature exists to
 *  stop making. */
export const ACTIVITY_LABEL: Record<VerifiedStepResult["status"], string> = {
  ran: "ran",
  unchecked: "unchecked",
  failed: "failed",
};

export function GenerateStepsDialog({
  open,
  url,
  onOpenChange,
  onVerify,
}: {
  open: boolean;
  url: string | null;
  onOpenChange: (open: boolean) => void;
  /** Run the proposed steps against the live page and insert what works —
   *  `recorder-store`'s `verifyGeneratedSteps`, which also marks what landed
   *  as new. A prop rather than an `api` call so the dialog can be tested
   *  against a stated outcome. */
  onVerify: (steps: RawStep[], label: string) => Promise<VerifiedStepsResult>;
}) {
  const { content, status, error, errorKind, start, stop } = useLlmChat();
  const [prompt, setPrompt] = React.useState("");
  const [added, setAdded] = React.useState(false);
  // True once the proposed steps have been tried, whatever happened. A second
  // "Try" of the same list after a failure would run — and insert — the prefix
  // that already worked a second time, so the button stays down until the
  // user regenerates.
  const [attempted, setAttempted] = React.useState(false);
  // What actually happened when the proposed steps were run, in order. Null
  // until the user asks for them; this is mabl's agent-activity view, and it is
  // what makes a bad generation diagnosable rather than merely disappointing.
  const [activity, setActivity] = React.useState<VerifiedStepResult[] | null>(null);
  const [verifying, setVerifying] = React.useState(false);
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
    if (open) {
      setAdded(false);
      setAttempted(false);
      setActivity(null);
      setVerifying(false);
    }
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
    setAttempted(false);
    setActivity(null);
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

  /**
   * Run the proposed steps against the live page, keeping the ones that work.
   *
   * The dialog used to insert all of them unverified, which is the same shape
   * as pasting a guess into the step list: the model names an element that may
   * not exist, and the user finds out on the next run, several steps away from
   * the cause. Each step now runs where it lands — against the page the
   * previous one left behind, not the page the model imagined — and the first
   * one that does not work stops the rest.
   *
   * The dialog STAYS OPEN on a failure. Its whole value at that moment is the
   * activity log saying which step broke and why, and closing over it would put
   * the user back where they started with a half-filled list.
   */
  const addSteps = async () => {
    if (!flowSteps || flowSteps.length === 0 || verifying || attempted) return;
    setVerifying(true);
    setActivity(null);
    try {
      const outcome = await onVerify(flowSteps, prompt.trim());
      setAttempted(true);
      setActivity(outcome.results);
      if (outcome.error) {
        toast.error(outcome.error);
        return;
      }
      const failed = outcome.results.find((r) => r.status === "failed");
      if (failed) {
        toast.error(
          outcome.inserted === 0
            ? `Nothing was added — the first step did not work: ${failed.label}`
            : `Added ${outcome.inserted} step${outcome.inserted === 1 ? "" : "s"}, then stopped at: ${failed.label}`,
        );
        return;
      }
      setAdded(true);
      toast.success(
        outcome.inserted === 1 ? "Added 1 step." : `Added ${outcome.inserted} steps.`,
      );
      onOpenChange(false);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setVerifying(false);
    }
  };

  const candidates = reviewing?.candidates ?? [];

  // The steps after a failure were never attempted: the page they were
  // written against never happened. Said explicitly, because a log that just
  // stops reads as a log that was cut off.
  const failedAt = activity?.findIndex((r) => r.status === "failed") ?? -1;
  const notAttempted =
    activity && flowSteps && failedAt >= 0 ? Math.max(0, flowSteps.length - activity.length) : 0;
  const kept = activity ? activity.filter((r) => r.status !== "failed").length : 0;

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
            <Button
              size="small"
              variant="accent"
              onClick={addSteps}
              disabled={added || verifying || attempted}
            >
              {added
                ? "Added"
                : verifying
                  ? "Trying them…"
                  : attempted
                    ? "Tried"
                    : `Try ${flowSteps.length} step${flowSteps.length === 1 ? "" : "s"}`}
            </Button>
          ) : null}
        </div>

        {/* The activity log — mabl's agent activity view. One row per step
            that was attempted, in order, each with what happened to it; this
            is what makes a bad generation diagnosable rather than merely
            disappointing, and it is the whole reason the dialog stays open
            after a failure. */}
        {activity ? (
          <div
            className="flex flex-col gap-1.5 rounded-md border border-separator p-3"
            data-testid="ai-activity"
            aria-label="What happened to the proposed steps"
          >
            <Text variant="small" color="secondary">
              What happened
            </Text>
            {activity.map((r, i) => (
              <div key={i} className="flex items-start gap-2" data-status={r.status}>
                <Badge
                  color={r.status === "ran" ? "green" : r.status === "failed" ? "red" : "secondary"}
                  className="shrink-0"
                >
                  {ACTIVITY_LABEL[r.status]}
                </Badge>
                <div className="flex min-w-0 flex-col">
                  <Text variant="small-mono" className="truncate">
                    {r.label}
                  </Text>
                  {r.detail ? (
                    <Text variant="small" color="tertiary" className="break-words">
                      {r.detail}
                    </Text>
                  ) : null}
                </div>
              </div>
            ))}
            {failedAt >= 0 ? (
              <Text variant="small" color="secondary">
                {kept > 0
                  ? `The ${kept} step${kept === 1 ? "" : "s"} that worked ${kept === 1 ? "was" : "were"} kept, grouped under your prompt. `
                  : "Nothing was added. "}
                {notAttempted > 0
                  ? `${notAttempted} step${notAttempted === 1 ? " was" : "s were"} not attempted — the page ${notAttempted === 1 ? "it was" : "they were"} written for never happened. `
                  : ""}
                Fix the page or the prompt and regenerate.
              </Text>
            ) : null}
          </div>
        ) : null}

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
