# iFrames — design

**Status:** the ENGINE (steps 1–3 below) SHIPPED 2026-08-22 — a framed step is writable and runnable. Design written 2026-08-08 from the note
*"Interact with iFrames — Engine; Ignore iFrames — Trainer"*.

> **Engine landed 2026-08-22.** `Locator.frame` + `shared/frame-ref.mjs`, the generator's `root()` prefix, the spec parser's `frameLocator` reader, and the step-replayer + Auto-Heal refusals are all built and tested (`main/services/frame-engine.test.ts`, `check:locator-roundtrip` frame rows, `e2e/frame-parity.spec.ts`). See DECISIONS 2026-08-22. **Still open:** the trainer NOTICE (step 4 below — it crosses the capture-egress boundary and is deferred to its own change) and trainer CAPTURE inside a frame (step 5, its own project). Two stale references in the design below — the SDK `WebFrameMain` note and the `data-pw-queue` top-document-attribute note (capture state now lives in the isolated world as `window.__glCapture`) — apply only to that unbuilt trainer-capture work.

> **Carried onto `main` 2026-08-14, and still accurate.** Written on
> `claude/transcribe-notes-plan-work-e36d77`, which never merged. Re-checked
> against `main` on 2026-08-14: `frameLocator`, `contentFrame`, `childFrames`
> and `allFrames` still appear nowhere in the tree, so every claim below about
> the starting position holds.

Companion documents: [ARCHITECTURE.md](ARCHITECTURE.md) for what exists,
[DECISIONS.md](DECISIONS.md) for why.

## Where we are

There is **no iframe support anywhere**. `frameLocator`, `contentFrame`,
`childFrames` and `allFrames` appear nowhere in the repo, docs included. Four
separate places assume a single document:

| Layer | File | The assumption |
|---|---|---|
| Capture | `main/recorder/capture-script.ts` | listeners bind to the top `document`; session state lives on `document.documentElement` attributes; every DOM helper queries `document` directly |
| Injection | `main/services/recorder-service.ts:537` `injectCapture()` | one `wc.executeJavaScript(CAPTURE_SCRIPT)`, main frame only |
| Model | `main/recorder/types.ts:75` `Locator` | `{ k, v, role, name }` — no frame component |
| Generation | `main/services/script-generator.ts:232` etc. | every target is built as `"page." + locatorExpr(loc)` |
| Parsing | `main/services/spec-parser.ts` | its vocabulary has no `frameLocator`, so an imported spec's frame statements land in `skipped` |

The one piece of frame logic that does exist is about navigation, not elements —
`main/services/recorder-navigation.ts:75`:

> A genuine sub-frame navigation stays in its frame; re-issuing it in the main
> window would replace the whole page with an iframe's URL.

**Net:** clicking inside an iframe while recording captures nothing at all. Not
a partial implementation — an absent one.

## The note splits the problem, and the split is right

*Engine interacts, Trainer ignores.* Those are two different features and the
cheaper one is worth more:

- **Engine** — a step whose locator names a frame must RUN. This unblocks
  hand-written steps, AI-generated steps, and imported specs that already use
  `frameLocator`. It is bounded work in files we control.
- **Trainer** — capturing a click inside a live iframe. This is where the cost
  is (injection into N frames, cross-origin limits, coordinate mapping for the
  crosshair picker), and the note's own answer is *ignore it for now*.

Doing engine-first means an iframe test is **writable and runnable** before it
is **recordable**. That is the same order the app already took for cookies and
conditionals.

## Engine: the design

### 1. Locator gains an optional frame path

```ts
export interface Locator {
  k: LocatorKind;
  v?: string;
  role?: string;
  name?: string;
  /** Frames to descend through, outermost first, before resolving this
   *  locator. Absent (the overwhelming case) = the top document. */
  frame?: FrameRef[];
}

/** How to find ONE iframe element from its parent document. Deliberately the
 *  same vocabulary as a normal locator rather than a URL or an index: a frame
 *  found by `name` or `testid` survives a page that reorders its frames, and an
 *  index does not. */
export interface FrameRef {
  k: "name" | "url" | "testid" | "css";
  v: string;
}
```

An **array**, not a single ref, because nested iframes are real (a payment
widget inside a checkout embed) and a single ref would have to be widened later
by everything that reads it.

### 2. Generation

`locatorExpr` stays exactly as it is — it already emits the part after the dot.
The change is to the *prefix*, which is built in five places today as the
literal `"page."`. That becomes one helper:

```ts
function root(loc: Locator | null | undefined): string {
  const path = loc?.frame ?? [];
  return path.reduce((acc, f) => acc + ".frameLocator(" + q(frameSelector(f)) + ")", "page");
}
```

`frameSelector` maps a `FrameRef` to a Playwright selector string
(`iframe[name="checkout"]`, `iframe[src*="..."]`, `[data-testid="..."]`). It
**must go through `q()`** like every other generated string — a frame ref is a
step field, so it is on the capture boundary the moment the trainer can produce
one, and the generator has to be safe before that day rather than after it.

Every existing test regenerates byte-identically, because `frame` is absent and
`root()` returns `"page"`.

### 3. Normalization

`normalizeRawStep` grows a `normalizeFrameRefs` that rebuilds the array from
known keys, caps its depth (3 is generous — deeper nesting is a page problem,
not a test problem), and drops refs whose `k` is not in the allowlist. Same
rebuild-don't-filter rule as everything else on that boundary.

### 4. Where it does NOT reach

- **`step-replayer.ts`** — per-step replay in the trainer uses the same
  top-frame `DOM_HELPERS`. A step with a `frame` path cannot be previewed there,
  and should say so rather than silently resolving against the wrong document.
- **Auto-Heal** — its candidate search is a top-document query. A framed step
  should be excluded from healing rather than healed against the wrong scope.

Both are "refuse clearly", not "make it work", and both need a test that pins
the refusal.

### 5. Spec parser

`parseSpecDetailed` learns `page.frameLocator("…")` as a prefix that
contributes a `FrameRef` and then continues parsing the rest of the statement as
it does today. Until it does, imported iframe specs keep counting into
`skipped`, which already surfaces as `stepsDiverged` — an honest signal, not a
silent one.

## Trainer: what "ignore" should actually mean

"Ignore" must not mean "behave as though the click never happened". A user who
clicks inside an iframe and gets no step has no way to tell that from a bug.

The cheap, honest version: `injectCapture` stays main-frame only, and the
capture script adds a top-document listener that notices a click whose
`event.target` is an `<iframe>` element and emits a **notice**, not a step —
surfaced in the trainer as "this element is inside an embedded frame; frame
recording isn't supported yet. You can add the step by hand." That is a few
lines and it converts a silent failure into a known limitation.

## When the Trainer side is built, the SDK can do it

Worth recording because it decides the shape: **the Glaze SDK already exposes
frame-scoped injection**, so this needs no new SDK capability.

- `WebFrameMain` (`sdk/@glaze/core/backend/web-frame-main.d.ts`) has
  `executeJavaScript`, `url`, `origin`, `parent`, `frames`, `framesInSubtree`
  and its own `ipc`.
- `webContents.mainFrame.framesInSubtree` enumerates the tree, so the capture
  script can be injected per frame.
- `BrowserWindow` accepts `nodeIntegrationInSubFrames` — and its own doc is the
  constraint that matters: *"Cross-origin frames always stay bridge-less."*

So same-origin frames are reachable and cross-origin frames are not, which means
the trainer's story has to be **"frames we can record" vs "frames we can't"**,
decided per frame at injection time and shown to the user, rather than a single
global "iframe support: on".

Two further problems that only appear on the trainer side, noted so the estimate
is honest:

1. **The queue is a top-document attribute.** `data-pw-queue` lives on
   `document.documentElement`. Per-frame scripts each get their own document, so
   the drain has to read every injected frame and merge — and merge *in event
   order*, which nothing currently records across frames.
2. **The crosshair picker is coordinate-based.** Element picking and the
   refine-selector flow resolve a point in the top document. Mapping a point
   into a nested frame's coordinate space is its own piece of work.

## Recommended order

1. **Locator + normalizer + generator + tests.** No UI. A hand-written or
   AI-written framed step runs. (`check:step-ingest` extends for the new field.)
2. **Refusals**: step-replayer and Auto-Heal decline framed steps out loud.
3. **Spec parser** learns `frameLocator`, so imported iframe specs stop
   diverging.
4. **Trainer notice** — "that's inside a frame, add it by hand".
5. **Trainer capture** (same-origin only), as its own project, only if 1–4 turn
   out not to be enough.

Steps 1–3 are the ones that make iframe tests *possible*. Step 5 is the one that
makes them *convenient*, and it is easily the largest single piece of work in
this document.
