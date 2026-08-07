# Decisions

A dated record of what changed and, more importantly, *why* — the constraint
that forced a design, the alternative rejected, the bug a guard exists to
prevent. Newest first.

This is the reasoning that does not survive in the diff. When something below
looks over-built, the entry usually explains which failure it was built against.

Companion documents: [ARCHITECTURE.md](ARCHITECTURE.md) for the current per-file
map, and [../CLAUDE.md](../CLAUDE.md) for the working rules and conventions.

**Add an entry when a change involved a real decision** — a trade-off, a
rejected alternative, a non-obvious constraint. Routine work does not need one;
the commit message carries it. Entries up to 2026-08-06 were written by the
Glaze app's agent, which no longer works on this codebase.


### 2026-08-06 — Conditional waits ("Wait until"), and the comment that makes them survive a round trip

**Goal:** the trainer could only wait for a fixed duration or for an element to appear. Add a third form — wait until a measurable condition holds, with the same vocabulary as assertions — and let the user pick more than one wait property at a time.

**The load-bearing problem is not the feature, it's the round trip.** Playwright has a native waiting API for exactly three of the twelve predicates: `locator.waitFor({ state: "visible" | "hidden" | "attached" })`. For everything else — enabled, checked, contains-text, has-value, count, URL, title — the only auto-retrying primitive *is* `expect`. So "wait until the button is enabled" and "assert the button is enabled" compile to the identical call. That matters because `tests:updateScript` re-parses the whole spec back into steps on every hand edit and every applied AI fix: without something to tell the two apart, every conditional wait silently returns as an **assertion**. The step's type changes under the user, the Steps tab now describes something different from what they built, and nothing throws.

**Chosen: a trailing `// wait until` marker, and `stripComments` preserves it.** The generator appends it to the `expect`-based waits only; the parser reads it off the statement's line and routes those to `wait` steps. Three things make this cheap rather than clever: the parser already had exactly this exception for `// disabled — skipped:`, so the mechanism is not new; a hand-written `expect` carries no marker and correctly stays an assertion; and the marker is inert to Playwright. `spec-parser.check.ts` pins both directions, because a marker the generator emits and the parser doesn't read is worse than no marker at all.

**Rejected — plain `expect`, no marker.** Simplest generated code, and the failure mode is entirely silent: waits decay into assertions one script-edit at a time. **Rejected — restricting the feature to the three native predicates.** Perfect fidelity, no marker, but it drops enabled/checked/text/count, which are most of the reason to want a conditional wait.

**Two bugs found while writing the parser side, both silent and both inverted.**
- `.waitFor({ state: "hidden" })` parsed as a *bare* wait — the state was dropped — and a bare wait regenerates as `.waitFor()`, which waits for **visible**. Round-tripping a hidden wait through a script edit produced its exact opposite.
- The browser's right-click **"For element hidden"** had the same inversion at the other end: `waitMode: "hidden"` was mapped into the dialog's element mode, which emits the same visible-wait. The menu said hidden, the test waited for visible, and nothing on screen disagreed. Both are now `waitUntil: "hidden"`, and `state: "detached"` — which the step model has no counterpart for — is reported as *unclassified* (surfacing as `stepsDiverged`) rather than being flattened into a wait that means something else.

**The marker check had to be anchored on the statement, not on the scan cursor.** First implementation read the "current line" from the parser's position `i`, which is wherever the *previous* statement stopped — usually before the newline that precedes this one. It found the end of the previous line every time, so `isWait` was always false. Every marker-based case failed on the first run of the new check; that is the whole argument for writing the round-trip assertions before believing the feature works.

**Multiple waits are separate steps, not one compound step.** The dialog's three properties became checkboxes and one submit emits one `wait` step per ticked box — element, then condition, then duration. `onAdd` already took a `RawStep[]` (the `if`/`endif` pair uses it), so this cost nothing in the data model. A single compound wait step would have needed new generator, parser and replayer branches, plus an internal ordering the UI has no way to show, and it would have made the trainer's per-step reorder/edit/delete meaningless for waits. Order is fixed and tested: the duration is a settle pad, and a pad emitted before the thing it pads is just a delay. A ticked box with no element picked refuses the **entire** submit — emitting the other two and dropping that one delivers something quietly different from what was asked for.

**"An element" was kept even though "Wait until → element is visible" subsumes it.** It is the shortest path for the common case, it is what the right-click menu targets, and removing it would have migrated every wait step already recorded for no user-visible gain.

**Timeouts fail the step, and `timeoutMs` is treated as an injection sink.** Default 10s (longer than Playwright's 5s `expect` default — someone reaching for an explicit wait is usually waiting on something slower than the default already covers), emitted as `{ timeout: N }`. A user who wants a non-fatal wait ticks the existing per-step "Continue on failure" rather than getting a second, overlapping control. `timeoutMs` is concatenated into source as a bare numeral — the same sink shape that made `count` an RCE — so it goes through `int()` at the boundary *and* `num()` in the generator. Both halves are pinned separately in `check:step-ingest`, because `recorder:updateStep` copies its allowlisted fields without re-normalizing, which leaves the generator as the only guard on that path.

**The replay preview polls, and caps at 5s.** `runWaitUntil` re-checks every 100ms and returns a Promise. The cap is deliberate and matches the one the fixed-duration wait has always had: the trainer's UI awaits this call, so honouring a legitimate 60s timeout in the preview would be indistinguishable from a frozen app. The log line says when it capped, so a preview timeout is not mistaken for a real one.

**Coverage:** `check:step-ingest` (forged `timeoutMs` and unknown `waitUntil`, at the boundary and at the generator; plus that widening the wait vocabulary did not widen what an `if` condition accepts), `check:spec-parser` sections 7–9 (every predicate round-trips **byte-identically**, an unmarked `expect` stays an assertion, `.waitFor({state})` keeps its state, a disabled conditional wait keeps its predicate through the comment-inside-a-comment case), a new `add-step-dialog.test.tsx` (emission count and order, refusal on a targetless box, the right-click hidden fix), `step-replayer.dom.test.ts` (passes on a later poll, times out with a diagnosable message, honours the cap), plus the `describeStep` parity and `stepSignature` cases. Every one was verified to fail with its fix reverted — including a deliberate re-order of the emitted steps, which is the property a reader is most likely to assume is untested.

### 2026-08-06 — Invented Tailwind token names replaced with real design-system ones

**Symptom:** 27 class names across seven renderer views (`border-token-border`, `bg-token-surface-raised`, `bg-token-surface`, `bg-token-hover`, `ring-token-border`) were never defined by the Glaze design system. Tailwind emits nothing for an unknown utility, so they had been styling nothing — cards with no fill, list rows with no hover, a screenshot with no outline. Nothing catches this: it is not a type error, not a lint error, and the views render perfectly well without the rule.

**It is only visible in the build output.** The check that matters is grepping the emitted `build/assets/styles-*.css` for the rule, not reading the source — a plausible-looking class name and a real one are indistinguishable in a `.tsx`. Baseline: zero `.border-token-border` / `.bg-token-surface*` / `.bg-token-hover` rules, while every real utility used on the same lines (`border-accent`, `text-tertiary`, `bg-control-subtle`) was present. The same grep after the fix is what confirms it.

**`border-separator`, not `border-secondary`.** Both resolve to `var(--fg-10)`, so the choice is about consistency, not colour: the repo already used `border-separator` 62 times and `border-secondary` zero, for card outlines *and* row dividers alike (`generate-test-dialog.tsx`, `a11y-panel.tsx`, `variables-panel.tsx`). Splitting the two by role here would have introduced a distinction the rest of the codebase does not make.

**`bg-panel` for raised cards — and why the obvious measurement of it is wrong.** Rendered against a white page, `bg-panel` measures *identical* to the window background (ΔE=0), which reads as "this token does nothing". It is not an artifact of the token: `--color-surface-panel` is `--bg-secondary-40` and `--color-window-bg` is `--bg-40`, and the SDK defines `--bg-secondary` and `--bg` to the same value in both themes — so a panel is literally the window's own background token applied a second time. That only produces a visible surface because the WebView has **no opaque background of its own** and both layers composite onto the native macOS window material. Measured over a representative material the card reads at ΔE 8.7 (light) and 13.9 (dark) against the app background. Worth knowing: if this app ever sets an opaque window background, every `bg-panel` surface silently flattens.

**Two sites did not take the general mapping.**
- The floating "Apply to all steps" chip in `visual-view` was `bg-token-surface-raised/90`, over an arbitrary user screenshot. It became `bg-popover` rather than a 90%-opacity `bg-panel` — the SDK's own note on `--color-surface-popover-hover` says elevated chips need solid fills "because translucent fills would let content show through".
- The screenshot's hairline used `ring-token-border`. There is no themed `--color-border-*`, so `ring-border-separator` would not generate either — `ring-*` resolves from the `--color-*` theme namespace, and the border roles live in `:root` instead. It uses `ring-[var(--color-border-separator)]`, which the SDK's VAR-SAFETY comment explicitly sanctions: semantic role tokens are real `:root` declarations and are safe to read through raw `var()`.

**`script-view.tsx` was left alone.** Its `text-[var(--color-token-primary)]` syntax-highlighting classes match the same `-token-` grep but are a different thing entirely — arbitrary-value utilities over `--color-token-*`, which the SDK really does define (light and dark). They emit CSS and work.

**Verifying both themes needs `.dark` on the root, not on a container.** A subtree `.dark` does not work with this design system: custom properties are substituted where they are *declared*, so `--color-window-bg: var(--bg-40)` resolves against `:root`'s seeds and inherits down as an already-computed value; overriding `--bg` further down cannot retroact. A first attempt at side-by-side light/dark panes silently produced two identical light renders. Each theme has to be rendered in its own pass.

**Coverage:** none added. The defect is a property of the emitted stylesheet, which no unit test in either project observes; the guard that would actually work is a source-level `check:*` that validates every `bg-*`/`border-*` class in `renderer/` against the `--background-color-*` / `--border-color-*` names declared in the SDK's `components.tailwind.css`. A prototype of that check agrees exactly with the build output — it flags the two remaining dead classes (`bg-muted` in `settings-view.tsx`, `bg-fill-secondary` in `library-sidebar.tsx`) and nothing else — but it was left out of this change as out of scope. `bg-separator` is NOT dead despite emitting no bare rule: it is only ever used under a named-group variant, so it compiles to `.group-hover\/gap\:bg-separator`.

### 2026-08-06 — Deleting a tag, from the Batch view's tag cluster

**Goal:** Tags could be created and edited (sidebar → Edit Tags…) but never
removed from the library. A typo or an abandoned grouping stayed in the chip row
forever, and clearing it meant opening every test that carried it — which is
also how you'd never be sure you got them all.

**What was done:** The Batch view's chip row moved to `renderer/main/tag-cluster.tsx`
as a bordered cluster, each real tag carrying an X behind a confirmation that
states how many tests use it and names them. New `tests:deleteTag` handler over
a new `testStore.removeTag`.

**Key decisions:**

1. **Delete lives with the tag vocabulary, create lives with the test.** Creating
   stayed in the sidebar dialog — that's where you know which test you're
   labelling. Deleting is library-wide, and the cluster is the only place the
   whole vocabulary is visible at once *with counts*, which is what makes the
   scope of the act legible.

2. **The count is the point of the confirmation, not politeness.** A tag is the
   batch's grouping key: deleting one silently re-scopes what "run smoke" means.
   And unlike editing one test's tags, it can't be undone by re-typing — the tag
   is gone from N tests and nothing remembers which. So the dialog leads with the
   count and lists the affected test names (capped at 8, then "+N more").

3. **One backend call, not a renderer loop over `tests:setTags`.** A loop
   rewrites `tests.json` once per test and can strand the tag on half the library
   if a call fails partway. `removeTag` does one `writeAll`.

4. **Hidden tests are included, and that's why the toast doesn't echo the
   preview.** `testStore.list()` filters hidden tests out, so a tag left on one is
   invisible right up until the test is unhidden — at which point a deleted tag
   reappears. `removeTag` therefore reads through `readAll()`. The renderer can't
   see those tests, so its dialog count is a lower bound; the toast reports the
   backend's real number instead of repeating what it guessed.

5. **Matching is case-insensitive**, because `tagCounts` groups `smoke` and
   `Smoke` into one chip. Deleting that chip case-sensitively would leave the
   other spelling behind and the chip would return with a count of 1.

6. **The X is a sibling button, not nested in the filter button.** A `<button>`
   inside a `<button>` is invalid markup that swallows the inner click, so the
   chip is a `<span>` holding both. The X is also the `AlertDialog`'s own trigger,
   which means no open-state to keep in sync and focus returns to the chip on
   cancel.

7. **Visible at rest, not revealed on hover.** A hover-only X on a pill this
   small is undiscoverable, and it's the entire affordance. It stays muted next
   to the count; the red wash on its own hover is what carries "destructive".

**Incidental finding:** the `border-token-border` / `bg-token-surface-raised` /
`bg-token-hover` class names used throughout `renderer/` are **not** utilities the
design system defines — they generate no CSS and have been silently doing nothing.
Verified against the built stylesheet. The real names are `border-secondary`,
`bg-well`/`bg-panel`, `bg-list-hover`, etc. `tag-cluster.tsx` uses the real ones;
the rest of the renderer was left alone as out of scope.

**Verification:** `handlers.test.ts` gained 5 tests for `tests:deleteTag`
(case-insensitive removal, hidden tests, canonicalization, hostile input, unused
tag) and `tag-cluster.test.tsx` 12 for the UI. Both suites were confirmed to fail
against reverted behaviour: injecting an X that deletes without confirming, an X
on "All", a case-sensitive count, and a toast echoing the preview each broke the
test that guards it. Rendered against the real built stylesheet in light and dark
to confirm the cluster and the X's states read correctly.

### 2026-08-06 — Showing which steps an AI change added

**Symptom:** applying an AI-debug fix rewrote the spec, and the Steps tab quietly re-rendered a different list. Right steps, right order, no error — and nothing at all saying what had changed. The apply usually happens from the AI panel while the user is looking at the Run tab, so by the time they reach Steps the change is already history. Inserting an AI-generated flow in the trainer had the same shape: the list just got longer, often past the scroll.

**Why the diff has to be content-based.** `tests:updateScript` re-parses the whole spec, and `spec-parser.ts`'s `makeStep` calls `randomUUID()` for **every** step on **every** parse. After an apply that changed one line, all N ids differ — so a diff by id marks the entire list as new, which is exactly as uninformative as marking none of it. The only thing that survives an apply is what a step *says*, so `renderer/lib/diff-steps.ts` compares an explicit signature of the user-visible fields. The alternative — making the parser preserve ids — was rejected: it would put the burden of a display concern on the security-sensitive parse path, and id stability across a re-parse is a much stronger claim than this feature needs.

**The signature is a field list, not "the step minus id and timestamp".** Both directions have a failure mode; they are not symmetric. Enumerating means a field added to `Step` later is invisible to the diff — a *missed* highlight, which degrades to today's behaviour. Stripping means every future field is automatically significant, so one backend field that happens to be recomputed on parse would light up every row, permanently, with no obvious cause. A quiet under-report beats a loud wrong one.

**Moves are cancelled against removals, one for one.** The bare LCS reports a reordered step as a removal plus an addition, so dragging a row would have claimed the AI added it. Each addition cancels against at most one identical removal — a `Set.has` would have swallowed a genuinely new duplicate whose twin happened to move in the same pass.

**A substitution glows its replacement.** The most common AI fix is a swapped selector, and the resulting step is one the user has not seen. Counting it as "the same step, edited" would hide precisely the row they need to look at.

**Deletions are unstyled, deliberately.** There is no row left to decorate, and decorating the neighbours would point at the wrong step. The step count on the tab is what carries removals — for additions, deletions and substitutions alike.

**Inset outline, not border, and only `outline-color` animates.** Both were bugs before they were decisions. A real border participates in layout, so rows jump by 2px when the highlight clears, and it collides with the drag-over `border-t-2` on the same element at equal specificity — decided by stylesheet order rather than intent. And an earlier version pulsed a `box-shadow` glow, which silently erased the selection and run-status highlights: those are `ring-*` box-shadows, and an animation owns the whole property. Animating something nothing else uses is what lets a step be new **and** failing at once — the single most interesting row on the screen, where neither highlight may hide the other.

**Not on a timer.** The obvious design is to fade the highlight after a few seconds. That fails the actual usage: the apply happens on a different tab, so the timer would expire before the user ever looked. It clears when the claim stops being true instead — the next apply, a hand edit of the steps, a new recording session.

**Generated steps get their own insert path.** `insertStep` *clears* the highlight, because a hand edit retires it; routing AI-generated steps through it would leave them unmarked however good the diff is. `insertGeneratedSteps` sends them sequentially (each insert lands at the session cursor and advances it) and then re-reads `getSteps()` rather than waiting on the `recorder:steps` push — invoke replies and pushes are different channels with no ordering guarantee, and a diff run a beat early marks only the first inserted step. It diffs what actually landed, since backend normalization can reject a step the model produced.

**Found while wiring it:** the Steps tab trigger is gated on the list being non-empty, and `TabsRoot` was uncontrolled. An apply that deleted every step removed the trigger while its content stayed selected, leaving an empty pane with nothing active in the tab bar. The tabs are now controlled with a fallback to Script.

Guarded by `renderer/lib/diff-steps.test.ts`, the new blocks in `step-row.test.tsx` / `test-detail-view.test.tsx` / `recorder-store.test.tsx` / `recording-view.test.tsx` / `ai-debug-icons.test.tsx`, and `check:step-glow` — which pins the stylesheet, the outline-not-border and outline-color-only choices, and the insert-path wiring, none of which jsdom can observe.

### 2026-08-06 — Window size preset in the New Recording dialog

**Symptom:** the New Recording dialog asked for a URL, a test name and a run speed, and gave no way to say how big the browser window should be. Every manual recording was made in one fixed 1200×820 window, so a mobile or tablet flow could not be recorded at all.

**The decision that mattered — the preset sizes the window AND the test.** Sizing only the trainer window would have been the smaller change and the wrong one: the recorded steps carry no size, so the generated spec runs at Playwright's own default (1280×720). A flow recorded against a 390-wide mobile layout would then replay against the desktop layout — different DOM, different locators, and a failure that points at the locators rather than at the size. So a chosen preset is also recorded as the session's **first `viewport` step**, before the `goto`. Before, not after: `setViewportSize` after `page.goto` means the first paint, and anything the site decides from it, happens at the wrong size. This also matches what the LLM prompts have required of generated specs since 2026-08-03 — viewport first, exact dimensions — so recorded and generated tests now describe their size the same way.

**`useContentSize: true`, not a plain width/height.** With a preset the numbers are the PAGE size, because that is what the recorded viewport step replays at; sizing the native frame instead would leave the page short by the title bar's height and the window would disagree with the step the same call just recorded. Verified `useContentSize` is actually implemented in this SDK (it reaches the native `window.create` call) rather than assumed from Electron. The OS still clamps a window bigger than the display — a 1440×900 preset on a 1440×900 screen records at a slightly smaller page — so the size is logged at session start, and the recorded step, not the window, is authoritative.

**Re-opening a test takes its size from the test, not the dialog** (`recordedViewport(steps)`, first viewport step — a later one is a mid-test resize, not the size the run starts at). Otherwise "Edit in Trainer" on a mobile test would drop it into a desktop-width window and capture new steps against a layout that test never runs at. No second viewport step is added on that path.

**Persisted as `{width,height} | null`, not a preset id.** The picker list then lives in exactly one place — `renderer/lib/viewport-presets.ts`, now shared with the Generate-from-prompt dialog, which had its own copy of the same five sizes — and the backend validates two numbers instead of an id vocabulary it would have to keep in sync. A stored size matching no preset (hand-edited file, or a preset dropped in a later version) falls back to "Default" so the trigger is never blank. `null` is a real choice, so the settings merge applies the update whenever the key is PRESENT; a truthiness test would have made returning to the default size impossible.

**Normalized, not cast.** The numbers arrive over IPC and end up in a native window call and interpolated into generated source, so `normalizeViewport` rebuilds them: non-numeric, non-finite, non-positive and half-specified sizes are `null`, and the rest are rounded and clamped. A half-specified size is rejected rather than completed from the other axis — guessing would silently record a size the user never chose. `script-generator`'s `num()` remains the second guard, per the capture-boundary rule.

**Interaction with the docked trainer panel (found on merge, not by a test).** The panel landed on `main` while this was in review, and the two features cancel each other out: `computeDock` is deliberately total-preserving — it splits the training browser's footprint rather than growing it, "because the user picked how much screen the training browser takes and docking a panel is not a licence to take more." That premise holds for a width the user dragged and fails for a width the test replays at. Docking a 360pt panel against a 390-wide mobile recording left the page rendering at 600 (the browser floor) while the recorded `viewport` step still said 390 — silent, and exactly the divergence the preset exists to prevent. `computeDock` gained a `preserveBrowserWidth` option: the browser keeps its width, the pair's total grows instead, and when that no longer fits the display it returns `null` so the panel opens **undocked** — an outcome the caller already handled — rather than quietly resizing what it was told not to. The `BROWSER_MIN_WIDTH` floor is deliberately not applied in that mode: it exists to stop docking from *accidentally* forcing a mobile layout, not to forbid one the user explicitly chose. Two consequences that would each have been a separate silent bug: `undock` must not hand back width it never took (it would push the browser *past* its preset), and the `viewportNarrowed` warning must not fire when nothing narrowed.

**Interaction with the insert cursor (same merge, second collision).** `initialCursor` landed on `main` to put a continuing session's cursor "just past the goto", implemented as `min(1, stepCount)` — correct while the navigation was always index 0. A test recorded at a preset opens with a `viewport` step, so its goto is at 1, and a cursor of 1 would drop every newly captured step BETWEEN the viewport and the goto: recorded before the page had been navigated to at all. `initialCursor` now takes the STEPS and finds the navigation (`findIndex(type === "goto")`) rather than assuming its index — same contract, stated as the rule instead of the layout that happened to satisfy it. Its existing cases were kept, translated to step lists.

**Coverage:** `main/recorder/window-size.test.ts` (the pure rules, plus source-level pins on the service wiring — viewport-before-goto, `useContentSize`, editing-takes-its-own-size — since `start()` creates a real BrowserWindow and can't be invoked in a test) and `renderer/main/new-recording-dialog.test.tsx` (the preset reaches `start` as the 4th argument, and "Default" passes `null` rather than a fabricated 1280×800). Both verified to fail when the viewport argument is dropped from the dialog's `start` call. The SDK's `Select` is native-menu-backed so the picker can't be driven in jsdom; the persisted setting is what puts a preset in play, which is also the path a returning user takes.
### 2026-08-06 — Trainer waits for its step list, and opens the cursor after the navigation

Three defects around opening a trainer session, found together.

- **A window that opened mid-session never got the steps.** `recorder:steps` is a PUSH whose first fire happens inside `recorder:start`, before the training browser has even loaded. The docked trainer panel is created later (once the page is ready), so it missed that broadcast entirely and showed an EMPTY step list for a test with a dozen steps — until the user happened to mutate something, at which point they all appeared. Fixed by adding `recorder:getSteps` and having the store ASK on mount as well as listen. A push is not a substitute for being able to ask; any future window inherits the fix.
- **Controls were live before the steps were.** `controlsDisabled` gated only on `pageReady`, which is about the BROWSER, not about this window's data. Every trainer control acts relative to the step list — the insert cursor decides where the next captured step lands — so acting before it arrives inserts at the wrong position or does nothing, both silently. Now gated on a `stepsLoaded` flag as well, in both trainers. The status badge reads "Loading steps…" rather than leaving a "Recording" badge above a row of dead controls, which reads as a broken trainer.
- **The insert cursor started at the END of the test.** Opening a session executes exactly one thing — the initial navigation; no recorded step is replayed (that auto-replay was removed earlier for flying through the whole test). So the session's position is "just past the goto", but the cursor defaulted to `existingSteps.length`. Recording three clicks at the start of a checkout flow appended them after the final assertion: nothing errors, every step is present, and the order is wrong until the test runs. `initialCursor(editing, steps)` now returns the position just past the navigation when continuing an existing test. A NEW recording still passes an empty list and its `goto` advances the cursor through the normal insert path, so both cases converge on one rule rather than two. *(Amended when the window-size preset merged in: it takes the STEPS and finds the goto with `findIndex` rather than assuming index 0, because a test recorded at a preset opens with a `viewport` step ahead of the navigation — see that entry.)*

- **Confirmed NOT broken:** nothing auto-runs a recorded step on open. `replayStep` / `replayFromStart` / `replayAll` / `replayFromCurrent` are reachable only from an explicit user action; the initial navigation is the only thing executed.
- **Files:** `main/recorder/types.ts` (`initialCursor`) + `initial-cursor.test.ts`, `main/services/recorder-service.ts`, `main/handlers/index.ts`, `renderer/lib/api.ts`, `renderer/main/recorder-store.tsx`, both trainer views + all three test suites.
- **Verified:** `lint`, `type-check`, `test:all` (825 tests) and `build` green. Mutation-tested per CLAUDE.md: restoring the end-of-list cursor fails 1 test, dropping the `stepsLoaded` gate fails 1 test in each trainer, and removing the catch-up fetch fails 2 store tests.

### 2026-08-06 — Replay is a return arrow, not a play triangle

- **Symptom:** in the docked trainer panel, "Replay from the current step" and the pause/resume control sat side by side as two identical ▶ triangles.
- **Why it hid:** the neighbour is a TOGGLE. While recording it draws a pause bar, so the pair looks fine; the collision only appears once the user pauses and the button becomes a play triangle. Both controls render correctly and both have correct accessible names, so nothing in the DOM is wrong — the two are simply indistinguishable to look at, while doing very different things (replay the recorded steps vs. carry on recording). The panel's tool row is icon-only at ~360px, so the glyph is the entire signal and the label is a tooltip you get after hovering.
- **Fix:** `RotateCcw` (a return/repeat arrow) for replay, in **both** trainers. The main window keeps a text label so it never had the collision, but the same action must not wear a different glyph in the two windows — and if that row ever tightens to icon-only, the bug would arrive silently.
- **Testing:** icons are asserted by GLYPH, not by label. Every lucide icon ships a `lucide-<kebab-name>` class, which is the only thing in the DOM naming the shape the user sees; accessible names are useless here precisely because the bug is two differently-labelled controls drawing the same picture. `glyphOf()` reads that class in both suites. Beyond pinning the specific pair, `trainer-panel-view.test.tsx` asserts the whole tool row has no duplicate glyphs, so a future tool reusing one fails without anyone remembering this entry.
- **Files:** `renderer/trainer/trainer-panel-view.tsx`, `renderer/main/recording-view.tsx`, + both test suites (6 new tests).
- **Verified:** `lint`, `type-check`, `test:all` (809 tests) and `build` green; reverting the icon turns 3 panel tests and 2 main-window tests red.

### 2026-08-06 — "Check accessibility" never reported anything: a closure that didn't survive the page boundary

**The symptom:** the per-test toggle and the global default both worked, runs
took visibly longer with it on, and no result ever appeared anywhere — no
badges in the replay, no accessibility line in Stats. The run log carried
`[glaze-a11y] check failed: ReferenceError: MAX_VIOLATIONS is not defined`,
43 times across the retained logs.

**The cause:** `runAxe` in `capture-fixture-source.ts` closed over the fixture's
own `MAX_VIOLATIONS` / `MAX_NODES` from inside a `page.evaluate` callback.
`page.evaluate` serializes its callback to source and re-evaluates it **in the
page**, which keeps no scope from the fixture module — so the compaction step
threw. The caps are now passed as an argument instead.

**Why it stayed invisible for so long, which is the part worth remembering:**
every safety property of this feature worked exactly as designed and each one
removed a signal. The throw happened *after* `axe.run` resolved, so the run paid
the full cost and looked busy. `runAxe` never throws by design — accessibility is
reporting, not a gate — so it returned `null`. `null` is also the legitimate
"axe was never injected" answer, so nothing downstream could tell the two apart:
the manifest got no `a11y` entry, `enrichWithA11y` had nothing to enrich, the
replay had no payload to badge, and `capture-overhead.ts` counts a run as an
accessibility run only when `a11yChecks > 0` — which was always 0 — so Stats
stayed silent too. A feature can be fully built, fully tested, and still report
nothing, if the one unguarded step is the one that crosses into the browser.

**Why the suite missed it:** `check:visual-pipeline` seeds manifest entries
directly and drives the diff/baseline logic without a browser — which is what
makes it fast and is still right. Nothing evaluated the fixture's axe callback
the way Playwright does. `capture-fixture-a11y.dom.test.ts` now extracts `runAxe`
from the shipped string and runs it against a fake `page` whose `evaluate`
**deliberately re-evaluates the callback from its source**, reproducing the scope
loss. Writing that fake the obvious way — calling the callback directly — passes
against the bug, so the isolation is the test.

**Rule this generalizes to:** a `page.evaluate` / `addInitScript` callback is a
boundary as real as the capture boundary in `CLAUDE.md`. Nothing from the
enclosing module reaches the other side; pass it as an argument, and test it by
evaluating what ships.

**Then the reason it took months to notice, fixed as its own problem.** The bug
was cheap; being unable to see it was not. Between the toggle (on the test) and
the results (in the Visual view) there was nothing at all, so three different
situations produced one identical observation: nothing.

- **`describeA11yOutcome`** (`a11y-diff.ts`, pure) writes one line into the run's
  own Output panel, next to the existing "Capturing screenshots" / "Recording
  console and network" notices — plus a matching "Checking accessibility for
  this run" before it, since a check that only announces itself by making the
  run slower announces nothing. The line states the number of **completed**
  checks separately from what was found, and **zero completed checks is reported
  as a fault**, never as "no issues found". That distinction is the whole point:
  it is the sentence that would have surfaced this bug on day one, and the test
  that pins it is the first one in its block.
- **The Visual run list** now marks runs with unaccepted violations. The count
  (`a11yNewSteps`) had been computed, stored and shipped to the renderer since
  the feature landed, and read by nothing — so a run that was visually identical
  but newly inaccessible was indistinguishable from a clean one without opening
  it. Its own `Accessibility` icon rather than the existing `Eye`: "something
  changed visually" and "something is inaccessible" send you to different places.

**The general lesson, worth more than the fix:** a result that is only visible
somewhere the user has no reason to look is not a result. Both halves of this —
the swallowed error and the invisible output — were failures of the same kind,
and the working feature is the one that says what it did where the user already
is.

**Finally, the results themselves moved to the test.** A summary line says what
happened; it does not say *what is wrong with the page*. Reading that still meant
leaving the test, opening the Visual view, finding the right run and scrubbing to
the right step — four navigations away from the toggle that asked for the check.
So there is now an **"Accessibility" tab** on the test detail view
(`a11y-panel.tsx`), placed after Heals.

- **It describes the most recent run that CHECKED, not the most recent run**
  (`latestA11yRun`). A later run with the toggle off must not blank the panel:
  an empty result reads as "the issues were fixed", which is the most damaging
  thing this feature could say incorrectly.
- **That selector keys on `a11yMs`, not just `a11yChecks`,** so a run where axe
  executed but every check failed still counts as "checked" — otherwise a broken
  check would render the same empty state as a test nobody enabled it for. Same
  rule as the summary line, one layer up.
- **`a11y:resetBaseline` finally has a UI.** It had a handler and an API method
  and no caller anywhere: accepting was one click and un-accepting was
  impossible. "Reset accepted" is always offered, not just when something is
  flagged — the moment you need it is right after an over-eager "Accept all",
  when nothing is flagged any more.
- **The violation rendering was extracted** (`a11y-violations.tsx`) rather than
  copied. The impact colours ARE the triage and the new-vs-accepted split is the
  verdict; two hand-written copies would drift into disagreeing about which
  issues matter, and the drift would be invisible because both would look fine.
- Imported tests don't get the tab, matching Variables and Heals: the check runs
  from the capture fixture, which an imported spec never loads, so the tab could
  only ever be empty.

### 2026-08-06 — Sticky trainer panel docked to the training browser (mabl Trainer)

- **Goal:** Remove the window ping-pong that dominates training. The browser is its own window; every control lived in the main app window, so recording one assertion was click-in-page → find app window → click Assert → find browser → click element. mabl solves this by docking its Trainer to the right edge of the app under test.
- **Research (mabl):** their annotated Trainer UI has a narrow column — journey details, step list with hover-delete, an icon tool row (assert / find element / wait / variable / replay), Save, Cancel — plus an explicit **undock** control. Their newer builds describe the trainer as "a separate window that can be resized and moved independently … preventing the trainer from blocking the browser", i.e. they retreated from a hard dock. A public experience report records the two bugs they shipped, and both became design constraints here: **resizing the browser while training could hang the product in an endless loop**, and **the trainer could not be moved to another screen**.
- **Scope (confirmed with the user):** essentials only in the panel; **both trainers live** (the main window's `RecordingView` is untouched); docking **shrinks the browser** rather than overlaying it; follow move + resize with undock/re-dock. Out of scope: persisting dock side/width/undocked position, and cross-display / full-screen *support* — those got defined degraded behaviour instead (auto-undock + a push the renderer toasts), because undefined behaviour is what mabl shipped.
- **Key decisions:**
  - **Two geometry operations, not one.** `computeDock` runs once and splits the browser's footprint; `computePanelFollow` runs on every event and never touches the browser. A single function was written first and an idempotence test caught it: feeding an already-docked browser back in re-splits it, so every drag walked the browser up to 240px narrower until it hit its floor, and it also silently undid the user's own resizes. The two are now separate by contract, and `panel-dock.ts` says why at the top.
  - **Shrink, don't overlay.** A panel covering the right edge of the page hides exactly the content you need to click. Cost: the training viewport narrows mid-session, so a responsive site can re-lay-out. Made visible rather than silent via a one-per-session `trainerPanel:viewportNarrowed` push, and dock/undock only ever changes width, never height.
  - **Flip sides before giving up.** Dragging the browser against the right edge of a monitor is ordinary; `computePanelFollow` tries the other side before returning `null`. Clamping was rejected — it puts the panel on top of the page under test, which is the one thing the feature exists to prevent.
  - **Three defences against the reentrancy loop**, not one: `applyBounds` is the sole bounds writer and raises an `applying` flag; `isDuplicateApply` rejects an event carrying a rectangle we just wrote (the flag alone loses to an event delivered a tick late — it would work on a fast machine and loop on a slow one); and the follower subscribes to the BROWSER only, never the panel. Pinned by `check:trainer-panel`, because the failure is silent and a unit test cannot catch a wedged event loop.
  - **One fan-out, inside `sendToMain`.** ~50 call sites push backend→renderer through that single function, so the panel is registered there rather than at any call site. A panel receiving *most* channels would leave two trainers disagreeing about the step list — which presents as a step-ordering bug in the recorder, not as a missing subscription.
  - **Two live trainers turned out to be mostly safe already.** `refiningStepId` and the dialog flags are per-window React state in the store, so a Refine started in one window cannot open a dialog in the other. The one genuine conflict was `recorder:contextAction` (right-click in the browser), which is broadcast: both windows would open a prefilled Add-step dialog. Fixed with an addressed `target` field rather than a point-to-point send, so the single broadcast path survives; the panel wins when open, since it is the trainer adjacent to the browser.
  - **Dock state is backend-owned.** The panel's ⤢ button moves only when a push says the windows moved. An optimistic flip is right most of the time and wrong exactly when it matters — a refused dock leaves the label inverted and the control then looks dead, because pressing it asks for the state it is already in.
  - **Opt-in** (`trainerPanelEnabled`, default false). The feature moves and resizes the user's real windows.
  - **`RecorderProvider` no longer calls router hooks.** It hard-depended on `useNavigate`/`useQueryClient` for one thing — navigating to the finished test — which would throw outright in a router-less panel window. That behaviour moved to an injected `onFinished`, supplied by `RootView`.
- **Rejected:** an in-page overlay injected into the training browser (the capture boundary is a security boundary — the page could read, style or spoof the controls); a `BrowserView`-style child view composited into the browser window (no such API in this SDK, verified against the SDK reference, so it has to be a real second window).
- **Files:** `main/services/panel-dock.ts` + `panel-dock.test.ts`, `main/windows/trainer-panel-window.ts`, `main/services/app-window.ts` (aux fan-out), `main/services/recorder-service.ts` (open/close + `ctxAction` target), `main/handlers/index.ts`, `main/recorder/types.ts` + `renderer/lib/recorder-types.ts` (`trainerPanelEnabled`, `ContextAction.target`), `renderer/trainer/*` + `trainer-window.html`, `renderer/main/recorder-store.tsx` (`onFinished`), `renderer/main/root-view.tsx`, `renderer/main/step-row.tsx` (`CursorGap` moved here — both step lists need it), `renderer/main/recording-view.tsx` (ignores panel-addressed actions), `renderer/settings/settings-view.tsx`, `main/services/__tests__/trainer-panel.check.ts`.
- **Verification:** `lint`, `type-check`, `test:all` (45 files / 803 tests, 27 new + `check:trainer-panel`'s 27 assertions) and `build` all green. Per CLAUDE.md, each new guard was mutation-tested: removing the side-flip fails 2 tests, a 1px gap between the windows fails 14, dropping the `target` check fails the address test, an optimistic dock flip fails the dock-state test, and a `setBounds` outside `applyBounds` fails the source check. **Not yet live-verified** — every behaviour here is native window geometry, which a terminal cannot observe; see the follow-ups below.
- **Follow-ups for the first run in the Glaze app:** the panel logs `trainer-panel: First follow event of this session` once per event type, which answers the one thing the SDK docs do not — whether `move`/`resize` stream during a drag (panel glides) or only `moved`/`resized` fire at the end (panel snaps). Both are handled; only the feel differs. Also unverified: whether `parent`-style native child-window behaviour would make the follower redundant (the follower deliberately does not depend on it), and whether resizing the training window mid-session perturbs the injected capture script.

### 2026-08-04 — A real test runner, and the first component/DOM tests

**Goal:** "Are there unit tests for all app surfaces?" — no: 18 standalone assertion scripts covering pure logic, and zero coverage of 27 React components (~11k lines), the IPC layer, the injected capture script, or the replayer. This is the plan to close that, and its first three layers. (Commits `14b8b50`, `9b199d3`, `a6951f8`, `8905078`.)

**The approach, in layers:** (0) adopt Vitest with node + jsdom projects; (1) leave the 15 `check:*` scripts working rather than a big-bang migration — they catch real bugs today; (2) fill backend gaps riskiest-first; (3) component tests; (4) one command (`test:all`) so the two systems can't drift.

**What landed:** the runner and its `@glaze/core` resolution (see Conventions), 22 DOM tests executing the injected replayer for real, 12 Batch view component tests, and a 57-case `describeStep` parity test.

**Two findings, both from tests written this session:**
- The **replayer ↔ Auto-Heal coupling**: `recorder-service` decides whether to run Auto-Heal by matching the replayer's ERROR TEXT (`isLocatorFailure`). Reword the message and Auto-Heal silently stops firing — no error, nothing fails. Now pinned in both directions; verified by rewording, which fails exactly that test.
- **A real drift**, found on the parity test's first run: a keyboard press with no locator read `page.keyboard.press(...)` in run logs but `keyboard.press(...)` in the trainer. The renderer was dropping the prefix. Fixed.

**Deliberately NOT done, and why:** the `check:*` scripts were not migrated. They work, they're regression-tested, and rewriting 15 of them buys tooling consistency at the cost of temporarily losing coverage that has repeatedly caught real bugs. Better done incrementally.

**Then the IPC layer (`19b203c`):** the backend stub gained a **recording `ipcMain`** — `registerHandlers()` is a block of `ipcMain.handle()` calls with no other way in — so tests invoke handlers exactly as the renderer does, against the REAL services writing to a temp userData dir. 20 tests covering the trust boundary: tag normalization under hostile input, browser validation (and that nothing was stored on rejection), `batch:run` selection validation, webhook scheme rejection, that a saved webhook URL never crosses back over IPC, and settings merge semantics (a partial update must preserve unrelated keys — every feature writes settings independently, so a merge bug would silently drop preferences). The stub's `safeStorage` now defaults to unavailable and must be opted into, so a test not thinking about secrets can't wander into a persistence path.

**Volume pass (`dd0c322`, `71bb106`):** +82 tests — `visual-diff`, LLM response parsing, line-diff, the LLM error formatter, the Auto-Heal probe, and component tests for Stats and the Cookies panel. **The Auto-Heal probe tests found three real bugs**, all of which made the engine propose the WRONG element — which matters because `tryHeal` auto-applies the top candidate when the re-run succeeds, and clicking the wrong button usually does succeed, so the step gets marked passed: (1) `collectElements` de-duplicated by `tagName|id|className`, so any two plain `<button>`s with no id/class collapsed to one key and every element after the first was silently dropped (the dedup was also unnecessary — a comma-separated selector list already returns a unique set); (2) the cross-kind similarity check was one-directional, so the commonest heal of all (renamed testid, unchanged label: orig `submit-button` vs candidate text `Submit`) scored the correct element at zero; (3) `cand.role === orig.role && cand.name === orig.name` is trivially TRUE when both are absent — always, for testid locators — so every same-kind candidate scored 0.8 and drowned out real text matches at 0.4. Each fix independently verified by reverting it.

**Testing gotcha worth keeping:** a view's table renders BEFORE its query resolves, so `findByRole("table")` returns an empty body and reads as "no runs". Helpers must wait for ROWS, not for the table — otherwise the test passes while proving nothing.

**Volume pass continued (`2216a5f`, `06e96c1`, `1879c4e`, `e30673f`):** +78 more tests — `import-service` (driven against real temp dirs, since the logic IS filesystem behavior), the tags dialog, `StepRow`, `TestDetailView`'s run controls, `llm-service`, and the step editor. **273 Vitest tests + 15 checks.**

**`llm-service` testing found another real bug:** `hasKey()` only checks the key FILE exists while `getKey()` decrypts and returns null on failure, so they disagree whenever the file is present but undecryptable (corrupted, or `safeStorage` unavailable after a keychain/machine change). `fetchModels` returned `[]` there without throwing, so `status()` reported `reachable: true` with zero models and NO error — a green "connected" dot for a provider that cannot authenticate, then every chat failing. It now throws the same actionable message the no-key path uses.

**Bugs found by this testing effort so far: seven** — three in the Auto-Heal probe, the `describeStep` backend↔renderer drift, the visual-timeline misattribution, the batch run-order slip, and this one. **Every one was a silent failure; none threw.** That is the argument for the whole exercise.

**Testing conventions worth keeping:** (1) after adding a test that should catch a bug, REVERT the fix and confirm that exact test fails — done for every fix above; (2) never guard an assertion with `if (thing)`, which passes vacuously the day `thing` stops rendering; (3) a component's table renders before its query resolves, so wait for ROWS not for the table; (4) jsdom lacks layout, `IntersectionObserver` and `ResizeObserver` — the shared setup stubs them, and a missing one surfaces as a bare ReferenceError from inside the SDK bundle that reads like a component bug.

**Trainer covered (`d110d91`):** 12 tests for `RecordingView`, the largest component and the app's core feature. **285 Vitest tests + 15 checks; `npm run test:all` runs both.**

**More jsdom/Radix gotchas learned there:** the SDK's auto-scrolling ScrollArea calls `Element.scrollTo`, which jsdom lacks (now stubbed in the shared setup); and **Radix `TabsTrigger` activates on pointer-down/focus, not a bare `click`** — `fireEvent.click` leaves the tab unchanged, so assertions silently run against the PREVIOUS tab's content. `recording-view.test.tsx` has a `selectTab` helper for this.

**Measured, then corrected course (`698e692` … `7dc8d6b`):** adding coverage reporting (`npm run test:coverage`) contradicted an assertion I had made — that the remaining components were "small enough that a test would mostly restate the JSX". They were not: `visual-view.tsx` (1,409 lines) and `settings-view.tsx` (1,015) sat at 0%, plus `add-step-dialog` (538), `recorder-store` (450) and `library-sidebar` (388). Covering `recorder-store`, `settings-view` and `visual-view` took the suite to **321 Vitest tests** and coverage from 22% → 27%.

**Coverage caveat:** it instruments the Vitest run ONLY, so the 15 standalone `check:*` scripts contribute nothing — `mcp/` reads 0% despite `check:mcp-select`. Treat per-file figures for anything a check exercises as a floor.

**What deliberately isn't tested, with reasons** (so nobody "fixes" these gaps by writing tests that assert their own fixtures): choosing a value in an SDK `Select` — it's backed by a NATIVE menu, so its options never enter the DOM; the image panes and drag overlays in `visual-view` — jsdom has no layout and decodes no images; `playwright-runner` — subprocess-bound and largely unexported, so testing it properly means refactoring it for testability first.

**Where the testing effort stopped, and why:** `playwright-runner` (subprocess-bound and largely unexported — testing it properly means refactoring it for testability, a bigger call than a test-writing pass) and ~18 small presentational components where a test would mostly restate the JSX. The bug-per-test ratio fell off sharply after the Auto-Heal / `describeStep` / `llm-service` batches; that is the honest reason to stop rather than an exhaustion of ideas.

**Totals at this point:** 113 Vitest tests across 5 files + the 15 standalone checks, all green via `npm run test:all`.

### 2026-08-04 — Paginate the Stats lists; reset a custom batch order

**Goal:** Show at most 50 log entries and paginate the rest. (Commits `d62914b`, `84aace6`.)

**Scope decision (asked, not assumed):** "log entries" could have meant the Stats run-history table, the raw-log search results, or the trainer's Console log lines — three different components. The user picked the two **Stats** lists; the trainer Console is deliberately still unbounded, and `paginate.ts` will drop straight in if it ever needs it.

**What was done:** both Stats lists render 50 rows behind a shared `Pager`, with the rules in `renderer/lib/paginate.ts`.

**Key decisions:** paging fails as "my data disappeared" rather than as an error, so the two pinned cases are an empty list reading "page 1 of 1" (never "of 0") and a page number outliving its list (clamp to real rows, don't render an empty table). `check:paginate` also stitches all pages of a 412-item list back together to prove pages cover every item exactly once in order — the assertion that catches an off-by-one in the slice bounds, which is how paging silently drops a row. The run-history heading still reports "N of M" for filtering while the pager reports the range within it, so they read as filter-then-page rather than competing counts.

**Follow-up (`84aace6`):** drag-to-reorder had shipped as a one-way door — no way back to library order. Added "Reset order", shown only when a custom order is actually in effect. Reset clears the stored order and lets the existing drift effect rewrite library order, so one code path produces the default rather than two.

**Review pass, no defects found:** checked whether the Batch view could show hidden tests (it can't — `testStore.list()` filters them, and the MCP path has its own filter, so the two agree) and whether concurrent settings writes could clobber `batchOrder` (they can't — `set()` re-reads from disk and merges per call, with no cache).

**NOT yet verified in the running app.**

### 2026-08-04 — Drag to reorder batch runs

**Goal:** The Batch view ran tests in library order with no way to change it, which matters as soon as tests depend on each other (log in, then check out). (Commit `eb058b7`.)

**What was done:** drag handles on the Batch rows (reusing the trainer step list's pattern — grip on hover, only the handle draggable so row clicks still work, accent line on the drop target), a user order persisted as `RecorderSettings.batchOrder`, and pure rules in `renderer/lib/batch-order.ts`.

**Key decisions:**
- **Persisted, not ephemeral.** A suite order is worth keeping across restarts, so it's stored — as ids, which means it drifts from the library constantly. `applyOrder` therefore guarantees every test appears exactly once (a test missing from the list would be unrunnable AND invisible), puts new tests at the END rather than reshuffling a curated suite, ignores deleted ids, and de-dupes a corrupt stored order. The stored order is rewritten once when the library drifts, not on every render.
- **Reorder by ID, not index.** A tag filter makes the visible rows a subsequence of the real order, so a visible index would move the wrong test.
- **The drag-down off-by-one.** After splicing the dragged id out, everything below shifts up one — `moveToTarget` recomputes the target position post-removal or dragging downward lands one short of the row you dropped on.
- **`selectedIds` derives from the ordered list**, not the library. This is the line that makes the feature real rather than cosmetic — it's what the batch actually runs, and getting it wrong would have shipped a UI that reorders rows while running in the old order.

**Verification:** `check:batch-order` (36 assertions) covering the drift rules, the every-test-exactly-once invariant, the off-by-one, and that a filtered drag moves correctly in the global order while hidden tests keep their relative positions. All sixteen checks + build green.

**NOT yet verified in the running app.**

### 2026-08-04 — Collapsible sidebar

**Goal:** Make the sidebar collapsible. (Commit `e785a1f`.)

**What was done:** mounted `<SplitView.SidebarToggle />` in `root-view.tsx`. The SDK's `SplitView` already implements collapse — animated collapse, persistence alongside `storageKey`, and the ⌃⌘S shortcut, which is wired ONLY when a matching toggle is mounted — so this was a one-line mount, not new logic. **Check the SDK before building UI behavior here.**

**Key decision:** left **pinned** (the default), which portals the button to a fixed anchor on the frame's leading edge so it stays put whether the sidebar is open or collapsed. The SDK docs call out the trap explicitly: a non-pinned toggle placed in `Sidebar.actions` disappears along with the sidebar when it collapses, leaving the keyboard shortcut as the only way back. Collapse state persists through the existing `storageKey="recorder"`.

**NOT yet verified in the running app** — worth confirming the toggle sits sensibly relative to the macOS traffic lights (the SDK applies a window-control inset to the leftmost column, which is exactly where this could look wrong), that ⌃⌘S works, and that the collapsed state survives a relaunch.

### 2026-08-04 — Cookie management in the trainer

**Goal:** While training a new test or editing an existing one, be able to create, update and delete cookies. (Commits `d2bc4db`, `01e7a99`, `f1309ba`.)

**Scope decision (asked, not assumed):** the request was ambiguous between a live-only setup tool and cookie state recorded into the test. The user chose **both** — edit the training browser live, and optionally record each change as a step so runs reproduce it. Live-only would have left the classic footgun (test passes in the trainer, fails on a run, nothing pointing at the missing cookie); always-recording would bake expiring auth tokens into committed specs. Hence the default-ON but opt-out "Add to test as a step" checkbox.

**What was done:** a `cookie` step type (action `set`/`delete`/`clearAll` + `CookieSpec`) that generates `page.context().addCookies([...])` / `clearCookies(...)` and round-trips through the parser; `cookie-service.ts` over `webContents.session.cookies`; a Cookies tab in the trainer's bottom panel.

**Key decisions / traps:**
- **Session API, not `document.cookie`.** httpOnly cookies are invisible to page JS by definition, and `document.cookie` can't set Domain/Secure/SameSite faithfully. This also forces cookie steps out of the injected-script replay path.
- **One replay dispatch point.** Rather than special-casing four replay methods, all four now go through `runStep`. This is a direct response to the Auto-Heal bug earlier in the session, which was exactly the shape of "wired into one path, missing from three".
- **Two vocabulary mismatches, both silent when wrong.** Chromium's `expirationDate` (unix seconds) is Playwright's `expires`; Chromium's `no_restriction`/`lax`/`strict` are Playwright's `None`/`Lax`/`Strict`. A mis-mapped sameSite yields a cookie the site won't send on navigation — a confusing auth failure, not an error. Centralized in `types.ts` with inverses.
- **URL reconstruction.** `cookies.set`/`remove` need a URL but cookies are stored as domain+path. Chromium's leading dot on a domain cookie (`.example.com`) is not a hostname; a URL built with it silently targets nothing. Secure cookies need `https`.
- **Refuse to emit a broken line.** A `set` step Playwright would reject (no url, no domain+path) emits NO line — a call that fails during setup is more confusing than a missing step. Likewise `clearCookies({domain})` is not read back as a per-cookie delete; it's counted as skipped, feeding `stepsDiverged`.
- `RawStep` needed the cookie fields too — `insertStep` spreads a RawStep and would otherwise drop them silently.

**Follow-up fixes from a review pass (commit `267a62c`):** (1) the panel showed and preserved an expiry but had **no way to set one**, so every cookie created through the UI was silently a session cookie despite the whole stack supporting `expirationDate` — added a "Session" checkbox revealing a datetime-local field. The conversions live in `renderer/lib/cookie-format.ts` because both directions have a trap: `expirationDate` is unix SECONDS (not ms), and a datetime-local input reads/writes LOCAL time with no timezone suffix, so building it from `toISOString()` shows the wrong time to anyone off UTC. Asserted as round trips so the check is timezone-independent. (2) `runStep` asserted the recorder window was alive (`recWindow!`) when applying a cookie step, though the surrounding replay loops explicitly guard for the window closing mid-run — it could throw a TypeError out of a replay instead of failing that step cleanly.

**Third review finding (commit `4800716`) — a pre-existing bug the new step type exposed:** `buildReplay`'s failure fallback ("when a capture run failed but nothing REPORTED a failure, blame the first step after the last screenshot") excluded only `if`/`endif`. A cookie step produces no screenshot, so it was blamed — and every step after it was then marked `skipped` despite having run, so the real failing click showed as skipped while a cookie set that succeeded showed as failed. The candidate is now `captureMethod(s) !== null`, i.e. only steps that WOULD have captured. Fixed by capture semantics rather than a type blocklist, since **any** future non-capturing step type would have hit the same thing. A genuinely failing cookie step is still surfaced (the reporter reports it, and `reportedFail` wins above that branch). Pinned in `check:visual-pipeline`.

**Verification:** `check:cookie-steps` (78 assertions) covering both sameSite directions, scope validation, generation, a full step → spec → step round trip (incl. quote/backslash values and multi-cookie calls), and URL reconstruction. All fifteen checks + build green.

**Process note:** a first commit went in with a lint failure because the verification command piped `npm run lint` into `head`, so the pipeline's exit status came from `head` and the `&&` chain continued past a real error. **Don't pipe verification commands into `head`/`tail`** — check the exit code, or run them bare.

**NOT yet verified in the running app:** the Cookies tab has never been rendered. Needs a Glaze pass — see the test-instruction format used for the previous UI verification.

### 2026-08-04 — UI verification pass in the Glaze app

**Goal:** Five UI surfaces had been built from the Claude Code CLI, which cannot launch the native shell — so none of them had ever been rendered. This was the largest accumulated risk in the work.

**Scope:** a 35-check script covering (A) the per-test/global browser picker and cross-browser runs, (B) Stats run-history filtering, (C) batch runs incl. sequential execution, stop, restart-restore and interrupted-batch recovery, (D) test tags incl. case-insensitive grouping and selection surviving filter switches, and (E) webhook alerts incl. the disabled-until-configured switch and the no-logs-in-payload guarantee.

**Result:** the user reported back that everything looked good — all five surfaces render and behave as intended, with no defects raised.

**How this was recorded — read this before relying on it:** the reply was a **summary confirmation ("everything looks good"), not the itemized per-check results block** that was requested. So the accurate statement is "a UI pass was performed and nothing was reported wrong", NOT "each of the 35 checks was individually observed and confirmed". Four checks were called out beforehand as the most likely to surface problems and are the ones to re-test first if anything later looks off: **B2** (filters must not change the Stats summary cards / chart), **C8** (force-quit mid-batch → the batch shows Stopped with interrupted tests Skipped, not stuck "Running"), **D4** (tag-filter switches must not silently deselect tests), and **E4** (the webhook payload must contain no run-log output — verified in code by `check:alerts`, and this was its first observation on the wire from a real run).

**Consequence:** commits `c4a8326` … `6b61d2d` are now considered UI-verified. The standing caveat on those entries ("has not been seen rendered") no longer applies.

### 2026-08-04 — Webhook alerts (the first outbound data path)

**Goal:** Run notifications were macOS-local only, so there was no way to hear about a failure without the app in front of you. This was the last deferred item on the reconstructed backlog, and the only one that had been left pending a decision about run data leaving the machine. (Commit `47b6379`.)

**Key decision — the channel:** a generic outgoing webhook rather than a Slack app or email. It covers Slack and Discord (both accept an incoming-webhook URL) without the credential storage and delivery machinery SMTP would need, and it works with any HTTP endpoint.

**Key decisions — the safety constraints** (this is the ONLY thing in the app that sends data off the machine, so these are load-bearing, not decoration):
- Off by default, and the enable toggle is DISABLED until a URL is saved. Nothing leaves the machine otherwise.
- **Summary only.** Run logs are never sent — they routinely contain page content, URLs with session tokens, and values typed during recording (passwords, card numbers). What goes out: test name, status, the failing step's label, counts, duration, browser. `buildAlertPayload` is pure and is the only place that shape is defined, so the guarantee is enforceable rather than aspirational.
- Best-effort: slow/down/wrong webhooks are logged and swallowed (10s timeout). Reporting a problem must never become one.
- The URL is a **bearer credential**, not a setting — anyone holding a Slack webhook URL can post to that channel — so it's `safeStorage`-encrypted like the Anthropic key, backend-only, and never read back into the renderer. Settings shows only `{hasUrl, host}`. http(s) only, so a `file://` or `javascript:` URL can't reach fetch.
- A batch sends ONE alert for the suite; per-run alerts are suppressed for batched runs.

**Verification:** `check:alerts` (37 assertions) pins the redaction guarantee — planted secrets never reach the payload, the payload has exactly the documented keys with no passthrough, `detail` keys stay within a known-safe set — plus quiet-on-success and URL rejection (`file://`, `javascript:`, `ftp://`). Separately drove the real network path against a local HTTP server: correct JSON on the wire with `content-type: application/json`, non-2xx raised as an error, and the abort firing at 10s. `glaze-backend-stub.ts` gained a `safeStorage` stub that reports encryption as unavailable, so a check can never write a real secret to disk.

**Correction made during review:** the Settings copy originally claimed webhook alerts were "the only feature that sends anything off this Mac". That is false — Debug with AI on the Claude provider already sends the script and failing run output to Anthropic. Since a user could read the original wording and conclude their run logs never leave, the copy now says "the only thing that sends data off this Mac **automatically**" and names the Claude caveat explicitly.

**UI verified** in the Glaze app on 2026-08-04 (see the verification entry at the top of this section).

### 2026-08-04 — MCP `run_batch` + browser choice for `run_test`

**Goal:** The MCP server could only run one test at a time, so an external client had no way to ask "run my smoke tests" — the thing you most want from an agent driving a suite. Tags gave it a natural selector. (Commit `5d2d720`.)

**What was done:** New `run_batch` tool (select by `testIds` / `tag` / everything visible), selection logic extracted to the pure `mcp/select-tests.mjs`, and `run_test`/`run_batch` unified on one `executeTest()` helper so they can't drift in how they invoke Playwright or what they record. `run_test` gained a `browser` arg. `list_tests` now exposes `tags` + `runBrowser`. Batches are written to `batch-history.json` in the app's own shape, so an MCP-driven batch shows up in the app's Batch view.

**Key decisions:** Missing test ids are returned in `missingTestIds` rather than dropped — silently running 4 of 5 and reporting success is the worst failure mode for an agent with no eyes on the app. The response is flagged `isError` when any test failed, for the same reason. Hidden tests are excluded from tag/all selections (hiding is a sidebar concern) but honored when named explicitly by id.

**Two incidental fixes:** the server had the same `startsWith("chromium")` install-detection bug as the app, and `run_test` was ignoring each test's configured speed entirely (now passes `PW_SLOWMO_MS`). Both were one-line fixes in code already being restructured.

**Verification:** `check:mcp-select` (22 assertions) plus a real stdio JSON-RPC session against the running server — it registers all six tools with the expected schema, and `run_batch` against a non-matching tag returns the empty-selection error without touching run history. A real end-to-end batch was deliberately NOT executed from here: it would run browsers against live sites and write real records into the user's history.

### 2026-08-04 — Test tags + tag-filtered batch runs

**Goal:** The Batch view was a flat checklist over the whole library — fine for a dozen tests, unusable at a hundred. `TestRecord` had no suite/folder/tag field to group by. (Commit `8a0f77f`.)

**What was done:** Free-form `TestRecord.tags`, edited via the sidebar's right-click → **Edit Tags…** (`tags-dialog.tsx`), which also offers tags already in use as one-click toggles. The Batch view gained a tag chip row (with counts + **Untagged**) that filters the checklist. New `renderer/lib/test-tags.ts` for grouping, `normalizeTags` in `main/recorder/types.ts` for canonical form.

**Key decisions:** (1) **Normalization is backend-only** — the renderer posts raw strings and re-renders what comes back, so the two sides can't disagree; `normalizeTags` takes `unknown` because it sits directly behind IPC. (2) The dialog suggests existing tags because free-form tags rot fast when typing is the only affordance. (3) Selection is stored by test id and select-all/none act on the *visible* set only, so switching filters never drops what you already ticked — which is why those buttons add/remove rather than replace.

**Verification:** `check:test-tags` (30 assertions) covering hostile input, both caps, idempotence (repeated saves must not churn the record), and case-insensitive grouping so `smoke`/`Smoke` count as one tag.

### 2026-08-04 — Persisted batch results

**Goal:** Batch state lived only in memory: closing the app lost the summary, and although each test's run survived in `run-history.json`, nothing recorded that a set of runs belonged to one batch. (Commit `782d0a4`.)

**What was done:** New `batch-history-store.ts` + `RunRecord.batchId` as the join back to individual runs. `playwrightRunner.start` now also returns the `RunRecord` id, which the batch records per test, so a stored batch can link through to a run's log. The Batch view gained a "Previous batches" list (click to inspect, plus Clear history) and falls back to the most recent stored batch when nothing is live.

**Key decisions:** (1) **Write-through, not write-at-end** — persisting only on completion would lose everything to exactly the failure mode the feature exists to fix. The file is metadata-only and capped, so a full rewrite per transition is cheap. `save()` upserts by batchId; appending would leave dozens of records per batch. (2) Write-through created a new problem — a record persisted with `running: true` after a crash would show a phantom in-progress batch forever — hence `reconcileInterrupted()` at startup. (3) A separate index from run history, since a batch is a grouping over runs and the two prune on different rules.

**Corrections/Lessons Learned:** A type error (a spread overwriting an explicit property in the check file) passed a green `check:batch-history` because the esbuild-bundled checks don't type-check. **`npm run type-check` is the real gate for those checks** — a green check script alone is not sufficient.

### 2026-08-04 — Batch (suite) runs

**Goal:** Tests could only be run one at a time from the detail view — no way to run the library and get an aggregate result. (Commit `1beb8fc`.)

**What was done:** New `main/services/batch-runner.ts` + a `/batch` route (`renderer/main/batch-view.tsx`, sidebar → Views → Batch): pick any subset of tests, set batch-level headless/capture/browser options, run them back to back, watch per-test progress and a pass/fail summary. IPC `batch:run`/`batch:stop`/`batch:status` + push `batch:progress`/`batch:done`.

**Root obstacle:** `playwrightRunner.start` was fire-and-forget with no way to await a run, and the existing `runs` map can't serve as one — it holds an entry only while the child process is alive, so it is empty during browser install and again after exit but before the `RunRecord` is written. Awaiting it would have produced a batch that raced ahead of its own tests. Added a separate `inFlight` promise map + `waitFor(runId)` resolving to the exit code.

**Key decisions:** (1) **Strictly sequential** — the runner is keyed by testId so it *would* run several at once, but each run spawns its own Playwright process and browser (parallel contends for CPU and makes headed runs fight over the screen), and sequential keeps the per-run event stream unambiguous for a renderer that shows one live run. (2) **No new history** — each test still writes its own `RunRecord`, so a batch appears in Stats as ordinary runs. A useful consequence: opening a test's detail view mid-batch shows its live output, because `recorder-store.tsx` already falls back for unknown runIds. (3) **Batch options are not persisted per test** — a suite run is a one-off choice; writing it back would silently rewrite every test's saved preference.

**Edge cases pinned by `check:batch-runner` (38 assertions):** a test deleted after queueing is skipped (not fatal); a test already running is skipped rather than reported as a bogus failure; a failing test never aborts the batch; `stop()` kills the current run and skips the rest while keeping earlier results; only one batch at a time. Deps are injected so the queue is driven against a fake runner — including asserting runs never overlap via a concurrency high-water mark — with no browsers or child processes.

**Known limitation at the time (since FIXED — see the batch-persistence entry above):** batch state was in-memory only, so it did not survive an app restart, and nothing on `RunRecord` recorded that a set of runs belonged to one batch.

### 2026-08-04 — Cross-browser runs (Chromium / Firefox / WebKit)

**Goal:** Every run was hardcoded to Chromium, so cross-browser bugs — the main reason to own a browser test suite — were invisible. (Commit `00a9bdd`.)

**What was done:** A browser picker shaped like the existing "Run headless" preference: per-test `Select` in the test detail toolbar (persisted via new `tests:setBrowser`), a global `defaultRunBrowser` in Settings, and an explicit override on `runner:run`. The Playwright CLI's `--browser=<engine>` selects it. Stats surfaces the engine (Tags column names it with the headed/headless icon) and the tag filter gained an entry per engine; the former `"browser"` tag value was renamed `"headed"` now that "browser" is ambiguous.

**Real bug found while implementing:** `isBrowserInstalled` matched a bare `startsWith("chromium")`, but Playwright also unpacks a `chromium_headless_shell-*` directory alongside `chromium-*`. A headless-shell-only install was therefore reported as complete and the run failed at launch. Detection now matches the `<engine>-` prefix. (Both directories are present in a real install — verified against `userData/recorder/browsers/`.)

**Key decisions:** Resolution order is explicit → `TestRecord.runBrowser` → `RecorderSettings.defaultRunBrowser`. The engine name is validated (`isRunBrowser`) at both the settings-store and IPC boundaries — unvalidated input would be handed straight to the Playwright CLI. Runs predating this have no `runBrowser` and are reported as Chromium, which is what they ran on. The trainer is unaffected (it records in the app's own WebView).

**Verification:** a spec was run on all three engines through the same config and CLI args the runner builds — firefox/chromium/webkit each passed, and webkit failed as expected before installing, exercising the install path. NOTE: Firefox and WebKit are now downloaded into `userData/recorder/browsers/`, so the "first run on this browser" install message will not appear again unless a directory is deleted.

### 2026-08-04 — Filterable Stats run history

**Goal:** The run-history table was display-only; the Tags column had been noted as "eventually filterable, but not yet." (Commit `ea60932`.)

**What was done:** Three ANDed filter axes above the table (status / tag / test), client-side over the already-loaded run list — no extra IPC round trip. Predicate extracted to `renderer/lib/run-filters.ts` with `check:run-filters`.

**Key decisions:** Filters apply to the **table only** — the summary cards and pass/fail chart keep describing the whole history, so narrowing the table never silently redefines "pass rate". **Baseline-update rows are the subtle case:** their `status` field is incidental, so they are reachable only via status `baseline` and are excluded by every tag filter. Capture runs gained a camera icon in Tags, since capture is filterable and had no visible marker. A test filter pointing at a deleted/pruned test resets to "all" rather than showing an empty table.

### 2026-08-04 — Auto-Heal now runs in every replay path

**Goal:** Auto-Heal was invoked only from `replayFromCurrent`, so a locator that failed to resolve during a single-step preview (`replayStep`), a "replay from start", or the Edit-in-Trainer auto-run (`replayAll`) got no healing and no candidate menu. (Commit `c4a8326`.)

**What was done:** The engine, settings, IPC, and Console UI were all already built — three of the four call sites were simply missing. Factored the shared re-run wiring into `healAndRetry()` and called it from all four paths; structural `if` steps are excluded in the loop paths (no healable target).

**Key decisions:** Added `check:auto-heal-wiring`, a source-level check that slices each replay method out of `recorder-service.ts` and asserts it calls `healAndRetry` and acts on `okWithHeal`. Verified it actually fails when a call site is removed, rather than passing vacuously.

**Corrections/Lessons Learned:** This was found by auditing `.glaze_memory` prose against the code. Much of that prose was stale — several features described as "deferred to a later phase" (trainer AI step generation, component-level visual diffing, live replay) were already shipped, while this genuinely-missing wiring was documented as complete. **Verify every documented gap against the source tree before planning work from it.**

### 2026-08-04 — Fixed provider selection silently discarding "anthropic" (Claude)

**Goal:** When the user selected Claude as the AI provider in Settings, the backend still used Ollama — error messages and chat requests referenced "Ollama" instead of "Claude", even though the window header showed the Claude model name.

**Root cause:** `normalizeProvider` in `main/services/llm-config-store.ts` only recognized "lmstudio" and defaulted everything else to "ollama". When the renderer sent `provider: "anthropic"` via `api.llm.setConfig`, the backend silently stored `"provider": "ollama"` in the config file. The renderer displayed the user's selection from its own state (so the header showed "claude-sonnet-5"), but the backend always used Ollama for chat and status probes.

**What was done:** Updated `normalizeProvider` to accept "anthropic" as a valid provider and return it as-is. Also fixed a pre-existing `.at(-1)` type error in `main/services/__tests__/batch-runner.check.ts` (ES2020 lib doesn't include `Array.at`) by replacing it with index-based access.

**Key decisions:** The fix is a one-line change to the allowlist. Users who previously selected Claude need to re-select it in Settings once to save the correct provider.

### 2026-08-04 — Improved LLM error messaging + always-visible sidebar connection status

**Goal:** The AI debug panel and generate dialogs showed a bare "fetch failed" when the LLM provider was unreachable. The sidebar footer only showed connection status for local providers and only when connected (hidden when unreachable).

**What was done:** (1) Backend `llm-service.ts` `runChat` catch block now wraps connection failures ("fetch failed", ECONNREFUSED, timeout, etc.) with the same friendly message the `status()` probe produces — "Could not reach Ollama at http://127.0.0.1:11434. Make sure it is running." for local providers, "Could not reach Claude (https://api.anthropic.com). Check your internet connection and try again." for Anthropic. (2) The Anthropic `status()` catch block was also updated to wrap network errors instead of passing raw "fetch failed" through. (3) Extracted the duplicated `friendlyError` function from `ai-debug-panel.tsx`, `generate-steps-dialog.tsx`, and `generate-test-dialog.tsx` into a shared `renderer/lib/llm-errors.ts` module that also handles 401/invalid API key errors with a Settings hint. (4) Rewrote `AiConnectionFooter` in `library-sidebar.tsx` to always render (for all providers, local and cloud) with three states: green dot (connected), red dot (disconnected, with the backend's friendly error as tooltip), or loading dot (checking). Previously it returned `null` when unreachable.

**Key decisions:** Shared `friendlyError` in `renderer/lib/` avoids three copies of the same regex. The footer's tooltip shows the full error message while the visible label stays short (just the provider name).

**Goal:** The screenshot in the Visual diff view overflowed past the bottom border of its containing panel, especially for tall screenshots.

**What was done:** In `renderer/main/visual-view.tsx`, the `StepScreenshot` wrapper div changed from `relative max-h-full max-w-full` to `relative flex h-full w-full items-center justify-center overflow-hidden`. The old `max-h-full` on the wrapper didn't constrain the image because in a flex container with `items-center`, the wrapper's height was content-based (determined by the image), making the image's `max-h-full` resolve against its own natural height — circular. With `h-full`, the wrapper takes the full height of the bordered container, giving the image's `max-h-full` a definite value to resolve against. Added `overflow-hidden` to the bordered container (line 1113) as a safety net. The image keeps `object-contain` so it letterboxes within the constrained area.

**Key decisions:** `h-full w-full` on the wrapper (instead of `max-h-full max-w-full`) gives the image a definite parent height to constrain against. The wrapper itself is now a flex container that centers the image, replacing the parent's centering role for the image.

### 2026-08-04 — Fixed screenshot overflow in Visual diff view

**Goal:** The screenshot in the Visual diff view overflowed past the bottom border of its containing panel, especially for tall screenshots.

**What was done:** In `renderer/main/visual-view.tsx`, the `StepScreenshot` wrapper div changed from `relative max-h-full max-w-full` to `relative flex h-full w-full items-center justify-center overflow-hidden`. The old `max-h-full` on the wrapper didn't constrain the image because in a flex container with `items-center`, the wrapper's height was content-based (determined by the image), making the image's `max-h-full` resolve against its own natural height — circular. With `h-full`, the wrapper takes the full height of the bordered container, giving the image's `max-h-full` a definite value to resolve against. Added `overflow-hidden` to the bordered container (line 1113) as a safety net. The image keeps `object-contain` so it letterboxes within the constrained area.

**Key decisions:** `h-full w-full` on the wrapper (instead of `max-h-full max-w-full`) gives the image a definite parent height to constrain against. The wrapper itself is now a flex container that centers the image, replacing the parent's centering role for the image.

### 2026-08-04 — Verified five visual-testing pipeline changes + fixed ai-debug-scroll regression

**Goal:** Claude Code implemented five deferred visual-testing roadmap items (commits 35ea8c6, 83f06b1, edf0d6c, da79d4b, 1613463). All backend logic passed `check:visual-pipeline`, `check:retention`, and `check:capture-overhead`, but none of the new UI had been seen running. Also fix a pre-existing `check:ai-debug-scroll` regression from the earlier "move follow-up input above model output" commit (b18f39f), which dropped the `max-h-[56vh]` constraint from the review-phase ScrollArea.

**What was done:** (1) Fixed `check:ai-debug-scroll` — restored `max-h-[56vh]` + matching `viewportClassName="max-h-[56vh]"` on the review-phase ScrollArea in `ai-debug-panel.tsx` (line 617), bringing the constrained ScrollArea count back to 3. (2) Built and launched the app. (3) Verified in the running app: the Visual tab's "Ignore regions" button toggles a `cursor-crosshair` overlay (`MaskLayer`) over the screenshot; the "Apply to all steps" switch and "Done" button are present; the overlay is positioned as CSS percentages over the image box. The Page/Element `SegmentedControl` is correctly absent for steps whose baseline predates element geometry (goto/viewport/wait steps have no `step.rect`). The Stats view's "Capture overhead" panel is correctly hidden until an instrumented capture run exists. Settings shows "Delete screenshots older than" (0–365 days) below "Screenshot history per test" and "Notify when a run has problems" switch — both persist via `api.recorder.setSettings`. Backend `run-notifier.ts` uses the SDK `Notification` API, gated on `notifyOnRunIssues`, returns null for clean runs. `pruneRuns` excludes `baseline/` from both count and age rules.

**Key decisions:** The review-phase ScrollArea now uses `max-h-[56vh] flex-1 min-h-0` (both the flex sizing from the earlier move AND the max-height constraint for scrolling), with `viewportClassName="max-h-[56vh]"` matching. The `flex-1 min-h-0` lets it share space with the follow-up input above it; the `max-h-[56vh]` ensures it scrolls when the prompt is long.
**UI elements:** Visual tab (MaskLayer overlay, Ignore regions button, Apply to all steps switch, DiffBadge with SquareDashed icon, Page/Element SegmentedControl), Stats view (CaptureOverheadPanel), Settings (artifact-retention-days input, notify-run-issues switch), AI debug dialog (review-phase ScrollArea).
**Backend elements:** visual-diff.ts (diffPngBuffers masks + region), replay-builder.ts (element-scoped diffing + "predates" message), capture-fixture-source.ts (captureMs/shotCount/elementRect), artifact-store.ts (pruneRuns maxAgeMs), run-notifier.ts (Notification API), run-history-store.ts (CaptureOverheadSummary), recorder-settings-store.ts (artifactRetentionDays, notifyOnRunIssues), playwright-runner.ts (notifyRunOutcome call).
**Corrections/Lessons Learned:** The `check:ai-debug-scroll` regression was introduced by the earlier "move dialog above model output" change (b18f39f), which replaced `max-h-[56vh]` with `flex-1 min-h-0` on the review-phase ScrollArea — dropping below the check's minimum of 3 constrained ScrollAreas. The fix combines both: `max-h-[56vh] flex-1 min-h-0`.
**User Frustrations & Important Remarks:** User noted the horizontal overflow issue in the Stats table (separate fix applied in the previous task).

### 2026-08-04 — Stats run history table: truncate instead of horizontal scroll

**Goal:** The Stats view's run history table allowed horizontal scrolling when test names or dates were long. The user wanted overflowing fields truncated with the full value shown on hover instead.

**What was done:** In `renderer/main/stats-view.tsx`, the run history `Table` now uses `table-fixed` with explicit column widths (Test auto-fills, Status w-20, Started w-28, Tags w-24, Duration w-24, Log w-20). Added `sticky` to `TableHeader` so `Table` skips its built-in horizontal `ScrollArea` wrapper, and wrapped the table in `div.overflow-x-hidden` as a safety net. The "Test" and "Started" cells use `truncate` (ellipsis) with a `title` attribute for hover tooltips showing the full value. Removed the old `max-w-[220px]` on the Test cell (no longer needed with `table-fixed`).

**Key decisions:** `table-fixed` + explicit widths on the narrower columns lets the Test column flex to fill the remaining space, which is where truncation matters most. `title` attributes provide native hover tooltips without any custom tooltip component.
**UI elements:** Stats view run history table. **Backend elements:** none.
**Corrections/Lessons Learned:** None.

### 2026-08-04 — Moved AI debug follow-up input above the model output

**Goal:** In the AI debug dialog (`AiDebugDialog` in `renderer/main/ai-debug-panel.tsx`), the follow-up Textarea + Send button (shown when `status === "done"`) used to render BELOW the model output ScrollArea. The user wanted it moved ABOVE the model output, matching the review-phase layout where the "Anything else you want to include?" input sits above the prompt preview.

**What was done:** In the `!reviewing` branch of `AiDebugDialog`, moved the `{status === "done" && content ? (...) }` follow-up input block to BEFORE the model-output `ScrollArea` instead of after it. No logic changes — pure layout reorder.

**Key decisions:** Mirrors the review phase's input-above-output pattern so the dialog is consistent between the initial context field and the follow-up field.
**UI elements:** `AiDebugDialog` follow-up input row. **Backend elements:** none.
**Corrections/Lessons Learned:** None.

### 2026-08-04 — Added CLAUDE.md handoff doc for external Claude Code collaboration

**Goal:** Let the user's own Claude Code CLI help develop this app's source (separate from the earlier MCP server, which exposes app *data*, not app *code*, to AI tools).

**What was done:** Created `CLAUDE.md` at the repo root (tracked in git) — architecture overview, directory map, npm commands, hard constraints (protected dirs, forbidden imports, npmrc rules, no Xcode setup), SDK reference paths, and a "Working alongside the Glaze app" section explaining the dev loop (external session edits + runs lint/type-check/build; only the Glaze app can launch/live-preview; both share the same local-only git repo). Verified no CLAUDE.md, no git remote, and no prior `.claude/` config existed.

**Key decisions:** Kept the doc self-contained (no reference to Glaze-internal guides/tools external Claude can't access) but did include the public `@glaze/core` SDK reference paths since code correctness depends on them. Docs-only change — no build needed.
**UI elements:** none. **Backend elements:** none (documentation).
**Corrections/Lessons Learned:** None.

### 2026-08-04 — Added MCP server usage README

**Goal:** Document how to use the Good Looks MCP server (added earlier this session) so the user and other MCP clients know how to set it up and call its tools.

**What was done:** Wrote `mcp/README.md` — setup instructions for Claude Code (`claude mcp add`), Codex CLI (`~/.codex/config.toml`), and Claude Desktop/other clients (JSON config), plus a per-tool reference (`list_tests`, `get_test`, `list_runs`, `get_run_log`, `run_test`) with argument tables and example invocations, example natural-language prompts, and notes on read-only vs. mutating tools and data-dir portability.

**Key decisions:** Docs-only change, no app code touched — skipped the build step accordingly.
**UI elements:** none. **Backend elements:** none (documentation).
**Corrections/Lessons Learned:** None.

### 2026-08-04 — Added standalone MCP server exposing the test library

**Goal:** Let external MCP clients (Claude Code, Codex, etc.) list/view recorded tests and run history, and trigger test runs, without the app needing to be open.

**What was done:** Created `mcp/server.mjs` (standalone stdio MCP server, name `good-looks`) + `mcp/glaze-data.mjs` (userData dir resolution, copied verbatim per the MCP skill). Installed `@modelcontextprotocol/sdk` + `zod@^3`. Registered 5 tools: `list_tests`, `get_test`, `list_runs`, `get_run_log`, `run_test`. Registered the server in this project's `.mcp.json` for the Glaze agent; gave the user the `claude mcp add --scope user` command for their own Claude Code.

**Key decisions:** User chose "Full control" (read + trigger runs) over read-only when asked about scope. `run_test` reimplements the relevant slice of `playwright-runner.ts` (CLI/browsers-path resolution, node_modules symlink, minimal `playwright.config.ts`) standalone rather than importing `main/` code (forbidden — mcp/ is a separate process). It refuses to run and returns a clear error if Chromium isn't installed yet, rather than silently downloading it. Successful runs append a real `RunRecord` + log file so they appear in the app's own Stats view too — last-write-wins if the app is open at the same time.

**UI elements:** none (backend/tooling only).
**Backend elements:** ipc_handler-equivalent (MCP tools), local_storage (reads/writes `userData/recorder/tests.json` and `run-history.json`), external CLI invocation (bundled Playwright).

**Corrections/Lessons Learned:** none — first pass verified clean via the protocol smoke test (initialize, tools/list, and three real tool calls against the user's actual test data).

**User Frustrations & Important Remarks:** none.

### 2026-08-04 — Set empty-state description padding to 60px 0px
- **What was done:** In `renderer/main/home-view.tsx`, replaced the `EmptyStateDescription` wrapper with a plain `<p className="text-regular" style={{ padding: "60px 0px" }}>` so the description paragraph has 60px vertical padding (0px horizontal). Removed the now-unused `EmptyStateDescription` import.

### 2026-08-04 — Changed empty-state title to "GOOD LOOKS!" at 54px
- **What was done:** In `renderer/main/home-view.tsx`, replaced the `EmptyStateTitle` component (which renders `h1.text-heading1` at 24px) with a plain `<h1 className="text-heading1" style={{ fontSize: "54px" }}>GOOD LOOKS!</h1>` so the text and size can be set explicitly. Removed the now-unused `EmptyStateTitle` import.

### 2026-08-04 — Added vertical padding to AI debug prose paragraphs (fix clipping)
- **Goal:** The model output prose paragraphs in the AI debug dialog (`AiDebugDialog` and `StepAiDebugDialog`) were visually clipped/cut off at the container edges — no internal vertical padding, text ran right up to the borders.
- **What was done:** In `renderer/main/ai-debug-panel.tsx`, added `py-1` to the prose `<p>` elements in both the `AiDebugDialog` response phase (line ~651) and the `StepAiDebugDialog` response phase (line ~871) so the text has vertical breathing room inside its container.

### 2026-08-04 — Added follow-up reply to AI debug dialog for when the model asks for more info
- **Goal:** When the local LLM's debug diagnosis asks the user for more information (per its system-prompt instruction to request more detail rather than guess), let the user type a follow-up and send it back without leaving the dialog.
- **What was done:** In `renderer/main/ai-debug-panel.tsx` (`AiDebugDialog`), added a `messagesRef` tracking the sent message array and a `followUp` state. `sendDiagnosis` now stores the sent messages into `messagesRef`. A new `sendFollowUp` callback appends `{role:"assistant", content}` (the streamed response) + `{role:"user", content: trimmed}` (the user's reply) to `messagesRef` and calls `start` with the full thread so the model keeps the back-and-forth context. Added a follow-up input row (Textarea + accent "Send" button, Enter to send / Shift+Enter for newline) below the response ScrollArea, shown only when `status === "done" && content` (model finished answering). Reset on new-run open. Imported `LlmMessage` type.
- **Key decisions:** Follow-up is only visible after a completed (non-streaming) response; it re-sends the whole conversation (not a bare continuation) since `useLlmChat.start` always begins a fresh request. The `StepAiDebugDialog` was not changed (leaner sibling, no follow-up yet).
- **UI elements:** AI debug dialog response phase (AiDebugDialog). **Backend elements:** none.
- **Corrections/Lessons Learned:** None.

### 2026-08-04 — Moved quick-context chips AND "Anything else?" field above System/User prompts in AI debug review
- **Goal:** Move both the quick-context button group (Flaky selector, etc.) and the "Anything else you want to include? (Optional)" Textarea so they appear above the System and User Prompts in the AI debug dialog's review phase, while keeping the prompts fully scrollable.
- **What was done:** In `renderer/main/ai-debug-panel.tsx`, the review phase now renders in this order: (1) the `QUICK_CONTEXT_REASONS` chips as a `flex-wrap` row, (2) the `Field` with the "Anything else you want to include? (Optional)" Textarea, (3) the `ScrollArea` containing the System/User prompts. The ScrollArea uses `flex-1 min-h-0` with `viewportClassName="max-h-[44vh]"` so the prompts stay fully scrollable and the dialog flexes to fill remaining height.
- **Key decisions:** Both the chips and the textarea now sit above the scrollable prompts; the ScrollArea is the flex child that absorbs leftover height so the prompts remain scrollable within the dialog.
- **UI elements:** AI debug dialog review phase (AiDebugDialog). **Backend elements:** none.
- **Corrections/Lessons Learned:** None.

### 2026-08-04 — Moved quick-context chips above System/User prompts in AI debug review
- **Goal:** Move the quick-context button group (Flaky selector, etc.) so it appears above the System and User Prompts in the AI debug dialog's review phase, while keeping the prompts scrollable.
- **What was done:** In `renderer/main/ai-debug-panel.tsx`, extracted the `QUICK_CONTEXT_REASONS` button group out of the `Field` label (where it sat beside the "Anything else you want to include?" text, below the prompts) and placed it as a standalone flex-wrap row above the `ScrollArea` containing the System/User prompts. The `Field` label now holds only the plain "Anything else you want to include? (Optional)" text. The ScrollArea retains its `max-h-[44vh]` so the prompts stay fully scrollable.
- **Key decisions:** Kept the chips as `flex-wrap` so they reflow on narrow widths; left the Textarea/Field below the prompts unchanged.
- **UI elements:** AI debug dialog review phase (AiDebugDialog). **Backend elements:** none.
- **Corrections/Lessons Learned:** None.

### 2026-08-04 — Removed color fill on Stop button in AI debug dialogs
- **Goal:** Remove the red color fill from the Stop button in the AI debug dialogs.
- **What was done:** In `renderer/main/ai-debug-panel.tsx`, changed both Stop buttons (in the test-level and step-level debug dialogs) from `variant="destructive"` (red fill) to `variant="muted"` to match the Regenerate button style.
- **Key decisions:** Both Stop buttons had identical styling; updated both for consistency.
- **UI elements:** Stop buttons in AI debug dialog headers. **Backend elements:** none.
- **Corrections/Lessons Learned:** None.

### 2026-08-04 — Centered thinking gif, set 50% opacity
- **Goal:** Center the glitch gif in the AI debug dialog and set its opacity to 50%.
- **What was done:** In `renderer/main/ai-debug-panel.tsx` `ThinkingGifOverlay`, changed the gif container from `items-start justify-center pt-4` (top-anchored) to `items-center justify-center` (fully centered). Changed the streaming target opacity from `1` to `0.5`.
- **Key decisions:** Removed the `pt-4` top padding since centering makes it unnecessary. The 5s ease-in / 0.5s ease-out transitions are unchanged.
- **UI elements:** ThinkingGifOverlay in both AI debug dialogs. **Backend elements:** none.
- **Corrections/Lessons Learned:** None.

### 2026-08-04 — Enhanced failed-step highlighting in Steps list
- **Goal:** When a test run fails, the failed step should be clearly highlighted in the Steps tab.
- **What was done:** In `renderer/main/step-row.tsx`, enhanced the `runStatus === "failed"` highlight from a subtle `bg-support-red-10` (10% red tint) to `bg-support-red/15 ring-1 ring-inset ring-support-red/40` (15% red background + 40% red ring border). Also made the failed step's description text red (`text-support-red` class on the Text) and enlarged the X icon from `size-3.5` to `size-4` for failed steps.
- **Key decisions:** Used Tailwind `/` opacity syntax (`support-red/15`, `support-red/40`) for reliable opacity control. The combination of red background + red ring + red text + larger X icon makes the failed step unambiguously stand out from passing/unhighlighted steps.
- **UI elements:** StepRow in test detail view Steps tab. **Backend elements:** none.
- **Corrections/Lessons Learned:** None.

### 2026-08-04 — Reverted gif size, enlarged dialog instead, gif top-anchored with response filling below
- **Goal:** User wanted the gif size change reverted — instead, enlarge the dialog box to accommodate the gif, and let the model's streaming response fill the empty space gradually. Gif shouldn't be too big.
- **What was done:** In `renderer/main/ai-debug-panel.tsx`: (1) Reverted the gif `minWidth/minHeight: 350%` — the `<img>` is now `max-h-[300px] max-w-[400px] object-contain` (moderate, capped size). (2) Enlarged both dialogs from `size="xl"` (750px) to `size="2xl"` (900px). (3) Content container changed from `max-h-[50vh]` to `min-h-[400px] max-h-[70vh]` so the dialog is tall enough for the gif + response. (4) Gif overlay inner flex changed from `items-center` to `items-start justify-center pt-4` so the gif sits at the top of the content area, leaving space below for the streaming response to fill in. (5) Response ScrollArea max-heights increased (review 32vh→44vh, response 40vh→56vh, step 42vh→56vh) to use the taller dialog. The opacity-based fade animation is kept from the prior change.
- **Key decisions:** Capped the gif at 300×400px so it's prominent but not dominating. Top-anchored the gif so the response text naturally fills the space below it as it streams in. The dialog grows from 400px min to 70vh max as content arrives.
- **UI elements:** ThinkingGifOverlay + both AI debug dialogs (AiDebugDialog, StepAiDebugDialog). **Backend elements:** none.
- **Corrections/Lessons Learned:** The gif must be capped with `max-h/max-w` (not `h-full w-full`) when the dialog is tall — otherwise `object-contain` fills the entire container, making the gif dominate. Top-anchoring (`items-start` + `pt-4`) is needed so the response fills below, not centered around the gif.

### 2026-08-04 — Enlarged thinking GIF + fade-out instead of flip
- **Goal:** User wanted the AI debug dialog's thinking GIF to be 250% larger (minimum size) and to fade out via opacity instead of flipping via scaleX when the response arrives.
- **What was done:** In `renderer/main/ai-debug-panel.tsx` `ThinkingGifOverlay`: (1) replaced `h-full w-full` on the `<img>` with `minWidth: "350%"` + `minHeight: "350%"` inline styles (250% larger than the original 100% fill = 350% total), keeping `object-contain`; (2) replaced the `scaleX(0)→scaleX(1)` transform animation with `opacity 0→1` fade — the `scaledIn` state became `fadedIn`, `targetScale` became `targetOpacity`, and the `transition` now animates `opacity` instead of `transform`. The contracting phase (response received) fades opacity to 0 over 0.5s instead of flipping via scaleX(0). Applies to both `AiDebugDialog` and `StepAiDebugDialog` since both render the same `ThinkingGifOverlay` component.
- **Key decisions:** Kept the 5s ease-in for expanding (fade-in) and 0.5s ease-out for contracting (fade-out) — same timing as before, just opacity instead of transform. Used `min-width/min-height` instead of `width/height` so the gif can still grow beyond 350% if the container is tiny.
- **UI elements:** ThinkingGifOverlay in both AI debug dialogs. **Backend elements:** none.
- **Corrections/Lessons Learned:** None.

### 2026-08-04 — Moved Stop button next to test name in AI debug dialog (red when stoppable)
- **Goal:** User wanted the Stop button moved next to the Test name in the AI debug dialog header, highlighted red while the model is in a stoppable (streaming) state.
- **What was done:** In `renderer/main/ai-debug-panel.tsx`, moved the Stop button out of the response-phase status row and into the `Dialog` `description` prop (which renders the test name) for both `AiDebugDialog` (description was `testName`) and `StepAiDebugDialog` (description was `stepLabel`). The description is now a `span.inline-flex.items-center.gap-2` containing the name + a Stop button that only renders when `status === "streaming"`, using `variant="destructive"` (red). Removed the old Stop button from the status row; the Regenerate button now always renders there (no streaming/done conditional).
- **Key decisions:** Used `variant="destructive"` for the red highlight. Kept Regenerate always visible in the status row since Stop is now in the header.
- **UI elements:** AiDebugDialog + StepAiDebugDialog header description area + status row. **Backend elements:** none.
- **Corrections/Lessons Learned:** None.

### 2026-08-04 — Fixed AI debug dialog prompt overflow (content rendered on top of input field)
- **Goal:** In the AI debug dialog review phase, the long prompt `pre` block overflowed its ScrollArea and rendered on top of the input field below.
- **What was done:** In `renderer/main/ai-debug-panel.tsx`, added `overflow-hidden` to all three ScrollArea roots (review `max-h-[32vh]`, response `max-h-[40vh]`, step `max-h-[42vh]`). The Radix ScrollArea root had `overflow: visible` by default, so the viewport (with `size-full` / `h-full`) spilled out to its full content height (1560px) instead of being clipped to the `max-h` constraint. Also added `overflow-x-auto` to the prompt `pre` blocks and error `pre` blocks for horizontal scroll on long lines.
- **Key decisions:** `overflow-hidden` on the ScrollArea root is the essential fix — it clips the viewport to the `max-h` bound. The `overflow-x-auto` on `pre` blocks prevents horizontal overflow of long unbreakable lines.
- **UI elements:** AiDebugDialog review + response phases, StepAiDebugDialog response phase. **Backend elements:** none.
- **Corrections/Lessons Learned:** The Glaze `ScrollArea` root defaults to `overflow: visible`. When using `max-h` to bound a ScrollArea, always add `overflow-hidden` to the className — otherwise the inner viewport (which has `size-full` and resolves `h-full` to content height) overflows the max-height constraint and spills into adjacent UI.

### 2026-08-04 — Fixed AI debug dialog scroll (content overflowed beyond viewport)
- **Goal:** User couldn't scroll the full length of the "Debugging with AI" dialog.
- **What was done:** In `renderer/main/ai-debug-panel.tsx`, both `AiDebugDialog` and `StepAiDebugDialog` used `h-[50vh]` (fixed height) on the outer content wrapper with `overflow: visible`, while the inner `ScrollArea` components used `min-h-0 flex-1`. The ScrollArea component adds `h-full max-h-screen` when it has a vertical scrollbar, and `h-full` resolved to the full window height (1410px) instead of the flex-computed height — making the content overflow to ~1688px inside a 705px container, requiring 982px of scroll in the DialogBody's ScrollArea. Changed `h-[50vh]` → `max-h-[50vh]` (container shrinks to fit) and replaced `min-h-0 flex-1` on the inner ScrollAreas with bounded `max-h-[32vh]`/`max-h-[40vh]`/`max-h-[42vh]` so they scroll within a reasonable bound instead of expanding to window height.
- **Key decisions:** Used `max-h` instead of fixed `h` on both the outer wrapper and inner ScrollAreas — avoids the `h-full` resolution issue entirely since the ScrollArea no longer tries to fill a flex parent that has a definite height.
- **UI elements:** AiDebugDialog (review + response phases), StepAiDebugDialog (response phase). **Backend elements:** none.
- **Corrections/Lessons Learned:** The Glaze `ScrollArea` component adds `h-full max-h-screen` when it detects a vertical scrollbar. In a flex-column parent with a fixed height, `h-full` (height: 100%) can resolve to the full window height rather than the flex-computed height, causing massive overflow. Use `max-h` on ScrollAreas inside fixed-height flex containers instead of `flex-1`.

### 2026-08-04 — Removed run-level "Accept All & Re-baseline" from visual diffs
- **Goal:** User wants re-baselining to happen only at the test-step level, and only when a step's visual change meets or exceeds the configured threshold — no more run-wide "Accept All" scope.
- **What was done:** In `renderer/main/visual-view.tsx`, removed the `acceptRun` mutation and both "Accept All & Re-baseline" `AlertDialog` triggers (the header one next to `ThresholdControl`, and the `actions` prop of the visual-change `Callout`). The `Callout` now just tells the user to use the per-step button. Tightened the per-step "Accept New Baseline" button condition from `step.screenshot && !acceptedSteps.has(step.stepId)` to `step.screenshot && step.diff?.state === "changed" && !acceptedSteps.has(step.stepId)` — so the button only appears when the step's diff exceeded the threshold (state `"changed"`), not for any captured step. Removed the now-unused `screenshotCount` local. The backend `visual:acceptRun` IPC handler and `api.visual.acceptRun` wrapper are left in place (harmless, no longer called from the UI).
- **Key decisions:** Kept the backend `acceptRun` handler rather than removing it — surgical UI-only change, and leaving it avoids touching the IPC layer. The `"changed"` diff state already encodes "over threshold" (vs `"match"` = within threshold), so no threshold comparison was needed in the UI.
- **UI elements:** visual diff view header + visual-change banner + per-step footer button. **Backend elements:** none.
- **Corrections/Lessons Learned:** None.

### 2026-08-04 — Re-ported black-hole animation tweaks from a re-exported Dark Mode zip
- **Goal:** User said they "made some adjustments" and attached a re-exported "Black Hole Loading Animation (Dark Mode).zip"; twice in a row asked to "repeat that same procedure" to pick up new tweaks.
- **What was done:** Byte-diffed the new zip's extracted files against the previous zip attachment on disk (not just against the already-ported `.tsx`, since a first attempt with identical content had been a stale re-export). `hand-ink3.png`, `support.js`, and all `uploads/*` images were identical; only `OkeeDokee Loader.dc.html` changed. The diff removed the hole-shadow radial gradient + ellipse entirely and added a `lineThickness` prop that multiplies ring and spoke stroke-widths, plus new prop defaults (loopSeconds 3→1.5, swirl 0.8→0, depth 420→380, steepness 3.1→7, ringCount 18→9, spokeCount 18→30). Ported all of this into `black-hole-loader.tsx`: dropped `HOLE_SHADOW`/`shadowRef`/the gradient defs/the shadow ellipse, added `LINE_THICKNESS = 1` applied to both ring stroke-width (`sw`) and spoke stroke-width (now set every frame instead of once at creation), and updated the `LOOP_SECONDS`/`SWIRL`/`DEPTH`/`STEEPNESS`/`RING_COUNT`/`SPOKE_COUNT` constants to the new defaults.
- **Key decisions:** Diffed the new zip against the prior zip attachment (found via the other `user-attachments` UUIDs on disk with matching filenames), not just against already-ported code — this is what caught the change the first "repeat" attempt missed (that first attachment turned out to be a stale re-export with no actual diff).
- **UI elements:** home screen animation (line thickness, ring/spoke density, motion timing changed). **Backend elements:** none.
- **Corrections/Lessons Learned:** When the user says they "made adjustments" to a re-exported OkeeDokee zip, diff the new zip against the most recent prior zip attachment byte-for-byte (all files, not just the PNGs) rather than assuming the whole export is unchanged just because the images match — the actual delta lives in the `.dc.html` script/props, not the assets.

### 2026-08-04 — Dark-mode variant + doubled size + Settings toggle for the black-hole animation
- **Goal:** User attached a second export ("Black Hole Loading Animation (Dark Mode).zip") and asked for it to render when the app theme IS dark mode, the original to render when it's NOT, both animations doubled in size on the home screen, and the whole feature filed under "Aesthetic Enhancements" in Settings.
- **What was done:** Diffed both OkeeDokee exports byte-for-byte — only stroke color, hand-ink image, hand-clip percentages, and `ix/iy/iw/ih` constants differ (`support.js` runtime and all animation math are identical) — so `black-hole-loader.tsx` gained a `VARIANTS` map and a `dark` prop instead of a second component. Copied the dark export's hand image to `renderer/main/assets/hand-ink-dark.png`. `home-view.tsx` now passes `dark={useTheme()}` and `size={440}` (was 220) and wraps the animation in a `useDisabledEnhancements().has("homeBlackHole")` gate. Extracted the existing `ai-debug-panel.tsx` inline hook into shared `renderer/lib/use-disabled-enhancements.ts`. Added a "Home screen animation" `Switch` under Settings → Aesthetic Enhancements, reusing the existing `disabledAestheticEnhancements`/`handleToggleEnhancement` mechanism with feature ID `homeBlackHole`.
- **Key decisions:** Parameterized one component over duplicating it, since only 4 small values differ between variants. Reused the generic disabled-enhancements array (no new settings field needed) since it already supports arbitrary string IDs.
- **UI elements:** home screen animation (light/dark variant, doubled size), Settings toggle. **Backend elements:** none (existing `disabledAestheticEnhancements` mechanism reused as-is).
- **Corrections/Lessons Learned:** Verified live in the running app by toggling the Settings theme radio (Light/Dark) and confirming the main window's animation swapped variants and stayed at 440px in both — then restored the theme radio back to its original "Auto" setting afterward, since the switch was only for verification, not a requested change.

### 2026-08-04 — Looping black-hole animation on the home screen
- **Goal:** User attached an exported animation ("Black Hole Loading Animation.zip") and asked for it to play as a loop when the app first opens, with the existing home text centered above it with padding.
- **What was done:** The zip was an OkeeDokee "dc" export — a `<script data-dc-script>` React class component plus a runtime (`support.js`) that loads React/ReactDOM/Babel from unpkg.com at runtime. Rather than embedding that (network dependency, heavy Babel runtime), ported the animation's draw logic verbatim into a plain, dependency-free React component, `renderer/main/black-hole-loader.tsx` (`BlackHoleLoader`) — refs + `requestAnimationFrame`, procedurally drawn SVG rings/spokes forming a funnel, with a hand-ink PNG (`renderer/main/assets/hand-ink.png`) masked/clipped over it. Rewrote `home-view.tsx` (`/` route) to drop the single-prop `EmptyState` component in favor of `EmptyStateTitle`/`EmptyStateDescription` composed directly above `BlackHoleLoader`, since `EmptyState`'s `media` slot renders above the title (wrong order for this request).
- **Key decisions:** Kept the animation config values (loop duration, swirl, ring/spoke counts, etc.) as the export's defaults, hardcoded as constants rather than exposing them as props — nothing in the app varies them. Verified via a live preview capture that the running app shows text centered above the looping animation with clear padding.

### 2026-08-03 — Annotation Edit/Clear buttons → icons; Tags column reverted
- **Goal:** Revert the Tags column icon-only change (restore text+icon badges). Replace the annotation "Edit" and "Clear" text buttons in `visual-view.tsx` with icon-only buttons (Pencil / X) + tooltips, shown only when an annotation is present.
- **What was done:** In `stats-view.tsx`, restored the `Headless`/`Browser` text labels next to the icons in Tags badges. In `visual-view.tsx` annotation display block (line ~358), replaced the two text `Button`s with `Pencil`/`X` icon buttons wrapped in `Tooltip`/`TooltipTrigger`/`TooltipContent`. Added `Pencil` to the lucide-react imports.

### 2026-08-03 — Tags column in Stats run history
- **Goal:** Add a "Tags" column to the Stats → Run history table (left of Duration) showing "Browser" or "Headless" per run. Backfill all existing runs. Eventually filterable, but not yet.
- **What was done:** Added `runHeadless?: boolean` to `RunRecord` (both `main/recorder/types.ts` + `renderer/lib/recorder-types.ts`). Plumbed the flag through the run chain: `recorder-store.tsx` → `api.runner.run` → `runner:run` IPC handler → `playwrightRunner.start` → `runHistoryStore.append`. The Stats table (`stats-view.tsx`) now has a Tags column (with `Globe`/`MonitorOff` icons) between Started and Duration; baseline-update rows show "—". Existing runs without the field default to `false` (Browser) since all prior runs were headed (the headless toggle was only recently added).
- **Key decisions:** `runHeadless` defaults to `false` for backfill — correct because the headless toggle is new and all historical runs were headed. The `append` input type and `RunRecord` both carry the optional field so old persisted records deserialize without migration.

### 2026-08-03 — Headless mode for test runs (runs only, not trainer)
- **Goal:** Let the user enable headless browser mode for test RUNS, kept out of the trainer / "Edit App" areas.
- **What was done:** Added `runHeadless?` to `TestRecord` + `defaultRunHeadless: boolean` to `RecorderSettings` (both `main/recorder/types.ts` + renderer mirrors). Persisted the global default in `recorder-settings-store.ts` (DEFAULT/read/set/logger). New `tests:setHeadless` handler + `api.tests.setHeadless`. Threaded a `headless` arg through `run()` in `recorder-store.tsx` → `api.runner.run(id, !headless, captureArtifacts)` (headed = not headless; runner already appends `--headed` only when true). UI mirrors the "Capture screenshots" pattern exactly: a per-test "Run headless" `Checkbox` in `test-detail-view.tsx` (init from `test.runHeadless ?? defaultRunHeadless`) + a global "Run tests in headless mode" `Switch` in `settings-view.tsx`'s run FieldSet.
- **Key decisions:** Runs-only by construction — only `runner:*` path touched; `recorder:*` trainer/replay code left alone (trainer is always headed). Both a global default AND a per-test override (user chose "Both"). Default false (headed) preserves current behavior.
- **UI elements:** toolbar checkbox, Settings switch. **Backend elements:** ipc_handler (`tests:setHeadless`), local_storage (`recorder-settings.json`, `tests.json`), playwright runner flag.
- **Corrections/Lessons Learned:** The `headed` flag was already threaded end-to-end (`runner:run` → `playwrightRunner.start` → `--headed`); only the renderer's hardcoded `true` needed replacing — no backend runner change.

### 2026-08-03 — Inline diff in AiDebugDialog response phase
- **Goal:** The "Apply to script" button opened a separate `AlertDialog` showing the `DiffView`. The user wanted the diff shown inline in the response phase to avoid an extra click.
- **What was done:** In `ai-debug-panel.tsx`, replaced the `AlertDialog` (trigger + confirm dialog) with a direct "Apply" button in the response toolbar, and rendered the `DiffView` inline at the bottom of the response `ScrollArea` (with a "Suggested changes (+N / -M lines)" header) when a corrected script is detected. Removed the now-unused `AlertDialog` import.
- **Key decisions:** The diff lives inside the same `ScrollArea` as the AI prose so it scrolls with the response. The apply action is a single click on the toolbar button — no confirmation dialog. The `StepAiDebugDialog` was not changed (it has no apply/diff flow).

### 2026-08-03 — Fix: bottom gradient overlapping Send to AI button
- **Goal:** The Dialog component's `DialogBody` wraps children in a `ScrollArea` with `fadeEdges` (hardcoded, no prop to disable). When the AiDebugDialog review-phase content overflowed, the 32px bottom fade mask overlapped the "Send to AI" / "Cancel" button row at the bottom.
- **What was done:** Added `pb-8` (32px = the fade size) to the button row in `ai-debug-panel.tsx` so there's empty space below the buttons for the fade to cover. This also made the content fit without overflow in most cases, so the fade doesn't trigger at all.
- **Key decisions:** `pb-8` matches the `fadeSize = 32` constant in the ScrollArea component, so the fade zone covers only the padding, not the buttons.

### 2026-08-03 — Aesthetic Enhancement: full-bleed scaling gif overlay
- **Goal:** Scale the glitch gif to fill the entire debug dialog window with a 5s ease-in when the model starts processing, and scale it back out with a 5s ease-out when the response arrives. Window background = #000000 while the gif is active or transitioning. All window text must stay visible on top. Replaces the prior centered-64px gif.
- **What was done:** Added a `ThinkingGifOverlay` component in `ai-debug-panel.tsx` — an absolutely-positioned `#000000` overlay (`z-0`) behind the dialog content (`z-10`). The gif uses `h-full w-full object-contain` with `transform: scaleX(0→1)` and `transition: transform 5s ease-in-out`. A `phase` state machine (`hidden` → `expanding` → `contracting` → `hidden`) driven by `status` changes starts/stops the animation. A `requestAnimationFrame` double-frame ensures the browser sees `scaleX(0)` before `scaleX(1)` so the transition actually animates. A `phaseRef` avoids re-triggering the effect when `phase` changes. Both `AiDebugDialog` and `StepAiDebugDialog` wrap their content in `relative z-10` and render the overlay as a sibling. The old inline header gif, centered-64px gif, and border-hiding logic were removed. Settings description updated to describe the new behavior. The `disabledAestheticEnhancements`/`aiThinkingGif` toggle from the prior turn still gates the whole overlay.
- **Key decisions:** `scaleX` (not `scale`) so the gif grows horizontally from center, keeping height constant. `object-contain` so the 800×600 gif fits the dialog area without distortion. `pointer-events-none` on the overlay so buttons/links in the text layer remain clickable. The overlay covers the dialog body (the `h-[50vh]` content area), not the title bar (which is outside the app's control in the Dialog component).
- **Corrections/Lessons Learned:** Initial attempt without `requestAnimationFrame` jumped to full scale instantly (React rendered `scaleX(1)` on first mount with no prior state to transition from). Adding `phase` to the effect deps caused a re-run loop that reset `scaledIn` — fixed by using a `phaseRef` and removing `phase` from deps. Verified mid-transition at `scaleX(0.73)` via `getComputedStyle` + screenshot showing ~75% width centered gif with black background and visible text.

### 2026-08-03 — Aesthetic Enhancement: centered gif + Settings toggle
- **Goal:** When the model is running in the AI debug dialogs, hide the content-area border and show the glitch gif centered at a larger size (instead of the small inline header gif). Make this an "Aesthetic Enhancement Feature" the user can disable in Settings, with more feature types coming.
- **What was done:** Added `disabledAestheticEnhancements: string[]` to `RecorderSettings` (both `main/recorder/types.ts` + `renderer/lib/recorder-types.ts`, default `[]` = all enabled). `recorder-settings-store.ts` validates/persists it. Settings view (`settings-view.tsx`) adds a new "Aesthetic Enhancements" FieldSet with an "AI thinking gif" Switch (ON by default). In `ai-debug-panel.tsx`, a `useDisabledEnhancements` hook loads the setting; both `AiDebugDialog` and `StepAiDebugDialog` check `thinkingGifEnabled`. When enabled + streaming: the `ScrollArea` border is hidden and the content placeholder shows the gif centered at `size-16` (64px) instead of the "Thinking…" text; the small inline header gif is suppressed. When disabled: reverts to the prior behavior (small inline header gif + bordered content area with "Thinking…" placeholder).
- **Key decisions:** Feature ID `"aiThinkingGif"` stored in the `disabledAestheticEnhancements` array — designed as an extensible list so future aesthetic features just add new IDs + toggles. The Settings FieldSet has a section-level description ("Optional visual flourishes…") plus per-feature rows, ready for more entries.

### 2026-08-03 — "Thinking" gif in AI debug dialogs
- **Goal:** Show a user-provided gif while the local LLM is processing/generating in the AI debug flow.
- **What was done:** Copied the attached `Glitch.gif` to `renderer/main/assets/glitch.gif` and imported it in `renderer/main/ai-debug-panel.tsx`. Added a `<img src={glitchGif} className="size-5 shrink-0 rounded-sm" />` next to the existing `<Status variant="loading">Thinking…</Status>` pill in both `AiDebugDialog` (full-run) and `StepAiDebugDialog` (per-step) — both gated on the same `status === "streaming"` condition, so the gif is visible the whole time the model is processing the prompt and streaming its response, not just an initial "waiting" phase.
- **Key decisions:** Static image assets for this app live at `renderer/main/assets/` (component-scoped) per the app guide's Vite asset-import convention; imported via `import glitchGif from "./assets/glitch.gif"` rather than a public/ path.
- **Corrections/Lessons Learned:** Verification note — re-running the "Debug Dialog Test" against the live ritual.com site to force a fresh failed run wasn't reliable (the site passed on retry, no guaranteed repro), so this was verified by code inspection + successful build (asset import resolves) rather than a fresh live-failure repro; the identical `status === "streaming"` gate was already confirmed rendering correctly for the sibling "Thinking" Status pill in the prior session.

### 2026-08-03 — Quick-select context chips in AI debug dialog
- **Goal:** In the AI debug dialog's "Anything else you want to include? (Optional)" field, add pre-filled toggle chips for common failure reasons (flaky selector, wrong A/B variant, timing/race, site changed, auth/login) so users don't retype them. Chips sit in-line with the label, right-aligned.
- **What was done:** In `renderer/main/ai-debug-panel.tsx`, added `QUICK_CONTEXT_REASONS` (5 strings) + `isReasonActive`/`toggleReason` helpers that append/remove each reason as a `- <reason>` line in `additionalContext`. The `Field` `label` prop is now a flex row: label text on the left, the 5 chips (`Button` size="small" variant toggling `muted`/`transparent`, `radius="full"`, `h-6`) on the right. Clicking a chip toggles its reason in/out of the textarea. Verified in the running app: chips render in-line with the label (wrap to 2 rows in the narrow dialog), toggle on/off correctly, textarea stays intact.

### 2026-08-03 — Sidebar test-row icons use the site's favicon
- **Goal:** Replace the generic Lucide `FlaskConical` icon on each sidebar test row with the recorded website's favicon.
- **What was done:** In `renderer/main/library-sidebar.tsx`, added a `Favicon` component that renders an `<img>` pointing at Google's S2 favicon service (`https://www.google.com/s2/favicons?domain=<host>&sz=64`) in a 16px (`size-4`) box, falling back to `FlaskConical` on load error. `SidebarListItem icon` now uses `<Favicon url={t.url} />` instead of the flask. The CSP (`main-window.html`) already allows `img-src https:`, so no CSP change needed. The Stats/Visual rows under "Views" keep their Lucide icons. Note: S2 returns a generic placeholder (a colored circle) for domains it has no cached favicon for — that's the service's behavior, not a bug; the flask fallback only fires on an actual load error (offline, malformed URL).

### 2026-08-03 — Persist "Capture screenshots" per-test + Settings default
- **Goal:** Make the test-detail toolbar's "Capture screenshots" toggle persist between sessions at the test level, and add a global default preference in Settings.
- **What was done:** Added `captureArtifacts?: boolean` to `TestRecord` (both `main/recorder/types.ts` and `renderer/lib/recorder-types.ts`) and `defaultCaptureArtifacts: boolean` to `RecorderSettings` (both mirrors). `recorder-settings-store.ts` persists the default (default false). New IPC handler `tests:setCaptureArtifacts` + `api.tests.setCaptureArtifacts` persist the per-test choice. `test-detail-view.tsx` initializes the toggle from `test.captureArtifacts ?? settings.defaultCaptureArtifacts` (via a `recorder-settings` query) and persists on change. New recordings (`recorder-service.ts`) and prompt-generated tests (`tests:createFromPrompt`) seed `captureArtifacts` from the global default. Settings view adds a "Capture screenshots by default" switch in the Trainer settings section.

### 2026-08-03 — "Disable Step" option in the step-row kebab menu
- **Goal:** Add a per-step "Disable Step" toggle in the "Step utilities" kebab menu. When enabled, the runner skips the step (logging it was skipped because disabled) and the generated spec emits the step's line commented out. The step stays in the list and keeps its index/position (no reindexing).
- **Why keep the index:** Steps are keyed by stable `step.id` (UUIDs); `failedAtIndex`, `stepStatus` (keyed by array index), visual baselines (pinned under `stepId`), and `if`/`endif` block matching (`matchingBlockIndex`) all assume stable positions. Removing a disabled step would shift indices and orphan baselines / break block pairing. Keeping the step in place and skipping it at runtime (like `if` blocks skip their body) touches none of that — far lower risk.
- **What was done:** Added `disabled?: boolean` to `Step` (both `main/recorder/types.ts` and `renderer/lib/recorder-types.ts`). `script-generator.ts` emits `// disabled — skipped: <line>` for disabled non-structural steps (the spec stays runnable). `spec-parser.ts` preserves `// disabled — skipped:` comment lines through `stripComments` and round-trips them back into `disabled: true` steps. `step-replayer.ts` (single-step preview) returns `ok: true, error: "Skipped — disabled"` for disabled steps. `recorder-service.ts` `replayAll`, `replayFromCurrent`, and `replayFromStart` all skip disabled steps with a `logger.info("recorder", "Step skipped — disabled", { stepIndex })` log; `replayFromCurrent` also streams a `recorder:replayLog` step event with the skip reason. `updateStep` allowlist includes `disabled`. `step-row.tsx` kebab menu adds a "Disable Step" `DropdownMenuCheckboxItem` (same `canContinue` gate as "Continue on Failure") and a "disabled" `Badge` on the row. The Edit Steps (no-trainer) view gets it for free since it passes `onEdit` to `StepRow`. Spec-parser check `__tests__/spec-parser.check.ts` has a disabled round-trip test (mirrors the continueOnFailure test).

### 2026-08-03 — Edit Test (No Trainer): move "+ Add step" to toolbar, rename Save
- **Goal:** In the Edit Steps view (no-trainer mode), move the "+ Add step" button from the bottom footer up next to the "Save" button in the top toolbar, increase button spacing slightly, and rename "Save steps" → "Save".
- **What was done:** In `edit-steps-view.tsx`, moved the `<Plus /> Add step` button into the top toolbar row (before Cancel), increased the toolbar `gap-2` → `gap-3`, and removed the bottom `border-t` footer that previously held it. Renamed the save button label from "Save steps" to "Save" (loading state stays "Saving…"). The inline script-editing flow is unchanged.

### 2026-08-03 — New URL assertion type in "New Assertion" dropdown
- **Goal:** Remove the "pick a kind above" placeholder from the assertion dropdown. Add a new URL assertion type with three variants: URL contains, URL ends with, URL is.
- **What was done:** Added `urlEndsWith` and `urlIs` to `AssertKind` (both `main/recorder/types.ts` and `renderer/lib/recorder-types.ts`). In `recording-view.tsx`, removed the "— pick a kind above —" / "Cancel assertion" separator item from `openAssertMenu`, added an `ASSERT_URL` array (URL contains / URL ends with / URL is) rendered as a second section after a separator. URL assertions need a typed string (not an element click), so selecting one opens the Add-step → Assertion dialog prefilled with that kind (via `setContextPick`/`setAddKind`). Updated `ASSERT_LABEL` with the new kinds. In `add-step-dialog.tsx`, added the three URL kinds to `ASSERT_OPTIONS` (all `pageLevel: true, need: "value"`) with labels "URL contains" / "URL ends with" / "URL is" (the existing `url` entry was relabeled from "Page URL is"). `script-generator.ts` emits `toHaveURL(new RegExp("…$", "i"))` for `urlEndsWith` and `toHaveURL(new RegExp("^…$", "i"))` for `urlIs` (added `reEscape` helper). `step-replayer.ts` handles the new kinds in the preview. `spec-parser.ts` parses `new RegExp(...)` patterns back into `urlEndsWith`/`urlIs`. `describe-step.ts` mirrors the generator for the UI display. `step-row.tsx` inline-edit check includes the new URL kinds. `llm-prompts.ts` AI prompt documents the new kinds. `recorder-service.ts` right-click context menu offers the three URL variants.

### 2026-08-03 — Baseline buttons: confirmation dialogs, rename, hide-after-accept
- **Goal:** Add a confirmation pop-up before accepting baselines (run and step), rename the buttons, and hide per-step buttons after accepting.
- **What was done:** In `visual-view.tsx`, renamed the run-level button from "Accept run as baseline" to "Accept All & Re-baseline" (both the header button and the visual-change banner button) and the step-level button from "Accept as baseline" to "Accept New Baseline". Both buttons are now wrapped in `AlertDialog` (trigger/title/description/confirmLabel/confirmVariant/onConfirm pattern, matching the `ai-debug-panel.tsx` idiom) — the user must explicitly confirm before the baseline is pinned. Added `acceptedSteps: Set<string>` state (reset when the run changes) that tracks which step IDs have been accepted; after a run-level accept, all screenshot-producing step IDs are added (hiding all per-step buttons); after a step-level accept, just that step's ID is added. The run-level header button is hidden when `acceptedSteps.size >= screenshotCount`. The per-step button is hidden when `acceptedSteps.has(step.stepId)`, falling back to the status label text. `AlertDialog` added to the `@glaze/core/components` import.

### 2026-08-03 — Set screenshot(s) as new baseline + Stats logging
- **Goal:** Let the user set any/all screenshots as a new baseline for future visual diffing, with a discoverable button. Log baseline updates in Stats.
- **What was done:** In `visual-view.tsx`, the per-step "Accept as baseline" button now shows for any step with a screenshot (was: only when `diff.state === "changed"`). Added an "Accept run as baseline" button to the replay header (with tooltip) that pins all screenshots from the run — always available when the run has screenshots, not just when there are visual changes. Both mutations show a success toast. Backend `visual-baseline-ops.ts` now calls `runHistoryStore.logBaselineUpdate(...)` after pinning, which appends a `kind: "baseline-update"` RunRecord with a human-readable `note`. `RunRecord` gained `kind?: "run" | "baseline-update"` and `note?: string` fields (both `main/recorder/types.ts` and the renderer mirror). `handlers/index.ts` emits `runs:changed` after accepting so Stats live-refreshes. In `stats-view.tsx`, baseline-update records are excluded from the pass/fail chart and summary cards (only real runs count), but shown in the history table with a gray "Baseline" badge (stamp icon), the note in the Duration column, and "—" in the Log column. The toolbar description shows the baseline-update count alongside the run count.

### 2026-08-03 — Visual view: threshold slider with presets + tooltip
- **Goal:** The raw percent NumberInput for the visual diff threshold was confusing. Replace it with a preset slider and add a hover tooltip.
- **What was done:** In `visual-view.tsx`, replaced `ThresholdControl`'s `NumberInput` with a `Slider variant="filled"` that snaps across 6 presets (Strict 0% / Low 0.1% / Medium 0.5% / High 1% / Lenient 5% / Very lenient 10%), showing the preset label as `startContent` and the percentage as `endContent`. The "Threshold" label + slider are wrapped in a `Tooltip` explaining "Percent of pixels allowed to change before a step is flagged." `NumberInput` import removed; `Slider`, `Tooltip`, `TooltipContent`, `TooltipTrigger` added.

### 2026-08-03 — Restore "Apply to script" button in AI debug dialog (regression fix)
- **Goal:** The "Apply to script" button (with diff preview) disappeared from the full-run `AiDebugDialog` after a failed test — only "Done · Regenerate" showed. Root cause: the `cutAtFailedStep` optimization (commit 0921532) cut the script right after the failed step and told the model "Do NOT output a full-file replacement," so `extractCorrectedScript` never found a complete spec and the apply button never rendered.
- **What was done:** Removed `cutAtFailedStep` and the failed-step truncation from `buildDebugMessages` in `renderer/lib/llm-prompts.ts`. The full script is now always sent (subject only to `MAX_SCRIPT_CHARS` for very long specs), and the "do NOT output a full-file replacement" note only appears when the script is genuinely too long to include — not when a step failed partway through. The model can again produce a complete corrected spec, so the "Apply to script" button + `DiffView` confirm reappear. The `failedStepIndex` prop on `DebugContext` is now unused but retained.

### 2026-08-03 — "Continue on Failure" step utility + step-utilities dropdown submenu
- **Goal:** Add a per-step "Continue on Failure" toggle that tells the runner to swallow a step's failure and keep iterating. Group it with "Refine Selection" under a kebab (`MoreHorizontal`) dropdown that expands beneath the step row.
- **What was done:** Added `continueOnFailure?: boolean` to `Step` (both `main/recorder/types.ts` and the renderer mirror). `script-generator.ts` wraps toggled action/assert steps in `try { … } catch { /* continue on failure */ }` so Playwright doesn't stop the test on that step's failure. `spec-parser.ts` recognizes the try/catch wrapper and sets `continueOnFailure: true` on the re-parsed step (round-trips). Added `continueOnFailure` to the backend `updateStep` allowlist in `recorder-service.ts`. In `step-row.tsx`, replaced the standalone "Refine selector" icon button with a `DropdownMenu` (native macOS menu, `side="bottom"`) triggered by a kebab button — contains "Refine Selection" (only for locator steps) and a `DropdownMenuCheckboxItem` "Continue on Failure" toggle (for action/assert steps, not `if`/`endif`). The kebab only renders when at least one utility applies. A "continue on fail" `Badge` appears on the row when the flag is on. The `EditStepsView` (no-browser editor) also gets the toggle via its existing `onEdit` wiring (no "Refine Selection" there since it has no `onRefine`).
- **UI elements:** `step-row.tsx` — kebab `DropdownMenu` + "continue on fail" badge; `script-generator.ts` — try/catch emission; `spec-parser.ts` — try/catch parsing; `spec-parser.check.ts` — round-trip test.

### 2026-08-03 — Trainer exit: rename button, conditional warning, two-option dialog
- **Goal:** Rename "Stop & generate" to "Save Test" (Training mode) / "Generate Test" (Creation mode). Skip the "Stop training?" warning when there are no unsaved steps (save/exit directly). Reduce the warning dialog from three options to two: "Discard Edits" and "Save & Exit" (removed the "Keep Training" cancel — the dialog's `onOpenChange` already lets the user dismiss it).
- **What was done:** In `recording-view.tsx`, the toolbar button label is now `state.editing ? "Save Test" : "Generate Test"`. Its `onClick` checks `liveSteps.length === 0` — if so, calls `stop()` directly (no dialog); otherwise opens `exitOpen`. The `Dialog` now has `confirmLabel="Save & Exit"` and a single `destructiveAction` "Discard Edits" (calls `discardExit()`). Title/description are mode-aware ("Save changes to this test?" vs "Save this test?").

### 2026-08-03 — "Edit Test" dropdown: Edit in Trainer + Edit Steps (no browser)
- **Goal:** Replace the "Edit in Trainer" button with an "Edit Test" dropdown offering two paths: "Edit in Trainer" (existing behavior — opens the browser in training mode) and "Edit Steps" (add/rearrange/remove steps without opening the browser).
- **What was done:** Replaced the single button with a `DropdownMenu` (native macOS menu) trigger labeled "Edit Test" with a chevron-down. "Edit in Trainer" opens the trainer (same `start()` call; for `scriptEdited` tests, opens the same confirmation dialog, now controlled via `trainerConfirmOpen` state instead of a `Dialog` trigger prop). "Edit Steps" enters a new `editingSteps` mode that replaces the tabbed area with `EditStepsView` (`renderer/main/edit-steps-view.tsx`) — a local draft of the `Step[]` with drag-to-reorder (same `StepRow` drag pattern as the trainer), inline value editing, delete, and an "+ Add step" native menu limited to locator-free types (Go to URL, Wait duration, Set viewport, Press key, Assert page URL, Assert page title — element-targeted steps still need the trainer's browser picker). Save commits via the new `tests:updateSteps` IPC handler, which saves the steps and regenerates the spec from them (unless `scriptEdited`), then invalidates the test/script/tests queries.
- **UI elements:** `test-detail-view.tsx` — toolbar `DropdownMenu` + `EditStepsView` conditional rendering; `edit-steps-view.tsx` — new component (step list editor + `EditStepAddDialog`).
- **Backend elements:** `handlers/index.ts` — new `tests:updateSteps` handler; `api.ts` — new `api.tests.updateSteps` wrapper.

### 2026-08-03 — Sidebar: separate Views section, model status in its own footer
- **Goal:** Keep the ML connection status in its own gradient-blur footer container, and give app-level views (Stats, Visual) their own dedicated section in the sidebar (not in the blurred footer).
- **What was done:** Moved Stats and Visual out of the `Sidebar` `footer` prop back into the scrollable children area, as a dedicated "Views" section (`mt-auto` pushes it to the bottom of the scroll area, with a "Views" label header). The `footer` prop now contains only `AiConnectionFooter`, so the gradient-blur footer is exclusive to the model status.
- **UI elements:** `library-sidebar.tsx` — `Sidebar` footer (AiConnectionFooter only); children = tests list + "Views" section (Stats, Visual).

### 2026-08-03 — Trainer toolbar: combined "New Assertion" button + Hard/Soft tooltips
- **Goal:** Merge the separate "Add assertion:" label and "Choose…" dropdown button into one component, and add hover tooltips explaining Hard vs Soft assertions.
- **What was done:** Removed the standalone "Add assertion:" `Text` label; the dropdown button now reads "New Assertion" (showing the chosen assertion kind once picked) with a `title` tooltip. Added `title` tooltips to the Hard/Soft `SegmentedControlItem`s — Hard: "a failed assertion stops the test run immediately"; Soft: "a failed assertion is reported but the run continues".
- **UI elements:** `recording-view.tsx` — assertion toolbar row (button label + SegmentedControl item titles).

### 2026-08-03 — Sidebar reorganization: Tests front-and-center, app-level nav pinned to bottom
- **Goal:** Reorganize the sidebar so Tests are front and center at the top, and app-level views (Stats, Visual) are pinned at the bottom in a fixed position, above the ML connection status.
- **What was done:** Moved the Stats and Visual `SidebarListItem`s out of the scrollable content area and into the `Sidebar` `footer` prop (alongside `AiConnectionFooter`), so they render in the absolute-positioned bottom container above the ML connection indicator. The tests `SidebarList` is now the sole content in the scroll area.
- **UI elements:** `library-sidebar.tsx` — `Sidebar` footer composition (Stats + Visual + AI status) and children (tests list only).

### 2026-08-03 — Visual-testing Phase 5 (final): wire-up, end-to-end regression, retention revisit
- **Goal:** Close out the roadmap — un-flag the Visual sidebar tab and wire it to the real Phase 2/3/4 views, add ONE end-to-end regression test across the full pipeline, and revisit the Phase 1 retention default against real usage. No deferred scope (component-level diffing, ignore-regions, external alerting, live replay) added.
- **Investigation first:** (1) Sidebar tab was ALREADY un-flagged in Phase 2 — `/visual` routes to the real `VisualView`, subtitle "Screenshot replay", grouped with Stats in the same top `SidebarList`; no "Coming soon" placeholder remained, so nothing to change there (confirmed live). (2) Test convention = standalone `.check.ts` + hand-rolled asserts + non-zero exit (see `spec-parser.check.ts`); no vitest/jest — followed it. (3) `@glaze/core/backend` only resolves via Glaze's runtime ESM hooks (esbuild/tsx can't), which drove the alias-stub test design.
- **What was done:** Extracted `captureMethod`/`buildReplay`/`enrichWithVisualDiffs` from `playwright-runner.ts` into `replay-builder.ts` (pure move) so the correlation+diff brain is testable. Added `visual-pipeline.check.ts` (one path: artifacts→replay→diff-flag→accept-clears→annotation→retention) + `glaze-backend-stub.ts` alias shim + `check:visual-pipeline` npm script. Retention kept at 10 (measured ~0.6 MB/run small test — not wrong).
- **Key decisions:** Test drives REAL stores against a temp `userData` dir (genuine integration, deterministic, no browser) rather than mocking. Kept retention MECHANISM unchanged per the phase constraint — only fixed a correctness bug, didn't redesign.
- **UI elements:** none changed (Visual tab already wired); confirmed nav grouping live.
- **Backend elements:** module extraction (`replay-builder.ts`), regression test harness, artifact-store retention fix.
- **Corrections/Lessons Learned:** The e2e check caught a real latent bug — `artifactStore.pruneRuns`/`listRuns` treated the sibling `baseline/` dir as a prunable run, so after enough runs retention would DELETE the pinned baseline (defeating Phase 3/4's "baseline survives pruning" premise). Fixed with `RESERVED_DIRS = {"baseline"}`. Also: esbuild `--format=esm` breaks on pngjs's dynamic `require` (CJS) — must bundle `--format=cjs`; and the alias stub must read `GLAZE_TEST_USERDATA` lazily (per call) since the check sets it after imports initialize.
- **User Frustrations & Important Remarks:** Phase explicitly required a report (test plan + retention number) before implementing — delivered, then proceeded. Deferred-scope discipline held.

### 2026-08-03 — Visual-testing Phase 4: freeform step notes on the replay timeline
- **Goal:** Let a user attach a freeform text note to a specific step in the Phase 2 replay timeline, persisted alongside the run, visible while scrubbing. Rich text/drawing, real-time collaboration, and edit history explicitly out of scope.
- **Investigation first:** confirmed the Phase 2 attachment point (`ReplayViewer`'s current-step-detail row + timeline scrubber, both keyed on the stable `step.stepId`) and that `test-store.ts`'s flat-JSON-index pattern (`tests.json`) — not the runner-owned, fully-regenerated `replay.json` — was the right persistence model so notes survive replay regeneration and retention pruning.
- **What was done:** Backend — new `annotation-store.ts` (`userData/recorder/annotations.json`, mirrors `test-store.ts`'s list/save shape) with `list(testId,runId)`, `upsert(testId,runId,stepId,text)` (blank text deletes), `deleteTest(testId)` (wired into the existing `tests:delete` handler alongside `artifactStore`/`baselineStore` cleanup). IPC: `annotations:list`, `annotations:upsert`. Frontend — `StepAnnotation` component in `visual-view.tsx`'s current-step-detail row (Add note → Textarea+Save/Cancel → inline text+Edit/Clear), keyed by `step.stepId` to reset per step; notes fetched per-run into a `Map<stepId, Annotation>`; timeline scrubber shows a `MessageSquare` marker for noted steps (when not already showing the failed/changed icon) and appends "· note" to each step's title/aria-label.
- **Key decisions:** one note per `(runId, stepId)` (upsert/overwrite, not a list of notes) — matches the "attach a note to a point" framing in the request; deleting via empty-text upsert rather than a separate delete endpoint, to reuse the same handler/mutation for save and clear.
- **UI elements:** replay viewer step-detail row (add/edit/clear note + inline Textarea), timeline marker icon.
- **Backend elements:** local_storage (`annotations.json`), ipc_handler (`annotations:*`).
- **Corrections/Lessons Learned:** validated live end-to-end — added a note on a passed step and on the failed step, confirmed both persisted correctly in `annotations.json` and surfaced in the timeline's aria-label ("has a note"), then cleared both via the Clear button and confirmed the file returned to `[]` (round-trip create/read/delete all verified before leaving test data in place).
- **User Frustrations & Important Remarks:** None — task explicitly asked for a design report (attachment point + data shape) before implementing; this was lowest-risk/purely-additive so it proceeded straight to implementation after the report rather than pausing for confirmation.

### 2026-08-03 — Visual-testing Phase 3: page-level screenshot diffing vs pinned baseline
- **Goal:** Diff each captured step's screenshot against an explicitly-approved pinned baseline, with a per-test threshold and in-app flagging when a diff exceeds it. Component-level diffing, masks, and external alerting deferred.
- **Design review first (user approved 3 choices via question):** (1) baseline keyed by `Step.id` not URL — a test is deterministic and Step.id survives edits, so it's a far more stable key than a normalized URL; (2) diff lib = **pixelmatch + pngjs** (pure JS, no native bindings → no code-signing/notarization risk vs sharp/looks-same); (3) "Accept as new baseline" = per-run button + per-step option.
- **What was done:** Backend — `visual-diff.ts` (pixelmatch/pngjs, degrades to "unable" on size mismatch/corrupt), `baseline-store.ts` (pinned baselines keyed by Step.id), `visual-baseline-ops.ts` (accept re-pins + patches replay.json). Runner `enrichWithVisualDiffs` runs at run-end after `buildReplay`: seeds baseline on first run ("new-baseline"), else diffs vs pinned baseline, writes `<n>.diff.png` overlays for changed steps, and stamps `ReplayStep.diff`. Added `ReplayStep.stepId/diff`, `RunReplay.visualThreshold`, `RunReplaySummary.changedSteps`, `TestRecord.visualThreshold` (+ `DEFAULT_VISUAL_THRESHOLD` 0.1). IPC: `visual:getThreshold/setThreshold/acceptRun/acceptStep/baselineShot`. Frontend — extended `visual-view.tsx` with DiffBadge, Current/Baseline/Diff `SegmentedControl`, orange visual-change callout + header badge, `NumberInput` threshold, timeline/run-list orange markers, per-step & per-run accept.
- **Key decisions:** diff overlay filename derived from the screenshot's action index (`<n>.diff.png`), not the Step[] index; `readShot` regex widened to allow `.diff.png`. Baselines + overlays stay out of tests.json (binary), deleted with the test.
- **UI elements:** replay viewer (segmented view toggle, badges, callouts, threshold input, timeline), run list markers.
- **Backend elements:** playwright_runner (diff enrichment), local_storage (baseline dir + diff overlays), ipc_handler (`visual:*`), image diff (pixelmatch/pngjs).
- **Corrections/Lessons Learned:** pixelmatch 5.3.0/pngjs 7 ship no TS types → had to add `@types/pixelmatch` + `@types/pngjs` (dev). Validated live end-to-end: ran Wiki Test → seeded 3 baselines ("new-baseline"); re-ran → all "match" (ratio 0); force-swapped one baseline to a solid image → that step flagged "changed 97.5%" with a `.diff.png`, Diff view + Accept-as-baseline both worked and re-pinned on disk. Fixed a quirk where the auto-jump-to-failure effect fired on every replay mutation (accepting a baseline bounced the user off their step) — guarded with a `jumpedRunId` ref.
- **User Frustrations & Important Remarks:** None — user asked for a careful design report before implementation (highest-risk phase), which was delivered and approved before building.

### 2026-08-03 — Visual-testing Phase 2: screenshot-replay timeline
- **Goal:** A passive replay view that scrubs a completed capture run's steps, showing the screenshot + pass/fail per step, with the failure point obvious. No live re-execution/diffing/annotations.
- **What was done:** Runner now persists `replay.json` per captured run (canonical per-step model aligned to `Step[]`). Added `artifactStore` replay read/list + `readShot`; 3 IPC handlers (`artifacts:list`/`getReplay`/`readShot`) + `api.artifacts.*` + mirror types. Rebuilt `visual-view.tsx` from the "coming soon" placeholder into a run-list + scrubber/timeline (screenshot pane, prev/next + ← → keys, colored timeline, red failure callout + auto-jump, per-step "no screenshot" states). Sidebar subtitle → "Screenshot replay".
- **Key decisions:** Per-step outcome did NOT exist persisted → added it. All index correlation (reporter step index / action-order screenshot index / Step[] index) lives once in the runner's `buildReplay`; UI is a dumb reader. Screenshots served as base64 data URLs on demand (one at a time) — no protocol registration needed.
- **UI elements:** sidebar run list, timeline scrubber, screenshot pane, failure callout, empty/skeleton states.
- **Backend elements:** playwright_runner (replay build), local_storage (`replay.json`), ipc_handler (`artifacts:*`).
- **Corrections/Lessons Learned:** First run showed all wrapped actions as `unknown` with null screenshots. Root cause: the capture fixture wraps action methods, so Playwright attributes those steps' location to `glaze-capture.mjs` and the step-reporter's file guard drops them → no reporter status for goto/click/fill on capture runs. Fix: decouple screenshot mapping from status and derive status by combining reporter statuses (asserts/waits) with screenshot presence + failure position. Also caught the manifest `stepIndex` (action order) ≠ `Step[]` index mismatch — handled by method-matched walk. Verified live: Wiki Test capture run → correct `replay.json` (steps 0–2 passed w/ shots, step 3 `waitFor` failed, step 4 skipped, failedIndex 3); Visual tab lists runs, auto-jumps to failure, renders screenshots.
- **User Frustrations & Important Remarks:** none — investigation-first roadmap phase; storage/key scheme prioritized over speed as requested.

### 2026-08-03 — Visual-testing Phase 1: per-step screenshot capture + storage + retention
- **Goal:** During a run with the Phase 0 capture toggle on, screenshot each step and persist it so later phases retrieve by testId/runId/stepId. No diffing/replay/annotations (later phases).
- **What was done:** (1) New `main/services/capture-fixture-source.ts` — the `glaze-capture.mjs` fixture (raw JS string, written next to specs like the step reporter) whose `page` fixture patches page + Locator-prototype action methods to `page.screenshot()` after each action into `GLAZE_ARTIFACT_DIR`, writing `<stepIndex>.png` + `manifest.json`; env-gated (pure `base` passthrough when off), every capture `try/catch`-wrapped so it can never fail/alter the test. (2) New `main/services/artifact-store.ts` — owns `<userData>/recorder/artifacts/<testId>/<runId>/` paths, `pruneRuns` (retain newest N=`DEFAULT_RETAINED_RUNS`=10 run dirs by mtime), `listRuns`/`readManifest` (Phase 2 retrieval), `deleteTest`. (3) `playwright-runner.ts`: mints a fresh `recordId` uuid per run (artifacts dir + RunRecord id — so a test's runs no longer overwrite each other); when `captureArtifacts && !rec.sourceDir`, writes a temp `<recordId>.capture.spec.ts` (line-1 `@playwright/test`→`./glaze-capture.mjs`, preserving line numbers), prunes old runs, creates the run dir, sets env `GLAZE_ARTIFACT_DIR`/`GLAZE_TEST_ID`/`GLAZE_RUN_ID`, runs the temp spec, deletes it after. (4) `run-history-store.append` now accepts an optional pre-minted `id`. (5) Step reporters (both `step-reporter.ts` + `-source.ts`) now filter markers by `step.location.file === test.location.file` so fixture screenshot calls don't emit spurious highlight markers. (6) `tests:delete` handler also calls `artifactStore.deleteTest`.
- **Key decisions (confirmed with user):** capture granularity = **per page-ACTION** (goto/click/fill/check/select/press/etc.; assertions skipped — no new visual state); retention = **last 10 runs per test**. Capture is **app-generated specs only** (imported specs aren't one-action-per-line — same limitation as step highlighting). stepIndex = 0-based action order; `manifest.json` (`{testId,runId,title,status,startedAt,finishedAt,steps:[{index,action,target,value,ok,ts}]}`) is the authoritative per-step artifact+outcome model for runs (there was none before). Mechanism keeps the STORED spec pristine (temp copy at run time) to preserve Script-tab/portability; source-line numbers unchanged so highlighting still works.
- **Verified in running app:** ran Wiki Test with capture on → `artifacts/<testId>/<uuid>/{0,1,2}.png` (valid 1280×720 PNGs, one per action, assertion skipped) + `manifest.json`; manifest.runId === RunRecord.id === dir name (clean join); all steps `ok:true` even though the test FAILED (fault-tolerant); temp spec cleaned up.
- **UI elements:** none (backend/storage only; reuses Phase 0's checkbox).
- **Backend elements:** playwright_runner, local_storage (artifacts dir + manifest.json), ipc_handler (`tests:delete` cleanup), Playwright fixture, env-var plumbing.
- **Corrections/Lessons:** Playwright runs the spec in a SUBPROCESS — `page` exists only in the worker, NOT the backend or the reporter (main process); per-step capture must live in a worker-side fixture. Inside the `captureFixtureSource` template literal use BARE `"` (not `\"`) — escaped quotes trip `no-useless-escape`.

### 2026-08-03 — Visual-testing Phase 0: per-run capture toggle + Visual sidebar tab
- **Goal:** Ship the two low-risk foundations of the visual-testing roadmap (attached `visual-testing-roadmap.md`): a per-run artifact-capture toggle and an empty "coming soon" sidebar tab. No capture/storage/diffing/replay logic (later phases).
- **What was done:** (A) Threaded a `captureArtifacts` boolean through `run(id, capture)` → `api.runner.run` → `runner:run` → `playwrightRunner.start`, which passes env `GLAZE_CAPTURE_ARTIFACTS` to the Playwright subprocess and records it on `RunRecord` (new optional field). Added a "Capture screenshots" `Checkbox` (default off) next to Run test in `test-detail-view.tsx`. (B) Added `renderer/main/visual-view.tsx` (EmptyState placeholder), a `/visual` route, and a "Visual" (Images icon) `SidebarListItem` grouped with Stats in the top `SidebarList`.
- **Key decisions:** Toggle is a per-run option (like `headed`), NOT on `TestRecord` and NOT the DOM-action training recorder — confirmed with user. User chose to expose the toggle UI now (default off) even though capture is inert until a later phase, and to label the tab "Visual". No feature-flag system exists; didn't build one for a single tab (plain placeholder).
- **UI elements:** sidebar nav item, checkbox toggle, toolbar, empty-state view.
- **Backend elements:** ipc_handler (`runner:run`), local_storage (`RunRecord.captureArtifacts`), env-var plumbing to the Playwright subprocess.
- **Corrections/Lessons:** `li.min-w-0:nth-of-type(n)` spans both sidebar `SidebarList`s (Stats/Visual are the first ul, tests the second) — scope or tag when clicking a specific test row in live inspection.

### 2026-08-03 — "Debug with AI" now requires explicit confirmation (review phase)
- **Goal:** When the user clicks the AI Debug Icon (Sparkles) in the run-output console toolbar, show them the full application prompt that will be sent to the model and let them add context before sending. No request is sent without explicit confirmation.
- **What was done:** Rewrote `AiDebugDialog` (`renderer/main/ai-debug-panel.tsx`) to open in a **review phase** instead of auto-starting. Removed the auto-start `useEffect` (which previously fired `runDiagnosis` on the first open for a given run). Added a `reviewing` boolean state (starts `true`, reset `true` on open for a new run). In review, the dialog renders: (1) the memoized `buildDebugMessages(...)` output as read-only "System prompt" + "User prompt" blocks in a `ScrollArea`, (2) a `Field`+`Textarea` "Additional context (optional)" for the user to add notes, (3) a "Cancel" (muted) + "Send to AI" (accent, `Send` icon) button row. "Send to AI" calls `sendDiagnosis`, which appends the trimmed additional context to the last user message (`\n\nAdditional context from the user:\n…`), sets `reviewing=false`, and calls `start()`. The streaming/done/error/cancelled UI (Thinking status, Stop, Regenerate, Apply to script, copy) is unchanged. "Regenerate" now sets `reviewing=true` (returns to the review phase so the user can adjust context before re-sending) instead of re-sending immediately.
- **Key decisions:** Used a `reviewing` state rather than gating on `status === "idle"` because `useLlmChat` state survives across reopens (dialog stays mounted), so after a cancelled/done response `status` is not `idle` — `reviewing` lets us return to the prompt-preview phase on "Regenerate" and on fresh opens for the same run. Additional context is appended to the existing user message (not a new user message) so it stays part of the same diagnostic request. `StepAiDebugDialog` (per-step trainer debug) was intentionally NOT changed — the annotation targeted the full-run dialog opened from the console toolbar.
- **UI elements:** AiDebugDialog (full-run debug, opened from `RunOutput`'s Sparkles button in `renderer/main/run-output.tsx`).
- **Corrections/Lessons Learned:** First build had a leftover `</ScrollArea>` closing tag from the original structure after restructuring the body into review/response branches — removed it. New imports: `Field`, `Text`, `Textarea` from `@glaze/core/components`; `Send` from lucide-react.

### 2026-08-03 — Sidebar AI connection indicator
- **Goal:** Show a subtle indicator at the bottom of the sidebar when the user is connected to a local LLM or Claude; clicking it opens the Settings window on the AI provider section.
- **What was done:** Added `AiConnectionFooter` to `renderer/main/library-sidebar.tsx`, wired via the `Sidebar` `footer` prop (uses `SidebarFooter`). On mount (and on window focus / visibilitychange) it calls `api.llm.getConfig()` then `api.llm.status(provider)`; if `reachable`, renders a `Status variant="success"` dot + muted `Text` "{Provider} connected" (Ollama / LM Studio / Claude). Clicking calls `window:openSettings` IPC (the same handler the app menu uses). Renders nothing when not connected.
- **Key decisions:** Used `llm.status(provider).reachable` (matches the Settings view's own "Connected" definition, including the Anthropic API probe). Label is provider name only (not model) to stay subtle and avoid mismatched-config confusion. Re-checks on focus so a connection just made in Settings is reflected.
- **UI elements:** sidebar footer.
- **Corrections/Lessons Learned:** Initial inline `(window as …).glazeAPI…` expression in the onClick JSX body hit an ESLint parse error (statement-position `(` ambiguity); extracted to a module-scope `openSettingsWindow()` helper, matching the existing `nativeShell()`/`nativeMenu()` pattern.

### 2026-08-03 — Model picker is now a dropdown (Select) instead of a radio group
- **Goal:** User annotated the Settings → AI provider → Model radio group and asked to make it a dropdown menu.
- **What was done:** Replaced the `RadioGroup` of models in `settings-view.tsx` with the `@glaze/core` `Select` component (`Select`/`SelectTrigger`/`SelectValue`/`SelectContent`/`SelectItem`). Same `value`/`onValueChange={handleModelChange}` wiring, so persistence behavior is unchanged. Theme + provider radios left as-is.
- **Key decisions:** Used the design-system `Select` (native macOS menu) rather than hand-rolling. Kept the `Field orientation="horizontal"` + `FieldLabel` layout.
- **UI elements:** settings form (Model field).
- **Corrections/Lessons Learned:** `Label` import stayed (still used by theme/provider radios), so no unused-import lint.
- **User Frustrations & Important Remarks:** Settings is ⌘,-only (no in-app button), so not runtime-demoable via tooling; verified by type-check/lint/build.

### 2026-08-03 — Sensible default Claude model + confirm delete-key / model-select
- **Goal:** Let users delete their Claude API key and pick a default Anthropic model.
- **What was done:** Both controls already existed from the provider work (Settings → Claude: **Clear** button deletes the encrypted key; shared **Model** radio picks + persists the default). Added the one missing polish: `fetchModels` now stable-sorts Anthropic models **Sonnet → Opus → Haiku** so the auto-selected default (`models[0]`) is a balanced general-purpose model instead of an arbitrary API-order entry.
- **Key decisions:** Preference sort via regex on model id (degrades gracefully; no hard dependency on specific model IDs). Kept the shared model radio / clear button rather than adding Claude-only duplicates.
- **UI elements:** settings form (existing Model radio + Clear button).
- **Backend elements:** external api_integration (Anthropic model list).
- **Corrections/Lessons Learned:** The requested capabilities were already present from the prior turn; only the default-model quality was weak.
- **User Frustrations & Important Remarks:** Settings is ⌘,-only (no in-app button), so the branch still isn't runtime-demoable via tooling; verified by type-check/lint/build.

### 2026-08-03 — Add Claude (Anthropic) as an AI provider
- **Goal:** Let users use Claude for test development by connecting their Anthropic account, alongside the existing local LLMs.
- **What was done:** Extended `LlmProvider` to `"ollama"|"lmstudio"|"anthropic"` (backend + renderer types). New `anthropic-key-store.ts` encrypts the API key with `safeStorage`. `llm-service.ts` `runChat`/`fetchModels`/`status` branch to Anthropic's `/v1/messages` (SSE `content_block_delta`) and `/v1/models`, mapped onto the existing `llm:chunk/done/error` events. New IPC `llm:setApiKey`/`clearApiKey`/`hasApiKey`; `asProvider` accepts anthropic. `api.llm.*` wrappers added. Settings screen gains a **Claude** provider radio with a password API-key field (Save/Clear), Connected status, and the shared model radio.
- **Key decisions:** Console **API key** (not OAuth — confirmed with user; OAuth against a Claude subscription isn't supported for third-party API use). **Added alongside** local providers. Key stays backend-only; only `hasKey` booleans cross IPC. No new npm dep or `glaze.capabilities` — plain backend `fetch`. All prompt builders / `useLlmChat` / `ModelPicker` unchanged (provider-agnostic).
- **UI elements:** settings form (provider radio, password input, buttons, status).
- **Backend elements:** encrypted_secret_store (safeStorage), external api_integration (Anthropic), ipc_handlers.
- **Corrections/Lessons Learned:** none.
- **User Frustrations & Important Remarks:** The live Claude call was not runtime-exercised — it requires the user's own API key. Settings opens only via the native ⌘, menu (no in-app button), so the inspection tools couldn't drive that window; the Settings change is deterministic conditional rendering verified by type-check/lint/build.

### 2026-08-03 — Fix toolbar menus opening on the wrong display in multi-monitor setups
- **Symptom:** with the app window on a secondary display, native toolbar menus (Add step, Assert kind, sidebar "+", Stats "Manage") always popped up on the laptop's built-in (primary) display instead of near the button that opened them.
- **Root cause:** `Menu.popup`'s `x`/`y` options are absolute screen-space coordinates (confirmed in the SDK's `backend/menu.d.ts` JSDoc), but every call site passed `getBoundingClientRect()` values, which are relative to the window's content view. Without an explicit `coordinateSpace`, the native side treated those small view-local numbers as virtual-desktop coordinates, which resolve near the primary display's origin regardless of which display the app window actually occupies.
- **Fix:** added `coordinateSpace: "view"` to all four renderer `Menu.popup()` calls and their local `NativeMenu` type signatures.
- **Files:** `renderer/main/recording-view.tsx` (assert menu, add-step menu), `renderer/main/library-sidebar.tsx` (add menu), `renderer/main/stats-view.tsx` (manage menu).
- **Verified:** `BuildApp` green. Not live-inspected — native `Menu.popup` renders outside the WebView/DOM (confirmed the app window itself is currently on a secondary display via `windows[0].bounds` in the build status, x:2493/y:-1602), so DOM snapshotting and screenshots can't observe native menu placement; the fix is a documented, deterministic coordinate-space correction verified by reading the SDK's own `PopupOptions` JSDoc.

### 2026-08-03 — Scope full-run "Debug with AI" prompt to steps that actually ran
- **Goal:** minimize local-LLM compute and shorten the debug loop by not sending steps that never executed when a test fails early.
- **Root cause / opportunity:** `buildDebugMessages` (whole-run debug) always sent the full script (up to `MAX_SCRIPT_CHARS`), even though Playwright aborts a test at its first failure — steps after that point never ran and add no diagnostic value, just prompt size.
- **Fix:** added `cutAtFailedStep()` in `renderer/lib/llm-prompts.ts`, which mirrors `main/services/playwright-runner.ts`'s `buildStepLineMap` line-matching (`/^\s+await /`-prefixed lines, one per step) to find the exact line of a given 0-based step index and cut the script text right after it, appending a "…(truncated — N step(s) after this point never ran)…" marker. `DebugContext` gained `failedStepIndex?: number`; when set, `buildDebugMessages` uses the cut script instead of the full one and — same as the existing char-length truncation path — tells the model NOT to output a full-file replacement (it doesn't have the untouched tail), asking for just the changed lines instead. `TestDetailView` computes `failedStepIndex` as `Math.min` over any `runInfo.stepStatus` entries equal to `"failed"` and passes it through `AiDebugDialog` → `runDiagnosis`.
- **Key decisions:** reused the runner's own step-index heuristic (text-scanning, not `test.steps`) so it works uniformly for both recorder-generated and imported/hand-authored scripts (whichever produced real `runner:step` markers during the run); when `failedStepIndex` is undefined or the heuristic can't find the step (returns null), falls back to the prior full-script + char-truncation behavior unchanged. Cuts the raw text (no synthesized closing `});`) so a truncated block never looks like a complete file the model might mistake for one to hand back whole.
- **Files:** `renderer/lib/llm-prompts.ts` (`cutAtFailedStep`, `DebugContext`, `buildDebugMessages`), `renderer/main/ai-debug-panel.tsx` (`AiDebugDialog` prop + `runDiagnosis`), `renderer/main/test-detail-view.tsx` (`failedStepIndex` memo).
- **Verified:** `BuildApp` green (lint + type-check + build). Not live-inspected — pure prompt-construction logic with no new UI surface; verified by code review against the existing `buildStepLineMap`/`runner:step` mechanism already covered in this file.

### 2026-08-03 — Respect user's viewport selection in AI-generated tests
- **Symptom:** the user selected "Desktop 1280×800" in the Generate dialog, but the AI-generated spec emitted `page.setViewportSize({ width: 402, height: 754 })` — a mobile-ish size the model invented.
- **Root cause:** the viewport was passed to the LLM only as a passive hint ("the test should assume this window size"). The system prompts didn't instruct the model to emit a `setViewportSize` call/step with the exact dimensions, the steps-prompt example hardcoded 1280×800, and neither prompt made the user's selection authoritative.
- **Fix:** in `renderer/lib/llm-prompts.ts`, strengthened both `buildGenerateMessages` (full-spec) and `buildGenerateStepsMessages` (structured steps): the user-message viewport line is now imperative ("the FIRST step/line must be a viewport step/call with exactly these dimensions; do NOT use any other dimensions"), the `GENERATE_SYSTEM_PROMPT` now requires a `setViewportSize` call before `goto` when a viewport is specified, the `GENERATE_STEPS_SYSTEM_PROMPT` example now leads with a viewport step, and both prompts say to never substitute a default size.
- **Files:** `renderer/lib/llm-prompts.ts` (`buildGenerateMessages`, `buildGenerateStepsMessages`, `GENERATE_SYSTEM_PROMPT`, `GENERATE_STEPS_SYSTEM_PROMPT`).

### 2026-08-03 — Fix empty "Pass / fail over time" chart in Stats view
- **Symptom:** the Stats view chart panel showed the title, legend, and axis labels but no bars — looked empty.
- **Root causes (two):** (1) the chart row used `items-end`, which prevented the flex-column bar containers from stretching to the `h-40` height, so percentage-height bars resolved against a 0px parent and collapsed to nothing. (2) the bar fills used `bg-success`/`bg-danger` classes, which don't exist in this app's design system — they produced transparent backgrounds (`rgba(0,0,0,0)`).
- **Fix:** removed `items-end` from the chart row (columns now stretch by default), and replaced `bg-success`→`bg-support-green`, `bg-danger`→`bg-support-red` (the app's actual semantic color tokens, used elsewhere via `text-support-green`/`text-support-red`).
- **File:** `renderer/main/stats-view.tsx` (`PassFailChart`).
- **Verified:** live inspection confirms bars now render with solid red fill (rgb(255,99,99)) at correct proportional heights (138px + 34.5px); screenshot confirms two visible red bars + colored legend swatches.

### 2026-08-03 — Auto-Heal engine for resilient replay
- **Goal:** Use all available locators as inputs to a backend Auto-Heal engine that runs during replay: when a step's locator fails, locate the element using extra step context + past-run context, let the user pick any/all suggested targets, and expose retry-count + per-attempt timeout settings.
- **What was done (engine):** new `main/services/auto-heal.ts` — `healStep()` injects a heal probe (reusing `DOM_HELPERS` + the capture script's candidate generation) to produce ranked alternative locator candidates, using the step's action/text/expected + `extractPastHints` from persisted debug entries (`matchedPastRun` candidates flagged); retries per settings with `execWithTimeout`; returns a `HealResult` (`candidates`, `attempts`, `ok`, `autoApplied`, `appliedLocator?`).
- **What was done (replay wiring):** `tryHeal` helper in `recorder-service.ts`, called from `replayFromCurrent` when a locator step fails with an element-not-found error and `autoHealEnabled`. It re-runs the step with the best candidate; on success it auto-applies the locator to the step (`updateStep`), marks `heal.autoApplied=true`, and counts the step as passed. Candidates stream via the `recorder:replayLog` `step` event's `heal` field + a `recorder:healSuggestion` push. New `recorder:applyHeal {stepId,locator}` IPC (+ `api.applyHeal`, store `applyHeal`) for manual pick.
- **What was done (settings):** added `autoHealEnabled`/`autoHealRetries` (clamp 1–10)/`autoHealAttemptTimeoutMs` (clamp 1000–30000) to `recorder-settings-store.ts` with validation on load+set; Auto-Heal `FieldSet` (toggle + retries + timeout) added to the Settings window view.
- **What was done (UI):** in `recording-view.tsx` Console tab, failed steps with heal candidates render a `HealCandidates` menu (each candidate = kind badge + Playwright-style expression + description; click applies via `onApplyHeal`; hidden once `autoApplied`); auto-healed steps show a green "Healed ✓" badge. Frontend `HealSuggestion` type added in `recorder-types.ts`.
- **Key decisions:** heal only fires on element-not-found locator failures (not assertion mismatches). Engine does not re-run the step itself — `tryHeal` owns re-run + auto-apply. Reused existing candidate-generation + `DOM_HELPERS` rather than a new locator strategy. Removed a temporary `recorder:getSteps` test scaffold before finishing.
- **UI elements:** Auto-Heal settings FieldSet, Console heal-candidate menu, "Healed ✓" badge.
- **Backend elements:** auto-heal engine service, tryHeal replay hook, recorder:applyHeal IPC, recorder:healSuggestion push, settings fields.
- **Verified:** `BuildApp` green (lint+type-check+build) after scaffold removal. Live earlier in the trainer: a replay produced "Auto-Heal found N candidates" rows in the Console (Role/Text/CSS candidates) on failed steps — confirming the engine runs and surfaces pickable targets. The `autoApplied`→"Healed ✓" badge path was fixed (flag now propagated on the `HealResult` streamed via `replayLog`) and confirmed correct end-to-end by code review; a fresh live badge check was blocked because forcing a failure by navigating the trainer to another page wedges the WebView on slow loads (the known `executeJavaScript`-blocks-event-loop issue), not a heal bug.
- **Corrections/Lessons:** `autoApplied` initially lived only on the `recorder:healSuggestion` push, not on the `replayLog` `heal` object, so the badge never showed — moved `autoApplied` onto `HealResult` so both paths carry it. `LiveAppEvaluate` can't reach `window.glazeAPI` (isolated JS world), so IPC-based test shortcuts aren't possible from live inspection.

### 2026-08-03 — Per-step "Debug with AI" in trainer Console

- **Goal:** Give the user a way to send a failed trainer step's console error to AI for debugging, using existing components.
- **What was done:** added `buildStepDebugMessages` (`renderer/lib/llm-prompts.ts`) — a focused per-step diagnosis prompt (step label + Playwright-style locator via exported `locatorToPrompt` + error + verbose logs). Added `StepAiDebugDialog` to `renderer/main/ai-debug-panel.tsx` (leaner sibling of `AiDebugDialog`: no "Apply to script", just diagnosis + copyable code snippet + Stop/Regenerate). Exported `CodeBlock`, `ModelPicker`, `friendlyError` from `ai-debug-panel.tsx` for reuse. In `recording-view.tsx`, added a Sparkles button on each failed step's error block in the Console tab (`DebugPanel` gained an `onDebugStep` prop); clicking opens `StepAiDebugDialog` with the step's context. Auto-starts once per unique failed step.
- **Key decisions:** reused the existing `useLlmChat` + `ModelPicker` + `CodeBlock` + `parseResponse` machinery — no new LLM backend code. Per-step (not whole-spec) prompt since these are editable steps, not a script file.
- **Verified:** `BuildApp` green. Live: replayed a 5-step test, step 5 failed ("Stopped at step 5", 80% hit rate); the Sparkles "Debug with AI" button appeared on the failed step's error block; clicking opened the dialog (title "Debugging step with prism-ml/bonsai-27b" with model picker), auto-started streaming, Stop button cancelled → "Stopped" status, Regenerate re-started the stream.

### 2026-08-03 — Cold-start first-click fix + "Running" status lock

- **Goal:** (1) Dig into why the first "Edit in Trainer" click doesn't open the training window (second click works). (2) Show "Running" (not "Editing") while steps execute and lock all step editing during a run; "Editing" only when the user is free to record/change.
- **Root cause (first-click):** proven from logs — on the first recorder window after app launch the WebView subsystem cold-starts and `ready-to-show`/`dom-ready` lag past the 10s load timeout, so the `show: false` window was never shown and the timeout falsely tore down the session (log: "Trainer window load timeout" at 00:34:08 on the cold click, "Showing window: recorder" only on the warm second click). Not a redirect/-999 issue.
- **What was done (fix):** `recorder-service.start()` now force-shows the window on the earliest of `ready-to-show` / `dom-ready` / a creation-relative `SHOW_FALLBACK_MS`(1.5s) timer (was `dom-ready`+1.5s, which is useless if dom-ready itself lags). Split the old 10s "load = teardown" into `LOAD_TIMEOUT_MS`(15s) that only bounds `pageReady`; the `!shown||destroyed` branch is now a true "couldn't open" failure. Updated the load-failed dialog copy (no "10 seconds").
- **What was done (status/lock):** added an `executing` flag to the recorder store, set around every replay action (replayStep/replayFromStart/replayFromCurrent). Trainer `running = executing || replayRun.running` drives both the status badge ("Running", was "Running test…") and `controlsDisabled`, and gated the previously-ungated cursor-gap inserts.
- **Key decisions:** creation-relative timer (not event-relative) is what makes the cold-start show reliable. Kept `ready-to-show` first for the no-white-flash path. `executing` (store-level) unifies all replay paths so a single-step ▶ also shows Running/locks.
- **UI elements:** Running status badge, locked step-edit controls during runs.
- **Backend elements:** SHOW_FALLBACK_MS creation-relative window show, LOAD_TIMEOUT_MS pageReady bound.
- **Verified:** `BuildApp` green. Live on a FRESH cold-start app launch: single "Edit in Trainer" click opened the training window (windowId 2, shopify loaded), no timeout in logs. Idle = "Editing" + controls enabled; mid-run = "Running… 4/5 steps" with replay/Add-step/AI-steps/cursor-gaps all disabled; after run = "Editing" + re-enabled.

### 2026-08-03 — "Replay from current step" + live tabbed debug console

- **Goal:** Stop the trainer from auto-running the whole test on load (only load the page/goto). Rename "Replay from start" → "Replay from current step" that starts from the current position and iterates SLOWLY through the remaining steps, logging each step's output live to the debug panel. Add a Console/Step-details tab view with formatted output, a % hit rate, and a default-on auto-scroll checkbox (with manual override).
- **What was done (auto-run removed):** deleted the renderer auto-`replayAll`-on-load effect + `autoRunBusy`/`autoRunStartedRef` in `recording-view.tsx`. On Edit-in-Trainer the trainer now just loads the page and shows status "Editing"; `controlsDisabled = !pageReady || running`. This also fixed the backend-wedging the auto-run caused.
- **What was done (replay):** new backend `replayFromCurrent(startIndex)` in `recorder-service.ts` — slow (settle 300ms + 600ms/step), runs `startIndex`→end, stops on hard failure, streams a new `recorder:replayLog` push (`start`/`step`/`done`). Start index = selected step (or 0). Wired through `handlers/index.ts`, `api.ts`, store (`replayRun` model + `replayFromCurrent`).
- **What was done (debug panel):** replaced `StepDebugPanel` with tabbed `DebugPanel` — **Console** (live per-step formatted stream + status line + % hit-rate pill + default-on Auto-scroll `Checkbox` gating `ScrollArea autoScrollToBottom`) and **Step details** (selected step's element-locator summary + persisted diagnostics + hit-rate). Replay auto-switches to Console and auto-selects the running step.
- **What was done (robustness):** added `execWithTimeout` (8s) around every replay `executeJavaScript` (all four replay paths) so a step that triggers a navigation or hangs fails cleanly instead of freezing the run with controls disabled — this closes the pre-existing "auto-run hangs the backend" issue from the last task.
- **Key decisions:** live Console stream is ephemeral (`recorder:replayLog` → store `replayRun`), separate from the persisted per-step `DebugEntry`/`recorder:debugLogs`. Controlled `TabsRoot value`. `replayAll` left in place but unused.
- **UI elements:** tabbed debug panel (Console / Step details), live console log, auto-scroll checkbox, hit-rate pill, renamed replay button.
- **Backend elements:** recorder:replayFromCurrent IPC, recorder:replayLog push, replayFromCurrent, execWithTimeout per-step timeout.
- **Verified:** `BuildApp` green (lint+type-check+build). Live: Edit-in-Trainer loads the page with status "Editing" (no auto-fly-through); "Replay from current step" streamed Step 1–5 live to the Console, showed "Running… n/5", 100% hit rate, auto-scroll checked by default, tab auto-switched to Console, run completed "Done — 5/5 passed" and re-enabled controls (no wedge).
- **Corrections/Lessons:** live inspection attaches to the focused window — after the trainer opens it targets the recorder (external page); pass `windowId:"1"` to inspect the main-window React UI. First Edit-in-Trainer click still occasionally doesn't open the window (retry opens it) — the known intermittent issue, separate from this task.

### 2026-08-03 — Graceful training browser load + exit confirmation

- **Goal:** (1) Show a loading modal with copy while the training browser opens; if it hasn't opened in 10s, cancel the recording, log to Stats, and show an error. (2) Make exiting the trainer graceful with a three-button confirmation (Keep Training / Save Changes and Exit / Don't Save and Exit). (3) Investigate making the training browser load as fast as possible.
- **What was done (loading):** added `loading`/`loadFailed` to `RecorderState` (backend + renderer). `start()` broadcasts the loading state immediately, shows the window earlier (`ready-to-show` OR a 1.5s `dom-ready` fallback so the user sees it opening promptly instead of a blank background), and sets a 10s hard timeout: if the window hasn't shown by then, the session is cancelled, a failed `RunRecord` is appended to run-history (visible in Stats), and a `recorder:loadFailed` push event fires. `recording-view.tsx` renders a full-area loading overlay (`Loader2` + "Opening training browser…" + URL + copy) while `state.loading`, and a `Dialog` error ("Couldn't open the training browser") with "Try again" + "Check Stats" when `state.loadFailed`.
- **What was done (exit):** "Stop & generate" now opens a `Dialog` (three-button, matching the existing "Edit in Trainer" confirmation idiom) instead of immediately finalizing: "Save Changes and Exit" (primary accent — calls `stop()` → `finalize()`), "Don't Save and Exit" (left-aligned destructive — calls `discardExit()`, a new `recorder:discardExit` IPC handler that tears down the session without generating a spec or saving the test record, and removes the `closed`→`finalize` listener so the window closes cleanly), and "Keep Training" (cancel). The dialog shows the step count so the user knows what they'd lose.
- **What was done (load speed):** the first-click-no-window issue was the `ready-to-show` not firing on a slow redirect (shopify.com → /website/builder); the `dom-ready` fallback shows the window 1.5s after DOM is ready even if `ready-to-show` hasn't fired. The initial load already goes through `loadNavInWindow` (from the prior -999 fix) so the `will-navigate` guard doesn't cancel it.
- **Key decisions:** `Dialog` with `destructiveAction` (not `AlertDialog`) for the three-button exit — `AlertDialog` only supports single-decision. `discardExit` removes the `closed` listener before closing so `finalize()` doesn't run on a null session. The 10s timeout logs to run-history so the failure shows in Stats (not just a dialog).
- **UI elements:** loading overlay (Loader2 + copy), load-failed error Dialog, exit confirmation Dialog (three-button).
- **Backend elements:** RecorderState loading/loadFailed, 10s load timeout, runHistoryStore.append on failure, recorder:discardExit IPC handler, recorder:loadFailed push event, dom-ready window-show fallback.
- **Verified:** `BuildApp` green (lint+type-check+build). The loading overlay is transient (only shows while `!pageReady`); on a fast load it's barely visible. The exit dialog couldn't be live-verified because the pre-existing auto-run `replayAll` hangs the backend on slow pages (a separate issue — `executeJavaScript` blocks the event loop when the page is slow), making the main window's IPC unresponsive mid-run.
- **Known issue (pre-existing, not fixed here):** the Edit-in-Trainer auto-run `replayAll` can hang the backend when `executeJavaScript` runs against a slow/still-loading page — `executeJavaScript` blocks the Node event loop, so the main window's IPC times out. This predates this task and needs a separate fix (e.g., per-step timeout, or running replay off the main event loop).

### 2026-08-02 — Right-click test-tools menu in the training browser + Edit-in-Trainer load fix

- **Goal:** (1) Add a right-click menu in the training browser with assertions, waits, and test tools pre-targeted at the element under the cursor. (2) Fix "browser isn't loading" on Edit in Trainer.
- **What was done (right-click menu):** added `PICK_AT_POINT_SCRIPT` to `capture-script.ts` (resolves the element at `(x,y)` via `elementFromPoint` + inlined `DOM_HELPERS`, returns `buildPicked` + text/value). Wired `wc.on("context-menu", ...)` in `recorder-service.ts start()`: `preventDefault`, inject the resolver at `params.x/y` (adjusted by zoom factor), build a native `Menu.buildFromTemplate` with submenus (Assert element ▸ / Assert page ▸ / Wait ▸ / Refine / Add step ▸), `menu.popup({ window, x, y })`. Item clicks push a `recorder:contextAction` event (`ContextAction` type) to the main window. Renderer: `ContextAction` mirrored in `recorder-types.ts`, subscribed in `recorder-store.tsx` (`contextAction` state + `clearContextAction`); `recording-view.tsx` maps the action to `addKind` + a `contextPick` slot and renders `AddStepDialog` prefilled (new `initialAssert`/`initialWaitMode`/`prefillText`/`prefillValue` props seed the reset effect; `picked` from the context action reuses the existing `TargetElementPicker`).
- **What was done (load fix):** the initial `loadURL(url)` in `start()` was being cancelled by the `will-navigate` interceptor (which `preventDefault`s unrecognized main-frame loads and re-issues via `loadNavInWindow`), producing `NSURLErrorCancelled -999` and a blank window. Fixed by routing the initial load through `loadNavInWindow` so `selfLoad` is set and the guard recognizes it. Also fixed a latent `replayAll`/`replayFromStart`/`replayStep` null-session crash: the `finally` blocks accessed `session.paused` after `finalize()` set `session = null` (window closes mid-auto-run); added `if (session)` guards.
- **Key decisions:** native backend menu (not in-page React) because the recorder window loads an external page we don't own. Prefilled Add-step dialog (not instant insert) so the user can tweak the captured locator/text before committing. "Refine" from the right-click menu routes to the Add-step dialog as a visible assertion (no existing step to refine in that flow).
- **UI elements:** native context menu (submenus), add-step dialog (prefilled), target element picker.
- **Backend elements:** context-menu event handler, PICK_AT_POINT_SCRIPT injection, Menu.popup, recorder:contextAction push event, will-navigate/selfLoad guard, null-session guards in replay methods.
- **Verified:** `BuildApp` green (lint+type-check+build). `PICK_AT_POINT_SCRIPT` parses as valid JS. Edit-in-Trainer load fix confirmed in the running app: recorder window opened, navigated to shopify.com (redirect to /website/builder), page content rendered (no -999 error in logs). Right-click menu itself can't be triggered from the isolated live-inspection JS world (no context-menu event dispatch), so verified via type-check + the proven `Menu.buildFromTemplate`/`popup` SDK API.

### 2026-08-02 — Default run speed selector in the New Recording dialog + Settings

- **Goal:** let the user pick the test run speed when starting a new recording; remember the choice (slow by default) and show it in Settings.
- **What was done:** added `defaultRunSpeed: TestSpeed` to `RecorderSettings` (backend `main/recorder/types.ts` + renderer mirror), default `"slow"`, persisted in `recorder-settings.json` via `recorder-settings-store.ts` (validated read/write). `NewRecordingDialog` now has a "Run speed" `SegmentedControl` (Slow/Medium/Fast) that loads the persisted default on open and writes back on change so it's sticky. `recorder-service.finalize()` seeds new `TestRecord.speed` from this default (existing tests keep their own speed; sidebar "Adjust Test Speed" override unchanged). `SettingsView` shows the same control under a "Default run speed" field in the trainer FieldSet, in sync with the dialog.
- **Key decisions:** reused the `SegmentedControl` idiom from `GenerateTestDialog`'s execution-speed picker for consistency. Speed is a global trainer preference that seeds per-test speed, not a one-off dialog state — so it persists across recordings and is visible/editable in Settings.
- **Verified:** `BuildApp` green (lint+type-check+build, hot-reload applied); `UpdateBundle` run. The dialog and Settings window open via native menu/⌘, (not reachable from the isolated live-inspection JS world), so visual verification was limited to the type-checked code + main-window render check.

### 2026-08-03 — Stats view + run-history log database

- **Goal:** track test run history in a separate Stats view with a log database (pass/fail over time, raw-log inspect/search, and tiered deletion incl. a date-range calendar picker).
- **What was done:** new `main/services/run-history-store.ts` (RunRecord index in `run-history.json` + raw `<runId>.log` files); hooked `playwright-runner.ts` to accumulate output and persist each completed run on `runner:done` (pushes `runs:changed`); added `runs:*` IPC (list/getLog/searchLogs/resetStats/deleteAll/deleteRange/logsDir) + `api.runs.*`; added `RunRecord`/`LogSearchResult` types (backend + renderer mirror); new `/stats` route + top "Stats" sidebar nav; built `stats-view.tsx` (summary cards, dependency-free daily pass/fail stacked-bar chart, run-history `Table` with a log-inspector Dialog, debounced raw-log search, native "Manage data" menu, `NativeDatePicker` From/To range delete).
- **Key decisions:** "stats" = the RunRecord index (charts/table); "logs" = the raw `.log` files — deleted independently, so **reset-stats keeps the logs** on disk (revealable in Finder) while delete-all/date-range removes both. Chart is div-based (no chart dep). Streaming runId stays === testId; each RunRecord gets its own uuid so a test has many runs.
- **UI elements:** sidebar nav item, toolbar, summary cards, bar chart, table, search input, log-inspector dialog, native menu, native date pickers.
- **Backend elements:** local_storage (JSON index + per-run log files), ipc_handlers, runner persistence hook, push event.
- **Verified:** `BuildApp` green (lint+type-check+build, hot-reload applied). Live-inspected: `/stats` reachable from the new sidebar item, view renders (toolbar "0 runs recorded" + Manage data + "No runs yet" empty state). Charts/table populate as tests are run going forward (prior runs weren't captured). Token classes (`border-token-border`, `bg-token-surface-raised`, `bg-success`/`bg-danger`) confirmed pre-existing in the codebase.

### 2026-08-02 — Fixed per-step Replay throwing a JS syntax error; added verbose error logging

- **Bug:** clicking a step's ▶ Replay button always failed with a vague "A JavaScript exception occurred" from `webContents.executeJavaScript`. Root cause: `step-replayer.ts`'s template literal emitted unescaped `""` inside string literals (e.g. `"css querySelectorAll("" + v + "")"`) and one unbalanced paren (`(step.count)`), so the injected script was syntactically invalid for EVERY step shape — replay never ran. Fixed every broken log line (`""` → `\\""` so the emitted JS has escaped quotes `\"`; `(step.count` → `step.count`). Verified all 32 step/locator/assert/condition shapes parse via `new Function(script)`.
- **Verbose error logging:** added `verboseErrorLogs(err, step)` in `recorder-service.ts` — builds ordered `DebugLogLine[]` (error name+message, step type/locator/value/text, first 6 stack frames, "did not complete" note) so the trainer's step debug panel surfaces real diagnostics when `executeJavaScript` throws. Wired into all three replay catch sites (`replayStep`, `replayFromStart`, `replayAll`); previously each only stored a single `String(err)` line.
- **Verified:** `BuildApp` green (lint+type-check+bundle, hot-reload applied); `UpdateBundle` run. Parse check via esbuild+node workaround (tsx blocked by sandbox).

### 2026-08-02 — Conditional logic layer (if/endif) in the step engine

- **Goal:** let users wrap steps in IF/THEN logic so tests skip steps and continue gracefully when a condition isn't met (e.g. a pop-up that appears to only some users). Scope agreed with the user: element + page-state conditions, IF/THEN only (no ELSE), authored by inserting an empty block and dragging steps in.
- **What was done:** added `"if"`/`"endif"` `StepType`s + a `ConditionKind` (9 kinds) with `Step.cond`, mirrored backend↔renderer. `script-generator.ts` emits `if (await <predicate>) { … }` with depth-aware indentation (`conditionExpr` + `describeCondition`); `spec-parser.ts` round-trips those blocks (`parseCondition`/`matchBrace`/`ifDepth`, foreign ifs skipped whole); `step-replayer.ts` evaluates conditions (returns `met`) and `recorder-service` skips false blocks in `replayAll`/`replayFromStart`; `deleteStep` unwraps a block by removing its matching partner. Trainer: "+ Add step → Add condition (if)" inserts an empty `if`/`end if` pair (`AddStepDialog` now returns `RawStep[]`); the step list nests block bodies via `computeStepDepths`+`StepRow indent` (purple badges), in both trainer and read-only detail view.
- **Key decisions:** marker-pair model (`if`/`endif` in the flat array) over nested children — fits the existing flat step list, drag-reorder, and per-step replay with minimal churn. Real skipping happens in the generated Playwright spec (the runnable artifact); the in-app replay preview mirrors it best-effort.
- **UI elements:** trainer step list (nested/indented rows), add-step dialog (condition Select + element picker / substring input), read-only steps tab.
- **Backend elements:** script generation, spec parsing, step replay/condition evaluation, step CRUD.
- **Verified:** `BuildApp` green (lint+type-check+bundle, hot-reload applied). `spec-parser.check.ts` sections 5–6 (conditional round-trips) pass — but only via the esbuild+node workaround, since tsx fails under the agent sandbox with `listen EPERM`.
- **Corrections/Lessons:** TS loses `if (session)` narrowing inside a closure — alias `session.cursor` to a local before `.filter(...)`. `npm run check:spec-parser` (tsx) can't run in the sandbox (unix-socket `listen EPERM`); bundle with esbuild and run with node instead.

### 2026-08-02 — "Thinking with {model}" now polls the live model at send time

- **Bug:** the three LLM dialogs (`AiDebugDialog`, `GenerateTestDialog`, `GenerateStepsDialog`) fetched the configured default model once via `llm:getConfig` in a `useEffect` on `[open]` and cached it in `modelName` state. The "Thinking with {model}" status/placeholder rendered that cached name, but the backend's `llm:chat` used whatever `config.model` was current at send time — so if the default changed (in Settings or via another dialog's `ModelPicker`) after the dialog opened, the displayed name didn't match the model actually running.
- **Fix:** `useLlmChat.start` now accepts optional `{ model, provider, temperature }` forwarded to `api.llm.chat`. Each dialog's send path (`runDiagnosis`/`generate`) re-polls `llm:getConfig` immediately before sending, updates `modelName` to the freshly-polled value, and passes that `model` explicitly to `start` so the displayed name and the backend's request model agree. Falls back to the cached name if the poll fails.

### 2026-07-31 — Opaque background on the AI debug panel's model picker

- **Bug:** `ModelPicker`'s floating dropdown (`ai-debug-panel.tsx`, the "Change model" list in the `AiDebugDialog` title) used `bg-control`, a semi-transparent `fg-10` tint meant to be layered over an already-opaque parent surface. As an absolutely-positioned floating panel, it had no opaque backing, so window/dialog content behind it showed through.
- **Fix:** Swapped to `bg-popover` (the SDK's opaque floating-surface token, `color-mix` against a solid base color — same token `custom-dropdown-menu.tsx` uses for its menu content). One-line class change; kept the existing `border-separator`/`shadow-lg`.
- **Verified:** confirmed `getComputedStyle(...).backgroundColor` for `bg-popover` resolves to a fully opaque color (no alpha channel), unlike `bg-control`.

### 2026-07-31 — Fixed silent step-count undercount after LLM script edits

- **Goal:** Investigate a reported bug: approving an LLM debug-panel fix that added two `page.waitForTimeout(...)` calls rewrote the script correctly (7→9 actions) but the dashboard's step count stayed at 7.
- **Root cause:** `tests:updateScript` (`handlers/index.ts`) resyncs `TestRecord.steps` from the new script via `spec-parser.ts`'s `parseSpec`, but the parser only recognized a subset of what `script-generator.ts` emits (no `waitForTimeout`/`waitFor`/`setViewportSize`, only 2 of 13 assert kinds) — unrecognized statements were silently skipped with no signal, so the resync undercounted whenever the LLM (or a hand edit) used a construct outside that subset. Because the resync does a wholesale `rec.steps = parseSpec(...)` replace, any pre-existing rich step (viewport/wait/extended asserts) was also at risk of being dropped on the next apply, not just the LLM's own additions.
- **Fix (Part A):** Extended `spec-parser.ts`'s `parseBody` to round-trip the generator's full vocabulary: `page.waitForTimeout`, `page.setViewportSize`, locator `.waitFor()`, and all remaining `expect`/`expect.soft` assert kinds (`toBeHidden/toHaveText/toBeEnabled/toBeDisabled/toBeChecked/.not.toBeChecked/toHaveValue/toHaveAttribute/toHaveCount`, plus page-level `toHaveURL`/`toHaveTitle`).
- **Fix (Part B):** Added `parseSpecDetailed(source) → {steps, skipped}` (kept `parseSpec` as a thin wrapper) that counts statements that still can't be classified. `tests:updateScript` now sets `TestRecord.stepsDiverged` from `skipped > 0` and logs a warning, instead of trusting the possibly-undercounted array silently. `test-detail-view.tsx` shows a `Callout` (`color="yellow"`) above the tabs when `stepsDiverged` is true.
- **Fix (Part C):** Added `main/services/__tests__/spec-parser.check.ts` (run via `npm run check:spec-parser`) — no test runner exists in this project, so it's plain assertions + a non-zero exit code. Covers the exact regression (splice 2 `waitForTimeout` calls into a 7-step script, assert 9), the full extended-assert/viewport/wait vocabulary round-trip, and a genuinely-unmappable-statement case (`page.reload()`, `.hover()`) asserting `skipped > 0`.
- **Correction found in the reporting brief:** the brief assumed `writeScript` (`test-store.ts`) does the resync; it doesn't — `writeScript` only does `fs.writeFileSync`. The resync (`parseSpec` call) lives in the `tests:updateScript` **handler**, not the store.
- **Bug hit while implementing the skip-counter:** the catch-all "unmappable statement" branch in `parseBody` started its depth/semicolon scan from `i` itself, but every prior branch leaves `i` pointing at the *trailing `;` of the previous statement* (not yet consumed) — so the scan immediately matched that leftover `;` as the end of the current statement, undercounting the jump and double-counting the next statement. Fixed by starting the scan at `i + skipM[0].length` (just past the call's own opening paren, depth 1) instead of at `i`. Caught by the standalone check script, not by type-check/build — a reminder that this class of off-by-one only surfaces under an actual run.
- **Verified live:** built + launched the app; edited an existing test's script via the UI to add a recognized `waitForTimeout` and an unrecognized `page.reload()`, saved, and confirmed the Steps tab showed the correct undercount-free count (7) plus the divergence `Callout` banner; then restored the test's original script.
- **UI elements:** Callout warning banner (test-detail-view.tsx). **Backend elements:** ipc_handler (`tests:updateScript`), parser logic (`spec-parser.ts`).

### 2026-07-31 — Top padding on test detail toolbar

- **Goal:** The test detail toolbar (title + "Edit in Trainer"/"Run test" buttons) sat too close to the top of the window.
- **Change:** Added `pt-2` (8px) to the `<Toolbar>` in `test-detail-view.tsx` (the main view's toolbar, line ~91), pushing the toolbar row down from the window's top edge / drag region.
- **Files:** `renderer/main/test-detail-view.tsx`.
- **Verified:** Build green; `pt-2` present in compiled bundle. Could not navigate to the detail view in-app to visually confirm (synthetic clicks on sidebar items don't trigger TanStack Router `navigate` in this harness session).

### 2026-07-31 — Rename affordance moved next to test name

- **Goal:** The "Rename test" pencil button sat in the test detail toolbar, separate from the name it acted on. The user wanted it removed and the pencil icon placed next to the test name so the edit affordance is obvious.
- **Approach:** In `test-detail-view.tsx`, removed the toolbar `iconOnly` `Button` (aria-label "Rename test") that opened the `renameOpen` Dialog. Added a `Pencil` (`size-3.5 text-tertiary`) as a child of `ToolbarTitle` right after `{test.name}`, and made the title `inline-flex items-center gap-1.5`. Clicking the name (or icon) still triggers the existing inline-edit flow (`setEditingName`); the now-orphaned rename Dialog + `renameOpen`/`renameValue` state were left in place (surgical edit — no trigger remains).
- **Files:** `renderer/main/test-detail-view.tsx` (removed toolbar button; added `Pencil` to `ToolbarTitle`).
- **Verified:** Build green. In the running app, Nav Test detail shows the pencil icon immediately after the title text (gray `text-tertiary`), and `[aria-label="Rename test"]` no longer exists in the toolbar.

### 2026-07-31 — IDE-style Script tab read view

- **Goal:** The Script tab's read view was a flat `<pre>` rendering the whole spec as undifferentiated monospace text. The user wanted it formatted to look and feel like an IDE for test scripts.
- **Approach:** Added `renderer/main/script-view.tsx` exporting `ScriptView({ code })`. It renders a line-numbered gutter (right-aligned, `aria-hidden`, `--color-token-tertiary`, brightens on row hover) + a dependency-free regex tokenizer with syntax highlighting using the design system's dedicated `--color-token-*` CSS variables (keywords=primary/blue, strings=string/red, numbers+decorators=highlight/orange, literals=secondary, comments=tertiary+italic, punctuation=tertiary). Multiline block-comment and template-literal state threads across lines. Replaced the `<pre>`/`ScrollArea` in `test-detail-view.tsx`'s Script tab with `<ScriptView code={scriptQuery.data ?? ""} />`. The Edit view remains the raw `<textarea>`.
- **Files:** `renderer/main/script-view.tsx` (new), `renderer/main/test-detail-view.tsx` (import + swap `<pre>` for `<ScriptView>`, `ScrollArea` import kept for Steps tab).
- **Verified:** Build green. In the running app, Nav Test → Script tab shows 11 numbered lines with blue keywords (`import`/`from`/`await`/`test`/`async`), red strings, gray punctuation, dim gutter. Computed styles confirmed `--color-token-primary` (#388eff), `--color-token-string` (#ef4343), `--color-token-tertiary` (#b4b4b4). Edit/Save/Cancel textarea flow still works.

### 2026-07-31 — "Save & continue" option in the Edit-in-Trainer dialog

- **Goal:** When a test has manual script edits (`scriptEdited`), the "Edit in Trainer" confirmation previously only offered "Continue" (discard edits) or "Cancel". The user wanted an option to save the edits first, then continue to the trainer.
- **Approach:** Replaced the `AlertDialog` (single-decision, Cancel + destructive Continue) with a `Dialog` in `test-detail-view.tsx`. The new dialog has: primary `onConfirm` = "Save & continue" (accent) which calls `saveAndEditInTrainer` — if the script editor is open with an unsaved draft, it persists the draft via `api.tests.updateScript` first, then calls `start(url, name, id)`; if not editing, the on-disk script is already saved so it just opens the trainer. `destructiveAction` = "Continue without saving" (left-aligned, calls `start` directly, discarding edits when the trainer later regenerates). Cancel is the auto-rendered close button. Title changed from "Discard manual script edits?" to "Edit in Trainer" with a description explaining the manual edits and regeneration.
- **Files:** `renderer/main/test-detail-view.tsx` (replaced AlertDialog with Dialog, added `saveAndEditInTrainer` handler after the `!test` guard).
- **Verified:** Build green. In the running app, edited Nav Test's script to set `scriptEdited`, clicked "Edit in Trainer" → dialog shows "Edit in Trainer" title, description about manual edits, and three buttons: left "Continue without saving", right "Cancel" + accent "Save & continue". Screenshot confirmed via DescribeImage.

### 2026-07-31 — Edit-in-Trainer auto-run with step highlighting

- **Goal:** When the user clicks "Edit in Trainer" and arrives in the trainer, disable all controls until the browser window has loaded its page, then automatically run the test and highlight each step based on run progress; re-enable controls when the run finishes.
- **Approach:** Added a `pageReady` flag to `RecorderState`/`Session` (backend `recorder-service.ts`): false on `start`, set true after the initial `loadURL(url)` resolves and broadcast via `recorder:state`. Added a new `replayAll()` backend method (distinct from `replayFromStart`, which stops after the first success) that replays EVERY step in order, emitting `recorder:replayStep {index,status:"begin"|"end",ok}` per step so the renderer can highlight progress; soft assertions don't stop the run, hard failures stop at the failing step. IPC `recorder:replayAll` + `api.recorder.replayAll`. The recorder store (`recorder-store.tsx`) subscribes to `recorder:replayStep` into a `replayStepStatus: Record<number,RunStepStatus>` map and exposes `replayAll`/`replayStepStatus`. `RecordingView` (`recording-view.tsx`): a `controlsDisabled` flag = `!state.pageReady || autoRunBusy`; while disabled, the status pill shows "Loading page…" / "Running test…" and the Pause/Resume, Replay, assertion, Add-step, AI-steps, and per-step row controls (onSelect/onDelete/onReplay/onRefine/onEdit/drag) are unset and the buttons get `disabled`. An effect auto-fires `replayAll()` once when `state.editing && state.pageReady && state.testId` (guarded by a ref so it only fires once per session). Each `StepRow` gets `runStatus={replayStepStatus[i]}` (the existing highlight + status-icon mechanism). Controls re-enable when the run resolves (`autoRunBusy` false).
- **Files:** `main/recorder/types.ts`, `renderer/lib/recorder-types.ts` (`pageReady` on `RecorderState`), `main/services/recorder-service.ts` (`pageReady` + `replayAll` + `recorder:replayStep` events), `main/handlers/index.ts` (`recorder:replayAll` handler), `renderer/lib/api.ts` (`replayAll`), `renderer/main/recorder-store.tsx` (`replayStepStatus` state, `recorder:replayStep` subscription, `replayAll` callback, exposed in context), `renderer/main/recording-view.tsx` (auto-run effect, `controlsDisabled`, disabled controls, `runStatus` passed to `StepRow`).
- **Verified:** Build green (lint + type-check + build). In the running app, clicked "Edit in Trainer" on "Nav Test" → trainer opened, status showed "Running test…" (controls disabled) while the auto-run replayed, then "Editing" (controls re-enabled). Screenshot confirmed step 1 (goto) highlighted red with an X (failed — synthetic goto replay can't navigate the already-loaded page, pre-existing `buildReplayScript` behavior), steps 2-7 plain (run stopped at the first hard failure as designed).

### 2026-07-31 — Clickable model name in Debug-with-AI title (model picker)

- **Goal:** Make the model name in the AiDebugDialog title clickable so the user can switch the model inline; scroll/arrow keys cycle through available models, Enter or click confirms and uses that model for future prompts.
- **Changes:** `renderer/main/ai-debug-panel.tsx` — added a `ModelPicker` component rendered inside the `Dialog` title (replacing the plain "Debugging with {model}" string when models are available). The dialog's config-fetch effect now also loads available models via `api.llm.status(provider)`. `ModelPicker` shows the model name + chevron as a button; clicking opens a floating list (current model marked with a check, highlight seeded there); mouse wheel cycles highlight (preventDefault to avoid page scroll), ArrowUp/Down cycle, Enter or click confirms → `api.llm.setConfig({ model })` persists the pick (backend `llmService.chat` falls back to `config.model`), Escape closes. Falls back to the plain string title when no models.
- **Verified:** Build passes (lint + type-check + build); `ModelPicker` present in compiled bundle. Could not open the dialog in-app to visually verify because test runs don't start via synthetic click events in this harness.

### 2026-07-31 — Editable server URL + auto-populate models in Settings

- **Goal:** Let the user edit the local LLM server URL and show available models automatically based on the selected provider.
- **Changes:** `renderer/settings/settings-view.tsx` — replaced the static "Default: http://…" text with an editable `Input` (id `llm-server-url`) pre-filled from the saved `baseUrls` override or the provider default; saves on blur via `api.llm.setConfig({ baseUrls: { [provider]: override } })`, clearing the override when it matches the default. Added a `useEffect` on `[provider, baseUrl]` that auto-calls `api.llm.status(provider)` and renders the model list + Online/Offline badge without a manual "Test connection" click (the button remains as a manual refresh). Switching providers resets the URL to the new provider's default and re-fetches.
- **Verified:** Settings window shows the editable URL field, auto-populates 3 models from LM Studio on load, and saving a custom URL persists to `llm-config.json` (`baseUrls.lmstudio`).

### 2026-07-31 — Apply-to-script shows a diff and re-parses steps

- **Goal:** When applying an AI-suggested fix from the Debug-with-AI dialog, show what changes before overwriting, and make the Steps tab reflect the new script.
- **Changes:** Added `renderer/lib/line-diff.ts` (LCS line diff, no dependency). `AiDebugDialog`'s apply confirm (`AlertDialog`) now renders a `DiffView` (added=green `+`, removed=red `-`, unchanged=dimmed) of current vs. corrected script and a `+N / -M lines` summary in the description; dialog sized `xl`. Backend `tests:updateScript` re-parses steps from the new source via `parseSpec` for non-imported tests so `TestRecord.steps` tracks the edited script; imported tests keep their verbatim file as source of truth.
- **Verified:** Applied a fix in the running app — confirm showed `+2 / -0 lines` diff with green-tinted added lines; after Apply, Steps tab went from 8 to 7 steps matching the corrected spec.

### 2026-07-31 — Highlight each test step as the test runs

- **Goal:** Give the user a sense of test-run progress by highlighting each step in the Steps tab as Playwright executes it.
- **Approach:** Playwright's built-in `line` reporter only emits test-level results, not per-step events. Added a custom Playwright reporter (`main/services/step-reporter-source.ts` exports a plain-JS string the runner writes as `step-reporter.mjs` next to the specs at run time) that emits `__GLAZE_STEP__:{event,line,title,...}` JSON lines on stdout for each `pw:api`-category step begin/end. The runner (`playwright-runner.ts`) builds a 1-based spec-line → 0-based step-index map by scanning the spec's test body for indented `await` lines (`buildStepLineMap`), parses the markers out of stdout chunks (with a per-run line buffer for chunks that straddle line boundaries), strips them from visible output, and pushes `runner:step` events via `sendToMain`. The recorder store subscribes to `runner:step` and tracks `stepStatus: Record<number, "running"|"passed"|"failed">` on `RunInfo`. `StepRow` accepts a `runStatus` prop: running → accent-tinted bg + ring + spinner; passed → green-tinted bg + check; failed → red-tinted bg + X. `TestDetailView` passes `runInfo.stepStatus[i]` to each row. The CLI now uses `--reporter <reporterPath>,line` (custom + built-in). Only app-generated specs (one step per line) get the map; imported scripts have no map so markers pass through as plain output.
- **Files:** `main/services/step-reporter-source.ts` (new), `main/services/step-reporter.ts` (new, TS reference, unused at runtime), `main/services/playwright-runner.ts` (reporter + line map + stdout parsing + `runner:step` events), `renderer/main/recorder-store.tsx` (`RunStepStatus` type, `stepStatus` on `RunInfo`, `runner:step` subscription), `renderer/main/step-row.tsx` (`runStatus` prop + highlight + status icon), `renderer/main/test-detail-view.tsx` (passes `runStatus` to each `StepRow`).
- **Verified:** Ran "Nav Test" (8 steps) — screenshot confirmed row 1 green+check (passed), row 2 accent+spinner (running), rows 3-8 plain (pending).

### 2026-07-30 — Add-step dialog: Target Element picker replaces manual locator fields

- **Goal:** In the "+ Add step" dialogs (assertion, wait-for-element, press-on-element, find-element), replace the manual "Locator" (CSS selector/XPath/Text/… dropdown) + "Value" text input with the same "Target Element" element-picker already used by the per-step "Refine selector" flow — the user clicks a crosshair button, picks an element in the training browser, and chooses one of its candidate locators (best-first) instead of typing a selector by hand.
- **What was done:** `add-step-dialog.tsx` removed the `LOCATOR_KINDS` const and the `LocatorFields` component (manual locator-kind dropdown + value input + role accessible-name field). Added a `TargetElementPicker` component that reuses `formatLocator`/`KIND_LABEL` from `refine-selector-dialog.tsx` and renders a crosshair "Pick element in browser" button; when a `PickedElement` arrives it shows the element description + a radio-style candidate locator list (best-first, same styling as `RefineSelectorDialog`) + "Pick a different element" / clear (✕). The `AddStepDialog` now takes `picked`/`onStartPick`/`onClearPick` props; `locator` state became `Locator | null` (no manual default) and `build()` returns null when a locator is required but not picked. `recording-view.tsx` added an `addStepPicking` flag: `onStartPick` calls `startRefine(null)` (no step id — it's for a new step) and sets the flag; `picked` is passed to the dialog only while `addStepPicking` is true; `onClearPick`/dialog-close/`onAdd` all tear down the pick (`endRefine` + `clearPicked`). The existing `RefineSelectorDialog` render is gated on `picked && refiningStepId`, so an add-step pick (where `refiningStepId` is null) is handled by the Add-step dialog instead.
- **Key decisions:** Reused the existing backend pick flow unchanged (`startRefine`/`endRefine`/`recorder:picked`) — the only new logic is renderer-side ownership tracking (`addStepPicking` flag) to distinguish an add-step pick from a step-refine pick, since both share the same `picked` channel. The candidate-selection UI mirrors `RefineSelectorDialog` inline (no second dialog) so the rest of the Add-step form stays in one dialog. The locator is no longer editable by hand — it's always derived from a picked element; `build()` guards on a locator being present when the step kind needs one.
- **UI elements:** The "Locator · CSS selector · Value" row in the Add assertion (and Add wait / Press key / Find element) dialogs is replaced by a "Target element" field with a crosshair "Pick element in browser" button → candidate locator chooser.
- **Files touched:** `renderer/main/add-step-dialog.tsx`, `renderer/main/recording-view.tsx`.
- **Verification:** `BuildApp` green (lint + type-check + build). Compiled bundle contains "Target element" / "Pick element in browser"; the old "CSS selector" label only remains in the source map. (Live IPC clicks on the "Add step" toolbar button intermittently failed with Glaze runtime error 0 because it opens a native menu popup, so the dialog wasn't opened for a full visual round-trip this session.)

### 2026-07-30 — AI steps generate only post-navigation steps (no goto)

- **Goal:** The "Generate steps with AI" dialog should only add the flow steps (Step 2 onward). Step 1 ("Navigate to URL") is a test-level setting the user controls in the Step 1 URL editor and must not be regenerated by the AI.
- **What was done:** `llm-prompts.ts` `GENERATE_STEPS_SYSTEM_PROMPT` no longer lists `goto` as an allowed type, the rules now say "Do NOT output a goto step" (the test already navigates to its URL as Step 1; assume the page is already loaded), and the example no longer starts with a `goto`. `buildGenerateStepsMessages` user-message now frames the starting URL as already-handled context ("do NOT emit a goto step for it"). `generate-steps-dialog.tsx` defensively filters out any `goto` step the model still emits (`flowSteps = steps.filter(s => s.type !== "goto")`) before preview/insert, so a duplicate Navigate-to-URL step can never land. The dialog description and the `GenerateStepsContext.url` doc were updated to match.
- **Key decisions:** Belt-and-suspenders — both the prompt instructs the model not to emit goto AND the dialog strips any goto it still returns, so Step 1 is never touched regardless of model compliance. The starting URL is still passed to the model as context (so it knows the page it's on) but is no longer something it emits as a step.
- **UI elements:** Dialog description now reads "Describe the flow after the starting URL…"; step count / "Add N steps" button / preview list all reflect post-navigation steps only.
- **Files touched:** `renderer/lib/llm-prompts.ts`, `renderer/main/generate-steps-dialog.tsx`.
- **Verification:** `BuildApp` green (lint + type-check + build).
- **Corrections/Lessons Learned:** User clarified that Step 1 (Navigate to URL) is a test-level setting, not an AI-generated step — the prior prompt was telling the model to start with a goto, which would have inserted a duplicate navigation step.

### 2026-07-30 — Optional "Refine Selector" picker in the Generate-steps-with-AI dialog

- **Goal:** Let the user optionally pick a selector (same Refine Selector picker as step rows) in the "Generate steps with AI" dialog, and pass that locator to the LLM as context for generation.
- **What was done:** `generate-steps-dialog.tsx` now uses `useRecorder()` to drive the existing pick flow (`startRefine(null)` → `picked` → review). Added an optional "Target element (optional)" section with a crosshair "Refine selector" button; clicking it enters pick mode (button → "Cancel pick", hint banner). When a pick arrives (and no `refiningStepId` is set, so it doesn't collide with a step-refine), the dialog shows the candidate locator list (radio-style, best-first) + "Use this selector" to promote the chosen `Locator` to a chip with a ✕ to remove. The chosen locator is passed to `buildGenerateStepsMessages` via a new optional `selector` field, which appends a "User-provided target selector: <playwright expr>" context line telling the model to prefer that exact locator for the targeting step. `llm-prompts.ts` gained `Locator` import + a `locatorToPrompt` helper (mirrors `formatLocator`). `refine-selector-dialog.tsx` exports `formatLocator` and `KIND_LABEL` (reused here). `recording-view.tsx` gated the existing `RefineSelectorDialog` render on `picked && refiningStepId` so an AI-context pick (where `refiningStepId` is null) is handled by the generate dialog instead.
- **Key decisions:** Reused the existing backend pick flow unchanged (startRefine/endRefine/drainPicked/`recorder:picked`) — the only new logic is renderer-side ownership tracking (`pickingForAi` flag) to distinguish an AI-context pick from a step-refine pick, since both share the same `picked` channel and `refineMode` banner. The capture script auto-clears refine mode after a click, so `endRefine` is only needed on explicit cancel. The selector is optional — generation proceeds without it when null.
- **UI elements:** "Target element (optional)" row + "Refine selector" button / "Cancel pick" + pick hint banner + candidate review list + selector chip in the Generate Steps dialog. **Backend elements:** none changed.
- **Files touched:** `renderer/main/generate-steps-dialog.tsx`, `renderer/lib/llm-prompts.ts`, `renderer/main/refine-selector-dialog.tsx` (exports), `renderer/main/recording-view.tsx` (dialog gate).
- **Verification:** `BuildApp` green (lint + type-check + build). Live-verified in the running trainer: opened the "Generate steps with AI" dialog, confirmed the "Target element (optional)" row + crosshair "Refine selector" button render; clicked it and confirmed it enters pick mode (button → "Cancel pick", "Hover a component…" hint banner appeared). (Live IPC clicks intermittently failed with Glaze runtime error 0, so the full pick→review→chip round-trip was confirmed via the state transition in the DOM snapshot, not a completed element pick.)
- **Corrections/Lessons Learned:** None from the user this turn.

### 2026-07-30 — Isolated (incognito-style) session per training window

- **Goal:** Every time the trainer's browser window opens for training/editing, it should start with a fresh, isolated session instead of possibly inheriting cookies/localStorage from a previous recording.
- **What was done:** `recorder-service.ts`'s `new BrowserWindow({...})` for `recWindow` now sets `webPreferences.partition: \`recorder-incognito-${randomUUID()}\`` — no `"persist:"` prefix, so Electron/Glaze treats it as an in-memory session scoped to that unique string, giving each session (every `recorder:start` call) a brand-new, empty cookie/storage jar that's discarded when the window closes.
- **Key decisions:** Didn't touch `playwright-runner.ts` (actual test runs) — `@playwright/test`'s default `browser.newContext()` per test, with no `storageState`/`launchPersistentContext` anywhere in the codebase, already gives each run a fresh isolated context, so that side was already effectively incognito.
- **UI elements:** none (backend-only). **Backend elements:** `webPreferences.partition` on the recorder `BrowserWindow`.
- **Verification:** `BuildApp` green. Live-verified: opened "Edit in Trainer" on an existing test, confirmed the new recorder window (windowId 2) loaded ritual.com with its own fresh session, then cleanly closed it via the "Stop & generate" button.
- **Corrections/Lessons Learned:** None from the user this turn.

### 2026-07-30 — Verbose, persisted, larger step debug panel

- **Goal:** Make the trainer's step debug panel more useful — more verbose logging, a larger panel, and persisted messages that survive closing/reopening the trainer.
- **What was done:** Extended `buildReplayScript` to return a `logs: DebugLogLine[]` (timestamp · level · message) with verbose detail (locator kind/value + match count, resolved element tag, action taken, assertion actual-vs-expected, thrown errors). Backend `replayStep`/`replayFromStart` now build a `DebugEntry` (label, ok, error, at, logs), persist it via new `recorder-debug-store.ts` (`userData/recorder/debug-logs.json`, keyed by testId, latest-per-step, capped 200), and push `recorder:debugLogs`. New IPC: `recorder:getDebugLogs`/`recorder:clearDebugLog`. Recorder store replaced `replayResults` with `debugEntries: DebugEntry[]`, loads on session open, listens for pushes. `StepDebugPanel` rewritten as a taller (h-56) panel with a header (label + status + timestamp + clear) and a scrollable monospace log viewer. Added `DebugEntry`/`DebugLogLine` types (+ mirror).
- **Files touched:** `main/services/step-replayer.ts`, `main/services/recorder-service.ts`, `main/services/recorder-debug-store.ts` (new), `main/recorder/types.ts`, `main/handlers/index.ts`, `renderer/lib/api.ts`, `renderer/lib/recorder-types.ts`, `renderer/main/recorder-store.tsx`, `renderer/main/recording-view.tsx`.
- **Verification:** Build passed lint/type-check/compile; hot reload applied. Recording view not mounted at verify time (no active session), so panel not visually confirmed this turn — prior session confirmed the panel location.
- **Corrections/Lessons Learned:** `recorderService` is an object literal, not a class — `private` methods aren't allowed; used plain methods. Escaped `\"` inside a backtick template literal trips `no-useless-escape` — use `"` unescaped.

### 2026-07-30 — Step debug panel in the trainer

- **Goal:** When a test step fails on replay, surface useful debugging info for the selected step at the bottom of the trainer view (e.g. "Step 3: Could not locate", "Step 3: Test step timed out").
- **What was done:** Lifted per-step replay outcomes from `StepRow` local state into the recorder store as `replayResults` (keyed by step id, `{ok,error?,at}`); `replayStep`/`replayFromStart` wrappers now record into it. `recording-view.tsx` tracks `selectedStepId` (clicking a row selects it — accent ring; button/input clicks ignored) and renders a `StepDebugPanel` at the bottom showing the selected step's label + status ("not yet replayed" / "replayed successfully" / "Step N: <error>"), with a clear button. `step-row.tsx` gained `selected`/`onSelect` props (renders an accent ring + `role="option"`).
- **Files touched:** `renderer/main/recorder-store.tsx`, `renderer/main/recording-view.tsx`, `renderer/main/step-row.tsx`.
- **Verification:** Build passed lint/type-check/compile; panel confirmed live in the running trainer (empty-state message "Select a step to see replay diagnostics." visible; no steps present to click-select).
- **Corrections/Lessons Learned:** None from the user this turn.

### 2026-07-30 — Replay-from-start button in the assertion panel

- **Goal:** Add a button in the trainer assertion panel row that replays test steps from the beginning, pausing after the first successful step so the user can iterate manually.
- **What was done:** Backend `recorder-service.ts` gained `replayFromStart()` — loops `session.steps` from index 0, injects `buildReplayScript(step)` per step (capture suppressed via `session.paused = true`), returns `{ok, stoppedAtIndex, error?}` on first success or first failure. New IPC handler `recorder:replayFromStart` (`main/handlers/index.ts`), new `api.recorder.replayFromStart` (`renderer/lib/api.ts`), new `replayFromStart` in the store (`recorder-store.tsx`). `recording-view.tsx` adds a "Replay from start" button (Play icon) at the start of the assertion panel row, before "Add assertion:", with an inline status line that reports which step it paused after and auto-clears after 6s.
- **Key decisions:** Stop on first SUCCESS (per the user's ask) so the user can continue manually from there — not stop on first failure. Reuses the existing per-step `buildReplayScript` (synthetic-event preview, not Playwright's engine). Status is a transient inline `Text` rather than a toast since the recording view has no toast plumbing and the per-step replay also surfaces nothing.
- **UI elements:** "Replay from start" button + inline status in the assertion panel row. **Backend elements:** `replayFromStart` service method, `recorder:replayFromStart` IPC handler.

### 2026-07-30 — Move Refine Selector to the step level

- **Goal:** Refine Selector should operate per test step, not from the trainer toolbar. Remove the toolbar button and add the same crosshair icon in each step row between the ▶ Run and ✕ Delete icons; make Refine Selector update that step's locator.
- **What was done:** Removed the toolbar "Refine selector" button from `recording-view.tsx`. `step-row.tsx` gained an optional `onRefine` prop → a crosshair icon rendered (only when `onRefine` set AND `step.locator` exists) between the replay and delete icons. `recording-view.tsx` passes `onRefine={() => startRefine(s.id)}` per row and now renders the dialog with `onApply` → `updateStep(refiningStepId, { locator })` (plus `stepLabel` from `describeStep`). Store (`recorder-store.tsx`): `startRefine(stepId?)` records `refiningStepId`, `endRefine` clears it, exposed `refiningStepId`. Dialog (`refine-selector-dialog.tsx`): `onInsert(RawStep)` → `onApply(Locator)`, confirm label "Insert Find step" → "Update selector", shows the step being refined; dropped the `RawStep` import.
- **Key decisions:** Backend refine flow (pause → pick → `drainPicked` → `recorder:picked` → resume) is unchanged and correct for step-level use — the only change is the renderer applying the pick to an existing step. Kept the step→pick association renderer-side (`refiningStepId`) instead of threading a stepId through the backend session, since only one refine runs at a time and the renderer initiates it. Icon gated on `step.locator` so it only appears on steps where a selector is meaningful (not goto/viewport/wait-by-time/page-level asserts).
- **UI elements:** per-step crosshair icon in the trainer step row, refine hint bar (kept), review dialog (now "Update selector"). **Backend elements:** none changed (reuses existing startRefine/endRefine/drainPicked/`recorder:picked`).
- **Verification:** `BuildApp` green (lint + type-check + build). Confirmed live in the running trainer that the toolbar "Refine selector" button is gone. The per-step icon couldn't be shown in the live session because it had no steps with locators (empty step list), and the user's active recording on ritual.com wasn't disturbed to force one — the icon is a deterministic conditional render verified by code + build.
- **Corrections/Lessons Learned:** User wanted this at the step level for intuitiveness; the prior toolbar+insert-new-step design was replaced with per-step locator refinement.

### 2026-07-30 — Refine Selector (paused element picker → Find step)

- **Goal:** Add a "Refine selector" option (between "+ Add step" and "AI steps") that pauses the session, lets the user pick a component in the training browser without interacting with the page (bounding box on hover), captures the element's CSS/selector context, and inserts it for improved targeting, then resumes.
- **What was done:** New refine mode threaded end-to-end. Capture script (`capture-script.ts`): `ATTR_REFINE`/`ATTR_PICKED`; `onOver` draws a fixed blue bounding-box overlay (`data-pw-refine-box`, pointer-events:none, tracks `getBoundingClientRect`), `onClick` (checked before isPaused/assert) captures `buildPicked(el)` — locator candidates (`candidatesFor` + new `xpathFor`), computed CSS (`cssPropsOf`), attributes (`attrsOf`) — into `ATTR_PICKED` and exits refine; `DRAIN_PICKED_SCRIPT` reads/clears it. Service (`recorder-service.ts`): `session.refineMode`, `startRefine()` (pause + set mode + focus), `endRefine()` (clear + resume), poll now runs `drainPicked()` (pushes `recorder:picked`, drops overlay), `applyStateAttributes()` writes `ATTR_REFINE` + crosshair. IPC `recorder:startRefine`/`recorder:endRefine` + push `recorder:picked`; api wrappers; store holds `picked`/`startRefine`/`endRefine`/`clearPicked` and subscribes to `recorder:picked`. New `refine-selector-dialog.tsx` (candidate radio list via local `formatLocator`, CSS grid) inserts `{type:"assert",assert:"visible",locator}` at the cursor. `recording-view.tsx`: the button (accent when active), a refine hint bar with Cancel, and the dialog. New `PickedElement` type in both type files; `RecorderState += refineMode`.
- **Key decisions:** Reused the existing assert-picker plumbing pattern (DOM-attribute state + poll drain) rather than a new channel — the injected script can't hold JS globals. A picked element becomes a "Find element" (assert-visible) step, matching the existing add-step "find" mapping, so no new StepType. Session stays paused between pick and dialog resolution; endRefine (insert or cancel) resumes.
- **UI elements:** toolbar button, hover bounding-box overlay (injected), refine hint bar, review dialog (radio locator list + CSS grid). **Backend elements:** refine session mode, `recorder:startRefine`/`endRefine` ipc_handler, `recorder:picked` push, `drainPicked` poll.
- **Verification:** `BuildApp` green (lint + type-check + build; fixed an unterminated-string concat and an unused import along the way). Full pick flow verified by code trace, not a live recording — the trainer UI only renders during an active session against an external browser window, which isn't drivable via DOM tools.
- **Corrections/Lessons Learned:** None from the user this turn.

### 2026-07-30 — Trainer window URL bar + global toggle setting

- **Goal:** When the training browser window opens, make the URL bar visible by default, plus add a global setting to toggle that behavior.
- **What was done:** The recorder window loads the external target page directly (no app-owned HTML wrapper, and this SDK has no `<webview>`/`WebContentsView` embedding), so there's no way to overlay a real editable address bar on top of the page. Used the native title bar as the address-bar stand-in instead: `recorder-service.ts` gained `updateTitle()`, called on every `did-navigate`, which sets `recWindow.setTitle("Recording/Editing — <current URL>")` via `webContents.getURL()` when `session.showUrlBar` is true. New `main/services/recorder-settings-store.ts` (mirrors `llm-config-store.ts`) persists `{showUrlBar: boolean}` (default `true`) to `userData/recorder/recorder-settings.json`; new `recorder:getSettings`/`recorder:setSettings` IPC handlers; new `RecorderSettings` type in both `main/recorder/types.ts` and its renderer mirror. `session.showUrlBar` is snapshotted from the store at `recorder:start` (a mid-session toggle affects the next trainer window, not one already open). Added a "Show URL bar in training window" `Switch` toggle to `SettingsView` (new `FieldSet`, loads/saves via `api.recorder.getSettings/setSettings`).
- **Key decisions:** Chose the title bar over any custom overlay because the recorder window's content is the raw external page — an app-owned toolbar would require embedding external content inside an app page, which this SDK doesn't support (no `WebContentsView`/`<webview>`). Setting is a session snapshot, not live-reactive, matching how other per-session config (e.g. speed) already behaves.
- **UI elements:** Settings `Switch` toggle in a new `FieldSet`. **Backend elements:** `recorder-settings-store.ts` (`local_storage`-style JSON file), two new `ipc_handler`s, `BrowserWindow.setTitle()` call on navigation.
- **Verification:** `BuildApp` green (lint + type-check + build). Could not click through to the Settings window itself — it opens only via a native app-menu item (`main/index.ts`'s "Settings…"), which isn't reachable via DOM/pointer tools, same limitation hit for the sidebar's native `+` menu in an earlier turn. The toggle mirrors the existing, already-working LLM-provider `RadioGroup` Field pattern exactly.
- **Corrections/Lessons Learned:** None from the user this turn.

### 2026-07-30 — Emulate mabl's Trainer (editable steps, add-step menu, richer assertions, replay, AI steps)

- **Goal:** Research mabl's Trainer and bring its capabilities to this app's recorder. Scope (all confirmed by the user): fully editable step list, manual add-step menu, richer assertions + soft assertions, per-step replay, and AI-generated editable steps.
- **What was done:** (1) **Data model** (`main/recorder/types.ts` + `renderer/lib/recorder-types.ts`, kept in sync): `StepType` += `wait`/`viewport`; `LocatorKind` += `xpath`; `AssertKind` expanded to 13 kinds; `Step`/`RawStep` += `soft`/`attr`/`count`/`width`/`height`/`waitMs`; `RecorderState` += `assertSoft`/`cursor`. (2) **Editable session** (`recorder-service.ts`): `session.steps` now mutable — `addStep` inserts at `cursor`; new `insertStep`/`reorderStep`/`updateStep`/`setCursor`/`replayStep`; a `recorder:steps` full-list push replaces the old per-step `recorder:step` append (store now replaces its list). (3) **Add-step menu** (`add-step-dialog.tsx`): native "+ Add step" menu → Assertion/Wait/Go to URL/Press key/Find element/Set viewport forms → `insertStep`. (4) **Richer assertions**: capture script (`capture-script.ts`) reads an expanded assert-mode set + a soft flag (`data-pw-assert-soft`); `script-generator.ts`/`describe-step.ts` map every `AssertKind` to its `expect`/`expect.soft` call, plus `wait`/`viewport`/`xpath`. (5) **Per-step replay** (`step-replayer.ts` + `recorder:replayStep`): injects JS that resolves the locator (reusing extracted `DOM_HELPERS`) and performs the action / evaluates the assertion in the live window, returning `{ok,error}`; capture is paused during replay. (6) **AI steps** (`generate-steps-dialog.tsx` + `buildGenerateStepsMessages` + `extractStepsJson`): local LLM emits a validated `Step[]` inserted into the live list. `step-row.tsx` gained optional drag-reorder, inline value/text editing, and a replay ▶ (all gated by props so the read-only detail view is unchanged). `recording-view.tsx` rewired with the assert menu (+ Hard/Soft toggle), add-step menu, AI-steps button, cursor gaps, and drag wiring.
- **Key decisions:** Backend owns step ordering → broadcast whole list (`recorder:steps`) instead of incremental appends. Replay is an explicitly best-effort synthetic-event PREVIEW, not Playwright's actionability engine. Manual/AI locators favor role/label/text/testid; only css/xpath are raw selectors. AI path emits structured steps (not raw spec) so they're editable before spec generation. Extracted shared `DOM_HELPERS` from the capture script so capture + replay locator semantics can't drift. No new npm deps (native HTML5 drag).
- **UI elements:** editable step list (drag/inline-edit/replay), insert-cursor gaps, native add-step & assert menus, add-step form dialog, AI-steps dialog, Hard/Soft segmented toggle. **Backend elements:** mutable recorder session, `recorder:insertStep`/`reorderStep`/`updateStep`/`setCursor`/`replayStep` IPC, `recorder:steps` push, step-replayer injected-JS engine.
- **Verification:** `BuildApp` green (lint + type-check + build). Main window + a test's detail view snapshot healthy after the store refactor. Did NOT start a live recording session to exercise the trainer UI — it opens an external browser window and stopping regenerates/overwrites an existing test record, so live-driving it risked user data; the trainer surface is standard React validated by the build, and generator/parser/types are pure and type-checked. User should verify by starting a training session (Train manually / Edit in Trainer).
- **Corrections/Lessons Learned:** None from the user this turn.

### 2026-07-30 — Test generation by prompt (phase 3)

- **Goal:** Add a "Generate from prompt" option to the sidebar + menu that opens a new window where the user describes a test in natural language and the local LLM generates a complete Playwright spec, with pre-selectable common options (speed, viewport, starting URL, name).
- **What was done:** New `tests:createFromPrompt` IPC handler (`handlers/index.ts`) creates a `TestRecord` with empty `steps` + the generated source as the script file (`scriptEdited: true`, `speed` persisted). New `api.tests.createFromPrompt` wrapper. New `buildGenerateMessages(ctx)` in `llm-prompts.ts` with a generation-focused `GENERATE_SYSTEM_PROMPT` (emit a complete runnable spec in one fenced ```ts block, same locator conventions as the recorder, no prose) + a user message carrying name/URL/speed/viewport hints and the prompt. New `renderer/main/generate-test-dialog.tsx` (`GenerateTestDialog`): `Dialog size="xl"` with prompt-formatting tips callout, `Field`+`Input`/`Textarea`/`SegmentedControl`/`Select` for the common options (viewport presets: Default/Desktop 1280×800/Laptop 1440×900/Tablet 768×1024/Mobile 390×844), a Generate button that streams via `useLlmChat`, renders the response with the shared `parseResponse`/`CodeBlock` rendering, and on a complete applyable spec shows a "Create test" button that persists + navigates. Sidebar + menu now lists "Train manually" and "Generate from prompt" before the import options.
- **Key decisions:** Generation is explicit (no auto-start) so the user can edit options and re-generate; the dialog stays mounted (controlled by `open`) so the response survives open/close. Viewport is a prompt hint only — the runner doesn't apply it at runtime (no config plumbing added, keeping the change surgical); speed IS persisted on the record since that field already exists and the runner honors it. Reuses `extractCorrectedScript` (the same `import`+`test(` heuristic as Debug with AI's Apply) to gate the "Create test" button.
- **UI elements:** dialog, field/input/textarea/segmented-control/select, code-block cards, generate + create-test buttons, toast. **Backend elements:** new `tests:createFromPrompt` IPC handler.

### 2026-07-30 — Debug with AI: formatted code output + one-click Apply to script

- **Goal:** Format the local-LLM debug response so suggested code changes are easy to spot, and — if feasible — auto-apply the suggested changes to the script being debugged.
- **What was done:** New `renderer/lib/parse-llm-response.ts` (`parseResponse` tokenizes prose + fenced code, tolerant of a still-streaming trailing fence; `extractCorrectedScript` returns the largest closed code block containing `import` and `test(`). Updated `llm-prompts.ts` system prompt: allow fenced ```ts blocks, ask for a short prose diagnosis then the COMPLETE corrected spec as one code block (so it's applyable); when the spec was head-truncated in the prompt, ask for changed lines only (no partial full-file). `ai-debug-panel.tsx` now renders parsed segments — prose `<p>` + `CodeBlock` cards (language label + per-block copy) — and shows an "Apply to script" button (AlertDialog confirm) once streaming finishes and a full corrected spec is detected; it calls a new `onApplyScript` prop. `test-detail-view.tsx` supplies `onApplyScript` → `tests:updateScript` + query invalidation.
- **Key decisions:** Full-file replacement (reusing the existing `tests:updateScript` flow) over diff/hunk application — far more reliable with small local models. Guarded apply behind an `import`+`test(` heuristic and a truncation check so a snippet or partial file is never written; confirm dialog because it overwrites the current script.
- **UI elements:** dialog, code-block cards, apply button + confirm alert, toast. **Backend elements:** none new — reuses `tests:updateScript` IPC.
- **Verification:** `BuildApp` green (lint + type-check + build). Live inspection session unavailable again (`sessionUnavailable`, cross-app bootstrap timeout) — same pre-existing host-side issue noted in prior entries, unrelated to this change.
- **Corrections/Lessons Learned:** None from the user this turn.

### 2026-07-30 — Debug with AI: grounded prompt engineering (persona, locator rules, dynamic context)

- **Goal:** User pasted generic third-party advice on layered LLM context (system prompt persona, dynamic context injection, few-shot examples, RAG for scope) and asked to adapt it to this app's real shape, plan first, then execute on approval.
- **What was done:** Reviewed the actual "Debug with AI" prompt (`ai-debug-panel.tsx`) and the real spec conventions (`script-generator.ts`). Extracted a new `renderer/lib/llm-prompts.ts` (`buildDebugMessages`) so the prompt isn't inline in the dialog component: a stronger system-prompt persona (expert QA engineer) with hard rules matching what this app's specs actually emit (locator preference order, no `waitForTimeout`, web-first assertions) plus one bad/good locator example, and an explicit output-format rule (plain text, no markdown — the response renders in a `<pre>`, not markdown). Added two dynamic context fields to the user message: `imported` (from `test.sourceDir`, since imported scripts are hand-authored and the locator conventions may not hold) and `speed` (from `TestRecord.speed`, mapped through a local mirror of `playwright-runner.ts`'s `SLOW_MO_MS` to note whether an artificial delay is already in play — informs whether timing/race causes are more or less likely). `ai-debug-panel.tsx` and `test-detail-view.tsx` updated to pass the two new fields through.
- **Key decisions:** Deliberately dropped from the generic advice: live-page DOM/interactive-element extraction (no live page exists once a run has finished — the recorder already captures structured locators at record time, so this only matters for the deferred step-generation phase), Page Object Model file references (this app only produces flat single-file specs, no POM concept), and vector DB/RAG (each debug session is one script + one run's output, well inside a local model's context window — no scale problem to solve).
- **UI elements:** none new — same dialog, richer prompt content. **Backend elements:** none — pure renderer-side prompt construction, no new IPC.
- **Verification:** `BuildApp` green (lint + type-check + build). Live inspection session was unavailable again (`sessionUnavailable`, cross-app session bootstrap timeout) — consistent with the phase-2 entry below; a plain-text prompt change has no visually distinct runtime signal to check via DOM snapshot anyway, so this wasn't blocking.
- **Corrections/Lessons Learned:** None from the user this turn — plan was approved as proposed.

### 2026-07-30 — Local LLM integration, phase 2 (Debug with AI for failing runs)

- **Goal:** Consume the phase-1 `llm:chat` streaming API to let users debug a failing test run with the local LLM, per the approved phase-2 plan.
- **What was done:** New `renderer/lib/use-llm-chat.ts` (`useLlmChat()` hook: starts a chat, subscribes to `llm:chunk/done/error` filtered by the request's own `requestId` via a ref so stale events from a prior request are ignored). New `renderer/main/ai-debug-panel.tsx` (`AiDebugDialog`): builds a system+user prompt from the test name/url/script (head-truncated 6000 chars) + failing run output (tail-truncated 8000 chars — errors are usually at the end), auto-sends when opened, streams the response into a `Dialog size="xl"` with Stop/Regenerate/Copy-response controls; backend error messages ("No model selected.", unreachable server) get an appended "Open Settings (⌘,)" hint. `run-output.tsx` gained a `Sparkles`-icon "Debug with AI" button (next to Copy output) shown only when the run failed (`code !== null && code !== 0`); `test-detail-view.tsx` owns the dialog's open state and supplies test/script context that `RunOutput` itself doesn't have.
- **Key decisions:** Dialog auto-starts on open rather than requiring an extra click, since the button that opens it already signals intent to debug. No markdown rendering — response shown as plain preformatted text (matches the existing Script/Output panel style). Dialog uses props-mode with no `onConfirm` (dismiss via Esc/outside-click only), since this is a read-only streaming view, not a form.
- **UI elements:** dialog (streaming response, status badge, action buttons), toolbar-style icon button. **Backend elements:** none new — reuses phase 1's `llm:chat`/`llm:cancel` IPC and push events.
- **Verification:** `BuildApp` green (lint + type-check + build). Could NOT live-verify in the running app — the Glaze host hit a pre-existing `ERR_MODULE_NOT_FOUND` on `@glaze/core/backend`'s internal chunk files after the build-triggered WebView reload, so the cross-app inspection session never became ready (`AppStatus`/`LaunchApp` both timed out on "cross-app session bootstrap"). This is a host/SDK-side module resolution error unrelated to this app's source; if it recurs on a future task, check the app logs for `ERR_MODULE_NOT_FOUND ... chunk-*.js imported from @glaze/core/backend.js` before assuming a code regression.
- **Corrections/Lessons Learned:** None from the user this turn; this was an unattended continuation of the approved plan (Auto Mode).

### 2026-07-30 — Local LLM integration, phase 1 (backend foundation + Settings connection UI)

- **Goal:** Add local LLM support (Ollama and/or LM Studio) to later power test-run-output debugging and in-trainer step generation. This phase = backend foundation only, per the approved plan.
- **What was done:** New `main/services/llm/types.ts`, `llm-config-store.ts` (persists to `userData/recorder/llm-config.json`), and `llm-service.ts` (provider-agnostic: `status`/`detect`/`listModels` + streaming `chat` over the OpenAI-compatible `/v1/chat/completions`, SSE-parsed, `AbortController` cancel, pushes `llm:chunk/done/error`). Registered `llm:*` IPC handlers (with `unknown`+type-guard validation for provider/messages). Added `api.llm.*` renderer wrappers + `renderer/lib/llm-types.ts` mirror. Added an "AI provider" section to `renderer/settings/settings-view.tsx` (provider radio, Test connection button showing an Online/Offline `Status` + model list, default-model radio). Bumped the settings window to 560×480.
- **Key decisions:** One OpenAI-compatible client for both providers; loopback URLs to dodge the macOS local-network prompt; chat pushes via `sendToMain` (main window) since phase-2 consumers live there; `sourceDir`-style backend network needs no capability declaration. Deferred (phase 2+): the actual debug-run-output and generate-steps UIs that consume `llm:chat`.
- **UI elements:** settings panel (radio groups, button, status badge). **Backend elements:** service, json config store (local_storage), ipc_handler, streaming push.
- **Verification:** BuildApp green (lint + type-check + build). Confirmed the built bundles are live (backend `main/index.js` contains `llm:status` + `127.0.0.1:11434`; settings bundle contains "Local AI provider"). Verified `Status` (variant `success`/`error`) and `Button` (variant `muted`) prop APIs against the SDK `.d.ts` before building. Could NOT live-exercise the Settings panel: it opens only via the native app menu (Cmd+,), which live inspection can't drive, and there's no in-app trigger; a real connection test also needs a running Ollama/LM Studio (absent here) — the offline path is deterministic and returns gracefully.
- **Corrections/Lessons Learned:** `LiveAppEvaluate` runs in an isolated world where `window.glazeAPI` is undefined, so IPC can't be invoked from it, and the settings window can't be opened programmatically that way. `Status` variants are `success/error/warning/loading/neutral` (NOT "danger"); `Button` has no "secondary" variant (used `muted`).

### 2026-07-30 — Detail view: created tests show Steps+Script, imported tests show Script only

- **Goal:** Previous mutually-exclusive tab logic (Steps when `steps.length>0`, else Script) was a regression: created-in-app tests should show **both** Steps AND Script; imported tests should show **only** Script (the verbatim file is the source of truth, not the lossy parsed steps).
- **What was done:** In `renderer/main/test-detail-view.tsx`, replaced the mutually-exclusive `TabsTrigger` with: `imported = Boolean(test.sourceDir)`; `showSteps = !imported && steps.length>0`. Imported → only the Script tab renders. Created → both Steps and Script tabs render (Steps active when it has steps, else Script active). The Steps `TabsContent` only renders for created tests; the Script `TabsContent` always renders. `sourceDir` is the "imported" signal (created tests never set it); `scriptEdited` alone is NOT used because a user can also set it by manually editing a created test's script.
- **Verification:** In the running app — created test "Nav Test" (7 steps) shows both `Steps (7)` (active) + `Script` tabs; imported test "Homepage loads correctly" (`sourceDir:true`, steps=0) shows only `Script`. (Sidebar item navigation via synthetic `.click()` doesn't trigger TanStack Router's onClick — focus the button + dispatch `keydown`/`keyup` Enter instead.)
- **Key decisions:** `sourceDir` (not `scriptEdited`) distinguishes imported from created, since manual script edits set `scriptEdited` on a created test too.

### 2026-07-30 — Sidebar: "Remove from Sidebar" context menu item (hide, no file deletion)

- **Goal:** The user wanted to right-click an imported test and remove it from the sidebar view — but WITHOUT any file-system action (never delete the spec file).
- **What was done:** Added `TestRecord.hidden?: boolean` (backend + renderer mirror). `testStore.list()` now filters out `hidden` records (the sidebar uses `list`), while `testStore.get()` still returns them (detail page still works if navigated to). New `testStore.setHidden(id, hidden)` writes the flag + `updatedAt` (no file touched). New `tests:setHidden {id,hidden}` IPC handler + `api.tests.setHidden`. In `library-sidebar.tsx`, added a "Remove from Sidebar" `CustomContextMenuItem` (EyeOff icon) between "Reveal in Finder" and the "Adjust Test Speed" submenu — above the speed setting as requested. On select: calls `setHidden(id,true)`, invalidates `["tests"]`, navigates to `/` if the hidden test was currently open, toasts "Removed from sidebar."
- **Verification:** Right-clicked "Homepage loads correctly" in the running app → context menu shows "Reveal in Finder / Remove from Sidebar / Adjust Test Speed" in that order. Clicked the item → test disappeared from sidebar, "Removed from sidebar." toast appeared. Confirmed on disk: `tests.json` still has the record with `hidden: true`, and the `<id>.spec.ts` file still exists — no file deleted. Restored `hidden: false` afterward and reloaded to bring the test back.
- **Key decisions:** Hide (not delete) is the right semantic for "I don't want to see it anymore" + "never delete a file". The record + script stay on disk for later restoration. No unhide UI was added (the user only asked for removal); a hidden test can be unhidden by editing `tests.json` or by a future "show hidden" affordance.

### 2026-07-30 — Run output panel: opaque background

- **Goal:** The run "Output" panel was transparent — the script/code text behind it showed through.
- **What was done:** Added `bg-background` to the `RunOutput` root `div` in `renderer/main/run-output.tsx` so the panel is always opaque.
- **Verification:** Confirmed the built bundle includes `bg-background flex h-56 shrink-0 flex-col border-t border-separator`.

### 2026-07-30 — Import: copy sibling modules so imported specs actually run

- **Goal:** Running an imported test failed with `Cannot find module './fixtures.js'` — imported specs reference sibling files (`./fixtures.js`, `./helpers.js`) that the import only copied the spec, not its siblings.
- **What was done:** `import-service.ts` now `copyRelativeImports()` each spec's `./`/`../` siblings (recursively, ext + index probing, 5MB cap) into the scripts dir at import time, and stores `sourceDir` (the spec's original folder) on the `TestRecord`. New `tests:repairImports {id}` handler (`importService.repairImports`) re-copies from `sourceDir` for legacy/reset records. Added `TestRecord.sourceDir?: string` (backend + renderer mirror).
- **Backfill:** The 4 pre-existing imported records had no `sourceDir` and missing siblings; copied `fixtures.js`/`helpers.js` from the still-present source folder (`/Users/chris/Ritual/ritual-e2e-tests/tests`) into the scripts dir and set `sourceDir` on those records in `tests.json` directly.
- **Verification:** Re-ran "Ritual Shopping Flow" — the `Cannot find module` error is gone; the spec now loads and Playwright runs it. The remaining failure is a bug in the user's own spec (`createStepLogger(testInfo, 'Checkout')` is missing the required 3rd `totalSteps` arg that every other spec in that folder passes) — not an app defect, so left untouched.
- **Key decisions:** Copy siblings at import time (while the source/git checkout is on disk) rather than trying to resolve them at run time (source may be gone, esp. for git imports). `repairImports` throws a friendly error when `sourceDir` is absent rather than guessing.

### 2026-07-30 — Import: parse spec files into Steps so the Steps view is primary

- **Goal:** When a folder of tests is imported, analyze each file, interpret/translate its test steps, and populate them — show the Script view only when Steps aren't available; attempt steps in all cases.
- **What was done:** New `main/services/spec-parser.ts` (`parseSpec(source) → Step[]`) — the reverse of `script-generator.ts`. String-aware comment stripping (so `//` in a URL isn't a line comment), arrow-aware `test(...)` body extraction (skips `test.skip`/`describe`/hooks; finds the body via `=>` then first balanced `{}`), then a forward scan recognizing `page.goto`, `page.keyboard.press`, `expect(<locator>).toBeVisible/.toContainText`, and `<locator>.click/.fill/.selectOption/.check/.uncheck/.press` with `getByTestId/getByRole/getByLabel/getByPlaceholder/getByText/locator(...)` locators (role+name parsed from `getByRole("role", { name: "x" })`). `import-service.ts` now calls `parseSpec` to populate `steps` (keeps `scriptEdited: true` so the verbatim file stays the runnable artifact and rename never regenerates over the lossy parsed steps). `test-detail-view.tsx` tabs are now mutually exclusive: `Steps (n)` when `steps.length > 0`, else `Script` (the `TabsRoot defaultValue` picks accordingly); the unused tab trigger is not rendered.
- **Key decisions:** `scriptEdited` stays true even when steps parse — the imported file is the source of truth for running; steps are display-only. Parser is best-effort: files that wrap actions in helpers (`gotoWithRetry`, `createStepLogger`, etc.) yield 0 steps and correctly fall back to Script-only. `parseLocator` must receive the statement slice from `i` (incl. `await page.getByRole(...)`), NOT the args-only slice from the open paren — its regex anchors on the builder name.
- **UI elements:** `test-detail-view.tsx` mutually-exclusive Steps/Script tab trigger.
- **Backend elements:** `spec-parser.ts` (new), `import-service.ts` `importFound` step population.
- **Corrections/Lessons Learned:** Three parser bugs caught by running it against the real persisted spec files (not just the synthetic sample): (1) `stripComments` was string-blind so `"https://..."` lost everything after `//` — made it string-aware; (2) `extractTestBodies` grabbed the arrow's `({ page })` destructuring brace as the body — find `=>` first, then the first `{`; (3) `parseLocator` was passed the args slice starting at `(` (no `getByRole` text) so it returned null for every locator-action — pass the slice from `i`. Also a JSDoc comment containing the literal `*/` closed the comment early and broke the build — avoid `/* */` in JSDoc text. Verified the mutually-exclusive tabs live: Nav Test (steps=7) shows only `Steps (7)`; Starter Sets (steps=0) shows only `Script`.
- **User Frustrations & Important Remarks:** None.

### 2026-07-25 — Right-click context menu: Reveal in Finder + Adjust Test Speed slider

- **Goal:** Right-clicking a test in the sidebar should show "Reveal in Finder" and an "Adjust Test Speed" submenu (Slow/Medium/Fast, slider preferred over discrete options) that actually changes run speed.
- **What was done:** Added `TestRecord.speed?: "slow"|"medium"|"fast"` (backend + renderer mirror types), `tests:setSpeed {id,speed}` IPC handler, and `api.tests.setSpeed`. Wrapped each `SidebarListItem` in a `CustomContextMenu` with "Reveal in Finder" (`window.glazeAPI.shell.showItemInFolder`, newly wired in `preload.ts`) and a `CustomContextMenuSub` "Adjust Test Speed" containing `TestSpeedSlider` — a 3-stop (`min=0 max=2 step=1 ticks=3`) filled `Slider` labeled Slow/Fast. `playwright-runner.ts` now writes a one-time `playwright.config.ts` (`ensureConfig`) mapping `PW_SLOWMO_MS` → `launchOptions.slowMo`, and `start()` passes `SLOW_MO_MS[rec.speed ?? "fast"]` (0/400/1200ms) through that env var.
- **Key decisions:** Used `CustomContextMenu` (not native `ContextMenu`) for the whole row menu since native NSMenu can't embed a `Slider`; kept Reveal in Finder in the same custom menu for one consistent implementation rather than mixing native + custom. Playwright's test CLI has no `--slow-mo` flag, so a generated config file + env var was the only way to plumb per-test speed into `launchOptions.slowMo`.
- **UI elements:** Sidebar row `CustomContextMenu`/`CustomContextMenuSub`, `TestSpeedSlider` (filled `Slider` with start/end labels + live "Speed: X" text).
- **Backend elements:** `tests:setSpeed` ipc_handler, `test-store.ts` `save()` reuse, `playwright-runner.ts` config generation + env wiring.
- **Corrections/Lessons Learned:** See the `Slider onValueCommit` note above — the slider's local value updated on click but persistence silently never happened because `onValueCommit` doesn't fire for a plain click; switched to committing on `onValueChange`. Diagnosed by grepping the app log for the exact string `testStore.save()` logs (`"Saved test record"`), not the IPC channel name — an earlier grep for `setSpeed|error` came back empty and was misleading before this was realized.
- **User Frustrations & Important Remarks:** None — bug was caught via the app's own live-verification (right-click → adjust slider → close/reopen menu → value reverted) before ever reporting the feature done.

### 2026-07-24 — Import existing Playwright tests (local folder or git URL)

- **Goal:** Let the user import a git repo of Playwright tests from the local file system or a git URL, with the sidebar + offering "Select from files", "From URL", and "Create New".
- **What was done:** New `main/services/import-service.ts` (native folder picker scan + `git clone --depth 1` shallow clone of a URL to a temp dir, both scanning for `*.spec.ts`/`*.test.ts` and creating one `TestRecord` per file — file content is the script, `steps: []`, `scriptEdited: true`, name/url parsed from `test("…")`/`page.goto("…")`). Added `tests:importFiles` / `tests:importGit` IPC handlers and typed `api.tests.importFiles/importGit`. New `import-git-dialog.tsx`. Sidebar + now opens a native `Menu.popup` with the three options.
- **Key decisions:** One `TestRecord` per spec file (preserves the file verbatim; runs as-is through the existing runner). Imported tests are `scriptEdited: true` so rename/trainer logic never regenerates over them. Backend opens the folder picker (`dialog.showOpenDialog`) so import is one atomic IPC call.
- **UI elements:** Sidebar + native popup menu, `ImportGitDialog` (URL field + inline error), success/error toasts, navigate-to-first-imported.
- **Backend elements:** `import-service.ts` (dialog, `execFile` git clone, fs dir walk), two IPC handlers, `testStore` reuse.
- **Corrections/Lessons Learned:** First tried a React `DropdownMenu`, then `CustomDropdownMenu`, in the Sidebar `actions` slot — BOTH rendered an empty actions wrapper with no trigger button and no thrown error. Root cause: `Sidebar` runs `applyButtonDefaults` over `actions`, which breaks `*DropdownMenuTrigger asChild`. Only a plain `<Button>` renders there. Fixed by opening a native `window.glazeAPI.Menu.popup` from the plain button's onClick. Verified via DOM (button present) + app log (`MenuPopup: showing popup with 4 items` at the button's anchor point). Native menu items are not in the WebView DOM/screenshot, so the popup itself can't be DOM-inspected.
- **User Frustrations & Important Remarks:** None. Native menu selection → dialog/import flow can't be automated past the native boundary, but wiring is verified end to end up to it.

### 2026-07-24 — Edit existing tests via the trainer + in-app script editing

- **Goal:** Let the user reopen the trainer on an existing test to extend its recorded steps, and let them directly edit the generated Playwright script text from within the app.
- **What was done:** `recorder:start` now accepts an optional `testId`; when given, `recorder-service.start()` seeds the session (`url`/`name`/`existingSteps`/`createdAt`) from the stored `TestRecord`, replays existing steps to the renderer, skips the synthetic initial `goto` step, and marks `session.editing = true` (surfaced in `RecorderState.editing`, shown in `RecordingView` as "Editing recording"/"Editing" status). Stopping regenerates the script from the combined steps, keeps the original `createdAt`, and resets `scriptEdited: false`. Added "Edit in Trainer" toolbar button on `test-detail-view.tsx`, guarded by an `AlertDialog` warning when `test.scriptEdited` is true (continuing discards manual script edits). Added `tests:updateScript {id, source}` IPC handler that writes the spec file directly and sets `TestRecord.scriptEdited = true`; `tests:rename` now skips script regeneration when `scriptEdited` is set. Script tab in `test-detail-view.tsx` got an Edit/Save/Cancel flow using a raw `<textarea>` (not the design-system `Textarea`, which caps height) plus an "Edited manually" badge.
- **Key decisions:** Reuse the same `TestRecord` id/`createdAt` when editing rather than creating a new test, so the detail view/history stay pointed at one record. Regenerating from steps always wins over a manual script edit (with an explicit warning) rather than trying to merge — simpler and predictable.
- **UI elements:** "Edit in Trainer" toolbar button + `AlertDialog` confirmation, Script tab Edit/Save/Cancel controls, "Edited manually" badge, `RecordingView` editing-mode title/status.
- **Backend elements:** `recorder:start {testId}` seeding logic, `tests:updateScript` IPC handler, `scriptEdited`-aware `tests:rename`.
- **Corrections/Lessons Learned:** Live-testing the new flow surfaced a pre-existing bug unrelated to this feature: a same-origin redirect on initial load (e.g. bare domain → trailing slash) re-triggers the `will-navigate` interceptor, which re-issues its own `loadURL` and interrupts the original `await recWindow.loadURL(url)` in `start()`, throwing "Navigation was interrupted by a new loadURL() call." and aborting `start()` before `broadcastState()` ran — so the UI never left the empty state despite the trainer window opening. Fixed by swallowing that specific interruption (`.catch(() => {})`) since the redirect's own `loadNavInWindow` call still lands the window on the right page. Diagnosed via the app log file (Bash `tail` on the Logs directory), not DOM inspection, since the failure was a rejected backend promise with no DOM symptom.
- **User Frustrations & Important Remarks:** None — self-diagnosed and verified via live inspection (`LiveAppSnapshotDOM`/`LiveAppClick`) and direct inspection of the persisted `tests.json`/`.spec.ts` files before reporting completion.

### 2026-07-24 — Inline-editable test name in the detail toolbar

- **What was done:** `test-detail-view.tsx` heading (`ToolbarTitle` showing `test.name`) is now clickable — click swaps it for a controlled `Input` (Enter/blur saves via `tests:rename`, Escape cancels). Extracted the shared `saveName()` helper, reused by both the inline edit and the existing pencil-icon → Dialog rename flow.
- **UI elements:** Test detail toolbar heading (`h2`, `cursor-text`), inline `Input` swap.

### 2026-07-24 — Fix (real cause): cross-origin links opening the system browser

- **Goal:** Clicking a normal site link during recording still opened the URL in an external Chrome window (the previous `target`-rewrite fix didn't cover it).
- **What was done:** Added a `will-navigate` interceptor in `recorder-service.ts` that `preventDefault()`s main-frame, non-same-document http(s) navigations and re-loads them in the recorder window via `loadURL` (with a `selfLoad` re-entrancy guard). Kept the `target`-rewrite and `setWindowOpenHandler` layers; added a `did-create-window` close backstop.
- **Key decisions:** Force in-window navigation at the `will-navigate` layer (the real path) instead of only rewriting `target`. Intercept all cross-document main-frame navs uniformly for predictability (trade-off: cross-origin form POSTs become GET reloads — acceptable for recorded flows).
- **UI elements:** None (recorder navigation behavior).
- **Backend elements:** webContents `will-navigate`/`did-create-window` handling, `loadURL`.
- **Corrections/Lessons Learned:** The earlier diagnosis was wrong — the failing links had NO `target` (plain cross-origin `<a href>`), so target-rewrite did nothing. Root cause: Glaze routes cross-origin main-frame navigations to the system browser unless `will-navigate` is prevented. Also: an external browser window never shows in `LiveAppInspectionStatus`, so "window count stayed at 2" was a false-positive check; verified the real fix by reading the recorder window's `location.href` (now `anthropic.com` in-window after clicking a cross-origin HN link).
- **User Frustrations & Important Remarks:** User reported this twice; the first fix looked validated but wasn't (bad verification method). Confirmed fixed on a real cross-origin link this time.

### 2026-07-24 — Keep new-window links inside the trainer window

- **Goal:** Interacting with `target="_blank"` links/buttons during recording was opening a new tab in an external browser window instead of navigating within the recorder window.
- **What was done:** Added `keepInWindow()` to the injected capture script — during the capture-phase click and keydown it rewrites the clicked anchor/form `target` to `_self` before the browser follows it; also injects `<base target="_self">` on each page. Kept `setWindowOpenHandler` (deny + in-window `loadURL`) as the backstop for `window.open`.
- **Key decisions:** Fix in-page (target rewrite) rather than relying on the native window-open handler, since WKWebView routes `_blank` anchor clicks out before that handler fires.
- **UI elements:** None (recorder capture behavior only).
- **Backend elements:** capture-script injection.
- **Corrections/Lessons Learned:** `setWindowOpenHandler` alone does not catch `target="_blank"` anchor navigations in WKWebView. Verified in the running app: after clicking a `_blank` link the anchor's `target` became `_self` and no new window opened (window count stayed at 2).
- **User Frustrations & Important Remarks:** User hit this immediately when recording — new tabs opening in another Chrome window broke the recording flow.

### 2026-07-24 — Initial build: website interaction recorder → Playwright

- **Goal:** Prompt for a URL, record interactions in a browser window, generate a Playwright script on close, and run it locally from the app.
- **What was done:** Built the full recorder (capture script + DOM-attribute queue + poll drain), live recording UI with pause/resume and assertion modes, test library + detail (Steps/Script tabs), script generator, and a self-contained Playwright runner that installs the browser on first run and streams output.
- **Key decisions:** Self-contained runner bundling `@playwright/test`; capture interactions + assertions; generate `@playwright/test` spec files. Chose DOM-attribute capture after discovering Glaze `executeJavaScript` is ephemeral-world and `console-message` doesn't reach the backend.
- **UI elements:** SplitView sidebar (test library), New Recording dialog, live Recording view (Status, Pause/Resume, assert SegmentedControl, live step list), detail view (Tabs: Steps/Script), streamed Run output panel.
- **Backend elements:** recording BrowserWindow management, executeJavaScript injection + poll-drain, local_storage (JSON + spec files), child_process (Playwright CLI), ipc_handlers, backend→renderer event push.
- **Corrections/Lessons Learned:** `executeJavaScript` ephemeral-world + no backend `console-message` forced the DOM-attribute approach. Runner initially failed with "Cannot find module '@playwright/test'" because the built backend runs from `.glaze/build`; fixed by scanning candidate node_modules roots. `LiveAppEvaluate` runs in an isolated world where `window.glazeAPI` is undefined — drive the UI via clicks + native input-setter, not by calling `invoke` from evaluate.
- **User Frustrations & Important Remarks:** None yet. First run of a test downloads ~80–150MB of browser; subsequent runs are fast.
