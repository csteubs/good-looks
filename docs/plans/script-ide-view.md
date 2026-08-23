# Script IDE View — research and plan

Written 2026-08-22 on `claude/script-ide-view-research-385a38`. Research memo
04, after "The Locator Gap", "The Authoring Gap" and "The Pipeline Gap".

The Script tab's Edit mode is a transparent `<textarea>` over a highlighted
`<pre>`, with no verification of what it saves. This document records what was
fixed immediately, what the research into JetBrains, mabl, VS Code, Atom,
editor engines and inline AI found, and a phased plan for turning the tab into
a Script IDE View: an editor a power user who knows Playwright reaches for
first, with the app's own test-automation tooling (trainer, heals, run
history, variables, flows, AI) available from inside the code.

Everything marked **measured** was measured by the research pass on
2026-08-22 on this machine; version numbers are what the registry reported
that day and must be re-checked at install time. Everything marked **repo**
was read from this checkout.

---

## 0. What shipped with this document (the two reported bugs)

Both fixes survive whatever engine the IDE adopts — one is the stopgap until
the engine is replaced, the other is the oracle the IDE keeps.

**Lines broke and the view shifted.** The textarea soft-wrapped (a
`<textarea>`'s default) while the pre was `white-space: pre`, so the first line
wider than the pane took two rows in one layer and one in the other; every row
below it sat one line off from the caret. The only scroll sync wrote
`scrollTop` to an element that does not scroll. Now `wrap="off"` +
`white-space: pre` on the textarea, one shared style object for both layers,
the textarea as the single scrolling element with the pre and gutter following
it. `renderer/main/script-view.test.tsx` pins the structure; the preview
confirmed the geometry.

**Save wrote anything.** `tests:checkScript` (`main/services/script-check.ts`)
writes the draft beside the real spec and runs the real Playwright CLI over it
in `--list` mode — same binary, same Babel transform, same module resolution
as a run — through a small reporter that writes the outcome to a file. About
0.5 s. Catches a syntax error (line, column, code frame), an unresolvable
import (on the import's line), a duplicate title, a module-scope throw, a file
with no `test()`. Does not catch type errors: Playwright strips types, and
`check:script-check` pins that as a row. Save refuses with the problems listed
against their lines (click → caret on the line; red gutter number; tinted row
on the layer behind the textarea) and offers **Save anyway**. A check that
cannot run is reported the same way, never passed through silently.

Guards: `check:script-check` (nine rows through the real CLI),
`script-check.test.ts`, `tests:checkScript` in `handlers.test.ts`, seven
"saving a script edit" tests in `test-detail-view.test.tsx`. DECISIONS
2026-08-22 has the reasoning for each choice.

---

## 1. Engine: CodeMirror 6

**Recommendation: CodeMirror 6**, hand-rolled React 19 binding (one effect
creating the `EditorView`, a `Compartment` per reconfigurable piece, one
`updateListener`), themed from the existing `--gl-*` tokens, dynamically
imported so the trainer, settings and URL-strip windows never load it.

| | CodeMirror 6 | Monaco 0.56 | Keep the overlay |
|---|---|---|---|
| Bundle, gz (measured) | 168 KB for `basicSetup` + `lang-javascript` (TS mode) + `lint`; 178 KB with `merge`; 196 KB with `lsp-client` | 1.02–1.16 MB editor + 1.55 MB TS worker + 94 KB editor worker | 0 |
| TypeScript intelligence | Must be wired: TS 5.x language service + `@typescript/vfs` behind a `Transport`; probe: completions 32 ms, diagnostics 11 ms, environment 191–278 ms, heap 59–113 MB | Built in; `addExtraLib` takes the Playwright `.d.ts` | None possible |
| Theming | `EditorView.theme` accepts `var(--gl-*)` verbatim (verified); light/dark via `&dark`/`&light` | `defineTheme` rejects CSS variables (issue #2427, 2021 — re-confirm on 0.56); would need a `getComputedStyle` resync that `check:theme-tokens` cannot audit | Already on tokens |
| Wrap/scroll correctness | Native, virtualised viewport | Native | Fixed today, by hand |
| Diagnostics, gutters, inlays, fold, panels, inline diff | One documented extension each (`lint`, `gutter`, `Decoration`, `foldService`, `showPanel`, `unifiedMergeView`) | Decorations/view zones; no panel primitive; no merge view outside the diff editor | None |
| React 19 | Hand-rolled or `@uiw/react-codemirror` | `@monaco-editor/react` loads from jsdelivr unless `loader.config` is overridden — dead under the CSP | n/a |
| Headless testability | `EditorState` is pure; runs in the Vitest `node` project | Monaco's own tests are browser smoke tests | jsdom only |
| TypeScript version control | App chooses (pin 5.x; see §2) | 5.9.3, fixed per Monaco release | n/a |
| Risk | No Worker exists in `renderer/` today (repo); `main-window.html` CSP has `worker-src 'self' blob:` (repo), `preview.html` has no CSP, so the worker must be proven in the main window specifically | Same worker risk, three bundles, ESM-only since 0.53 | Cannot host any feature below |

Monaco is the right choice only if TypeScript hover/completion must ship in
the first release with no worker engineering and the bundle and theming costs
are accepted. The memo's reading of Sourcegraph's migration write-up
(Monaco at 2.4 MB, 40 % of their page) matches this trade.

---

## 2. Verification: five parsers, one diagnostics sink

Every layer normalises to `@codemirror/lint`'s `Diagnostic[]`. The save gate
must use a parser other than the editor's own Lezer tree, or the gate agrees
with the editor by construction.

| Layer | Runs in | Latency (measured) | Catches | Cannot catch |
|---|---|---|---|---|
| Lezer tree (`lang-javascript`, TS mode) | Renderer, per keystroke | sub-frame | Highlighting, folding, bracket matching; `⚠` error nodes as a live "cannot save yet" marker | Lezer's recovery and TypeScript's parser disagree on some malformed input |
| `ts.transpileModule(src, {reportDiagnostics:true})` | Main process, debounced | ~0.5 ms per small spec | Syntax errors with positions (one diagnostic 1005 on an unclosed call, zero on a type error — verified on 5.9.3) | Types |
| TypeScript language service (TS 5.x + `@typescript/vfs`, seeded with `lib.es2020` and the Playwright type files read from the packaged `@playwright/test`) | Renderer Web Worker **or** an Electron `utilityProcess` bridged over IPC (must be re-exported through `main/shell/`) | see §1 | Type errors, hover, completion, signature help, go-to-definition, rename | Whether the runner loads the file (Babel, not tsc — DECISIONS 2026-08-21) |
| ESLint `Linter` + `eslint-plugin-playwright` + `@typescript-eslint/parser` | Main process / the same `utilityProcess` (so `typescript.js` loads once); `eslint/universal` does not bundle for a browser (fails on `node:path`, verified) | Not measured on a large file; type-aware parsing is seconds, not "tens of ms" — measure on a 2000-line spec before committing to per-keystroke | 60+ Playwright rules (`missing-playwright-await`, `no-wait-for-timeout`, `no-focused-test`, `valid-expect`, many fixable) plus app rules as `(source) => Diagnostic[]`: unknown `${var}`, helper not in the runtime's export list, locator spelled in a way `shared/testid-attr.mjs` would not emit, statement `spec-parser.ts` cannot map | Anything needing the live page or run history |
| `playwright test --list` via the packaged CLI | Main process, on save and before run | 0.45–0.6 s (measured on 1.53.0) | **Shipped today** — see §0 | Type errors; executes module scope (same trust as a run) |
| Live-page and run-history facts | Renderer, from what the trainer and runner already push | the existing `buildCountScript` round trip; query cache | Locator matches 0 or >1 on the live page (`matchesFor`); step failed in the last run (`RunInfo.stepStatus`); heal-map entry exists | Nothing about the text |

Two constraints. **Pin `typescript` to 5.x** (or `@typescript/typescript6`):
`typescript@7` on npm is the Go compiler with no `lib/typescript.js` and no
stable programmatic API until 7.1, and `@typescript-eslint/parser` declares a
peer range below 6.1 — a casual `npm i typescript@latest` removes the language
service silently. **Per-keystroke work stays in the renderer and its worker**;
only the `transpileModule`/ESLint/`--list` calls cross IPC, debounced or on
save.

**The save becomes a transaction.** Today `writeTestScript` reads the outgoing
script for the journal, writes, sets `scriptEdited`, and only then re-parses
and sets `stepsDiverged`. Reorder to: (1) syntax gate, refuse with positions;
(2) `parseSpecDetailed` preview returning `{steps, skipped}` with positions, so
the editor can say "3 statements will not map to steps" before commit;
(3) `--list` dry run; (4) temp-file + rename write; (5) journal entry and step
update as one unit; (6) **revision bump** on the record (see §7).

Prettier: `prettier/standalone` + estree + typescript plugins measure 1.2 MB
min / 301 KB gz — larger than the editor. Lazy-load, or run main-side where it
is an ordinary Node dependency.

---

## 3. Feature catalogue

Effort: S (days), M (one to two weeks), L (several weeks), XL (a quarter).
Tier: **must** (first release of the IDE view), **should** (second pass),
**later**. "Grounding" names the module that already holds the data.

### Editing core

| Feature | Borrowed from | What it does here | Grounding | Effort | Tier |
|---|---|---|---|---|---|
| CodeMirror 6 editor: TS highlighting, search panel, multi-cursor, undo history, bracket matching | CodeMirror | Replaces the regex tokenizer and the overlay in `script-view.tsx` | — | M | must |
| Token theme, light/dark, self-hosted mono font, explicit `font-variant-ligatures`, reduced-motion floor for cursor blink and reveals | CodeMirror `EditorView.theme`; `renderer/theme/` | `HighlightStyle` tag palette ALSO on `--gl-*` tokens (that is where hard-coded hex creeps in); `check:theme-tokens` and `check:renderer-classes` cover it | `renderer/theme/` | S | must |
| Lint gutter + problems panel as the single diagnostics sink, with an `aria-live` count for screen readers | `@codemirror/lint`; IntelliJ Problems window | All §2 layers feed one `Diagnostic[]`; `setDiagnostics` for results computed elsewhere | new | S | must |
| Transactional save (§2) with "Return to generated script" (regenerate from steps, journal entry, confirm with a diff) | VS Code save semantics | `scriptEdited` is a one-way latch today: once set, `updateSteps` marks diverged instead of regenerating and `regenerateCallers` skips the test. The IDE needs the way back | `writeTestScript`, `testStore.regenerateScript` | M | must |
| Quick-fix lightbulb with preview (Alt+Enter) | IntelliJ intention actions with preview; VS Code code actions | Each diagnostic's `actions`; preview uses the existing line diff | `renderer/lib/line-diff.ts` | M | must |
| Inline diff review (`unifiedMergeView`) with per-hunk keep/undo | `@codemirror/merge`; VS Code diff editor; Copilot Edits | AI debug's proposal, a journal revert and an Auto-Heal rewrite land inside the editor as hunks — diffed against the BUFFER, not the stored script | `line-diff.ts`, `script-change-store.ts` | M | must |
| Accessible name; keyboard access to every gutter affordance; Tab-trap escape; fixed resolution order for Tab's three claimants (indent, snippet field, ghost text) | Monaco accessibility guide; VS Code "Tab moves focus" | Gutters are mouse-only in CodeMirror by default | `renderer/__tests__/setup.ts` | S | must |
| Snippets / live templates generated from the generator vocabulary | IntelliJ live templates; `snippet()` | `exp`, `step`, `loop`, `if`, `waitUrl` expand to text the generator would emit, so the typed step parses back identically; choice lists from `shared/step-semantics.mjs`; a snippet emitting a new helper needs a `check:runtime-boot` row | `script-generator.ts`, `step-semantics.mjs` | S | should |
| Surround-with (`test.step`, loop, condition) over a selection | IntelliJ surround templates | Through the step model, then regenerate | loop/condition steps | S | should |
| Format on save / Format command | Prettier standalone | LF, two-space, one statement per line — which also removes most exact-match failures for AI edits | new dep, lazy | S | should |
| Sticky scroll; folding by step/flow/loop with the step description as placeholder; fold state per test | VS Code sticky scroll; IntelliJ custom fold regions | A 200-line `test(` body reads like the Steps list | `foldService` + step↔line map | S | should |
| Gutter change markers vs last saved script, popup revert | IntelliJ VCS gutter | "What did I just change" before Save | test store | S | should |

### Navigation and structure

| Feature | Borrowed from | What it does here | Grounding | Effort | Tier |
|---|---|---|---|---|---|
| Caret ↔ Steps tab binding, both directions; console step click → line | IntelliJ Structure autoscroll; Playwright UI mode Source tab | Caret highlights the step row; clicking a row scrolls the editor | `playwright-runner.ts` `buildStepLineMap` — emit at generation time instead of re-deriving | S | must |
| Breadcrumbs `test > step 7: click "Sign in" > locator`; the locator crumb opens the refine picker | IntelliJ breadcrumbs | Orientation plus a second entry to the picker | step map, `refine-selector-dialog.tsx` | S | should |
| File Structure popup (Ctrl+F12) fuzzy-filtering steps | IntelliJ | `cmdk` list over step descriptions | `command-palette.ts` | S | should |
| Palette: go to test / go to step modes; settings rows toggleable inline | IntelliJ Search Everywhere | Palette flips booleans without opening Settings | `settings-schema.ts`, `window:openSettings(pane)` | S | should |
| Find Usages across the library for a variable, secret, flow or locator | WebStorm Find Usages | "Every test touching `getByTestId("checkout")`" after a site change | MCP `get_step_matches`/`list_tests` index | M | should |
| Highlight usages of a `${var}` in-file | WebStorm | Mark decoration | variables store | S | should |
| Code Vision: "used in 7 tests" above a flow call or `${var}` | IntelliJ Code Vision | Decides whether a heal should propagate | same index | M | later |

### Test-automation tools, from the trainer browser

| Feature | Borrowed from | What it does here | Grounding | Effort | Tier |
|---|---|---|---|---|---|
| Live match-count inlay after every locator; red on 0 or >1 | Aqua Web Inspector; Playwright VS Code `debugHighlight` | The same `matchesFor` the picker and the run agree on, `testid-attr` rule included | `buildCountScript`, `matchesFor` | M | must |
| Caret on a locator highlights the element in the trainer | Playwright VS Code "Tune locators"; Aqua | Parse the expression at the caret (TS service, not Babel), rewrite the action to `.locator()`, send to the trainer's highlighter | picker's highlight path | M | must |
| Pick locator → insert at caret, honouring the strategy ranking | Playwright VS Code pick | The picked `Locator` model goes through the generator, `shared/heal-key.mjs` and `shared/testid-attr.mjs`, so an editor-inserted locator cannot drift from a recorded one | picker + generator | M | must |
| Record at cursor | Playwright VS Code `reusedBrowser`; mabl draggable Trainer cursor | Caret inside `test(` + Record → steps spliced at that line through `normalizeRawStep` and the generator (the capture boundary applies to an editor buffer too); never during `view.composing` | `?view=recorder-editing` insert cursor | M | must |
| Page-dependent actions visible but disabled with the reason when no trainer is attached | mabl quick edit | Not hidden | recorder state | S | must |
| Locators scratchpad pane: type a locator, see count + highlight before committing | Playwright VS Code `locatorsView`; mabl Locator field | Accepts fluent and string forms; inserts the fluent form | same oracle | M | should |
| Completion of `getByRole` names / labels / testids from the live document, shadow roots included | Aqua locator-value completion | `scanAll` already walks the document | `shadow-dom-capture` | M | should |
| Run to cursor in the trainer (replay 1..N, leave the page live) | IntelliJ Run to Cursor; mabl Play through here | The trainer is the paused process; then pick, refine or record against real state | continue-recording replay | M | should |
| Run selection against the trainer page, docked console; **never echoes a secret** | mabl Run-before-save + Console | Editor as a REPL | injected replayer, run console, `variable-step.ts` rule | M | should |
| Heal markers on locator lines: hover original vs healed, click to revert; per-step `heal off`; assertion locators never heal | mabl auto-heal policy and element history | A healed assertion is a false pass | `heal-journal-store.ts`, `shared/heal-key.mjs` | M | should |
| Test-automation lint: long CSS/XPath chains, positional `nth()` without context, `waitForTimeout`, `{force:true}`, `dispatchEvent('click')`, with picker-backed quick-fixes and optionally a standing overlay rule | mabl find-strategy hierarchy; `eslint-plugin-playwright` | Playwright enforces actionability, so the lint targets the bypasses | `overlay-rule-store`, picker | M | should |
| Locator strategy ranking in Settings (testid > role > label > text > css), honoured by insert and snippets | WebStorm locator chooser | A ranked list, not a free template, so spelling stays parseable and heal-keyed | `shared/testid-attr.mjs` | S | should |
| Debug with Playwright Inspector: gutter breakpoint → temp spec with `page.pause()` before that step, headed | WebStorm/Aqua gutter debugger | `page.pause()`/`PWDEBUG=1` present in 1.53 | runner | M | later |
| Aria-snapshot assertion step (`toMatchAriaSnapshot`) | Playwright 1.49 codegen | New step kind; `step-semantics.mjs` gets the rule so generator, replayer and list agree; parity rows | available on 1.53 | M | later |

### Run integration

| Feature | Borrowed from | What it does here | Grounding | Effort | Tier |
|---|---|---|---|---|---|
| Gutter run icon on `test(`; per-step replay icon on each step's first line, coloured from the last result | IntelliJ gutter icons; VS Code Testing API | Every source exists | `runner:step`, `RunInfo.stepStatus`, per-step replay | S | must |
| Running-step line decoration; failed line gets the error inline (expected/actual zone) | Aqua failed-line highlight; VS Code `TestMessage` | The console's highlight, mirrored into the editor | step markers | S | must |
| Verify command = the `--list` dry run, with Playwright's own text | `check:runtime-boot` | **Shipped today** on Save; expose as a command and pre-run | `script-check.ts` | S | must |
| Inlay hints after each step: last duration, pass rate over N runs, "healed 3×" — each toggleable | Aqua step-time inlays | Read from `metrics.db` and the heal journal | `get_step_health`, heal journal | M | should |
| Step tree beside the console; rerun from failed step; click-to-source on `file:line`; pin an older run = `compare_runs` as UI | IntelliJ test runner window | Reuses run-to-cursor | `run-history-store`, line map | M | should |
| Run toggles in the editor chrome: headed, keep trainer attached, site address, snapshot update mode, show trace | Playwright VS Code settings | Per-test, persisted on the record | #228 site-address variable, baselines | S | should |
| Rerun on save (watch) | VS Code Testing watch | Debounced after a successful save gate | runner | S | later |
| Open trace after run | Playwright trace viewer | `openTrace` exists | runner | S | later |

### AI, inline

| Feature | Borrowed from | What it does here | Grounding | Effort | Tier |
|---|---|---|---|---|---|
| Cmd-K selection rewrite with hunk review, keep/undo, follow-up | Cursor inline edit; VS Code inline chat | Works on every provider: the model returns only the new selection text | `llm-service.ts`, `line-diff.ts` | M | must |
| Explain this failure at the cursor (sparkle on the failed step's line) | Copilot `/fixTestFailure`; JetBrains Explain Runtime Error | Small pre-selected context; 7B-capable | `failedStepIndex`, `buildStepDebugMessages` | S | must |
| Round-trip diagnostic with one-click rewrite into the generator vocabulary, accepted only if the parser then classifies it | Copilot next-edit fixes | "Diverged" becomes a live diagnostic with a verifiable target | `parseSpecDetailed` | M | must |
| Journal entries tagged with author (user / AI + provider + model + prompt version / heal / import / mcp) and affordance | mabl "Agent generated" tag; IntelliJ Local History labels | Journal doubles as the activity log; every AI edit revertable | `script-change-store.ts` (needs fields) | S | must |
| Fix the locator on this line against the live page (choose among heal candidates, re-count, show only if count = 1) | Cursor Tab linter context | Selection-and-verification, not generation | heal candidate ranker, `buildCountScript` | M | should |
| Generate an assertion for the picked element (`{kind, expected}` constrained to `AssertKind`) | JetBrains/Copilot Generate Tests | Enum + string output; inserted via `normalizeStep` so it round-trips | `main/recorder/types.ts`, `step-semantics.mjs` | M | should |
| Extract selection to flow / extract variable (the model names and picks parameters; the transformation is deterministic) | WebStorm Extract Function / Introduce Variable | Structured refactor over the step model | flow store, `runFlow` | M | should |
| Verify after apply: replay the affected step in the trainer and report pass/fail | mabl agent debug loop | Closes the loop AI debug lacks | per-step replay | M | should |
| Copy prompt on every failed step | Playwright 1.51 "Copy prompt" | For a tool the app does not integrate | AI debug prompt builder | S | should |
| Per-site and global AI instructions, scoped by capability | mabl agent instructions (1000 chars) | Injected into every prompt | Settings AI pane | S | should |
| Ghost text from a local FIM model, validated before display, yielding to the snippet menu; **never sent to a hosted provider** | Copilot ghost text; Zed subtle mode; Continue autocomplete role | Prefix carries page URL, variables, flow names, recent locators as a comment block | autocomplete role (§4) | L | later |
| Deterministic next-edit suggestions for recurring heal pairs (no model call) | Copilot NES | Heal journal already has old→new | heal journal | M | later |

### Configuration

| Feature | Borrowed from | What it does here | Grounding | Effort | Tier |
|---|---|---|---|---|---|
| Settings → Editor: font, size, ligatures, wrap, line numbers, minimap, sticky scroll, tab size, autosave (always through the gate; never a file that fails the syntax gate) | VS Code settings UI | Each a `Compartment`, so it reconfigures live and is headless-testable | `settings-schema.ts`, panes | S | must |
| AI roles: chat/edit, instant helpers, autocomplete — each a provider + model, chat fallback, FIM gate on autocomplete | JetBrains AI Assistant models assignment; Continue roles | `LlmConfig` grows from one slot to three | `main/services/llm/types.ts` | M | must |
| Settings → Inspections: per-rule severity, highlighting level, scope; per-test / per-line suppressions stored on the record (a comment the generator overwrites would not survive) | IntelliJ inspection severities | Maps onto ESLint flat-config severities plus the app rules | new pane | M | should |
| Settings → Keymap: Default / JetBrains / VS Code presets + user overlay; chord shown beside each palette entry; find action by shortcut; a `when` context model (editorFocus, trainerAttached, runActive, selectionIsLocator) owned by one store the palette reads | IntelliJ keymap; VS Code keybindings; Atom keybinding resolver | `keymap` facet with `Prec`; every editor command registered in `command-palette.ts` with its chord, and a check that no keymap entry exists without a palette command or vice versa | palette registry (needs a keybinding field) | M | should |
| User stylesheet (later: init script registering palette commands against a small typed API), loaded after first paint, errors to the log | Atom init file and styles | User-authored files under `userData`, never page-derived | `check:theme-tokens` validates token names | M | later |
| Snippet editor with export | IntelliJ live-template groups | User snippets beside settings | new | S | later |

### Safety and round-trip

| Feature | Borrowed from | What it does here | Grounding | Effort | Tier |
|---|---|---|---|---|---|
| Parse coverage per statement as gutter state (mapped / opaque / unsupported) instead of one test-level "diverged" flag; the banner, Stats and MCP `get_test` keep reading `stepsDiverged`, derived from the per-line set | mabl import's "unsupported statements become echo steps" | The user sees which line costs them step tracking | `parseSpecDetailed` `skipped` (needs positions) | M | must |
| **Revision rule**: every main-process write bumps a revision on the record; the editor holds the revision it loaded; a stale write is refused and shown as a three-way merge (original / theirs / mine) | — | Covers AI auto-apply, heal rewrites, `regenerateCallers`, journal revert, import refresh AND an external editor, which mtime checking alone does not | test store, `MergeView` | M | must |
| Unattended AI auto-apply (the "Apply AI debug fixes automatically" setting, `ai-debug-store.tsx`) never fires while the buffer is dirty | — | The one existing concurrent writer | `ai-debug-store.tsx` | S | must |
| "Edit in Trainer" on an edited script: three-way prompt (discard edits / re-parse into steps first / cancel), never an overwrite without it | — | Today the trainer regenerates and discards | `test-detail-view.tsx`, handler test | S | must |
| Structural edits (rename, extract, insert locator, templates) go through the step model and regenerate | JetBrains refactorings | Otherwise the round trip marks the test diverged | stores + generator | — | must |
| Secrets: names may appear (`process.env[secretEnvName(...)]`), values never; TS hover/inlays never resolve a secret; prompts strip values from prefix, suffix AND the attached journal diff; `describeSending` says "secret names only"; a planted-secret `check:editor-egress` over every prompt builder, in the `check:insights-egress` shape | the app's own rules | Every new prompt surface is a new leak path | `secret-redaction.ts`, `variable-step.ts` | S | must |
| Fenced code step (page, vars in, return bound to `${var}`) the parser owns as one opaque step | mabl JavaScript snippet step | Hand-written logic no longer flips the whole test out of tracking; exports cleanly | generator + parser (new step type) | M | should |
| Flow blocks: decorated in a caller; editing warns "shared by N tests" — edit everywhere vs detach; a diagnostic "flow changed since this script was edited" with a re-inline quick-fix (the generator must mark flow boundaries in emitted source first) | mabl flows | An edited caller silently stops receiving flow updates today | flow store, journal | M | should |
| Local History: auto-labelled journal entries (run, heal, AI apply, manual), manual labels, fragment revert; entries over `MAX_SOURCE_BYTES` (256 KiB, blanked — not truncated) degrade VISIBLY ("history not kept for files over 256 KB") | IntelliJ Local History | Journal already stores before/after with pending/accepted/reverted | `script-change-store.ts` | M | should |
| Rename variable / secret / flow across the library, regenerating each affected test with a journal entry per test | WebStorm Rename | A refactoring, not text replace | stores, journal | L | later |
| Every AI edit = previewed intention + labelled revision; AI never changes what a run does without a user apply | mabl's retirement of runtime recovery | The regression-proofing asked for | journal | — | must |

---

## 4. AI in the editor, bring-your-own-provider

**Roles.** Continue assigns each model one or more of chat / autocomplete /
edit / apply (edit falls back to chat; autocomplete requires a FIM-trained
model). JetBrains splits the same way into core features / instant helpers /
code completion and states that inline completion requires FIM. `LlmConfig`
holds one provider and one model today. Grow it to three slots:

| Role | Used by | Ollama | LM Studio | Claude API |
|---|---|---|---|---|
| Chat / edit | AI debug, Cmd-K, explain failure, extract-to-flow naming, generation | existing path | existing path | existing path; add prompt caching (block-array `system`) and structured output |
| Instant helpers (JSON only: pick a locator candidate, pick an assert kind, name a step) | fix locator, generate assertion, round-trip rewrite | `format` = JSON schema, temperature 0 | `response_format` json_schema; unreliable below 7B per LM Studio's own note — parse-and-retry fallback | JSON-schema output config |
| Autocomplete (FIM, keystroke latency) | ghost text | `/api/generate` with `suffix`, `keep_alive` raised | `/v1/completions` applies no template and has no `suffix`, so the app assembles FIM tokens per model family from a small table | not offered — wrong latency class, not FIM; **never** send ghost-text prefixes to a hosted provider |

The AI pane's health probe warns when a chat model is assigned to autocomplete.

**Apply format.** Whole-file for AI debug, whole-selection for Cmd-K; never
line-numbered diffs; SEARCH/REPLACE only as an Anthropic-specific path over the
in-memory buffer via the text-editor tool. Cursor reports full-file rewrite
beating diff formats under ~400 lines and that models miscount line numbers
(vendor blog); aider defaults local models to `whole` and measured a 9× rise in
edit errors with strict unified-diff matching; Cline documents SEARCH/REPLACE
failures from CRLF, trailing whitespace and indentation. A recorded spec is
almost always under 400 lines, and the app's AI-debug prompt already asks for
the complete corrected spec. What changes is review: the result lands as hunks
in `unifiedMergeView`, diffed against the buffer, one journal entry tagged with
provider, model, prompt version and affordance, re-parsed on apply.

**Grounding, ranked by value per token.** (1) the failed step: index, log slice
around its marker, the Step record with its `step-semantics.mjs` meaning —
already in `DebugContext`; (2) locator facts: live count from
`buildCountScript` or the captured run's `get_step_matches`, Auto-Heal's ranked
candidates, the heal journal's old→new pairs; (3) step model and vocabulary;
(4) scope: variables (secret values masked), flow names, site address, per-site
instructions; (5) recent edits from the journal; (6) trainer screenshot and a
trimmed a11y snapshot — most expensive, last, optional; (7) the whole script,
cached on Anthropic, truncated on small-context local models. Budget each
affordance: a visible token estimate before a hosted call, debounce and
cancel-on-caret-move for inline affordances, a per-minute cap for hosted
providers, tokens in/out recorded per affordance in `ai-debug-history-store`
(facts, no content) so the Stats board can show spend.

**What a 7B local model can be trusted with.** Yes: explanation over a
pre-selected context; choosing among a supplied candidate list with JSON-schema
output and app-side verification (re-count must equal 1; parser must classify
the rewrite); naming a flow and picking parameters; one-line rewrites into a
closed vocabulary; FIM ghost text from a base coder model. No: inventing a
locator from raw HTML; multi-edit SEARCH/REPLACE; structured output below 7B
without a retry path; anything that changes a run without a user apply.

---

## 5. Configuration surface

| Setting | Options | Lives in |
|---|---|---|
| Keymap scheme | Default / JetBrains / VS Code + user overlay (`{key, command, when}`, `-command` to remove, chords) | Settings → Keymap; overlay under `userData`; presets in `renderer/lib/editor/keymaps/` as code so the gate covers them |
| Font, size, ligatures | self-hosted mono default; explicit `font-variant-ligatures` (ligatures change glyph advance) | Settings → Editor; a `Compartment`; `check:script-ide-layout` pins the declaration |
| Wrap, line numbers, minimap, sticky scroll, bracket colouring, tab size, indent guides | booleans / numbers | Settings → Editor; one `Compartment` each |
| Autosave | off / on idle / on focus loss — always through the gate | Settings → Editor |
| Format on save | off / on; Prettier options | Settings → Editor |
| Inspections | per rule off / info / weak / warning / error; level Syntax / Essential / All; scope; suppressions on the record | Settings → Inspections; one flat-config module read by the editor and its tests |
| Save gate strictness | syntax / + parse preview / + `--list`; "save anyway when diverged" confirmation, suppressed when the skipped set is unchanged from the last save (imports and fenced code would otherwise prompt every time) | Settings → Editor → Saving |
| Gutter markers, inlay hints | each toggleable, global off | Settings → Editor |
| AI roles, instructions | three slots; global + per-host instructions scoped by capability | Settings → AI (existing pane) |
| Locator strategy ranking | ordered list; testid attribute names | Settings → Recorder (testid part exists) |
| Run toggles | headed, keep trainer attached, site address, snapshot mode, trace | editor chrome, persisted per test |
| Escape hatches | settings JSON; user stylesheet; init script (later) | `userData`, loaded after first paint |

All of it enters through `renderer/lib/settings-schema.ts`, so the row search,
the `window:openSettings(pane)` deep link and palette toggles apply.

---

## 6. Regression strategy

1. **Vitest `node` — pure `EditorState` tests.** Every text operation lives in
   `renderer/lib/editor/*.ts` as `(EditorState) => Transaction` or
   `(source) => Diagnostic[]` (insert snippet, apply hunk, wrap selection,
   replace locator, dirty tracking, each lint rule, `Compartment`
   reconfiguration) and runs under the existing `renderer/lib/**/*.test.ts`
   glob with no DOM. Files split `common` / `browser` so nothing in `common`
   imports `EditorView`.
2. **Golden corpora** (`toMatchFileSnapshot`): `__fixtures__/specs/<case>.spec.ts`
   + `<case>.steps.json`, looped over `parseSpecDetailed` — generator output
   for every step type, hand-edited scripts from the journal, applied AI-debug
   specs (the `skipped` case); a generator corpus per step type; a diagnostics
   corpus with inline `<error descr="…">` markup (IntelliJ's pattern), and the
   ESLint half via `new Linter().verify(source, config)` with the editor's own
   config object.
3. **Property-based round trip** (`@fast-check/vitest`, new devDependency),
   generalising `locator-roundtrip.check.ts`: an arbitrary over every step
   type, assert mode, locator kind (testid with `attr`), context chains,
   `nth`, `filter`, nested loop/if via `fc.letrec`, hostile strings (quotes,
   backticks, `${`, `\n`, `*/`, RTL marks) through `normalizeStep` first.
   Properties: `parseSpecDetailed(generateSpec(steps)).skipped === 0`;
   `generate(parse(generate(s))) === generate(s)`.
4. **`check:*`**: `check:script-ide-layout` (editor host `min-h-0 flex-1`;
   `.cm-editor { height: 100% }`; exactly one scroll container — a second one
   breaks virtualisation and renders fine in jsdom; font stack; ligature
   declaration; reduced-motion); `check:runtime-boot` absorbs the edited-script
   corpus; `check:derived-cache` for any new run-derived query key;
   `check:package-integrity` for the promoted `typescript` and any worker or
   `utilityProcess` bundle; a **bundle-size budget** (gz bytes of the
   CodeMirror chunk and of any worker) so a later renderer import of full
   `prettier` or `typescript` fails the gate; `check:editor-egress` with a
   planted secret over every prompt builder.
5. **Handler tests** (`invokeHandler`): a broken source is refused with file
   and journal unchanged; a diverging source reports `skipped` and saves only
   with confirmation; a stale revision is refused; a journal entry carries the
   author tag; an edited script is never overwritten by "Edit in Trainer"
   without confirmation.
6. **Vitest `dom`**: wiring with the `api` module mocked and a LIVE push
   bridge (an inert `on: () => () => {}` hides the refresh path — DECISIONS on
   `RUN_DERIVED_KEYS`): the editor mounts, receives `runner:step`, updates the
   status gutter; `toastTexts()` for refusals; axe finds the accessible name;
   switching `data-theme` reconfigures the theme compartment.
7. **Optional: Vitest Browser Mode** (real Chromium, no Electron) for
   decorations, lint markers, fold, keymap chords — listed by hand in
   `vitest.config.ts` with a check that the glob is present (an unlisted
   renderer test silently never runs).
8. **`e2e/`** (real app): `script-ide-worker.spec.ts` — type an unclosed
   `goto(` in the packaged shell and wait for the lint marker, the only place
   `app://` + CSP + worker URL resolution exist, with a row asserting the
   editor still saves when the worker fails to start; `script-ide-geometry
   .spec.ts` — with a 400-char line, `coordsAtPos` lies inside the content
   rect on the selection's row, and after `scrollDOM.scrollTop = N` gutter
   line k and content line k share `top` within 1 px (geometry, not
   screenshots — Playwright warns they vary by OS and hardware, and CI is
   Linux under xvfb while the user sees macOS); `script-ide-trainer.spec.ts`
   — caret on a locator line produces a highlight in the trainer and a count
   that agrees with the picker. `assert-parity`, `context-parity`,
   `shadow-parity` and `step-progress` gain rows whenever the IDE adds a step
   kind, a context clause or a reporting change.

---

## 7. What this unlocks, and what existing planned work it helps

- **Imported projects become first-class.** The TS service seeded with the
  sandbox's own files gives hover, completion and go-to-definition across an
  imported spec's relative imports (refusing to open anything outside
  `destRoot` — the import-sandbox boundary applies to navigation too);
  per-statement parse coverage lets an imported spec be partly step-tracked.
  This needs a parser mode, because an imported record has no `steps` to map
  onto today. A file tab strip per sandbox, with sibling edits routed through
  `testStore.writeScript`'s in-sandbox rule, and `--list` run against the
  real sandbox path.
- **Export-to-repo** (mabl-derived plan): the editor is where a user reviews
  what will be written out; format-on-save, the `--list` gate and the
  journal's author tags give an exportable file a known shape and provenance;
  the fenced code step gives hand logic a form that survives re-import.
- **Environments**: the run toggles (site address per test) and the `${var}`
  usage index are the UI half; heal markers should show which environment a
  heal came from.
- **CLI runner**: the transactional save and the `--list` dry run are exactly
  the preflight a headless CLI needs — a `Verify` command with a `check`-style
  exit code falls out of the same handler. The MCP gains `check_script` (same
  handler, `author: mcp`, respecting the revision rule) and, once
  run-to-cursor exists, `run_step` / `run_to_step`, so external coding agents
  get the editor's loop. Shared rules (diagnostic severities) go in
  `shared/*.mjs`, since the MCP has no build step.
- **iframes** (Phase 6 of the recorder plan): not directly helped; the
  locator scratchpad and the match-count inlay make `frameLocator` chains
  verifiable from code once the trainer oracle supports frames.
- **Playwright pin upgrade** (1.53 → 1.59+): `page.pickLocator()` and the
  bundled MCP are library APIs the IDE could call instead of the trainer-side
  picker; `--list` accepting `declare` fields changes what the gate accepts.
  Its own PR, after this work.
- **Library-wide Problems view**, rename-as-refactoring, Code Vision usage
  counts, aria-snapshot and visual (LLM) assertion step kinds, duration and
  pass-rate inlays from `metrics.db` with nothing new stored.

---

## 8. Phases

Phase 0 is done. Each later phase is one or more PRs, gated, with the docs
updated in the same commit, in the rhythm the recorder and runner plans used.

| Phase | Scope | Depends on | Effort |
|---|---|---|---|
| **0 — bugs** (shipped) | Overlay wrap/scroll; `tests:checkScript` + Save gate with Save anyway | — | done |
| **1 — engine** | CodeMirror 6 behind a dynamic import; `--gl-*` theme incl. `HighlightStyle`; lint sink fed by Lezer error nodes + `ts.transpileModule` + the `--list` result; transactional save with revision rule, parse-coverage gutter, "Return to generated script", the Edit-in-Trainer prompt, auto-apply held while dirty; step↔line map from the generator; caret↔Steps binding; gutter run/step status; keyboard a11y + `aria-live`; Settings → Editor; `?view=script-ide` preview fixture incl. a 2000-line spec; `check:script-ide-layout`, bundle budget, geometry e2e | 0 | L |
| **2 — trainer tools** | Match-count inlay; caret → trainer highlight; pick-locator insert; record at cursor; page-dependent actions disabled-with-reason; run to cursor; locator scratchpad; heal markers | 1 | L |
| **3 — AI inline** | `LlmConfig` role slots + AI pane rows; Cmd-K with hunk review; explain failure; round-trip rewrite; journal author tags; `check:editor-egress`; token estimate, debounce, cap; per-site instructions | 1 | L |
| **4 — language service + lint** | TS 5.x service in a worker or `utilityProcess` (re-exported through `main/shell/`), Playwright `.d.ts` from the packaged tree, visible "type intelligence unavailable" fallback; ESLint + `eslint-plugin-playwright` + app rules; Settings → Inspections with suppressions on the record; quick-fix lightbulb with preview; worker e2e | 1 | L |
| **5 — configuration and structure** | Keymap presets + overlay + palette chord contract + `when` context; snippets/live templates; fold by step; breadcrumbs; File Structure popup; format on save; Find Usages; flow-block decorations and the re-inline quick-fix | 1, 4 | M–L |
| **6 — later** | Ghost text (FIM, local only); fenced code step; Playwright Inspector breakpoints; aria-snapshot step; rename across the library; user stylesheet / init script; MCP `check_script` / `run_to_step`; watch mode; Playwright pin upgrade | 2–5 | XL |

---

## 8a. Status (2026-08-23)

Phase 0 and Phase 1 shipped (PR #239). Phase 2 (live page, pick locator,
record here) is PR #240. Phase 3 is `feat/script-ide-phase3`, stacked on
#240: three role slots, ghost text (local only), ⌘K rewrite into the buffer
with `ai-inline` journaling, Explain failure at the caret, the budget line
and hosted cap, standing instructions global and per host, and
`check:editor-egress`. Deferred from Phase 3: hunk-by-hunk review, the
`llm:json` round-trip classification (service half built), acceptance
telemetry. Phase 4 is `feat/script-ide-phase4`, stacked on Phase 3: the
TypeScript service in a `utilityProcess` (typescript 5.x shipped, resolved
from the runner's node_modules), completions/hover/type errors in the
editor, six app-written inspections with quick fixes, Settings →
Inspections, `check:ts-service` and `e2e/ts-service.spec.ts`. Deferred from
Phase 4: signature help, rename, go-to-definition, format on save,
quick fixes from the live page and from Auto-Heal history. Phases 5–6 are
open.

## 9. Open questions for the maintainer

Each with the options and the recommended default.

1. **Engine.** CodeMirror 6 / Monaco / stay on the overlay and only grow the
   save gate. Default: CodeMirror 6.
2. **Where the TypeScript service lives.** Renderer Web Worker (first proof of
   a worker under `app://`) / Electron `utilityProcess` over IPC via an
   `lsp-client` Transport (shares `typescript.js` with ESLint, keeps 9 MB out
   of the renderer bundle) / no TS service in v1. Default: `utilityProcess`,
   behind the Transport so it can move.
3. **Promote `typescript` (pinned 5.x) to a runtime dependency** and use
   `ts.transpileModule` as the instant syntax gate, leaving esbuild a
   devDependency / promote esbuild instead / both. Default: `typescript` only.
4. **`--list` dry run on every save or only before run.** Every save (~0.5 s,
   Playwright's own text — what ships today) / pre-run only / a setting.
   Default: a setting, on.
5. **Saving when the parse preview reports diverged statements.** Refuse /
   confirm with the count / allow silently as today. Default: confirm, with
   the per-line gutter showing which, suppressed when unchanged from the last
   save.
6. **Step↔line map source.** Generator emits it / runner keeps deriving it /
   both with a consistency check. Default: generator emits, runner verifies,
   a check compares.
7. **Per-step markers in generated specs.** Visible `test.step` wrappers with
   the description as the title / hidden markers as today / visible comments.
   Default: `test.step` — standard Playwright, folds naturally, reports as a
   step.
8. **AI role slots.** Three / two (chat, autocomplete) / one. Default: three,
   autocomplete optional and FIM-gated.
9. **Anthropic-specific edit path.** Text-editor tool over the buffer /
   whole-file everywhere. Default: whole-file and selection everywhere in v1.
10. **Ghost text in v1.** Ship / defer. Default: defer; Cmd-K,
    explain-failure and the round-trip diagnostic first.
11. **Fenced code step.** Add as a step type / rely on per-statement opaque
    coverage. Default: add it — the only way hand logic stays inside step
    tracking and exports cleanly.
12. **Keymap presets.** Default + JetBrains + VS Code / Default + JetBrains /
    user JSON only. Default: all three, as code in the repo.
13. **User init script and stylesheet.** Both / stylesheet only / neither.
    Default: stylesheet only in v1.
14. **Vitest Browser Mode** as a third project / node + jsdom + e2e only.
    Default: skip in v1.
15. **Playwright pin.** Stay on 1.53.0 for this work / upgrade first.
    Default: stay; the upgrade is its own PR.
16. **Editor and recording session open on the same test.** Allowed with the
    revision rule deciding / blocked while a session is live. Default:
    blocked, with the reason shown.
