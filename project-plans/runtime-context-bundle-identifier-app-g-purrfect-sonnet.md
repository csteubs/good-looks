# Plan: Headless browser mode for test runs

## Context

Today every test **run** launches Playwright headed (a visible browser). The renderer hardcodes the run as headed even though the plumbing already threads a `headed` flag all the way down: `runner:run` → `playwrightRunner.start({ headed })` → appends `--headed` only when true (`main/services/playwright-runner.ts:408`); omitting the flag runs headless. We want to let the user opt into **headless** runs.

Scope is **test runs only** — it must not touch the trainer / recording / "Edit in Trainer" / "Edit Steps" flow (the `recorder:*` channel family and its in-window replays), which are visible by design. Because the two areas are cleanly separated by IPC family (`runner:*` = runs, `recorder:*` = trainer), keeping the option out of Edit-App areas is automatic: we only change run-path code.

Per the user's choice, mirror the existing **"Capture screenshots"** feature exactly: a **global default** in Settings **plus a per-run checkbox** next to "Run test" (persisted per test). Default is **headed** (headless off) to preserve current behavior.

## Approach

Reuse the `captureArtifacts` pattern end-to-end, adding a parallel `runHeadless` flag.

### 1. Types — add the fields (mirror `captureArtifacts`)
- `main/recorder/types.ts`: add `defaultRunHeadless: boolean` to `RecorderSettings`; add optional `runHeadless?: boolean` to `TestRecord` (the record interface near line 154/188 that already has `captureArtifacts?`).
- `renderer/lib/recorder-types.ts`: same two additions (the renderer mirror at lines ~117/135/225).

### 2. Settings store — persist the global default
`main/services/recorder-settings-store.ts` — copy the `defaultCaptureArtifacts` handling into `defaultRunHeadless`:
- `DEFAULT_SETTINGS`: `defaultRunHeadless: false`.
- `read()`: `typeof parsed.defaultRunHeadless === "boolean" ? parsed.defaultRunHeadless : DEFAULT_SETTINGS.defaultRunHeadless`.
- `set()`: merge line `update.defaultRunHeadless !== undefined ? update.defaultRunHeadless : current.defaultRunHeadless`.
- Add to the `logger.info` payload.

### 3. Per-test persistence — new IPC handler + api wrapper (mirror `tests:setCaptureArtifacts`)
- `main/handlers/index.ts`: add `tests:setHeadless` handler copied from `tests:setCaptureArtifacts` (index.ts:187-197) — set `rec.runHeadless`, bump `updatedAt`, `testStore.save`, return `rec`.
- `renderer/lib/api.ts`: add `setHeadless: (id, runHeadless) => ipc().invoke<TestRecord>("tests:setHeadless", { id, runHeadless })` under `tests` (next to `setCaptureArtifacts`, api.ts:113).

### 4. Run invocation — feed the flag through
- `renderer/main/recorder-store.tsx`:
  - Extend the `run` type + callback signature (lines 133, 406) to `run(id: string, captureArtifacts?: boolean, headless?: boolean)`.
  - Change the invoke (line 408) from `api.runner.run(id, true, captureArtifacts)` to `api.runner.run(id, !headless, captureArtifacts)` (headed = not headless).
- `renderer/lib/api.ts` `runner.run` and the `runner:run` handler / `playwrightRunner.start` already accept and thread `headed` — **no change needed** below the renderer.

### 5. Per-run checkbox — Run-tab UI (mirror capture-screenshots checkbox)
`renderer/main/test-detail-view.tsx` (Run test button lives at lines 215-238; capture pattern at 56-74):
- Add local state `runHeadless` + `headlessInited`, initialized once from `test.runHeadless ?? settingsQuery.data?.defaultRunHeadless ?? false` (copy the `captureArtifacts` `useEffect` at 69-74).
- Add a second `<label><Checkbox …/>Run headless</label>` beside the "Capture screenshots" checkbox (215-229): on change, `setRunHeadless(next)` and `api.tests.setHeadless(id, next).catch(()=>{})`, `disabled={runInfo?.running}`.
- Update the Run button (line 235) to `run(id, captureArtifacts, runHeadless)`.

### 6. Global toggle — Settings UI (mirror "Capture screenshots by default")
`renderer/settings/settings-view.tsx`: in the run-scoped `FieldSet` (~398-452, which already holds "Default run speed" and "Capture screenshots by default"), add a `<Field orientation="horizontal">` + `<Switch>` row "Run tests in headless mode" wired to local state seeded from `getSettings()` and a `handleRunHeadlessChange` that calls `api.recorder.setSettings({ defaultRunHeadless: checked })` (copy the `handleShowUrlBarChange` pattern at 107-114). Description: e.g. "Runs tests without opening a visible browser window. Only affects test runs, not the trainer." This keeps it clearly run-scoped.

## Out of scope (do NOT touch)
Trainer / Edit-App files: `recording-view.tsx`, `edit-steps-view.tsx`, `add-step-dialog.tsx`, `refine-selector-dialog.tsx`, `generate-steps-dialog.tsx`, `step-row.tsx`, and all `recorder:*` handlers / `recorderService.start` / trainer replay (`replayStep`/`replayAll`/`replayFromCurrent`). Headless does not apply there.

## Verification
1. `BuildApp` (lint + type-check + build) green; launch the app.
2. Settings: confirm the new "Run tests in headless mode" switch appears in the run FieldSet, toggles, and persists across reopen (`recorder-settings.json` gets `defaultRunHeadless`).
3. Test detail view: confirm a "Run headless" checkbox sits next to "Capture screenshots", reflects the global default for a test with no saved preference, and persists per-test after toggling + reopening the test.
4. Run a saved test with headless **on** → no visible browser window appears, output still streams and pass/fail is reported. Run with headless **off** → browser window appears as before.
5. Confirm the trainer / "Edit in Trainer" still opens a visible browser regardless of the headless setting.
