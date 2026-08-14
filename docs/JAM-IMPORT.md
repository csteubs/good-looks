# Importing Jam recordings — research

**Status:** research only, nothing built. Written 2026-08-08 from the note
*"Integrate w/ Jam or Droplr (or build own?)"*, clarified as **import Jam
recordings as tests**.

> **Carried onto `main` 2026-08-14, and still accurate.** Written on
> `claude/transcribe-notes-plan-work-e36d77`, which never merged. Re-checked
> against `main` on 2026-08-14: nothing in the tree mentions Jam, so this is
> research with no code behind it, exactly as written.

Companion documents: [ARCHITECTURE.md](ARCHITECTURE.md),
[DECISIONS.md](DECISIONS.md).

## The idea

A Jam (jam.dev) recording is a bug report someone already made: the clicks, the
console, the network, the page. Turning one into a runnable Playwright test
means the reproduction arrives with the report instead of being rebuilt by hand
— which is the actual work this app exists to remove.

Nothing about it exists here yet. A repo-wide search for `jam.dev`, `.har`,
"session recording" finds only false positives about the trainer's own window
sizing.

## Two landing shapes, and the choice matters

The app already has a complete import path, and the question is whether a Jam
converter joins it or bypasses it.

### Option A — generate a spec, reuse `import-service`

Convert the recording to Playwright source, then hand it to the existing flow:
`parseSpec` extracts steps, the verbatim file becomes the runnable artifact, the
record is marked `scriptEdited: true` with `sourceDir` set.

**Against, and it is decisive:** `sourceDir` is not bookkeeping. It is the flag
every fixture-borne feature checks (`playwright-runner.ts:870-888`):

```ts
let settling = speed === "crawl" && !rec.sourceDir;
```

`!rec.sourceDir` gates **screenshot capture, a11y checks, Auto-Heal, console
recording and crawl settling**. An imported test gets none of them — so a
Jam-imported test would arrive with **no visual diffing at all**, silently. For
a feature whose whole promise is "your bug report is now a test", handing back a
second-class test is the wrong first impression.

### Option B — emit `RawStep[]` directly

Convert the recording into the app's own step model and insert through
`normalizeRawSteps`. The test is then app-generated: its spec is regenerated
from steps, and it gets capture, a11y, healing and settling like any recorded
test.

**Recommendation: Option B**, for the `sourceDir` reason above. Option A's only
real advantage is that it reuses `copyRelativeImports`, and a Jam recording has
no sibling modules to copy — that machinery exists for cloning someone's repo,
which is a different job.

## What a converter has to produce

`RawStep` (`main/recorder/types.ts:256-287`), through the one mandatory gate:

```ts
normalizeRawStep(input: unknown): RawStep | null   // :801
```

It **rebuilds rather than filters** and returns null on an unknown `type`. The
legal types are the sixteen in `STEP_TYPES` (`:566-569`). Numeric fields are
clamped there (`count` 0–1e6, `width`/`height` 1–1e5, `waitMs`/`timeoutMs`
0–3.6e6), and `cssProp` is shape-checked rather than merely length-capped.

**This is a security boundary, and a Jam recording is untrusted input.** It is
a file (or an API response) describing actions taken on an arbitrary website,
compiled by this app into a `.spec.ts` that Playwright then executes in Node.
That is the same path CLAUDE.md describes as *"page input → generated code →
executed"*, and it already produced a real RCE once. A Jam converter is a **new
entry point on that path** and must normalize — which is exactly why Option B's
`normalizeRawSteps` call is a feature and not a formality.

The mapping itself is the ordinary part:

| Jam event | Step |
|---|---|
| navigation | `{ type: "goto", url }` |
| click | `{ type: "click", locator }` |
| input | `{ type: "fill", locator, value }` |
| key press | `{ type: "press", value }` |
| resize | `{ type: "viewport", width, height }` |

**Locators are where the quality lives.** The app's `LocatorKind` ordering
already prefers `testid` → `role` → `label` → `placeholder` → `text` → `css` →
`xpath`, and the trainer's own candidate ranking exists precisely because a raw
CSS path is a bad locator. If a Jam recording gives only a selector, the
converted test will be as brittle as that selector — worth saying up front,
because "Jam import produces flaky tests" would read as this app's fault.

## The unknowns that decide feasibility

Everything above is design. What is genuinely unknown is the input, and it
should be established before any of it is built:

1. **Is there a public API or export format?** A Jam link is a web page; the
   question is whether a recording can be fetched as structured data (and with
   what auth), or whether the only route is a manual export.
2. **Does the recording contain a DOM event stream at all?** Some tools capture
   video plus console/network and no per-element event log. If there is no
   event stream with element identity, there is no step list to build and this
   feature is not possible in the form the note imagines.
3. **What element identity travels with an event?** A selector? A DOM path? A
   snapshot? This determines locator quality, which determines whether the
   output is useful.
4. **Console and network.** Jam's main value to a developer is these. The app
   already has `RunLogs` for its own runs, but there is no place to put logs
   that came from *someone else's* session. That is a second feature and should
   not be smuggled into the first.

**None of this can be answered from the repo** — it needs the vendor's docs.

## Prior art worth looking at

A `jam-step-generator` skill exists in this environment (outside the repo) that
"receives a Jam link, parses the session recording, then translates the actions
and steps taken in the recording to generate a Playwright test". It is not part
of this codebase and nothing here depends on it, but it is direct evidence that
the parse is tractable, and its approach to the unknowns above would be worth
reading before designing ours.

## Droplr

The note offers Droplr as an alternative. It is a screenshot/screen-recording
sharing tool — it produces a video or an image, not an event stream. There is
nothing to convert into steps. If the interest in Droplr is *sharing evidence
outward* rather than *importing tests inward*, that is a different feature
(closer to the Linear note), and worth separating.

## Suggested order

1. **Answer the four unknowns from the vendor's docs.** No code. If (2) comes
   back "no event stream", stop here — that is a valuable answer.
2. **A pure converter in `shared/`**: recording JSON → `RawStep[]`, with a
   fixture of real recordings as its test corpus. Pure, so it needs no app to
   test and the MCP could use it later.
3. **Wire it to a "From Jam" entry** in the sidebar's + menu, creating an
   app-generated test through `normalizeRawSteps` — never bypassing it.
4. **Locator quality pass**: reuse the trainer's candidate ranking rather than
   taking Jam's selector at face value.
5. Console/network from the recording, if wanted, as its own feature.
