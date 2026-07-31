// Generate a new Playwright test from a natural-language prompt via the local
// LLM. Opens from the sidebar + menu ("Generate from prompt"). Lets the user
// pre-select common options (speed, viewport, starting URL), streams the
// model's response with the same formatted rendering as the AI debug panel,
// and — when the model returns a complete, applyable spec — offers a one-click
// "Create test" that persists it as a new test via tests:createFromPrompt.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  Field,
  Input,
  ScrollArea,
  SegmentedControl,
  SegmentedControlItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Status,
  Text,
  Textarea,
  toast,
} from "@glaze/core/components";
import { Check, Copy, Square, Wand2 } from "lucide-react";

import { api } from "../lib/api";
import { buildGenerateMessages } from "../lib/llm-prompts";
import { extractCorrectedScript, parseResponse } from "../lib/parse-llm-response";
import type { TestSpeed } from "../lib/recorder-types";
import { useLlmChat } from "../lib/use-llm-chat";

const SPEEDS: TestSpeed[] = ["fast", "medium", "slow"];
const SPEED_LABEL: Record<TestSpeed, string> = { fast: "Fast", medium: "Medium", slow: "Slow" };

// Common viewport presets. "Default" leaves it unset (the runner uses its own
// default; the prompt just won't mention a size).
const VIEWPORT_PRESETS = [
  { id: "default", label: "Default", w: 0, h: 0 },
  { id: "desktop", label: "Desktop 1280×800", w: 1280, h: 800 },
  { id: "laptop", label: "Laptop 1440×900", w: 1440, h: 900 },
  { id: "tablet", label: "Tablet 768×1024", w: 768, h: 1024 },
  { id: "mobile", label: "Mobile 390×844", w: 390, h: 844 },
] as const;

function friendlyError(message: string): string {
  if (/no model selected/i.test(message)) {
    return `${message} Open Settings (⌘,) → AI provider to pick one.`;
  }
  if (/could not reach|abort|timeout|econnrefused|fetch failed|network/i.test(message)) {
    return `${message} Open Settings (⌘,) → AI provider to check the connection.`;
  }
  return message;
}

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
  const { content, status, error, start, stop } = useLlmChat();

  const [prompt, setPrompt] = React.useState("");
  const [name, setName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [speed, setSpeed] = React.useState<TestSpeed>("fast");
  const [viewportId, setViewportId] = React.useState<string>("default");
  const [created, setCreated] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  // Configured default model name, shown in the "Thinking with {model}…"
  // placeholder while the LLM is generating.
  const [modelName, setModelName] = React.useState<string | null>(null);

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
  // Track whether we've kicked off a generation for the current prompt so
  // reopening the dialog doesn't auto-refire — the user edits the prompt and
  // clicks Generate explicitly. Reset when the prompt changes.
  const firedKeyRef = React.useRef<string | null>(null);

  // Reset the "fired" marker whenever the inputs change, so a new prompt can
  // be generated without reopening the dialog.
  React.useEffect(() => {
    firedKeyRef.current = null;
  }, [prompt, url, name, speed, viewportId]);

  // Clear state when the dialog is fully closed (not just collapsed), so the
  // next open starts fresh. The dialog stays mounted (controlled by `open`),
  // so this runs on the open→false transition.
  React.useEffect(() => {
    if (!open) {
      setCreated(false);
    }
  }, [open]);

  const viewport = React.useMemo(() => {
    const preset = VIEWPORT_PRESETS.find((p) => p.id === viewportId);
    if (!preset || preset.w === 0) return undefined;
    return { width: preset.w, height: preset.h };
  }, [viewportId]);

  const canGenerate = prompt.trim().length > 0 && url.trim().length > 0;

  const generate = React.useCallback(() => {
    if (!canGenerate) return;
    const key = `${prompt}|${url}|${name}|${speed}|${viewportId}`;
    firedKeyRef.current = key;
    setCreated(false);
    void start(
      buildGenerateMessages({
        prompt: prompt.trim(),
        url: url.trim(),
        name: name.trim() || "Generated test",
        speed,
        viewport,
      }),
    );
  }, [canGenerate, prompt, url, name, speed, viewportId, viewport, start]);

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
                    {SPEED_LABEL[s]}
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
            <Status variant="loading">{modelName ? `Thinking with ${modelName}` : "Thinking"}</Status>
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
                <pre className="text-small whitespace-pre-wrap break-words text-primary">{friendlyError(error)}</pre>
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
                  {status === "streaming" ? (modelName ? `Thinking with ${modelName}…` : "Thinking…") : ""}
                </p>
              )}
            </div>
          </ScrollArea>
        ) : null}
      </div>
    </Dialog>
  );
}
