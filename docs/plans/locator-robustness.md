# Locator robustness: substring text, missing roles, and the record-time gate

Written 2026-08-22, against `origin/main` at `0122a79`.

Goal: stop recording locators that verify as unique in the trainer and fail
in the run, and stop the run's own diagnosis from pointing at the engine when
the error line names the locator.

---

## 1. What was measured

The reported failure ("Unsplash Integration Test", step 6):

```
strict mode violation: getByTestId('search-route').getByText('Mountain') resolved to 3 elements:
  1) <h1>Mountain</h1>                    aka getByRole('heading', { name: 'Mountain' })
  2) <a href="/s/photos/mountains">mountains</a>
  3) <a href="/s/photos/mountain-peak">mountain peak</a>
```

Checked against the live page on 2026-08-22: 1,845 elements (well under
`MAX_UNIQUENESS_SCAN`), three substring matches for "mountain" inside
`search-route`, one exact match (the `<h1>`), one heading named "Mountain".
The recorder had two stable locators available and offered neither.

Across the on-disk library (18 store files, 96 `assert` steps):

| Locator kind on assert steps | Count |
|---|---|
| page-level (no locator) | 27 |
| `role` | 26 (1 with context) |
| `text` | 29 (7 with context) |
| `css` positional (`:nth-of-type`) | 6 |
| `css` other | 5 |
| `testid` | 2 |
| `label` | 1 |

Positional is ~9% of element assertions. Substring text is the large fragile
class, and nothing in the step list flags it.

Why the run read as an engine problem: `single-engine` is STRONG (3) and
`ambiguous-locator` is MODERATE (2) in `shared/triage.mjs`, and the cohort
(`siblingRuns`, keyed on `test_id` only, last 30) included the test's earlier
step sets, which had run on webkit and firefox. The failing step had run three
times, all on chromium. The triage verdict and the auto failure reason
("Environment issue") both came from that.

---

## 2. Root causes, in the code

1. **`roleOf` knows five tags** (`main/recorder/capture-script.ts:999`: `a`,
   `button`, `select`, `textarea`, `input`). Playwright's `kElementToRoles`
   (`playwright-core/lib/generated/injectedScriptSource.js`) has ~50. An
   `<h1>` never gets a `heading` candidate, so the click on it fell to a
   positional path and the assertion on it fell to substring text. One gap,
   both rows in the screenshot.
2. **No exact text locator exists.** `Locator` has no `exact` field; the
   generator can only emit `getByText(v)`.
3. **The composer shows the live count and does not act on it.**
   `element-context-picker.tsx:181` asks the page for a count of the chosen
   base + context; `step-composer.tsx`'s `ready` is `steps.length > 0`. A
   locator matching three elements is accepted. User-picked steps also skip
   `verifyAndInsertSteps` (that path is AI-proposed steps only).
4. **Triage lets an inferred signal outrank a stated one**, and infers it
   from a cohort that is not about the failing step.

---

## 3. The plan — four PRs, in this order

Ordered so each lands independently and the two that touch
`candidatesFor`/`matchesForBase` (PR 2 and PR 4) do not overlap in flight.

### PR 1 — Triage: the error line outranks the engine inference

Smallest change, and it stops the wrong label from being written on every
future run of this shape.

**Changes**

- `shared/triage.mjs`: `ambiguous-locator` becomes STRONG. It is Playwright
  stating the cause, not an inference; nothing inferred should outrank it.
- `shared/triage.mjs`: cross-engine evidence is scoped to the failing step.
  `triageRun` gains `stepEngines` — rows from
  `stepBrowserMatrix(db, { testId })` filtered to `run.failed_step_id` —
  and `single-engine` / `all-engines` are computed from those when a
  `failed_step_id` is known. An engine that has never run the failing step
  is not a "clean" engine; with no other engine on the step, push a `limits`
  line ("only chromium has run the failing step") rather than a signal. The
  run-level cohort stays for the dataset and capture-only signals.
- Both callers supply the new input: `main/services/metrics-store.ts:390`
  and `mcp/server.mjs:1889`. They must agree — `check:mcp-parity` is the
  existing guard for this seam; confirm it covers the triage input shape,
  and extend it if it only covers tool lists.
- `shared/failure-reasons.mjs`: no mapping change needed (`ambiguous-locator`
  already maps to `test-implementation`); the ranking change is what makes it
  win.

**Tests**

- `main/services/__tests__/triage.check.ts`: (a) a strict-mode signature plus
  a passing sibling on another engine yields `ambiguous-locator` as the
  strongest signal and a `runner` verdict; (b) `single-engine` does not fire
  when the failing step has only run on one engine, even when the test's
  siblings passed elsewhere; (c) it still fires when the step itself ran
  clean on the other engine.
- `main/services/failure-reasons.test.ts`: the Unsplash shape suggests
  `test-implementation`, not `environment`.

**Docs**: DECISIONS entry; `docs/MCP-GUIDE.md` §`triage_run` if it describes
the engine signal (it does not name signals today — verify).

**Size**: S. Pure modules, no UI.

### PR 2 — Roles: transcribe Playwright's implicit-role table

The largest reduction in both positional and text locators, and the fix for
both rows in the report.

**Changes** (all in `main/recorder/capture-script.ts`, which `DOM_HELPERS` /
`UNIQUENESS_HELPERS` share with the replayer, Auto-Heal and the dismiss
fixture — one edit, four consumers, no drift)

- `roleOf`: transcribe `kElementToRoles` in full, keeping the existing
  `input`/`select` arms. The conditional entries matter and are easy to get
  wrong from memory:
  - `header`/`footer` → `banner`/`contentinfo` only outside
    `kAncestorPreventingLandmark` (`article, aside, main, nav, section` and
    their explicit-role equivalents);
  - `section` → `region` and `form` → `form` only with an explicit accessible
    name (`aria-label`, `aria-labelledby`, `title`);
  - `img` with `alt=""` and no title/global aria/tabindex → `presentation`;
  - `td`/`th` → `cell`/`gridcell`/`columnheader`/`rowheader` by `scope` and
    the enclosing table's explicit role;
  - `svg` → `img`; `h1`–`h6` → `heading`; `li` → `listitem`; `ul`/`ol`/`menu`
    → `list`; `nav`/`main`/`aside`/`article`/`dialog`/`option`/`tr`/`table`
    and the rest as in the table.
- `accName`: gate name-from-content on Playwright's `allowsNameFromContent`
  "always" list (`button, cell, checkbox, columnheader, gridcell, heading,
  link, menuitem, menuitemcheckbox, menuitemradio, option, radio, row,
  rowheader, switch, tab, tooltip, treeitem`). For every other role the name
  comes from `aria-label`, `aria-labelledby`, `alt` (img), `title` — never
  from content. Without this, `getByRole("listitem", { name: "North" })`
  verifies unique here and matches nothing in the run, which is the exact
  failure class the `roleOf` comment warns about.
- The role scan in `matchesForBase` (`"[role],a[href],button,input,select,
  textarea"`) and the tag table in `roleOf` become ONE constant — a selector
  built from the table's keys — so a tag cannot be added to one and missed by
  the other.
- Nameless role candidates (`{ k: "role", role }` with no name) stay limited
  to the roles that produce them today plus `dialog` and `img`. Otherwise
  every `<p>` grows a `getByRole("paragraph")` candidate, and `pickLocator`'s
  indexed fallback would prefer `getByRole("paragraph").nth(7)` over the
  positional path it falls to now — an "indexed" grade in place of a
  "positional" one, which is not an improvement.
- `scopeLocatorFor` needs no change: with `roleOf` deriving `navigation`,
  `main`, `listitem`, `list`, `dialog`, `row`, `table`, `article`, `form`
  and `region` from tags, the context picker starts offering "Inside
  navigation" for a bare `<nav>`. `GL_SCOPE_ROLES` already lists them.

**Tests**

- `main/recorder/locator-uniqueness.dom.test.ts`: its independent oracle
  (`countMatches`, lines 95–127) derives roles itself and must learn the new
  tags — keep it a separate spelling, that is what makes it a check. Rows:
  the Unsplash shape (`<h1>Mountain</h1>` beside two links containing the
  word) records `getByRole("heading", { name: "Mountain" })`; a `<p>` with
  ambiguous text does not become an indexed role locator; an `<img alt>`
  records by role and alt; a `<li>` is not given a name from its content.
- `main/recorder/element-context.dom.test.ts`: a bare `<nav>` / `<main>` /
  `<li>` is offered as a scope.
- `e2e/assert-parity.spec.ts`: one row per conditional entry, because the
  real browser is the judge — heading by name (true); `listitem` by content
  name (expected FALSE — documents that the recorder must not emit one);
  `<header>` inside `<main>` as `banner` (false) and outside (true);
  `<section>` without a name as `region` (false), with `aria-label` (true);
  `<img alt="">` as `img` (false); `th scope="col"` as `columnheader` (true).
- `e2e/context-parity.spec.ts`: `within` a bare `<nav>` resolved as
  `{ k: "role", role: "navigation" }`.
- `main/recorder/step-replayer-parity.dom.test.ts`: a heading row, since
  the replayer resolves roles through the same helper.

**Docs**: ARCHITECTURE's `capture-script.ts` entry (the `roleOf` paragraph);
DECISIONS entry, including the nameless-role decision and why the table is
transcribed rather than imported (the injected script is a string built at
module load; Playwright's table lives inside a generated bundle).

**Size**: M. One file of logic, five test files, e2e rows.

### PR 3 — The composer refuses a locator that matches more than one element

**Changes**

- `renderer/main/step-composer.tsx`: the composer counts the locator it is
  about to submit — `api.recorder.countMatches(locator)` on every `emit`,
  cancelled on change — and `ready` additionally requires `count === 1`
  whenever a locator-bearing step has no `nth`. The panel says why, in the
  place it already says what is missing: "Matches 3 elements on the page —
  add a context or a position." A count of `-1` (the page could not answer)
  does NOT block: never refuse on the page failing to count. The count script
  is already uncapped (`buildCountScript` sets `UNCAPPED_SCAN`), so the
  number can be trusted.
- The count currently lives inside `ElementContextPicker` (`liveCount`); lift
  it to the composer and pass it down, so one request serves the readout and
  the gate, and the picker stops owning a fact the submit depends on.
- `renderer/main/refine-selector-dialog.tsx`: same gate on "Apply" — editing
  an existing step's locator is the other way an ambiguous one is written.
- Not doing: routing user-picked steps through `verifyAndInsertSteps`. That
  path performs the step on the live page, which is right for a model's
  proposal and wrong for a user composing a click meant for a later page
  state. The count answers the question the gate needs without acting.

**Tests**

- `renderer/main/step-composer.test.tsx`: `countMatches` mocked to 3 → Add
  disabled with the message; to 1 → enabled; to -1 → enabled; with `nth`
  set → enabled regardless. Mock the `api` module, not the bridge.
- `renderer/main/refine-selector-dialog.test.tsx`: the same four.
- Verify each can fail by removing the `count === 1` clause.

**Docs**: ARCHITECTURE entries for the composer and the picker; DECISIONS
entry (why count, not try).

**Size**: S–M. Renderer only.

### PR 4 — An exact text locator

The principled fix for the 29 text assertions already on disk and every one
recorded after. Last, because it crosses the capture boundary and touches
every consumer of a `text` locator.

**Model and boundary**

- `Locator.exact?: boolean`, meaningful on `k: "text"` only for now (Playwright
  also accepts `exact` on `getByLabel`, `getByPlaceholder` and a role `name`;
  the field is named so those can follow without a second field).
- `main/recorder/types.ts` `normalizeLocator`: rebuild `exact` only when
  `l.exact === true` and `k === "text"`; anything else is dropped. The
  renderer mirror `renderer/lib/recorder-types.ts` gains the field (a field
  the normalizer does not rebuild disappears on the way back — the comment
  on `LocatorContext` says so).
- `check:step-ingest`: a row that `exact: "true"` (string) and `exact: 1` are
  dropped, and that the generator emits nothing for a non-boolean.

**Every consumer** (the grep for `k === "text"` / `case "text"`):

| File | Change |
|---|---|
| `main/services/script-generator.ts:190` | `getByText(q(v), { exact: true })` |
| `main/services/spec-parser.ts` (`getByText` arm, ~470) | parse the options object for `exact: true`; round-trip test |
| `shared/heal-key.mjs` (+ `.d.mts`) | `healKeyText(v, exact)` — the exact form needs its own key prefix (e.g. `text!` in place of `text`) or a heal recorded for the substring form applies to the exact one |
| `main/services/playwright-runner.ts:489` | use the shared key function |
| `main/services/heal-fixture-source.ts` | `FACTORIES.getByText` reads `args[1]?.exact`; `baseFromModel` passes `{ exact: true }` |
| `main/recorder/capture-script.ts` `matchesForBase` text arm | exact: whole-string, case-sensitive, whitespace-normalized and trimmed on both sides, same smallest-element rule. This is the one place the oracle lives (shared with the replayer and Auto-Heal) |
| `main/recorder/capture-script.ts` `candidatesFor` / `locatorCandidates` | push `{ k: "text", v, exact: true }` immediately after the substring candidate, so a unique substring still wins and exact is tried before any CSS path. Derive `v` for the exact candidate from `pwText`, not `txt` — `innerText` applies `text-transform`, `textContent` (Playwright's `elementText`) does not, and an exact candidate built from the wrong one never matches |
| `renderer/lib/describe-step.ts:114,168` | render `{ exact: true }` |
| `renderer/main/refine-selector-dialog.tsx:34` | same |
| `renderer/lib/llm-prompts.ts:376` | document `"exact": true` in the locator grammar, so a model can propose it and `locatorToPrompt` shows it |
| `renderer/lib/locator-grade.ts` | no change — exact text is a healthy shape |

**Tests**

- `locator-uniqueness.dom.test.ts`: the Unsplash shape with a `<span>` instead
  of an `<h1>` (no role available) records exact text; substring-unique still
  records substring; an element whose `innerText` is transformed by CSS does
  not record an exact candidate that cannot match.
- `e2e/assert-parity.spec.ts`: exact true/false against "Mountain" vs
  "mountains"; case-sensitivity (`exact: true` + "mountain" against
  `<h1>Mountain</h1>` is false); surrounding whitespace still trims.
- `e2e/context-parity.spec.ts`: exact text within a container.
- `main/services/spec-parser` tests and `describe-mirror.test.ts`: round trip.
- `main/services/heal-fixture.test.ts`: the two keys differ; a heal against
  the exact form applies the exact form.
- `check:step-ingest`, `check:runtime-boot` (unchanged helpers, but run it).

**Docs**: ARCHITECTURE entries for `capture-script.ts`, `script-generator.ts`,
`spec-parser.ts`, `heal-key.mjs`; DECISIONS entry; `docs/MCP-GUIDE.md` if it
shows a locator JSON shape anywhere (it does not today — verify before
landing).

**Size**: L. Nine files of logic, seven test files, e2e rows.

### Not planned: a grade tier for substring text

Considered and rejected. `locator-grade.ts` is a pure function of what is on
disk, and whether a substring is ambiguous is a fact about the page. A badge on
all 29 text assertions would stop meaning anything — the grade's own rule. PR 3
is where ambiguity is caught, at the moment the page is in front of the user.

---

## 4. Gate per PR

```
npm run lint && npm run type-check && npm run test:all && npm run build
```

plus the e2e specs the PR added rows to (`npm run test:e2e -- assert-parity`,
`context-parity`, `verified-steps` for PR 3), and for PR 2 and PR 4 a real
recording on `https://unsplash.com/s/photos/mountain` in `npm run dev`: click
the `<h1>`, add a visible assertion on it, and read the locator the step row
shows. After PR 2 it is `getByRole("heading", { name: "Mountain" })` with no
warning on either row; the run passes.

## 5. Unblocking the existing test today

Open step 6 in Refine → Custom → `h1` with context "Inside search-route"
(emits `page.getByTestId("search-route").locator("h1")`). Or keep the text
candidate and set Position to 1. Neither needs any of the above.
