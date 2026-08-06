// Turns a provider's HTTP error response into something a user can act on.
//
// Every provider here speaks the OpenAI-compatible API but reports failures
// differently, and none of their bodies are meant for human eyes. Pasting the
// raw body into the panel produced things like:
//
//   Chat request failed (HTTP 400). {"error":"Failed to load model
//   \"google/gemma-4-e4b\". Error: LM Link connection closed"}
//
// which buries the one sentence that matters (the model didn't load) inside a
// status code and JSON escaping, and says nothing about what to do next. The
// model-load case is worth naming specifically because it is the most common
// local-provider failure by far: the model picker lists every model the server
// knows about, but a local server only serves the one it can actually load, so
// picking a model that is not loaded is a normal thing to do and a confusing
// thing to be told about in JSON.
//
// Pure and dependency-free so it can be tested without a provider.

import type { LlmErrorKind, LlmProvider } from "./types.js";

/** An error body long enough to be an HTML page rather than a message. Past
 *  this we keep a prefix — a wall of markup helps nobody, but the opening of a
 *  proxy's error page usually still identifies it. */
const MAX_DETAIL = 300;

/** A failure the PROVIDER reported and we have already decoded into a
 *  human-readable sentence — as opposed to a transport failure (server down,
 *  DNS, timeout), which needs the "is it running?" hint instead.
 *
 *  Carrying the distinction in the TYPE rather than inferring it from the text
 *  matters because a decoded message quotes the provider verbatim, and those
 *  words are outside our control: a body like "network error while fetching
 *  weights" would match the transport patterns and get replaced wholesale with
 *  "Make sure LM Studio is running" — sending the user after a server that is
 *  up and answering. */
export class ProviderError extends Error {
  readonly kind: LlmErrorKind;
  constructor(message: string, kind: LlmErrorKind) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
  }
}

export function providerLabel(provider: LlmProvider): string {
  if (provider === "ollama") return "Ollama";
  if (provider === "lmstudio") return "LM Studio";
  return "Claude";
}

/** Pull the human-readable sentence out of an error body.
 *
 *  Handles the shapes these providers actually send: `{error: "..."}` (Ollama,
 *  LM Studio), `{error: {message: "..."}}` (OpenAI-compatible, Anthropic),
 *  `{message: "..."}`, `{detail: "..."}`, and plain text. Returns null when
 *  there is nothing worth showing, so callers can fall back to the status. */
export function extractProviderMessage(body: string): string | null {
  const trimmed = (body ?? "").trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const found = messageFromJson(parsed);
    if (found) return clamp(found);
    // Valid JSON with no message field: showing the raw object is still worse
    // than saying nothing, so let the caller fall back to the status code.
    return null;
  } catch {
    // Not JSON — plain text or an HTML page.
    return clamp(trimmed);
  }
}

function messageFromJson(parsed: unknown): string | null {
  if (typeof parsed === "string") return parsed.trim() || null;
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  for (const key of ["error", "message", "detail"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const nested = messageFromJson(value);
      if (nested) return nested;
    }
  }
  return null;
}

function clamp(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_DETAIL ? `${collapsed.slice(0, MAX_DETAIL)}…` : collapsed;
}

/** Whether the provider is telling us it couldn't load or find the model.
 *
 *  Deliberately broad: LM Studio says "Failed to load model", Ollama says
 *  "model 'x' not found, try pulling it first", and OpenAI-compatible servers
 *  use a `model_not_found` code. All three mean the same thing to the user. */
export function isModelUnavailable(message: string): boolean {
  return /failed to load model|model_not_found|model not found|no such model|not found, try pulling|unknown model/i.test(
    message,
  );
}

/** How to get the model working again, per provider. */
function modelHint(provider: LlmProvider, model: string): string {
  if (provider === "ollama") {
    return `Pull it first (\`ollama pull ${model}\`), or pick a different model.`;
  }
  if (provider === "lmstudio") {
    return "Load it in LM Studio (Developer → select the model), or pick a different model.";
  }
  return "Pick a different model.";
}

/** Build the message shown in the AI panel for a non-2xx chat response, with
 *  the kind that decides which fix-it hint the renderer offers. Returned
 *  together so the two can never be derived from each other and drift. */
export function describeHttpFailure(opts: {
  status: number;
  body: string;
  provider: LlmProvider;
  model: string;
}): { message: string; kind: LlmErrorKind } {
  const { status, body, provider, model } = opts;
  const label = providerLabel(provider);
  const detail = extractProviderMessage(body);

  if (status === 401 || status === 403) {
    return {
      kind: "auth",
      message:
        provider === "anthropic"
          ? "Claude rejected the API key."
          : `${label} rejected the request as unauthorized (HTTP ${status}).${detail ? ` ${detail}` : ""}`,
    };
  }

  if (detail && isModelUnavailable(detail)) {
    // Lead with the actionable sentence; keep the provider's own words after
    // it, because the specific reason ("LM Link connection closed", out of
    // memory, wrong quantization) is what makes it fixable.
    return {
      kind: "model-unavailable",
      message: `${label} couldn't load the model "${model}". ${modelHint(provider, model)} ${label} said: ${detail}`,
    };
  }

  if (status === 404) {
    return {
      kind: "connection",
      message: `${label} has no endpoint at that address (HTTP 404). Check the server URL.${
        detail ? ` ${label} said: ${detail}` : ""
      }`,
    };
  }

  return {
    kind: "provider",
    message: detail
      ? `${label} couldn't run this request. ${detail}`
      : `${label} couldn't run this request (HTTP ${status}).`,
  };
}

// ── Empty responses ──────────────────────────────────────────────────
// A stream that ends cleanly with zero tokens of answer. The old message
// guessed — "may have hit a token limit, or the prompt may have been too long"
// — which is worse than useless when the prompt was 784 tokens: it sends the
// user to widen a context window that was never the problem, and it hides the
// one fact that rules out a whole class of theories, namely that the request
// COMPLETED rather than being cut off.
//
// So report what actually happened on the wire. `finish_reason` distinguishes
// "stopped at a limit" from "ended its turn", and the set of delta fields seen
// catches the case this app can genuinely get wrong: a model streaming its
// answer in a field we don't read, which is otherwise indistinguishable from a
// model that said nothing at all.

/** Fields we know how to read out of an OpenAI-compatible streamed delta. */
export const KNOWN_DELTA_FIELDS = ["content", "reasoning_content", "reasoning", "role"];

export interface EmptyResponseFacts {
  provider: LlmProvider;
  model: string;
  /** Total characters across every prompt message. */
  promptChars: number;
  /** How many SSE data events carried a parseable payload. */
  eventCount: number;
  /** The last `finish_reason` the provider reported, if any. */
  finishReason: string | null;
  /** Every delta field seen carrying a non-empty value. */
  deltaFields: string[];
  /** True when the model streamed thinking but never an answer. */
  sawReasoning: boolean;
}

/** ~4 characters per token. Rough on purpose: it is used to say "about N
 *  tokens" so a user can compare against a context-length setting, not to
 *  make any decision in code. */
export function approxTokens(chars: number): number {
  return Math.max(1, Math.round(chars / 4));
}

export function describeEmptyResponse(facts: EmptyResponseFacts): string {
  const { provider, model, promptChars, eventCount, finishReason, deltaFields, sawReasoning } =
    facts;
  const label = providerLabel(provider);
  const size = `The prompt was about ${approxTokens(promptChars).toLocaleString()} tokens.`;

  if (sawReasoning) {
    return (
      `The model spent its whole response thinking and never produced an answer. ${size} ` +
      "Reasoning models need room for both — raise the model's token limit in " +
      `${label}, or pick a non-reasoning model for this.`
    );
  }

  // A field we don't parse is the one cause the USER cannot diagnose and we
  // can: name it, because it means the answer arrived and this app dropped it.
  const unknown = deltaFields.filter((f) => !KNOWN_DELTA_FIELDS.includes(f));
  if (unknown.length > 0) {
    return (
      `${model} streamed its response in fields this app doesn't read (${unknown.join(", ")}), ` +
      `so the answer was received but not displayed. This is a bug — please report it. ${size}`
    );
  }

  if (finishReason === "length") {
    return (
      `${model} hit its token limit before writing any answer. ${size} ` +
      `Raise the context length (or max tokens) for this model in ${label}, or pick a model with a larger context window.`
    );
  }

  if (eventCount === 0) {
    return (
      `${label} accepted the request but sent no data at all. ` +
      `The request completed without an error, so this is not a connection problem — ` +
      `check ${label}'s own logs for this model.`
    );
  }

  // Events arrived, none carried text, and nothing hit a limit: the model
  // ended its turn immediately. In practice that is a prompt-format problem
  // for the specific model rather than anything about the request.
  return (
    `${model} ended its turn without generating any text${
      finishReason ? ` (finish reason: ${finishReason})` : ""
    }. The request completed normally, so this is not a connection or timeout problem. ${size} ` +
    `This usually means the model's chat template doesn't match how ${label} is prompting it — ` +
    `try a different model, or re-download this one.`
  );
}
