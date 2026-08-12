# Known gaps — for the QA pass of 2026-08-12

Everything on this page is **already known** and should **not** be filed as a
bug. It exists so the bug list that comes out of the pass is a list of things
nobody knew about.

Read the three sections differently:

- **§1 Not built** — the feature does not exist. Filing "X is missing" tells us
  nothing we have not already written down.
- **§2 Built, deliberately partial** — the feature is on screen and works, but a
  named part of it is not there yet.
- **§3 Deliberate absences** — these look like defects and are decisions, each
  with a rationale in [DECISIONS.md](DECISIONS.md). If you disagree with one,
  that is a *design* argument worth having — raise it as a discussion, not a
  defect.

**§4 is the important one:** places where the design document and the shipped
app genuinely disagree. Testing against the plan rather than the app will
produce false bugs there.

Everything not named on this page is fair game.

Baseline for this pass: `main` at `bdda77d`, gate fully green — lint,
type-check, 141 test files / 2764 Vitest tests, 56 `check:*` scripts.

---

## 1. Not built

| Area | What's absent | Where it would live |
|---|---|---|
| **Job ticker** | The top strip has no live run readout. One run, several runs, a batch, a failure and idle all show nothing. | `top-strip.tsx`'s `ticker` slot — passed nothing on purpose ([app-strip.tsx:252](renderer/main/app-strip.tsx:252)) |
| **Stats → Report mode** | No report mode, no weekly digest, no exports (PDF / CSV / JUnit XML / public link), no channel list. | Stats |
| **Emit adapters** | None of the five emitters (JUnit XML, GitHub Actions annotations, OTLP JSON, ticket markdown, NDJSON/CSV of step metrics). | Would ship with Report mode |
| **Routines / Batch v2** | Batch is still a single implicit checklist. No saved named configurations, no schedules, no flow builder. The nav still reads "Batch". | [ROUTINES.md](ROUTINES.md) |
| **Test groups / folders** | The library rail is flat. No group rows, no expand/collapse, no aggregate verdict. | Library rail |
| **Capture parity (MCP)** | `replay.json` is not produced, so captured app state is not a frame series. | Visual tab |

## 2. Built, deliberately partial

**Stats — the category board opens two of seven.** The board renders all seven
categories so the map is complete, but only **Stability** and **Auto-Heal** have
dashboards ([stats-category-view.tsx:43](renderer/main/stats/stats-category-view.tsx:43)).
The other five — Outcomes, Accessibility, Visual diff, Speed & cost, Step health
— render as tiles that state why they do not open, and their tile still carries
a real headline number. This is intended: a tile that navigates to an empty
screen is worse than one that says "not yet".

- Reaching one of those five by **typing the route** lands on a panel explaining
  the dashboard isn't built. Also intended — not a broken route.
- **Outcomes is on the board but its content is still the Stats landing page**
  (chart, KPIs, run table, log search). It moves into the category in a later
  PR. Both surfaces existing at once is expected right now.

**Stats has no page-level scope or range control.** The header does not carry
`All tests ▾` / `30 days ▾`. Deferred deliberately: the flake and metrics
handlers do not take a time window, so the control would scope half the page and
misreport the other half. The run table's own test filter is a different,
working control — that one is in scope.

**Visual — "what moved" and drift are not on this build.** The region breakdown
and the per-frame drift view are written and tested but sit on an unmerged
branch, so they are not in what you are testing. Wipe, Blink, the frame rail
with diff percentages, the masks manager, threshold-against-frames and baseline
provenance **are** all present and in scope.

## 3. Deliberate absences that look like bugs

**Baseline provenance shows five fields, not eight.** Commit, who accepted, and
viewport are absent because this app has no access to them — nothing reads the
user's repository, it is a single-user app with no identity, and a test can
resize mid-run so there is no single viewport. What ships is the run, when it
was pinned, the engine, headed/headless, and element-scoping — plus **"run since
pruned"** when retention has removed the run a baseline came from. That string
is correct behaviour, not a rendering fault.

**Cost mode never shows a currency symbol, and its two inputs do not persist.**
Both intended. The rate is in whatever currency the user thinks in and the app
is never told which; the inputs are a lens, not a preference. Cost also reports
*time* avoided rather than money avoided — converting would need an hourly rate
the app has no business guessing.

**"Failures caught", not "regressions caught."** Whether a failure was a
regression, a broken test or flake is what triage answers. The wording is exact.

**Every run is one attempt.** The runner configures no Playwright retries, so a
"retry" in the run-state summaries means two separate runs, not two attempts.

**The boot plate is skippable but does not say so.** Any key or click dismisses
it. The absence of a visible "Skip" is deliberate. It also covers a fully
mounted, interactive app rather than delaying it, and it is inert to the
pointer — clicks land on the plate, not the app beneath.

**Dark theme only.** The Appearance pane says "Dark only for now." There is no
light theme to test.

**Reduced motion changes Blink rather than disabling it.** With reduced motion
on, Blink becomes a manual frame toggle at the user's own pace, and the boot
plate runs 900ms instead of 2.6s with its fill rule drawn full and still. Both
are the intended reduced-motion behaviour, not a broken animation.

## 4. Where the design document disagrees with the app

**`docs/REDESIGN.md` §0 lists four appearance settings that did not ship.** CRT
overlay, ambient motion, code & step colours and change temp are named there as
shipping knobs. **None of the four exists in Settings** — there is no key for any
of them in `RecorderSettings`. What actually shipped in Appearance is: Theme
(dark only), Font size, Typeface, AI thinking gif, Home screen animation, and
fetch-site-icons-from-the-web.

Consequences for testing:

- The CRT treatment is always on for captured frames and is not user-toggleable.
- Ambient motion follows `prefers-reduced-motion` only — there is no in-app
  motion preference to exercise.
- Change temp renders (it reads real medians per test and per step) but has no
  user control over its mode.
- **Typeface is the inverse case**: the plan calls it fixed at the design
  default, and it shipped as a real setting.

Do not file the four missing knobs as bugs, and do not treat the plan's §0 table
as the spec for Appearance. Whether they *should* ship is an open product
question, not a defect.

**`docs/plans/` is historical.** Those documents record intent at the time they
were written; several proposals in them were changed or dropped during
implementation. Do not test against them. For current behaviour read
[ARCHITECTURE.md](ARCHITECTURE.md); for what landed and why, read
[DECISIONS.md](DECISIONS.md).

---

## What is fair game

Everything else, and in particular the surfaces that changed most recently and
have had the least real-world use:

- The step composer opening inline at the insert cursor, in both the main window
  and the trainer panel.
- The ⌘K command palette — especially **which row lands first**, since that is
  the only thing that matters about a palette.
- The training browser's URL bar and the URL assertion's default.
- Locator uniqueness feedback in the recorder.
- The six run states in test detail, and the run summary opening cold on a test
  that has not run this session.
- Visual: Wipe, Blink, the frame rail's diff percentages and the "changed only"
  filter.
- Cost mode's arithmetic against a suite you know the shape of.
- The trainer panel's docking and its behaviour in a narrow window.
