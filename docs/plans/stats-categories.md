# Stats categories — a browsable board and its drill-downs

Written 2026-08-10, against `claude/stats-category-components-5k95rt`.

> **Status: options, not decisions.** This document exists to be argued with.
> Everything in §3–§7 is presented as alternatives with a recommendation; §8
> (the rules) and §9 (testing) are the parts I would hold to whichever way the
> options go. Nothing here is built yet.

**The ask.** Stats grows a component that reports across overall *categories* —
accessibility, visual diff, stability, Auto-Heal, and so on. Clicking a category
replaces the view with that category's own dashboard. From inside a dashboard,
clicking a chart drills again — the example given was an a11y severity chart
opening a breakdown of severity types and their insights — and the user can go
forward and back through that trail.

Companion documents: [REDESIGN.md](../REDESIGN.md) (§B7 is the Stats reskin this
lands next to), [ARCHITECTURE.md](../ARCHITECTURE.md), [DECISIONS.md](../DECISIONS.md).

---

## 1. Where this lands relative to work already planned

`docs/REDESIGN.md` §B7 already schedules a **parity reskin of Stats** — the
existing chart, KPIs, capture overhead, stability, log search and run table
moved onto `Panel` / `Segmented` / `StatusChip` / `Temp`, with two structural
moves (a page-level scope + range stated once in the header, and two new row
kinds in the run table). It also schedules two Phase C modes for the same
screen: **Cost** (§6.4) and **Report** (§6.5).

This feature is a third thing, and it partly *subsumes* B7's plan: a category
board with per-category dashboards is a different information architecture from
"one long page in three modes". The sequencing question in §6 below is really
"does the board replace B7's page, sit above it, or wait for it".

The relevant fact about today's tree: **Phase A is complete and Phase B has not
started.** `stats-view.tsx` is still SDK chrome (`Toolbar`, `Table`, `Badge`,
`Text`, `Select`). Every primitive this feature would be drawn with exists and is
tested, but nothing in Stats reads them yet.

---

## 2. What data actually exists, per category

This is the constraint that shapes everything else, so it comes first. **Three
categories are already aggregated suite-wide. Three are computable renderer-side
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

### 2.1 The a11y severity drill is the one that needs new plumbing

The ask's worked example — "clicking a severity level chart in the a11y
component shows a breakdown of severity types and their insights" — is the one
drill whose data does not exist in aggregate form. `impact` is
`"minor" | "moderate" | "serious" | "critical"` on each `A11yViolation`, and
violations live inside `replay.json` per run, per step.

Three ways to get it, in increasing order of cost and durability:

- **E1 — renderer fan-out.** `artifacts.list()`, then `getReplay` for each run.
  N IPC round trips and N JSON parses on the main thread for a screen that is
  supposed to load at a glance. Fine for a demo with 12 runs, wrong at 200.
  *Not recommended.*
- **E2 — a backend summariser, with the arithmetic in `shared/`.** One new IPC
  (`stats:a11ySummary` or a single `stats:categories`), reading the replay files
  it already knows how to read, folding to counts by impact / rule / test /
  window. The pure fold goes in `shared/a11y-rollup.mjs` + `.d.mts` so the MCP
  can expose the same numbers later without a transcribed copy — which is
  exactly what CLAUDE.md says `shared/` is for. **Recommended.**
- **E3 — a metrics-DB table.** An `a11y_violations` rollup alongside
  `step_metrics`. Best long-term (it survives retention pruning, which is the
  whole argument for that DB) and the most work. It also inherits the DB's
  degradation rule: when `node:sqlite` is unavailable the category has to say
  "unavailable", not "none found". Worth doing *if* E2 measures slow.

Whichever, the summary must carry its **window** the way `FlakeReport` already
does (`windowRuns` / `windowCap`). A category headline computed over "everything
ever" is unbounded and silently changes meaning as history grows.

### 2.2 Visual diff has the same shape, one notch cheaper

`RunReplaySummary.changedSteps` gives a suite-wide headline with no new IPC. But
*which* steps changed, and by how much, is again per-run replay JSON. If a11y
gets E2, visual should ride the same summariser rather than growing a second
mechanism.

---

## 3. Navigation model — three options

The router uses `createMemoryHistory()`. There is no address bar, so "the URL" is
only ever an internal addressing scheme — but it is still a real history stack
with back/forward.

### N1 — Real routes, real history *(recommended)*

```
/stats                              the board
/stats/$category                    a category dashboard
/stats/$category/$facet             a leaf (severity, verdict, cluster…)
/stats/$category/$facet/$value      optional fourth level
```

- Back/forward are the router's own, so ⌘[ / ⌘] and any future gesture work.
- The **top strip breadcrumb already exists and is already the app's
  "where you are" surface** — `app-strip.tsx` builds it from the location.
  Extending it to `Home / Stats / Accessibility / Severity` is ~15 lines and no
  new vocabulary.
- Drilling out to a real object (a test, a run) and coming back lands on the leaf
  you left, for free.
- The browser preview can open a leaf directly (`?view=stats&path=a11y/severity`),
  which is how a reviewer looks at it without clicking three times.
- Costs: route params are strings from history and need validating against the
  registry (an unknown category must render "no such category", not crash); and
  `app-strip.tsx` gains knowledge of one more route shape.

### N2 — An in-view drill stack

`stats-view.tsx` holds `frames: Frame[]`, pushes on drill, pops on a Back button
it draws itself.

- No router changes, no param validation, trivially testable.
- But it builds a **second** back affordance and a **second** where-you-am
  indicator in an app that already has one at the top of the window, and the top
  strip would keep saying "Stats" three levels deep. The redesign's stated ethos
  is one surface per job.
- Re-entering Stats from the rail silently resets the trail, with nothing on
  screen explaining why.
- Drilling out to a test and coming back loses everything.

### N3 — Hybrid (route for the category, local frames below)

Rejected. Back would mean two different things at two different depths, which is
the worst property a back button can have.

> **Recommendation: N1.** The one real cost is param validation, and that is a
> registry lookup with a fallback.

---

## 4. The board component — three options

All three are drawn from the same vocabulary (`Panel`, `StatusChip`, `Verdict`,
mono uppercase labels, hairlines, zero radius) and all three are keyboard-
operable real `<button>`s.

**The constraint that rules out the obvious design first:** *categories are not
commensurable.* Fourteen unaccepted a11y steps, three flaky tests, and nine
healed locators are different units. Any treatment that puts them on a shared
scale — a stacked bar of category volumes, a single "health score" — is a lie
that looks like information. Each tile owns its own unit, and the only thing
shared across tiles is the **tone**.

### B-A — Instrument grid

A responsive grid of `Panel` tiles, 2×4 / 3×3 depending on breakpoint. Each:
32px header with the category name and a `StatusChip` at `--gl-status-w`; body
with one headline number in Space Grotesk at ~26px, one line of `Verdict`-style
sans explaining what it means, and a 7-day sparkline or micro-bar.

- Most legible per tile, most room for the "what this means" sentence, most
  faithful to the mockup's panel-heavy screens.
- Costs vertical space; at eight categories it is most of a screen before the
  existing content starts.

### B-B — Status ledger

One `Panel` titled `CATEGORIES`, one row per category, fixed columns:
`name · StatusChip(78px) · headline · trend · window · ›`.

- The column of chips has one edge, which is the design's most repeated move,
  and it is what the batch checklist and the run table already look like.
- Scales to ten categories without paging; densest; scans fastest once learned.
- Least room for a sentence — the "what it means" has to fit in ~40 characters
  or move into the dashboard.

### B-C — Verdict band + compact tiles

A full-width `Verdict` at the top ("Two categories need attention"), then a row
of small tiles that carry only name + chip + number.

- Best "read without reading" — matches the argument already written into
  `stats-view.tsx` for why the chart comes first.
- The band is a synthesis across incommensurable things, which is exactly what
  §4's constraint warns about. It survives only if the band counts *categories in
  a state*, never merges their units.

> **Recommendation: B-B for the board, B-A's tile as the dashboard's own header
> block.** The ledger is what the design does with a list of statuses; the big
> tile is what it does with one subject. Using each where it belongs avoids
> choosing.

---

## 5. Empty, unmeasured, and unavailable are three different things

This is the rule I would not trade away, and it is already written into this
codebase — `a11y-panel.tsx` opens with *"never let 'found nothing' and
'measured nothing' render the same"*, and every `metrics:*` response carries
`available` for the same reason.

Every category tile has **four** states, and they must be visually distinct:

| State | Means | Tile reads |
|---|---|---|
| **Measured, clean** | The check ran and found nothing | phosphor chip, `0`, "12 runs checked" |
| **Measured, findings** | The check ran and found things | tone chip, the count, what it is |
| **Never measured** | The feature is off, or has never run with it on | neutral chip, **no number at all**, "Not checked — turn on Check accessibility" |
| **Unavailable** | The mechanism cannot report (metrics DB absent, replay pruned) | neutral chip, no number, "Metrics are unavailable on this runtime" |

A category showing `0` when the truth is "never ran" is the single worst
outcome this feature can produce: it is a confident, wrong, all-clear.

---

## 6. Where the board sits — three options

### W1 — The board replaces the Stats landing

`/stats` is the board and nothing else. Today's chart, KPI cards, capture
overhead, stability, cost, step health, log search and run table are distributed
into `/stats/outcomes`, `/stats/stability`, `/stats/speed`.

- Cleanest IA; every screen answers one question.
- **Real regression risk:** the run-history table and the raw-log search are the
  most-used things on this page today and would each be one click further away.
  Mitigate by making Outcomes the first tile *and* keeping log search on the
  board itself (it is a search, not a category).

### W2 — Board on top, existing page unchanged below

Ship the board as a new component above what is already there; clicking still
navigates to a dashboard.

- Smallest, safest first PR; nothing moves; the board can be evaluated in the
  real app before anything is rearranged.
- The landing then says most things twice, and the duplication is permanent
  unless a follow-up removes it.

### W3 — Board only after B7

Do the parity reskin first, then build the board on the reskinned page.

- Avoids reskinning surfaces twice.
- Delays everything behind a separate ~3-day piece of work, and B7's own plan
  would need rewriting anyway if the board lands (§1).

> **Recommendation: W2 as PR 1, W1 as PR 3** — board added, evaluated on screen,
> then the landing rearranged once the dashboards it points at actually exist.
> Shipping W1 first means the day the board lands, half its tiles lead to
> screens that are not built.

---

## 7. What a dashboard and a leaf owe the user

**Every leaf must exit to a real object.** The failure mode of a drill-down
hierarchy is a beautifully broken-down number that you cannot act on. From a
severity breakdown, the user must be able to reach the test, the run, and the
step. Concretely: every leaf row carries a navigation to `/test/$id`, to the
Visual view for that run, or to `/heals` — the operational screens that already
exist.

**Analytics here, operations there.** The app already has Heals and Visual as
top-level views in the rail. A category dashboard must not become a second Heals
screen. The line I would draw: **Stats answers "how much, how often, is it
getting worse"; the existing views answer "what do I do about this one".** Every
dashboard links out; none of them duplicates an accept/revert control.

**Scope survives the drill.** REDESIGN §B7 puts a scope (`All tests ▾`) and a
range (`30 days ▾`) in the Stats header, governing the whole page. If those
exist, they must persist across every level of the trail and be visible at every
level — otherwise the user drills into a number computed under one scope and
reads it under another. This argues for putting them in the route or a
`SearchParams`-shaped store rather than component state.

---

## 8. Rules the implementation is held to

1. **Categories come from one registry.** `renderer/main/stats/categories.ts`
   exports the list; the board, the routes, the breadcrumb labels and the
   preview fixtures all read it. A category that exists in one place and not the
   others is the bug a registry makes impossible.
2. **Colour means outcome** (REDESIGN §3.1). A tile's tone reports what the
   number says. Selection and hover stay neutral — `check:selection-neutral`
   already enforces this and will see the new files.
3. **Every status chip is `STATUS_W`** — `check:status-width` sees them too.
4. **No status hex in a stylesheet**; tones derive through `toneSurface()`.
5. **Charts are accessible without hover.** Radix tooltips cannot be opened in
   jsdom (CLAUDE.md), so every chart segment carries its reading in a `title`
   *and* the same numbers appear in a text list below it. That is both an a11y
   position and the only way the chart is testable.
6. **Aggregates state their window.** "Over the last 30 days · 42 runs" next to
   every headline, not in a footnote.
7. **Nothing new is fetched on the board that a dashboard would fetch anyway** —
   the board's tiles and the dashboards share React Query keys, so drilling in
   is instant and drilling back is free.

---

## 9. Testing plan

### 9.1 Vitest — `dom` project

New: `renderer/main/stats/category-board.test.tsx`,
`stats-category-view.test.tsx`, one per dashboard as it lands.

- Board renders one row/tile per registry entry — asserted **against the
  registry**, not a hardcoded list, so adding a category without a tile fails.
- **The four states of §5 render differently.** Specifically: a category with
  zero findings and a category that was never measured produce different text,
  and the never-measured one contains no `0`. This is the test that would have
  caught the bug the whole rule exists to prevent, so write it first and verify
  it fails against a naive implementation.
- Clicking a tile calls `navigate` with the category route (mock
  `useNavigate`, the pattern `library-sidebar.test.tsx` and `ai-debug-chip.test.tsx`
  already use).
- Drill two deep, then back: the leaf's own breadcrumb/back calls
  `router.history.back()` and the dashboard is on screen again.
- A route param that is not a known category renders an explained empty state.
- **Wait for content, not containers** (CLAUDE.md): assert on rows, never on the
  board element, or the test passes against an unresolved query.

### 9.2 Vitest — `node` project

`renderer/lib/*.test.ts` runs in the node project, so any pure fold that stays
renderer-side is unit-tested there directly (category summarising, tone
selection, window arithmetic).

If §2.1 lands E2, the fold lives in `shared/a11y-rollup.mjs` and gets a
`check:a11y-rollup` script the way `check:flake-analysis` and
`check:step-insights` already cover their `shared/` counterparts.

### 9.3 A new `check:` script — `check:stats-categories`

Source-level, `tsx`, no bundling. Pins the things jsdom and type-check cannot
see:

- every registry entry has a route registered, a label in the breadcrumb map,
  and a tile component;
- every registry entry declares an `unmeasured` copy string (§5) — a category
  that cannot say "not checked" will eventually say `0` instead;
- no dashboard renders an accept/revert/destructive mutation (§7's line between
  analytics and operations), enforced as "no `api.*.accept*` / `api.*.revert` /
  `api.*.delete*` import under `renderer/main/stats/`).

**Verify it can fail** (CLAUDE.md's standing rule): delete a route, drop an
`unmeasured` string, add a mutation call — three deliberate breaks, three red
runs, before it is trusted.

### 9.4 Existing tests

`stats-view.test.tsx` is 100% preserved under W2 (nothing moves) and updated
under W1 as content relocates. **A parity PR may not delete a test**
(REDESIGN §8.1) — filtering, pagination and the "filters do not move the summary
cards" assertions all still have to hold wherever their content ends up.

### 9.5 Browser preview

`renderer/dev/preview-fixtures.ts` gains fixtures for whatever new channel §2.1
introduces, plus a11y-bearing replays so the severity leaf has something to draw.
Per REDESIGN §8.4, each PR carries screenshots at 1440 / 1024 / 800, a
console-clean check, and an **empty `window.__preview.misses`** — a miss renders
as an empty state and reads as real data, which on this feature is the §5 bug
arriving through the back door.

### 9.6 Not e2e

Nothing here moves, sizes or stacks a window, so `e2e/` gains nothing. If the
board later becomes a rail-context surface the way Settings is, that changes.

---

## 10. Suggested PR sequence

| # | PR | Contains | Size |
|---|---|---|---|
| 1 | Registry + board | `categories.ts`, the board component, the four states, `check:stats-categories`, board tests. Added above today's page (W2). Tiles for unbuilt dashboards are disabled with a stated reason rather than dead links. | 1–2 days |
| 2 | Routes + trail | `/stats/$category`, breadcrumb extension in `app-strip.tsx`, param validation, back/forward tests, preview `?path=`. Two cheap dashboards land with it — Stability and Auto-Heal, both already suite-aggregated. | 1–2 days |
| 3 | Outcomes + landing rearrange (W1) | Today's chart/KPIs/run table/log search move into Outcomes; the landing becomes the board. `stats-view.test.tsx` migrated, not deleted. | 1–2 days |
| 4 | a11y summariser | `shared/a11y-rollup.mjs` + `.d.mts`, one IPC, `check:a11y-rollup`, the a11y dashboard and the severity leaf — the ask's worked example. | 2 days |
| 5 | Visual diff + Speed dashboards | Riding PR 4's summariser and the existing metrics queries. | 1–2 days |

PRs 1–3 are the feature; 4–5 are categories filling in. Each is independently
shippable and leaves the board honest about what it cannot yet show.

---

## 11. Open questions

Listed in the order they block work.

1. **Does the board replace the Stats landing, or sit above it?** (§6) The
   recommendation is "above first, replace in PR 3", but if the landing should
   never change, PR 3 comes off the list.
2. **Which categories ship, and is "Outcomes" one of them?** (§2) Folding
   today's chart + KPIs + run table into a category called Outcomes is what makes
   W1 coherent; keeping them on the landing forever is also defensible.
3. **Do Stability, Auto-Heal, Visual and a11y dashboards in Stats coexist with
   the Heals and Visual views in the rail** (§7), or is the long-term intent that
   those rail entries retire into Stats?
4. **Is the metrics DB allowed to be a hard dependency for any category?** Speed
   and Step health are gated on it today and degrade to "unavailable". A category
   that is permanently unavailable on a runtime without `node:sqlite` is honest
   but sad; the alternative is computing a weaker version from run records.
5. **How deep does the trail go?** Three levels (board → category → leaf) covers
   the ask. A fourth (severity → rule → the steps that violate it) is where the
   a11y data actually stops.
6. **Does this supersede REDESIGN §B7's page-level plan, or slot into it?** (§1)
   If it supersedes, B7's entry needs rewriting in the same PR that lands the
   board, and §6.4/§6.5 (Cost and Report modes) become two more categories rather
   than two more modes.
