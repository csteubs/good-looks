# Plan: Emulate mabl's Trainer

## Context

The user wants this app's recorder to emulate [mabl's Trainer](https://help.mabl.com/hc/en-us/articles/17683632328852-Getting-started-with-browser-tests) — mabl's interactive desktop tool for building/maintaining browser tests. Research of mabl's docs ([Interacting with the Trainer](https://help.mabl.com/hc/en-us/articles/19078186552980-Interacting-with-your-web-app-in-the-mabl-Trainer), [Assertions](https://help.mabl.com/hc/en-us/articles/19078158566932-Assertions-in-the-mabl-Trainer), [Test Creation Agent](https://help.mabl.com/hc/en-us/articles/38361400751380-Build-browser-tests-with-the-Test-Creation-Agent)) shows the Trainer is centered on a **numbered, editable Steps window**: interactions record automatically, but the user can **reorder** (drag/drop), **insert at a cursor**, **add steps manually** (assertions, waits, find-element, JS), **replay** individual steps, apply **many assertion constraint types** including **soft assertions**, and use an **AI agent** to build steps from a natural-language outline.

This app's recorder today is **append-only + delete**, with only two assertion kinds (`visible`/`text`), no manual step insertion, no reorder/edit, no replay, and an AI path that emits a whole spec rather than editable steps. This plan closes that gap.

**Confirmed scope (all selected):** editable step list, add-step menu, richer assertions, per-step replay, and step-generating AI.

## Approach

Five phases, each independently shippable and build-green. Phases 1–2 unlock the rest. The core idea: make `session.steps` fully mutable (insert / reorder / update, not just append/delete), give the renderer a rich editable Steps panel, teach the script generator the new step/assert kinds, add a best-effort in-window replay engine, and let the local LLM emit our `Step[]` schema into the live list.

### Shared foundation — data model
`main/recorder/types.ts` and its renderer mirror `renderer/lib/recorder-types.ts` (keep identical):
- Extend `StepType` with `"wait"` and `"viewport"`.
- Extend `LocatorKind` with `"xpath"` (`"css"` already exists).
- Extend `AssertKind` to: `visible | hidden | text | exactText | enabled | disabled | checked | unchecked | value | attribute | count | url | title`.
- Extend `Step` with optional: `soft?: boolean`, `attr?: string` (attribute-assert name), `count?: number`, `width?/height?` (viewport), `waitMs?: number` (wait). Reuse existing `value?`/`text?` for comparison operands.
- Add `cursor?: number` to `RecorderState` (the insert position).

### Phase 1 — Editable step list (mutable session + panel)
**Backend** `main/services/recorder-service.ts` + `main/handlers/index.ts` + `renderer/lib/api.ts`:
- Add a `session.cursor` (default = end). `addStep` inserts at `cursor` and advances it, instead of always `push` (recorded steps still land at the end by default; the cursor lets the user aim insertions).
- New IPC handlers mirroring the existing `recorder:*` registration block (`handlers/index.ts:70-85`) and `api.ts:29-39` wrappers:
  - `recorder:insertStep { step: RawStep, index? }` — assigns id/timestamp, splices in, emits refreshed state.
  - `recorder:reorderStep { stepId, toIndex }` — array move.
  - `recorder:updateStep { stepId, patch }` — shallow-merge editable fields (value/text/url/attr/count/width/height/waitMs/soft/assert/locator).
  - `recorder:setCursor { index }`.
- Because steps can now change arbitrarily, add a `recorder:steps` push (full `Step[]`) emitted after every mutation, so the renderer re-syncs the whole list rather than only appending (the existing per-step `recorder:step` push stays for live capture).
**Frontend** `renderer/main/recorder-store.tsx`, `recording-view.tsx`, `step-row.tsx`:
- Store: subscribe to `recorder:steps` (replace list) and add actions `insertStep/reorderStep/updateStep/setCursor`.
- `step-row.tsx`: add a drag handle + native HTML5 `draggable` reorder (no new dep — WebView supports it; drop computes `toIndex`), an inline-edit affordance (click the value/text → `Input`/`Textarea` in place, commit → `updateStep`), keep the delete X, and render an insert-cursor line (click a gap to `setCursor`).
- Keep `step-row.tsx` presentational-safe for the read-only detail view (gate edit/drag/replay behind props so `test-detail-view.tsx` usage is unaffected).

### Phase 2 — Add-step menu (manual steps)
`recording-view.tsx`: a **"+ Add step"** control (native `window.glazeAPI.Menu.popup`, same pattern as the sidebar + menu documented in PROJECT-CONTEXT "Sidebar actions cannot host a React dropdown") with items: **Assertion, Wait, Go to URL, Press key, Find element (CSS/XPath), Set viewport**. Each opens a small `Dialog` + `Field` form (a new `renderer/main/add-step-dialog.tsx`) and calls `insertStep` at the current cursor:
- Wait → `{ type:"wait", waitMs }` or wait-for-locator.
- Go to URL → `{ type:"goto", url }`.
- Press key → `{ type:"press", value:key, locator? }`.
- Find element → `{ type:"assert", assert:"visible", locator:{k:"css"|"xpath", v} }` (a presence check; doubles as mabl's "Find Element").
- Set viewport → `{ type:"viewport", width, height }` (offer the `VIEWPORT_PRESETS` already in `generate-test-dialog.tsx:40-124`).
`main/services/script-generator.ts` (+ `describe-step.ts` mirror) — add `stepLine` cases: `wait` → `await page.waitForTimeout(ms)` / `await <target>.waitFor()`; `viewport` → `await page.setViewportSize({width,height})`; `xpath` locator → `page.locator("xpath=...")`.

### Phase 3 — Richer assertions + soft assertions
- `capture-script.ts` assert path (`onClick`, ~240-252) + `recording-view.tsx` assert toolbar: replace the 2-option `SegmentedControl` with a menu of the full `AssertKind` set plus a **soft** toggle. Click-to-pick assertions (visible/hidden/text/exactText/enabled/disabled/checked/unchecked) capture from the clicked element; operand assertions (value/attribute/count/url/title) use the add-step form (Phase 2) since they need typed input. For `attribute`, capture `attr` + expected `value`; for `count`, `count`.
- `script-generator.ts` (+ mirror): map each `AssertKind` to its `expect` call (`toBeVisible/toBeHidden/toContainText/toHaveText/toBeEnabled/toBeDisabled/toBeChecked/not.toBeChecked/toHaveValue/toHaveAttribute(attr,value)/toHaveCount/toHaveURL/toHaveTitle`), wrapping in `expect.soft(...)` when `step.soft`.

### Phase 4 — Per-step replay (best-effort in-window preview)
New `main/services/step-replayer.ts` + `recorder:replayStep { stepId } → { ok, error? }`:
- Build a `RESOLVE_SCRIPT` (injected via `webContents.executeJavaScript` on the recording window) that resolves a `Locator` to a DOM element by mirroring the existing capture-script semantics — reuse `roleOf`/`accName`/`cssPath` from `capture-script.ts` (extract the shared helpers so both files use one copy), and add `getByRole/TestId/Label/Placeholder/Text`, css, and `document.evaluate` for xpath.
- Then perform the action (`click`/`fill`→set value + dispatch input/change/`press`/`check`/`select`) or evaluate the assertion, returning `{ok,error}`.
- **Set `data-pw-paused` for the duration of replay** so the replayed interaction is not re-captured, then restore.
- `step-row.tsx`: a ▶ replay button per step (recording-only) that flashes pass/fail from the result.
- **Documented limitation:** replay is a preview using synthetic DOM events, not Playwright's auto-waiting/actionability engine, so it won't perfectly match a real run (matches mabl's "preview a step" intent). Note this in the UI (subtle) and PROJECT-CONTEXT.

### Phase 5 — Step-generating AI
- `renderer/lib/llm-prompts.ts`: add `buildGenerateStepsMessages(ctx)` — a system prompt that instructs the model to output a **JSON array of `Step` objects** (embed the exact schema + locator/assert enums + a good/bad example), given a natural-language outline + starting URL + viewport hints.
- `renderer/lib/parse-llm-response.ts`: add `extractStepsJson(text): RawStep[] | null` — robustly pull the largest valid JSON array and validate each entry against the `StepType`/`AssertKind`/`LocatorKind` enums (drop invalid).
- `recording-view.tsx`: an **"AI: generate steps"** button (visible during a trainer session) opens a prompt input, streams via the existing `useLlmChat`, parses steps on `done`, and `insertStep`s them at the cursor for the user to reorder/edit/replay before stopping. Reuses the whole existing LLM stack (`llm-service.ts`, `use-llm-chat.ts`); no backend LLM changes.

## Critical files
- Data model: `main/recorder/types.ts`, `renderer/lib/recorder-types.ts`.
- Backend session/IPC: `main/services/recorder-service.ts`, `main/handlers/index.ts`, new `main/services/step-replayer.ts`, `main/recorder/capture-script.ts` (extract shared locator helpers; expand assert capture).
- Generator: `main/services/script-generator.ts`, `renderer/lib/describe-step.ts`.
- Renderer API/store: `renderer/lib/api.ts`, `renderer/main/recorder-store.tsx`.
- Renderer UI: `renderer/main/recording-view.tsx`, `renderer/main/step-row.tsx`, new `renderer/main/add-step-dialog.tsx`.
- AI: `renderer/lib/llm-prompts.ts`, `renderer/lib/parse-llm-response.ts`.

## Reuse (don't reinvent)
- Locator computation (`roleOf`/`accName`/`cssPath`/`locatorFor`) already in `capture-script.ts` — extract and share with the replayer.
- Native menu pattern (`window.glazeAPI.Menu.popup` + `commandId` switch) from `library-sidebar.tsx` for both the +Add-step and assert-kind menus.
- `VIEWPORT_PRESETS` in `generate-test-dialog.tsx:40-124` for the set-viewport form.
- Full LLM stack: `llm-service.ts`, `use-llm-chat.ts`, `buildGenerate*` in `llm-prompts.ts`, `parse-llm-response.ts`.
- `SLOW_MO_MS`/speed handling and `playwright-runner.ts` unchanged.

## Verification (per phase, end-to-end)
- After each phase run the build (lint + type-check + build must pass) before moving on.
- Live-inspect the running app for the recorder UI: start a "Train manually" session, then in the trainer window's Steps panel confirm — **P1** reorder via drag, inline-edit a fill value, insert cursor moves; **P2** each +Add-step form inserts the right step and it appears in the generated Script tab after stopping; **P3** each new assertion kind + soft toggle emits the correct `expect`/`expect.soft` line; **P4** ▶ replay on a click/fill/assert step flashes pass/fail in the live window without adding a stray recorded step; **P5** "AI: generate steps" inserts valid editable steps from an outline.
- Cross-check generated specs actually run via `runner:run` for a representative test containing new step kinds (wait, viewport, a soft assertion, an xpath find-element).
- Confirm `test-detail-view.tsx` (read-only step list) is unaffected — no drag/edit/replay controls leak into it.
- Update `.glaze_memory/PROJECT-CONTEXT.md` (Current State + a Recent History entry) after completion.

## Risks / notes
- **Replay fidelity** (Phase 4) is synthetic-event best-effort, not real Playwright — framed as a preview.
- **AI step quality** (Phase 5) depends on the local model; invalid entries are dropped, and steps are editable before spec generation, so bad output degrades gracefully.
- No new npm dependencies (native HTML5 drag for reorder; no dnd lib).
- Scope is large — recommend building and reviewing phase-by-phase rather than all at once.
