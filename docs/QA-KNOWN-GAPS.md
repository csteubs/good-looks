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
| **Stats → Report mode** | No report mode, no weekly digest, no PDF of a run or routine run, no public link, no channel list. **Narrowed 2026-08-21:** the format exports DO exist — see the row below. Note the one PDF in the app is the AI insights report (`insights:exportPdf`); there is none for a run. | Stats |
| ~~**Emit adapters**~~ | ~~None of the five emitters (JUnit XML, GitHub Actions annotations, OTLP JSON, ticket markdown, NDJSON/CSV of step metrics).~~ **Built 2026-08-12** — five formats over six `EMITTERS` rows in `shared/emitters.mjs`, pure and redacted, wired to `report:emit` and rendered by the Export panel under Cost in Stats. This row was stale from the day it was written; corrected 2026-08-21. **What is genuinely absent is a non-interactive destination:** `emitReport` opens a save dialog, so no scheduled routine, headless run or CI job can produce a file. | Stats → Report |
| **Routines / Batch v2** | Batch is still a single implicit checklist. No saved named configurations, no schedules, no flow builder. The nav still reads "Batch". | [ROUTINES.md](ROUTINES.md) |
| ~~**Test groups / folders**~~ | ~~The library rail is flat.~~ **Built 2026-08-14** — folder rows with expand/collapse, a monogram, a count and an aggregate verdict, plus `run_group` over MCP. | Library rail |
| **Capture parity (MCP)** | `replay.json` is not produced, so captured app state is not a frame series. | Visual tab |

## 2. Built, deliberately partial

~~**Stats — the category board opens two of seven.**~~ **All seven open as of
2026-08-14.** Outcomes, Accessibility, Visual diff, Speed & cost and Step health
each have a dashboard and a leaf below it; no tile is disabled and no route
lands on "isn't built yet". Two notes for testing it:

- **Outcomes' content MOVED off the Stats landing.** The chart, the four KPI
  cards and capture overhead are in the category now, not on both screens. The
  run-history table, its filters and log search deliberately STAYED on the
  landing — that is a run explorer, not a category breakdown.
- **Step health's three findings and Accessibility's four severities overlap.**
  A step counted under two of them is intended, and both screens say so. Facet
  counts adding up to more than the headline is not a bug.

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

**A "retry" in the run-state summaries usually means two separate runs.** Retries
are opt-in (R24) and off unless asked for, so most recoveries are a failed run
followed by a passing one rather than two attempts inside one. Both are real and
the panel tells them apart: a within-run retry says so and claims flake outright
(one process, one browser, one commit — nothing could have differed), while a
cross-run one compares the two records. **What the cross-run reading can say
depends on evidence recorded at run time.** Runs carry a digest of what they
executed as of 2026-09-13, so the app can distinguish "nothing was different" from
"the test changed" — but only where both runs have one. Two runs recorded before
that date compare as unknown, and the panel says so ("Whether the test itself
changed is not recorded for these two runs"). That string is correct behaviour,
not a missing feature; a test needs two fresh runs before the stronger readings
are reachable.

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
- ~~Locator uniqueness feedback in the recorder.~~ Built 2026-08-19: `renderer/lib/locator-grade.ts` grades every stored locator, risky tiers get a row glyph (button into Refine where wired) and the detail view rolls up positional counts.
- The six run states in test detail, and the run summary opening cold on a test
  that has not run this session.
- Visual: Wipe, Blink, the frame rail's diff percentages and the "changed only"
  filter.
- Cost mode's arithmetic against a suite you know the shape of.
- The trainer panel's docking and its behaviour in a narrow window.
