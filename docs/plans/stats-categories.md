# Stats categories — a browsable board and its drill-downs

Written 2026-08-10, against `claude/stats-category-components-5k95rt`.

> **Status: built, 2026-08-14.** PRs 1 and 2 landed on 2026-08-10 (the B7
> reskin, then the registry, board, routes, breadcrumb trail,
> `check:stats-categories` and the Stability and Auto-Heal dashboards). PRs 3–5
> landed together on 2026-08-14: all seven categories now open. Three
> corrections to what §10 assumed, recorded because the plan was written before
> the landing grew its Digest, Cost and Report panels:
>
> - **PR 5 was smaller than planned.** Speed & cost and Step health wrap
>   `SuiteCostPanel` and `StepHealthPanel`, which the landing already rendered,
>   rather than building new tables.
> - **PR 4 needed no new summariser file beyond the rollup.** `shared/a11y-rollup.mjs`
>   carries `rollupA11y` AND `selectLatestA11yRuns` AND the violation identity
>   pair, which collapsed two existing hand-copies.
> - **PR 3's landing rearrange was done in part, deliberately.** The chart, KPI
>   cards and capture overhead moved into Outcomes. The run table, its filters,
>   pagination and log search STAYED: that is a run explorer answering "find me
>   that run", it pairs with the Manage-data menu in the same header, and moving
>   it would have relocated ~200 lines of filter and pagination logic for no
>   gain in what the category answers.
>
> §11's open question 1 is answered: the trail stops at THREE levels. A severity
> opens its rules and a rule row exits to the test; a fourth level is more route
> surface for a screen the user opens to decide which test to go fix.
>
> Options were settled in two rounds with the maintainer on 2026-08-10. The
> choices are in §0; the alternatives are kept beside each one, because a
> rejected option with its reason is what stops the same question being reopened
> in six months. **One claim in §5 was wrong and is corrected in place** — the
> app had no back/forward at all, and building them was part of the work.

**The ask.** Stats grows a component that reports across overall *categories* —
accessibility, visual diff, stability, Auto-Heal, and so on. Clicking a category
replaces the view with that category's own dashboard. From inside a dashboard,
clicking a chart drills again — the worked example was an a11y severity chart
opening a breakdown of severity types and their insights — and the user can go
forward and back through that trail.

Companion documents: [REDESIGN.md](../REDESIGN.md) (§B7 is the Stats reskin this
now sits on top of), [ARCHITECTURE.md](../ARCHITECTURE.md),
[DECISIONS.md](../DECISIONS.md).

---

## 0. Settled decisions

| Question | Choice |
|---|---|
| **Board treatment** | **Verdict band + compact tiles.** A full-width sentence over a row of small number tiles. |
| **Navigation** | **Real routes, real history.** `/stats/$category/$facet`, with the existing top-strip breadcrumb as the trail. |
| **Sequencing** | **REDESIGN §B7 first, on this branch.** The parity reskin of Stats lands before the board; the board is built on reskinned surfaces, not on SDK chrome. |
| **Categories** | **All seven built-ins:** Outcomes, Stability, Auto-Heal, Accessibility, Visual diff, Speed & cost, Step health. |
| **User-created categories** | **Not built.** See §7 for what was considered and the one note worth keeping. |

Everything below is either the reasoning behind one of those, or a rule the
implementation is held to regardless.

---

## 1. Where this lands relative to work already planned

`docs/REDESIGN.md` §B7 schedules a **parity reskin of Stats** — the existing
chart, KPIs, capture overhead, stability, log search and run table moved onto
`Panel` / `Segmented` / `StatusChip` / `Temp`, with two structural moves (a
page-level scope + range stated once in the header, and two row kinds in the run
table that the data already distinguishes). It also schedules two Phase C modes
for the same screen: **Cost** (§6.4) and **Report** (§6.5).

**The board supersedes B7's "one long page in three modes" idea.** A board with
per-category dashboards is a different information architecture, and Cost and
Report become two more categories rather than two more modes. B7's *reskin* is
untouched and still happens first — the board is drawn in the theme layer, and
building it over SDK chrome would mean reskinning the same surfaces twice.

REDESIGN.md's §B7 entry is rewritten in the PR that lands the board, not before.

The relevant fact about today's tree: **Phase A is complete and Phase B has not
started.** `stats-view.tsx` is still SDK chrome (`Toolbar`, `Table`, `Badge`,
`Text`, `Select`). Every primitive this feature needs exists and is tested, but
nothing in Stats reads them yet.

---

## 2. What data actually exists, per category

This is the constraint that shapes everything else, so it comes first. **Three
categories are already aggregated suite-wide. Two are computable renderer-side
from data already fetched. One — the exact drill the ask names — is not
aggregated anywhere and needs new backend work.**

| Category | Headline available from | Suite-wide today? | Drill-down data |
|---|---|---|---|
| **Outcomes** | `api.runs.list()` — `status`, `startedAt`, `durationMs` | ✅ already on screen | per-test, per-day, per-browser — all derivable from the same array |
| **Stability** | `api.runs.flake()` → `FlakeReport` (`TestFlake[]`, `FailureCluster[]`, `windowRuns`/`windowCap`) | ✅ whole-suite, backend-computed | verdict → tests with that verdict → that test's `steps[]` and `failingDatasets[]`; clusters → `runIds[]` |
| **Auto-Heal** | `api.heals.listAll()` → `HealListEntry[]`, plus `RunRecord.healedSteps` | ✅ whole-suite | `status` (applied/suggested/accepted/reverted), `source` (trainer/run), per-test, per-step, `candidates[]` |
| **Speed & cost** | `api.metrics.slowness()` → `CostBreakdown` + `StepDurationRow[]`; `api.runs.captureOverhead()` | ✅ backend-computed, **gated on the metrics DB** | slowest steps, slowed-since rows, capture vs a11y overhead split |
| **Step health** | `api.metrics.stepHealth()` → `StepHealthRow[]`; `api.metrics.divergence()` | ✅ backend-computed, **gated on the metrics DB** | per-step failure/heal/retry counts |
| **Visual diff** | `api.artifacts.list()` → `RunReplaySummary[]` carries `changedSteps` per run | ⚠️ **derivable renderer-side**, not aggregated | per-run step detail needs `artifacts:getReplay(testId, runId)` — one call per run |
| **Accessibility** | `RunRecord.a11yChecks`, `a11yNewSteps`, `a11yMs`; `RunReplaySummary.a11yNewSteps` | ⚠️ **counts only** | **severity/impact and rule id live only inside per-run replay JSON** (`A11yViolation.impact`, `.id`). Nothing aggregates them. |

Speed & cost and Step health are kept **despite** the metrics-DB gate. They
degrade to "unavailable" (§4), which is a state the board has to render honestly
anyway — and a category that says why it cannot report is more useful than one
that was quietly dropped from the list.

### 2.1 The a11y severity drill is the one that needs new plumbing

`impact` is `"minor" | "moderate" | "serious" | "critical"` on each
`A11yViolation`, and violations live inside `replay.json` per run, per step.

**Chosen: a backend summariser, with the arithmetic in `shared/`.** One new IPC
(`stats:a11ySummary`), reading the replay files the app already reads, folding to
counts by impact / rule / test / window. The pure fold goes in
`shared/a11y-rollup.mjs` + a hand-written `.d.mts`, so the MCP can expose the same
numbers later without a transcribed copy — which is what CLAUDE.md says `shared/`
is for.

Rejected:

- **Renderer fan-out.** `artifacts.list()` then `getReplay` per run: N IPC round
  trips and N JSON parses for a screen meant to load at a glance. Fine at twelve
  runs, wrong at two hundred.
- **A metrics-DB table.** An `a11y_violations` rollup beside `step_metrics` is
  better long-term — it survives retention pruning, which is that DB's whole
  argument — but it is more work and inherits the DB's availability problem.
  Revisit if the summariser measures slow.

Whichever, the summary carries its **window** the way `FlakeReport` already does
(`windowRuns` / `windowCap`). A headline computed over "everything ever" is
unbounded and silently changes meaning as history grows.

**Visual diff rides the same summariser** rather than growing a second mechanism:
`changedSteps` gives a free headline, but which steps changed and by how much is
the same per-run-replay problem one notch cheaper.

---

## 3. The board — verdict band + compact tiles

A full-width `Verdict` ("Two categories need attention, four are clean, and one
has never been measured") over a row of small tiles carrying name, number and
unit. It is the option that reads without being read, which is the argument
already written into `stats-view.tsx` for why the chart comes before the numbers.

### 3.1 The band counts categories, never merges their units

**This is the condition the choice ships under.** Categories are not
commensurable: fourteen unaccepted a11y steps, three flaky tests and nine healed
locators are different units. Any treatment that puts them on a shared scale — a
stacked bar of category volume, a single "health score", a 0–100 index — is a lie
that looks like information.

The band is the easiest place in the design to introduce one. So:

- The band's sentence counts **categories in a state** ("two need attention"),
  never a total across categories.
- No number in the band is derived from more than one category's data.
- **`check:stats-categories` enforces it** (§8): the band's copy is built from a
  counting function over category states, and nothing in `renderer/main/stats/`
  may compute a cross-category sum, mean or score.

A category that has **never been measured is counted separately** in the band and
is never folded into "clean". That sentence is the four-state rule (§4) restated
at page level, and it is the reason the band says three things rather than two.

### 3.2 The two treatments that were not chosen

- **Instrument grid** — a grid of `Panel` tiles, each with a big number, a tone
  chip, a sentence and a sparkline. Most legible per tile and the only one with
  room to say what a number *means*; costs the most vertical space, and at seven
  categories it is most of a screen before anything else begins. **Still used —
  as the header block inside a category dashboard**, where there is one subject
  and room to explain it.
- **Status ledger** — one `Panel`, one row per category, fixed columns with the
  78px chip giving the column one edge. Densest, scales furthest, and closest to
  what the batch checklist already looks like. Rejected for the board; it is the
  right shape for a *list of tests within* a category, so it will reappear one
  level down.

---

## 4. Empty, unmeasured, and unavailable are three different things

The rule I would not trade away, and it is already written into this codebase —
`a11y-panel.tsx` opens with *"never let 'found nothing' and 'measured nothing'
render the same"*, and every `metrics:*` response carries `available` for the same
reason.

Every category tile has **four** states, and they must be visually distinct:

| State | Means | Tile reads |
|---|---|---|
| **Measured, clean** | The check ran and found nothing | phosphor, `0`, "12 runs checked" |
| **Measured, findings** | The check ran and found things | tone matching what it found, the count, what it is |
| **Never measured** | The feature is off, or has never run with it on | neutral, **no number at all**, "Not checked — turn on Check accessibility" |
| **Unavailable** | The mechanism cannot report (metrics DB absent, replay pruned) | neutral, no number, "Metrics are unavailable on this runtime" |

A category showing `0` when the truth is "never ran" is the single worst outcome
this feature can produce: a confident, wrong, all-clear.

---

## 5. Navigation — real routes

```
/stats                              the board
/stats/$category                    a category dashboard
/stats/$category/$facet             a leaf (severity, verdict, cluster…)
/stats/$category/$facet/$value      reserved; see §9 open question
```

The router uses `createMemoryHistory()`, so there is no address bar — but it is
still a real history stack.

- Back and forward are the router's own.

  > **Corrected while building this.** An earlier draft of this section said
  > "⌘[ / ⌘] work", which was simply false: with memory history there is no
  > browser history behind the router, the window's own navigation gestures move
  > nothing, and **nothing in the app was wired to `router.history` at all.** It
  > had never mattered, because every screen was one level deep and the rail
  > selected among them — a drill-down is the first thing in this app with
  > somewhere to go back *to*. So the controls are part of the work rather than
  > a property inherited from it: `HistoryNav` in `app-strip.tsx` puts Back and
  > Forward in the top strip and binds ⌘[ / ⌘].
  >
  > **Back is not the breadcrumb**, and the difference is the reason both exist.
  > The trail goes UP — to the parent of what is on screen. Back returns to where
  > you came FROM. They coincide while you descend and stop the moment you leave:
  > drill to a stability verdict, open the failing test, and "up" is Home while
  > "back" is the verdict you were reading.
- The **top-strip breadcrumb already exists and is already the app's
  "where you are" surface**. `app-strip.tsx` builds it from the location;
  extending it to `Home / Stats / Accessibility / Severity` is about fifteen
  lines and introduces no new vocabulary.
- Drilling out to a real object (a test, a run) and coming back lands on the leaf
  you left, for free.
- The browser preview can open a leaf directly, which is how a reviewer sees it
  without clicking three times.

**Cost, and it is real:** route params are strings from history and need
validating against the registry. An unknown category renders an explained empty
state, never a crash and never a blank page.

**Rejected: a drill stack inside the view.** `stats-view.tsx` holding
`frames: Frame[]` and drawing its own Back button costs nothing and is trivially
testable — but it builds a second where-you-are indicator while the top strip
keeps saying "Stats" three levels down, re-entering Stats from the rail silently
resets the trail, and drilling out to a test loses it entirely. A hybrid (route
for the category, local frames below it) is worse than either: back would mean
two different things at two different depths.

---

## 6. What a dashboard and a leaf owe the user

**Every leaf must exit to a real object.** The failure mode of a drill-down
hierarchy is a beautifully broken-down number you cannot act on. From a severity
breakdown the user reaches the test, the run and the step. In the mock, the rule
id is *not* the exit — the test is, because that is the object you can do
something to.

**Analytics here, operations there.** The app already has Heals and Visual as
top-level views in the rail. A category dashboard must not become a second Heals
screen. The line: **Stats answers "how much, how often, is it getting worse";
the existing views answer "what do I do about this one".** Every dashboard links
out; none of them carries an accept, revert or delete control. Enforced by
`check:stats-categories` (§8) rather than left as a convention.

**Scope survives the drill.** B7 puts a scope (`All tests ▾`) and a range
(`30 days ▾`) in the Stats header, governing the whole page. They persist across
every level of the trail and stay visible at every level — otherwise the user
drills into a number computed under one scope and reads it under another. This
argues for holding them in the route rather than in component state.

---

## 7. User-created categories — considered, not built

A category defined by the user from a natural-language prompt was raised and
**dropped**. Recorded because the reasoning outlives the decision.

If it ever returns, two things were already settled about how it would have to
work:

- **An LLM-authored category definition is untrusted input**, in the same class
  as page-captured steps and PR branch names. It cannot be generated code and it
  cannot be SQL — the MCP plan already rejects a SQL escape hatch in favour of
  curated tools, for this exact reason. It would have to be a **bounded spec**
  (source, filter, group, metric, window) that the app validates and executes
  itself, normalised by rebuilding rather than filtering, the way
  `normalizeRawStep` does.
- **The MCP's curated tool surface is the interesting direction** — `triage_run`,
  `compare_runs`, `get_browser_matrix`, `get_suite_cost`, `get_flake_report` are
  already a vetted, parameterised query vocabulary with no escape hatch. A user
  category expressed as *"one of these tools, with these arguments"* inherits
  every bound those tools already have, and needs no new grammar. That is the
  note worth keeping.

Nothing in this plan's design blocks it later: the category registry (§8) is a
list, and a second source of entries is an additive change.

---

## 8. Rules the implementation is held to

1. **Categories come from one registry.** `renderer/main/stats/categories.ts`
   exports the list; the board, the routes, the breadcrumb labels and the preview
   fixtures all read it. A category that exists in one place and not the others is
   the bug a registry makes impossible.
2. **The band counts, it does not score** (§3.1).
3. **Four states, and "never measured" carries no number** (§4).
4. **Stats reports; Heals and Visual act** (§6).
5. **Colour means outcome** (REDESIGN §3.1). A tile's tone reports what its
   number says. Selection and hover stay neutral — `check:selection-neutral`
   already enforces this and will see the new files.
6. **Every status chip is `STATUS_W`** — `check:status-width` sees them too.
   **No status hex in a stylesheet**; tones derive through `toneSurface()`.
7. **Charts are accessible without hover.** Radix tooltips cannot be opened in
   jsdom (CLAUDE.md), so every chart segment carries its reading in a `title`
   *and* the same numbers appear as text beside it. That is both an accessibility
   position and the only way the chart is testable.
8. **Aggregates state their window** — "Last 30 days · 42 runs" next to every
   headline, not in a footnote.
9. **The board fetches nothing a dashboard would not.** Tiles and dashboards
   share React Query keys, so drilling in is instant and drilling back is free.

---

## 9. Testing plan

### 9.1 Vitest — `dom` project

New: `renderer/main/stats/category-board.test.tsx`,
`stats-category-view.test.tsx`, one per dashboard as it lands.

- Board renders one tile per registry entry — asserted **against the registry**,
  not a hardcoded list, so adding a category without a tile fails.
- **The four states of §4 render differently.** Specifically: a category with zero
  findings and a category that was never measured produce different text, and the
  never-measured one contains no `0`. This is the test the whole rule exists for,
  so it is written first and **verified to fail** against a naive implementation.
- **The band's sentence counts states.** Given four clean, two with findings and
  one unmeasured, it says so — and there is no test that could pass by summing,
  because no sum is rendered.
- Clicking a tile calls `navigate` with the category route (mock `useNavigate`,
  the pattern `library-sidebar.test.tsx` and `ai-debug-chip.test.tsx` already use).
- Drill two deep, then back: the breadcrumb calls `history.back()` and the
  dashboard is on screen again.
- A route param that is not a known category renders an explained empty state.
- **Wait for content, not containers** (CLAUDE.md): assert on tiles, never on the
  board element, or the test passes against an unresolved query.

### 9.2 Vitest — `node` project

`renderer/lib/*.test.ts` runs in the node project, so any pure fold that stays
renderer-side is unit-tested there directly — category summarising, tone
selection, state classification, window arithmetic, and the band's counting
function.

The a11y rollup (§2.1) lives in `shared/a11y-rollup.mjs` and gets a
`check:a11y-rollup` script, the way `check:flake-analysis` and
`check:step-insights` already cover their `shared/` counterparts.

### 9.3 A new `check:` script — `check:stats-categories`

Source-level, `tsx`, no bundling. Pins what jsdom and type-check cannot see:

- every registry entry has a route registered, a breadcrumb label and a tile;
- every registry entry declares an `unmeasured` copy string — a category that
  cannot say "not checked" will eventually say `0` instead;
- **no cross-category arithmetic** anywhere under `renderer/main/stats/` (§3.1);
- **no mutation** — no `api.*.accept*`, `api.*.revert*`, `api.*.delete*`,
  `api.*.clear*` reachable from a Stats surface (§6).

**Verify it can fail** (CLAUDE.md's standing rule): delete a route, drop an
`unmeasured` string, add a cross-category sum, add a mutation call — four
deliberate breaks, four red runs, before it is trusted.

### 9.4 Existing tests

`stats-view.test.tsx` is updated through the B7 reskin (queries move when chrome
changes) and again when content relocates into Outcomes. **A parity PR may not
delete a test** (REDESIGN §8.1): filtering, pagination and the "filters do not
move the summary cards" assertions all still have to hold wherever their content
ends up.

### 9.5 Browser preview

`renderer/dev/preview-fixtures.ts` gains fixtures for the new a11y summary
channel, plus a11y-bearing replays so the severity leaf has something to draw.
Per REDESIGN §8.4, each PR carries screenshots at 1440 / 1024 / 800, a
console-clean check, and an **empty `window.__preview.misses`** — a miss renders
as an empty state and reads as real data, which on this feature is the §4 bug
arriving through the back door.

### 9.6 Not e2e

Nothing here moves, sizes or stacks a window, so `e2e/` gains nothing. If the
board later becomes a rail-context surface the way Settings is, that changes.

---

## 10. PR sequence

| # | PR | Contains | Size |
|---|---|---|---|
| 1 ✅ | **B7 — Stats parity reskin** | `stats-view.tsx` + `flake-panel`, `suite-cost-panel`, `step-health-panel`, `divergence-panel` onto the theme layer. Same behaviour, new chrome. Page-level scope + range in the header. Existing tests migrated, none deleted. | 2–4 days |
| 2 ✅ | Registry + board + routes | `categories.ts`, the verdict band and tiles, the four states, `/stats/$category`, breadcrumb extension in `app-strip.tsx`, param validation, `check:stats-categories`. Two dashboards land with it — **Stability** and **Auto-Heal**, both already suite-aggregated. Tiles for unbuilt dashboards state why rather than dead-linking. | 2 days |
| 3 | Outcomes + landing | Chart, KPIs, run table and log search become the Outcomes category; the landing becomes the board. REDESIGN §B7 rewritten in this PR. | 1–2 days |
| 4 | a11y summariser + severity drill | `shared/a11y-rollup.mjs` + `.d.mts`, one IPC, `check:a11y-rollup`, the a11y dashboard and the severity leaf — the ask's worked example. | 2 days |
| 5 | Visual diff + Speed & cost + Step health | Riding PR 4's summariser and the existing metrics queries. Step health and Speed carry the metrics-DB unavailable state. | 1–2 days |

Each is independently shippable and leaves the board honest about what it cannot
yet show.

---

## 11. Open questions

1. **How deep does the trail go?** Three levels (board → category → leaf) covers
   the ask. A fourth — severity → rule → the steps that violate it — is where the
   a11y data actually stops, and the route shape reserves it. Decide in PR 4.
2. **Does the scope/range live in the route or in a store?** §6 argues for the
   route; memory history makes that invisible to the user either way. Decide in
   PR 1, since B7 introduces the controls.
3. **Do Cost and Report (REDESIGN §6.4, §6.5) become categories?** They fit the
   pattern, but Cost needs two user-visible assumptions (cost per CI minute,
   minutes per manual run) and Report is an emit surface, not an analysis. Both
   are Phase C and neither blocks this.
