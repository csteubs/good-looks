# Explaining a failure to the model — design

**Status:** design only, nothing built. Written 2026-08-08 from the note
*"Let user explain test error + train model with screenshots. Allow user to
annotate screenshots, preserve HTML state in the logs(?), and create a context
pattern for portability + MCP use."*

> **Carried onto `main` 2026-08-14; partly overtaken.** Written on
> `claude/transcribe-notes-plan-work-e36d77`, which never merged. Two of the
> four things this note asks for now exist: the user can explain the failure in
> their own words (the free-text field in the AI debug panel) and the model can
> ask what the page looked like (`capture_app` / `get_screenshot`, in
> `mcp/debug-shots.mjs`). Screenshot **annotation** and preserved **HTML state**
> are still unbuilt. Verified 2026-08-14.

Companion documents: [ARCHITECTURE.md](ARCHITECTURE.md),
[DECISIONS.md](DECISIONS.md).

## What the note is actually asking for

Four things, and they are not equally ready:

1. **The user explains the error in their own words** — mostly built.
2. **Screenshots go to the model** — blocked on one concrete gap (below).
3. **The user annotates a screenshot** (circle the thing that's wrong).
4. **A reusable "context pattern"** that travels — to the model, and out over
   MCP.

"Train" here should be read as *give the model better context*, not *fine-tune
weights*. Nothing in this app trains a model, and nothing in this design would.
Worth stating because the word invites the other reading, and that project is
not this one.

## 1. Explaining the error — already there

The AI debug dialog has a freeform **additional context** box plus five quick
toggles (`QUICK_CONTEXT_REASONS` in `renderer/main/ai-debug-panel.tsx`: flaky
selector, wrong A/B variant, timing/race, site changed, auth/login state), and
`buildDebugMessages` folds it into the prompt.

Per-step notes exist too (`main/services/annotation-store.ts` — one freeform
`Annotation { testId, runId, stepId, text }` per step, surfaced while scrubbing
the visual timeline). **These two never meet**: a note written on the timeline
while looking at the failure is not offered to the model that is asked about the
same failure. That is the cheapest real win in this document — the note is
already keyed by `runId` + `stepId`, and the run context already knows both.

## 2. Screenshots — one concrete blocker

`LlmMessage` is text only:

```ts
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;   // renderer/lib/llm-types.ts:13
}
```

`toAnthropicPayload` and the OpenAI-compatible path both serialize that shape
straight through, so **there is no way to attach an image today**. Multimodal
content is a list of parts (`{type:"text"}` / `{type:"image"}`), and both APIs
support it — the app's own type is what forecloses it.

The change is contained but it is a real one:

```ts
export type LlmContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image"; mediaType: string; dataBase64: string }>;
```

…plus per-provider encoding in `llm-service.ts` (Anthropic: `image` blocks with
`source.type: "base64"`; OpenAI-compatible: `image_url` with a `data:` URL), and
a **capability gate**: a local Ollama model that isn't multimodal will either
error or silently ignore the image, and silently ignoring it is the bad one —
the user would think the model looked at the picture. `LlmModel` needs a
"supports images" flag, and the attach affordance must be disabled with a reason
when the selected model can't take one.

Screenshots themselves are ready: `artifact-store` already holds per-step PNGs,
and `baselineStore.readShotDataUrl` already produces a data URL.

**Cost note.** A full-page screenshot is large. Attaching one per step of a
20-step run would dwarf the rest of the prompt, and on the Claude provider that
is billed. The design should attach **one** image by default — the failing
step — with the user able to add others deliberately.

## 3. Annotation

Draw on the screenshot to say *this is the bit that's wrong*. The visual view
already has the machinery: `MaskLayer` in `renderer/main/visual-view.tsx` drags
out normalized 0–1 rectangles over a screenshot for ignore-regions. An
annotation layer is the same interaction with a different meaning and a
different colour.

Two ways to get the annotation to the model, and the choice matters:

- **Burn it in** — draw the rect onto a copy of the PNG before encoding. The
  model sees exactly what the user drew. Costs an image encode; the coordinates
  are then lost to anything downstream.
- **Describe it** — send the clean image plus "the user circled the region at
  (x, y, w, h), which contains the *Continue* button". Cheaper, keeps the
  coordinates structured, and is the only option that works for a text-only
  model.

**Recommendation: describe it, and burn it in as well when the image is going
anyway.** The description is what survives into the context pattern below; the
burned-in copy is a rendering detail of one request.

## 4. HTML state — the note's own question mark

The note writes "preserve HTML state in the logs(?)" with the question mark, and
the question mark is right.

- **For.** The single most useful thing for diagnosing a locator failure is the
  DOM as it actually was. A screenshot shows a button; only the HTML says why
  `getByRole("button", { name: "Continue" })` missed it.
- **Against.** A page's serialized DOM is often megabytes, routinely contains
  session tokens and personal data in attributes and inline JSON, and the app
  has a standing rule that recorded evidence is opt-in and stated
  (`recordLogs`, `recordAllHeaders` with its `danger="stores credentials"`
  label).

**Recommendation: not the whole document.** Capture a **bounded neighbourhood**
of the failing element — the element's own `outerHTML`, its ancestors' tag +
id + class + role + aria attributes up to a small depth, and its immediate
siblings — capped hard (say 8 KB) and captured only when the step FAILED. That
answers the locator question, which is what people actually ask, without turning
every failing run into an unbounded dump of the page. If the full document is
ever wanted it should be its own opt-in setting with the same danger label the
header capture has, not a quiet default.

## 5. The context pattern

This is the part worth designing carefully, because it is the piece the note
says should travel: *"a context pattern for portability + MCP use"*.

Define one serializable record — a **failure context** — assembled from things
that already exist:

```ts
interface FailureContext {
  testId: string;
  runId: string;
  stepId: string;
  stepLabel: string;
  error: string;             // shared/error-signature.mjs already clusters these
  locator?: string;          // locatorToPrompt(), the Playwright-ish rendering
  userExplanation?: string;  // the dialog's context box
  quickReasons?: string[];   // the five toggles
  note?: string;             // the timeline annotation, finally joined up
  regions?: { rect: NormalizedRect; label?: string }[];  // what the user circled
  domNeighbourhood?: string; // bounded, failed steps only
  screenshotRef?: { runId: string; stepId: string };     // a REFERENCE, not bytes
  consoleTail?: string;      // when recordLogs was on
}
```

Three properties are the whole point:

- **It is data, not a prompt.** Rendering it into a prompt is one pure function
  (`buildFailureContextPrompt`) that lives beside `llm-prompts.ts`. Anything
  else that wants the same facts — a Linear issue, a webhook alert, an MCP
  response — renders its own view of the same record. A prompt string cannot be
  reused that way, which is why the note's word "portability" is the right one.
- **The screenshot is a reference, not bytes.** Only the LLM path resolves it to
  base64. Everything else passes a `{runId, stepId}` pair the existing artifact
  APIs can fetch, so the record stays small enough to log, store and return.
- **It is pure.** So it belongs in `shared/` under the existing admission rule
  and the MCP server can build and read the identical shape.

### MCP shape

A new read-only tool — `get_failure_context(runId, stepId?)` — returns the
record, with two rules inherited from what MCP already does:

- Everything goes through `sanitizeOutput` in `mcp/run-plan.mjs`, the single
  choke point for anything the server returns.
- The `domNeighbourhood` and `consoleTail` fields follow the existing
  `consoleNetworkWithheldReason` precedent: **withheld library-wide when any
  test declares a secret variable**, because those files are unredacted and the
  MCP process cannot decrypt. Adding a new field that carries page text without
  that gate would quietly reopen a hole that was deliberately closed.

## Recommended order

1. **Join the timeline note to the AI prompt.** Small, uses only what exists,
   and is the fix for a real disconnect.
2. **`FailureContext` in `shared/` + a pure prompt renderer.** No new UI. The
   dialog builds one instead of assembling a prompt inline.
3. **`get_failure_context` over MCP**, with the secret-variable gate.
4. **Multimodal `LlmContent` + the model capability flag.** Attach the failing
   step's screenshot, one by default.
5. **Annotation layer** on the visual view, described into the context (and
   burned in when an image is being sent anyway).
6. **Bounded DOM neighbourhood**, failed steps only, capped.

Steps 1–3 are useful with no image support at all, which is what makes this
worth starting before step 4 — the expensive one — is decided.
