// Generate a new Playwright test from a natural-language prompt via the local
// LLM. Opens from the sidebar + menu ("Generate from prompt"). Lets the user
// pre-select common options (model, speed, viewport, starting URL), streams the
// model's response with the same formatted rendering as the AI debug panel,
// and — when the model returns a complete, applyable spec — offers a one-click
// "Create test" that persists it as a new test via tests:createFromPrompt.
//
// The model picker is per-generation, not a settings edit: writing a test is
// where model choice matters most (a bigger model for one gnarly flow), and
// making that switch rewrite the app-wide default would silently retarget the
// AI debug panel and step generation too. It also shows which models the
// provider currently holds in memory, because on LM Studio picking a cold model
// stalls with no output for as long as the load takes — indistinguishable, from
// the dialog, from a model that has hung.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Dialog,
  Field,
  Input,
  ScrollArea,
  SegmentedControl,
  SegmentedControlItem,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Status,
  Text,
  Textarea,
  toast,
} from "@glaze/core/components";
import { Check, Copy, Square, Wand2 } from "lucide-react";

import { api } from "../lib/api";
import { friendlyError } from "../lib/llm-errors";
import type { LlmModel } from "../lib/llm-types";
import { buildGenerateMessages } from "../lib/llm-prompts";
import { extractCorrectedScript, parseResponse } from "../lib/parse-llm-response";
import type { TestSpeed } from "../lib/recorder-types";
import { TEST_SPEEDS, TEST_SPEED_LABELS } from "../lib/recorder-types";
import { useLlmChat } from "../lib/use-llm-chat";
// Shared with the New Recording dialog's window-size picker — both dialogs ask
// the user the same question, so they offer the same sizes. "Default" leaves it
// unset (the runner uses its own default; the prompt just won't mention a size).
import { VIEWPORT_PRESETS, viewportForPresetId } from "../lib/viewport-presets";

// Fastest first here, unlike everywhere else: this dialog's default is "fast",
// and a segmented control reads better with its default at the leading edge.
// Reversed from the shared list rather than re-declared, so a new speed can't
// appear in three pickers and miss this one.
const SPEEDS: TestSpeed[] = [...TEST_SPEEDS].reverse();

// How the model list is split in the picker when the provider reports which
// models it currently holds in memory (LM Studio does; Ollama and Claude
// don't). All three buckets are kept apart on purpose: "not loaded" is a
// downloaded model that costs a load on first use, while "unknown" means the
// provider never said — folding the second into the first would print a
// confident wrong answer, and the whole point of this list is to tell the user
// which choice is instant and which one stalls.
const MODEL_GROUPS = [
  {
    id: "loaded",
    label: "Loaded",
    icon: "bolt.fill",
    sublabel: "In memory — starts answering right away",
    has: (m: LlmModel) => m.loaded === true,
  },
  {
    id: "not-loaded",
    label: "Not loaded",
    icon: "arrow.down.circle",
    sublabel: "Downloaded — loads into memory on first use",
    has: (m: LlmModel) => m.loaded === false,
  },
  {
    id: "unknown",
    label: "Load state unknown",
    icon: undefined,
    sublabel: undefined,
    has: (m: LlmModel) => m.loaded === undefined,
  },
] as const;

// Reuse the AI debug panel's code-block rendering: fenced code in a bordered
// card with a language label and per-block copy.
function CodeBlock({ lang, content }: { lang: string; content: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    await window.glazeAPI.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="my-1 overflow-hidden rounded-md border border-separator">
      <div className="flex items-center justify-between border-b border-separator bg-control-subtle px-3 py-1">
        <span className="text-small text-secondary">{lang || "code"}</span>
        <Button iconOnly size="small" variant="transparent" onClick={copy} aria-label="Copy code" title="Copy code">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
      <pre className="text-small-mono overflow-x-auto whitespace-pre-wrap break-words p-3 text-primary">{content}</pre>
    </div>
  );
}

export function GenerateTestDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { content, status, error, errorKind, start, stop } = useLlmChat();

  const [prompt, setPrompt] = React.useState("");
  const [name, setName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [speed, setSpeed] = React.useState<TestSpeed>("fast");
  const [viewportId, setViewportId] = React.useState<string>("default");
  const [created, setCreated] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  // The model this generation runs on. Starts from the configured default and
  // is overridable per generation — the picker is a choice for THIS test, not
  // an edit of the app-wide setting, so switching to a bigger model for one
  // hard prompt doesn't silently retarget every other AI feature.
  const [model, setModel] = React.useState<string | null>(null);
  const [models, setModels] = React.useState<LlmModel[]>([]);
  const [loadingModels, setLoadingModels] = React.useState(false);
  // Why the list is empty, straight from the provider probe. Without it an
  // unreachable provider and a provider with no models look identical: an empty
  // picker that gives the user nothing to act on.
  const [modelsError, setModelsError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingModels(true);
    void (async () => {
      try {
        const cfg = await api.llm.getConfig();
        if (cancelled) return;
        setModel(cfg.model);
        const status = await api.llm.status(cfg.provider);
        if (cancelled) return;
        setModels(status.models);
        setModelsError(status.reachable ? null : (status.error ?? "Could not reach the model provider."));
        // The configured model can be gone — deleted or renamed in the provider
        // since it was chosen. Sending it anyway fails at generate time with a
        // provider error that names a model the user no longer recognizes, so
        // fall back here instead, preferring one that's already in memory.
        setModel((current) => {
          if (current && status.models.some((m) => m.id === current)) return current;
          return status.models.find((m) => m.loaded)?.id ?? status.models[0]?.id ?? current;
        });
      } catch (err) {
        if (!cancelled) setModelsError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoadingModels(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);
  // Track whether we've kicked off a generation for the current prompt so
  // reopening the dialog doesn't auto-refire — the user edits the prompt and
  // clicks Generate explicitly. Reset when the prompt changes.
  const firedKeyRef = React.useRef<string | null>(null);

  // Reset the "fired" marker whenever the inputs change, so a new prompt can
  // be generated without reopening the dialog.
  React.useEffect(() => {
    firedKeyRef.current = null;
  }, [prompt, url, name, speed, viewportId, model]);

  // Clear state when the dialog is fully closed (not just collapsed), so the
  // next open starts fresh. The dialog stays mounted (controlled by `open`),
  // so this runs on the open→false transition.
  React.useEffect(() => {
    if (!open) {
      setCreated(false);
    }
  }, [open]);

  const viewport = React.useMemo(
    () => viewportForPresetId(viewportId) ?? undefined,
    [viewportId],
  );

  const canGenerate = prompt.trim().length > 0 && url.trim().length > 0;

  const generate = React.useCallback(() => {
    if (!canGenerate) return;
    const key = `${prompt}|${url}|${name}|${speed}|${viewportId}|${model ?? ""}`;
    firedKeyRef.current = key;
    setCreated(false);
    // The picked model is sent explicitly, so the run and the "Thinking with
    // {model}…" label can't disagree. Omitting it (nothing picked, provider
    // unreachable) leaves the backend on its configured default.
    void start(
      buildGenerateMessages({
        prompt: prompt.trim(),
        url: url.trim(),
        name: name.trim() || "Generated test",
        speed,
        viewport,
      }),
      { model: model ?? undefined },
    );
  }, [canGenerate, prompt, url, name, speed, viewportId, viewport, start, model]);

  // A full, applyable spec is only offered once streaming finishes.
  const generatedScript = status === "done" ? extractCorrectedScript(content) : null;

  const createTest = async () => {
    if (!generatedScript) return;
    try {
      const rec = await api.tests.createFromPrompt({
        name: name.trim() || "Generated test",
        url: url.trim(),
        speed,
        source: generatedScript,
      });
      setCreated(true);
      qc.invalidateQueries({ queryKey: ["tests"] });
      toast.success("Created test from prompt.");
      onOpenChange(false);
      navigate({ to: "/test/$id", params: { id: rec.id } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create test.");
    }
  };

  const copyResponse = async () => {
    await window.glazeAPI.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const segments = parseResponse(content);
  const showResult = status !== "idle" || content.length > 0;

  const selectedModel = models.find((m) => m.id === model) ?? null;
  // Only group when the provider actually answered the question for at least
  // one model; otherwise every entry would sit under "Load state unknown",
  // which is noise rather than information.
  const groupByLoadState = models.some((m) => m.loaded !== undefined);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Generate test from prompt"
      description="Describe the test in plain language. The local LLM writes a complete Playwright spec you can save and run."
      size="xl"
    >
      <div className="flex flex-col gap-4">
        {/* Prompt-formatting guidance */}
        <div className="rounded-md border border-separator bg-control-subtle p-3">
          <Text variant="small" color="secondary">
            <strong className="font-medium text-primary">Tips for a good prompt:</strong> name the page and the user
            flow step by step. Mention the elements to interact with by their visible label or role (e.g. “the
            ‘Sign in’ button”), the values to type, and what should be true at the end (e.g. “the dashboard heading
            ‘Welcome’ appears”). One test per prompt works best.
          </Text>
        </div>

        {/* Common test options */}
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Test name" orientation="vertical">
              <Input
                placeholder="My generated test"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Starting URL" orientation="vertical">
              <Input
                placeholder="https://example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Execution speed" orientation="vertical">
              <SegmentedControl
                value={speed}
                onValueChange={(v) => setSpeed(v as TestSpeed)}
                variant="filled"
                size="small"
              >
                {SPEEDS.map((s) => (
                  <SegmentedControlItem key={s} value={s}>
                    {TEST_SPEED_LABELS[s]}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            </Field>
            <Field label="Browser viewport" orientation="vertical">
              <Select value={viewportId} onValueChange={setViewportId}>
                <SelectTrigger size="small">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VIEWPORT_PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          {/* Which model writes the spec. Long model ids get the full row. */}
          <Field label="Model" orientation="vertical">
            <div className="flex min-w-0 items-center gap-2">
              <Select
                value={model ?? ""}
                onValueChange={setModel}
                disabled={models.length === 0}
              >
                <SelectTrigger size="small" className="min-w-0 flex-1">
                  <SelectValue
                    placeholder={loadingModels ? "Loading models…" : "No models available"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {groupByLoadState
                    ? MODEL_GROUPS.map((g) => {
                        const inGroup = models.filter(g.has);
                        if (inGroup.length === 0) return null;
                        return (
                          <SelectGroup key={g.id}>
                            <SelectLabel>{g.label}</SelectLabel>
                            {inGroup.map((m) => (
                              <SelectItem
                                key={m.id}
                                value={m.id}
                                icon={g.icon}
                                sublabel={g.sublabel}
                              >
                                {m.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        );
                      })
                    : models.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.label}
                        </SelectItem>
                      ))}
                </SelectContent>
              </Select>
              {selectedModel?.loaded === true ? (
                <Badge color="green" className="shrink-0">
                  Loaded
                </Badge>
              ) : null}
              {selectedModel?.loaded === false ? (
                <Badge color="secondary" className="shrink-0">
                  Not loaded
                </Badge>
              ) : null}
            </div>
            {modelsError ? (
              <Text variant="small" color="secondary">
                {modelsError}
              </Text>
            ) : selectedModel?.loaded === false ? (
              <Text variant="small" color="secondary">
                This model isn’t in memory yet — it loads on the first request, which can take a
                while before any output appears.
              </Text>
            ) : null}
          </Field>
        </div>

        {/* Prompt */}
        <Field label="Prompt" orientation="vertical">
          <Textarea
            size="medium"
            placeholder={"e.g. Go to the URL, click “Log in”, fill the email field with “test@example.com” and the password with “secret123”, then click “Sign in”. Assert the “Welcome” heading is visible."}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            autoFocus
          />
        </Field>

        {/* Action row */}
        <div className="flex items-center gap-2">
          {status === "streaming" ? (
            <Status variant="loading">{model ? `Thinking with ${model}` : "Thinking"}</Status>
          ) : null}
          {status === "error" ? <Status variant="error">Error</Status> : null}
          {status === "done" ? <Status variant="success">Done</Status> : null}
          {status === "cancelled" ? <Status variant="neutral">Stopped</Status> : null}
          <div className="flex-1" />
          {status === "streaming" ? (
            <Button size="small" variant="muted" onClick={stop}>
              <Square className="size-3.5" /> Stop
            </Button>
          ) : (
            <Button size="small" variant="accent" onClick={generate} disabled={!canGenerate}>
              <Wand2 className="size-3.5" /> {content ? "Regenerate" : "Generate"}
            </Button>
          )}
          {generatedScript ? (
            <Button size="small" variant="accent" onClick={createTest} disabled={created}>
              <Check className="size-3.5" /> {created ? "Created" : "Create test"}
            </Button>
          ) : null}
          {content ? (
            <Button
              iconOnly
              size="small"
              variant="transparent"
              onClick={copyResponse}
              aria-label="Copy response"
              title="Copy response"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
          ) : null}
        </div>

        {/* Streaming result */}
        {showResult ? (
          <ScrollArea
            className="max-h-[40vh] min-h-0 rounded-md border border-separator"
            autoScrollToBottom
            autoScrollDeps={[content.length]}
          >
            <div className="flex flex-col gap-1 p-3">
              {status === "error" && error ? (
                <pre className="text-small whitespace-pre-wrap break-words text-primary">{friendlyError(error, errorKind)}</pre>
              ) : content ? (
                segments.map((seg, i) =>
                  seg.type === "code" ? (
                    <CodeBlock key={i} lang={seg.lang} content={seg.content} />
                  ) : (
                    <p key={i} className="text-small whitespace-pre-wrap break-words text-primary">
                      {seg.content}
                    </p>
                  ),
                )
              ) : (
                <p className="text-small text-secondary">
                  {status === "streaming" ? (model ? `Thinking with ${model}…` : "Thinking…") : ""}
                </p>
              )}
            </div>
          </ScrollArea>
        ) : null}
      </div>
    </Dialog>
  );
}
