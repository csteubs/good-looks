# The indie redesign — an implementation plan

**Status: not built.** This is a design document for landing the "Good Looks
indie redesign" in the app. Nothing described here exists yet. Where it says
"would", it means would.

Source of truth for the design: `Good Looks Redesign.dc.html` in
`Good Looks indie redesign.zip` — a 4,083-line interactive mockup covering eight
screens, five global overlays and twenty-two components. It was produced *from*
this repo's source (its own `github.md` names the file each screen was built
from), so it is a re-imagining of the app as it exists, not a greenfield sketch.

Companion documents: [ARCHITECTURE.md](ARCHITECTURE.md) for what exists
today, [DECISIONS.md](DECISIONS.md) for why it is shaped that way,
[ROUTINES.md](ROUTINES.md) for the one large feature already specified.

---

## 0. Settled decisions

Four questions were answered before this plan was written. They are premises,
not proposals.

| Decision | Choice |
|---|---|
| **Foundation** | A bespoke theme layer. New `renderer/theme/` with tokens and primitives; SDK components retired from redesigned surfaces (55 files import them today), kept only where structural or native (`SplitView`, native `Select`/`Menu`, `Tooltip`, `Toaster`). |
| **Sequencing** | Parity first. Phase A foundation → Phase B reskin each screen to *exact current functionality* → Phase C the redesign's new features as their own PRs. |
| **Theme** | Dark only, and say so. The light theme goes; the Appearance pane reads "Dark only for now". |
| **Appearance knobs** | Ship 4 of 8 as real settings — CRT overlay, Ambient motion, Code & step colors, Change temp. Fix texture / glitch / hover / typeface at the design's defaults. |
| **Defaults** | The mockup's **preview props** — what the file actually renders when opened — not the older fallbacks inside `appear()`. |
| **Favicons** | Generated monogram by default. Third-party favicon fetching is an off-by-default setting. |

The shipped default state, in full:

```
temp     tint       ← setting
crt      off        ← setting
motion   calm       ← setting, floored by prefers-reduced-motion
syntax   phosphor   ← setting
texture  ember      fixed — warm orange suspended in black
glitch   echo       fixed — ghosting
hover    sweep      fixed
typeface space      fixed — Space Mono + Space Grotesk
```

The rationale for each is in §11.

---

## 1. Why this is a rewrite of the chrome, not a restyle

The current renderer is ~24,900 lines across 91 non-test files, built on
`@glaze/core/components` — imported by 55 of them — plus Tailwind utilities over
the SDK's token set. The redesign is built on none of that.

The gap is not colour. It is the shape of every primitive:

- **Zero border radius, everywhere.** The SDK's controls are rounded by `cva`
  default. There is no token for "no radius" — it is a variant that does not
  exist.
- **Hairline 1px boxes as the only container.** No elevation, no shadow except
  on true overlays. `Panel` is `1px solid rgba(255,255,255,.08)` over `#0d1012`,
  with a 32px header at `rgba(255,255,255,.02)`.
- **Status is an inset 2px rail**, not a background or a border —
  `boxShadow: "inset 2px 0 0 <tone>"`. This is the single most repeated motif in
  the design (step rows, diff lines, verdict blocks, menu hover, risk rows) and
  it has no SDK equivalent.
- **Mono-first typography.** Mono at 9.5–13px with `.1em`–`.26em` tracking and
  uppercase for every label; sans appears only for prose paragraphs. (The
  mockup's inline styles all name IBM Plex, but the shipped pairing is Space —
  see §3.2.) The SDK's `Text` scale is sans-first.
- **Fixed-width status columns.** `STATUS_W = 78` — every status chip in the app
  is exactly 78px so a column of them has one edge. That is a layout contract, not
  a style.

Forcing this through class overrides on `cva` components is the failure mode this
repo has already been bitten by twice — `bg-muted` and the `border-token-*`
family both emitted *no CSS at all* and styled nothing for months
(DECISIONS 2026-08-06). A plausible-looking class and a real one are
indistinguishable in a `.tsx`, and `type-check` does not check SDK component
props. A bespoke layer whose tokens are our own declarations is the way to make
that class of bug impossible rather than merely guarded.

### What the SDK keeps

| Keep | Why |
|---|---|
| `SplitView` + `SidebarToggle` | Owns collapse persistence and the pinned toggle anchor. The redesign's rail is a restyle of this, not a replacement. |
| `Select` | Native-menu-backed. The redesign draws a `▾` box; the menu itself should stay native. |
| `Tooltip` / `TooltipProvider` | Positioning and dismissal are not worth rewriting. Restyle the content surface only. |
| `Toaster` / `toast` | Same. |
| `Dialog` shell | For focus trap and escape handling; the visible surface is ours. |

Everything else — `Button`, `Text`, `Switch`, `RadioGroup`, `FieldSet`,
`SidebarListItem`, `Card` — is replaced on redesigned surfaces.

---

## 2. Prerequisite: make the UI verifiable before rewriting it

> **Done, 2026-08-08.** `npm run dev:web` runs the whole renderer in a browser
> tab against fixtures. See DECISIONS for the four things the native WebView
> was providing for free that a tab is not. The rest of this section is the
> reasoning, kept because it is why the rest of the plan is shaped this way.

**This is the highest-leverage item in the plan and it is not design work.**

Today, seeing a UI change requires a human at the Glaze app: `npm run build`
publishes to one global slot outside the repo, shared by every branch and
worktree (DECISIONS 2026-08-07, "The testing bottleneck was never the test
suite"). A redesign is, by volume, almost entirely visual change. Landing 8
screens through a one-at-a-time manual build slot is the single biggest schedule
risk here, and it degrades quality directly: the checks that get skipped are the
visual ones.

`shell/electron` already solves this. It carries `"dev:web": "vite --open
/preview.html"` — the renderer running in an ordinary browser tab against a fake
backend, with three guards against silent fixture drift (unhandled channels
recorded on `window.__preview.misses`, a test that reads the channel list out of
`api.ts` and fails in both directions, and handlers annotated with the app's real
return types). `main` has none of it: no `renderer/dev/`, no `dev:web` script.

**Port `dev:web` to `main` first, as its own PR, before any redesign code.** It
is a known-good, already-reviewed mechanism. With it:

- Every screen can be opened, screenshotted and diffed in a browser by an agent,
  with no build slot involved.
- The redesign's own responsive behaviour (three breakpoints — `wide` ≥1280,
  `mid` ≥940, `narrow`) can be verified by resizing a viewport rather than by
  resizing a native window by hand.
- The `@media (prefers-reduced-motion)` path is testable.

Cost: roughly a day, mostly fixture-writing for channels `main` has that the
Electron branch's fixtures may not cover. It pays for itself in Phase B alone.

The Glaze-app verification step (CLAUDE.md, "Making a change" step 3) still
happens — `dev:web` cannot catch a broken IPC handler, a window that fails to
open, or native menu behaviour. It changes *how often* a native rebuild is the
only way to see something, from "every UI change" to "once per screen".

---

## 3. The design system

### 3.1 Tokens

Transcribed from the mockup's `T` object and the literals used alongside it.
These become CSS custom properties in `renderer/theme/tokens.css`, declared on
`:root` — real declarations, so `var()` reads are safe (the SDK's own VAR-SAFETY
rule).

```
--gl-ink        #08090a   app background
--gl-panel      #0d1012   panel fill
--gl-rail       #0a0c0d   sidebar / rail fill
--gl-black      #000000   consoles and captured-frame backing
--gl-line       rgba(255,255,255,.08)    primary hairline
--gl-line-2     rgba(255,255,255,.055)   secondary hairline
--gl-tx-1       #e9edee   primary text
--gl-tx-2       rgba(233,237,238,.72)
--gl-tx-3       rgba(233,237,238,.54)
--gl-phos       #6bff9e   pass / go
--gl-cyan       #35e0ff   running / live / focus
--gl-amber      #ffb43d   flaky / healed / caution
--gl-red        #ff4d61   fail / stop / danger
--gl-violet     #b98cff   AI-adjacent accents
--gl-status-w   78px      fixed status-chip width
```

Plus one gradient, `--gl-holo`:
`linear-gradient(100deg,#6bff9e,#35e0ff,#8f9bff,#ff7ad1,#ffd36b,#6bff9e)` at
`300% 100%`, parked at `38%` when at rest.

**Two rules the design states explicitly, and both are load-bearing:**

1. **Colour means outcome — pass, fail, flaky, running.** Selection therefore
   gets a *neutral* treatment: `background: rgba(255,255,255,.055)` plus
   `inset 0 0 0 1px rgba(255,255,255,.16)`. Selection must never be blue, green
   or any status hue, because it would compete with what the colour is
   reporting. Encode this as `SEL_ROW` / `SEL_BG` / `SEL_RING` constants and
   guard it (§10).
2. **AI is not a status, so it gets a treatment, not a colour** — the holo
   gradient, on borders and small marks only, never on a text fill. A gradient
   text fill costs contrast and legibility at 10px, and the design says so at
   the call site.

### 3.2 Typography

**Space Mono and Space Grotesk**, per the shipped defaults (§0). Every inline
style in the mockup names IBM Plex literally and the typeface switch works by CSS
substring match on that name; we take the resolved pairing directly into two
tokens instead:

```
--gl-mono  'Space Mono', ui-monospace, SFMono-Regular, Menlo, monospace
--gl-sans  'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif
```

**Self-host them.** The mockup pulls from `fonts.googleapis.com`. In a packaged
desktop app that is an outbound request on every launch, a blank-until-loaded
flash, and a hard failure offline. Bundle woff2 subsets with local `@font-face`
and no network fallback.

Two metric consequences of Space that the design accounts for, or should:

- **Space Mono is wide.** The mockup gives the letterspaced uppercase labels
  their room back: tracking drops from `.22em` to `.12em` whenever the Space
  pairing is active. Bake that into the label token rather than carrying a
  conditional — with the typeface fixed, there is only one value.
- **Space Mono ships 400 and 700 only.** The design uses 500 and 600 heavily
  (`600 9.5px` labels, `500 10.5px` rows). Those weights do not exist in the
  family, so the browser rounds or synthesises them and the careful three-step
  hierarchy collapses to two. That collapse *is* what the mockup renders, so it
  is the look that was chosen — but **map it explicitly** (500 → 400, 600 → 700)
  rather than depending on font-synthesis behaviour, which differs across
  engines and would make the Electron and Glaze shells disagree. Space Grotesk
  has real 400/500/600 and needs no mapping.

### 3.3 Primitives

`renderer/theme/primitives/` — each is a small, tested, presentational component.
Fifteen carry the whole design:

| Primitive | Contract |
|---|---|
| `Panel` | Bordered section, optional 32px header with uppercase title, dim `id` subtitle, right-slot. `pad`, `flex`, `bodyMax`. |
| `Btn` | Four tones: `go` (phosphor), `stop` (red), `ghost`, `ai` (holo border + hover fill). 30px, uppercase, `.16em`. |
| `StatusChip` | Fixed `STATUS_W`, grid-centred, `tone+"55"` border over `tone+"12"` fill. The `running` variant takes the holo border. |
| `Segmented` | Row of buttons in one hairline box; active takes `SEL_BG` + `SEL_RING`. Used ~12 times across the app. |
| `Temp` | A duration plus its deviation from that test's own median, in one of five modes. See §3.4. |
| `StepRow` | Number, glyph, type chip, description, `Temp`. Status as inset rail. |
| `TypeChip` | Step-type pill tinted from the active syntax theme. |
| `CRT` | Screenshot bezel. **Content inside is never treated** — no scanlines, no vignette, no tint. `z-index: 610` lifts it above the global overlay. Evidence must read exactly as the browser rendered it. |
| `Verdict` | Tone dot + sans sentence, for summary panels. |
| `KeyValue` | Two-column `label` / value grid, baseline-aligned. |
| `MenuItem` | Label plus a line stating the consequence; `danger` variant. |
| `SiteIcon` | Custom image → favicon → generated monogram. Never falls through to nothing. See §3.5. |
| `TagStack` | Overlapped icon stack + count, opening to an actionable menu. |
| `InsertGap` | The between-steps insert cursor: 7px at rest, 16px hovered, lit rule when active. |
| `Atmosphere` | The three global fixed layers — scanlines, grain, vignette — plus the `data-atmo` / `data-glitch` roots. |

### 3.4 Change temp — the one genuinely new information design

A duration on its own is not information: 22s is fine for one test and a
regression in another. `Temp` reads a timing against *that test's own median* and
colours the deviation. The ramp is deliberately dead in the middle — nothing
colours until ±10%, because a table where every row is lit says nothing.

```
dev <= -0.10   →  mix(neutral → green)   over the next 25%
-0.10 < dev < 0.10  →  neutral rgba(233,237,238,.62)
0.10 <= dev < 0.40  →  mix(neutral → amber)
dev >= 0.40    →  mix(amber → red)       saturating at +100%
```

Five presentations (`tint`, `rule`, `bar`, `delta`, `halo`); `tint` is the
default and `off` is available. This is a shipped setting, not a knob, because it
changes what the number *tells you*.

**It needs a real median.** The mockup hardcodes `dev` per row. In the app the
source is `metrics-store` — `step_metrics` already holds per-step timings and the
rollup runs before retention prunes, which is exactly the history this needs.
Wiring `Temp` to real medians is a Phase C item (§6.3), not Phase B; in Phase B
it renders in `off` mode wherever the median is not yet available, which is the
current behaviour rendered honestly.

### 3.5 Two things in the mockup that change before they ship

Both are decided (§0); recorded here with the reasoning, because both look like
details and are not.

**The favicon fetch is an egress path.** `SiteIcon` calls
`https://icons.duckduckgo.com/ip3/<host>.ico` for every non-reserved host in the
library. That sends the hostname of every site under test to a third party, on
every render of the sidebar. This app's stated egress posture is *one opt-in
summary-only webhook* (DECISIONS 2026-08-04), and a QA tool's test list routinely
names unreleased staging hosts and internal domains.

Ship the monogram fallback as the **default**, and put the favicon fetch behind
an explicit, off-by-default setting in Keys & creds or Appearance with copy that
says what it sends and where. The monogram is already deterministic per host and
already the answer for reserved names — it is a complete design on its own, not a
degraded one.

**The textures are 75MB.** With texture fixed at the `ember` default, the app
needs `acid-25.jpg` (4.2MB) and the grain plate `super-light-1.png` (4.2MB). Both
are used at low opacity, over-scaled, behind other content. Convert to WebP at the
resolution actually rendered and budget **under 400KB combined**; drop the other
thirteen plates from the repo entirely. `glitch.gif` (723KB) is already in the
tree and already used by `ai-debug-panel.tsx`.

### 3.6 Motion, and the accessibility rule the mockup does not state

The design's `atmosphere` setting has three levels — `alive` (everything),
`calm` (ambient motion stops, status pulses continue), `still` (all motion stops).
The distinction is exactly right: a running step must still pulse, because *motion
that reports something is not decoration*.

Add the rule the mockup omits: **`prefers-reduced-motion: reduce` forces `calm`
as the floor**, and the setting can only go quieter from there, never louder. A
user who has asked the OS for less motion should not have to find a setting in
this app. `still` remains available for people who want it.

Implementation is one rule, as in the mockup — `[data-atmo="still"] *`, and its
`calm` counterpart scoped to ambient animation names only — rather than threading
a flag through hundreds of inline animation strings.

---

## 4. Phase A — foundation

One PR per numbered item.

**A1. Port `dev:web` to `main`.** §2. Prerequisite for everything else. ✅ **Done.**

**A2. Tokens, fonts, atmosphere.** `renderer/theme/tokens.css`, self-hosted
woff2, the three fixed overlay layers, `data-atmo`/`data-glitch` roots, the
reduced-motion floor. Lands with the app still looking exactly as it does — the
overlays default off until A4.

**A3. Primitives.** The fifteen in §3.3, each with its own test file. No screen
consumes them yet. This is the PR where the visual contract gets pinned: fixed
status width, selection-is-not-status, CRT-content-is-untreated.

**A4. Shell.** Top strip (wordmark, breadcrumb, ⌘K affordance, job ticker slot,
settings gear), the rail restyle over `SplitView`, the views nav pinned to the
bottom, the rail handle. Retire `useTheme()` and the light theme; Appearance pane
becomes "Dark only for now".

**A5. Retire the SDK on the shared surfaces.** `step-row.tsx`, `pager.tsx`,
`tag-cluster.tsx`, `log-inspector.tsx`, `heals-panel.tsx` — the components every
screen embeds. Doing these before the screens means Phase B's per-screen PRs are
about layout, not about swapping buttons.

---

## 5. Phase B — parity reskin, screen by screen

Each PR: one screen, same behaviour, new chrome. The review question is "does it
still do everything it did?" — and the existing test file for that screen is the
answer, updated only where a query genuinely changed.

Ordered by risk-adjusted value: the screens with the most existing test coverage
and the least new layout go first, so the pattern is proven before the hard ones.

### B1. Home — `home-view.tsx`

Smallest screen, and the `BlackHole` loader already exists in the tree.

| Today | Redesign |
|---|---|
| SDK card layout | Full-bleed textured plate + radial falloff, centred column |
| — | Wordmark at 40px/`.2em`, glitch animation |
| — | Three stat readouts (tests / green last 7d / heals to review) |
| Buttons | `Btn go` "Run a test", `Btn ghost` "Generate from prompt" |

New: the texture plate, the stat row (data already available from existing
queries), the wordmark treatment.

### B2. Heals — `heals-view.tsx` + `heals-panel.tsx`

395 lines, two-pane, well covered.

| Today | Redesign |
|---|---|
| SDK list + detail | `Panel` journal (330px) + `Panel` detail |
| Status text | `StatusChip` at `STATUS_W`: Applied / Suggested / Accepted / Reverted |
| was/now | `label()` column + struck-through `was`, lit `now` |
| — | Amber warning block: "A heal that succeeded is not the same as a heal that was right" |
| Candidates list | Same, with a `use` affordance per row |

### B3. Batch — `batch-view.tsx` + `tag-cluster.tsx`

887 lines. The redesign keeps the information architecture the current view
already has (per-row engines and headedness landed 2026-08-07) and restyles it.

| Today | Redesign |
|---|---|
| Row controls | Fixed columns: drag handle, check, name, tags (118px), engines (84px), window (72px), time (46px), status (82px) |
| Engine icons | `CR` / `FF` / `WK` short codes; off stays visible at low contrast; per-engine result tints the code |
| Headless toggle | 72px cell reading `Headless` / `Headed`, amber when headed |
| Concurrency select | Menu where each option states its trade-off ("A laptop will thrash and report failures it caused") |
| Headless + screenshots | One bordered two-cell cluster at header height |
| History rows | Same rows, now expandable — drawer shows the batch's own per-test results and the settings it ran under |

New in B3: the concurrency menu copy, the history drawer. Both are presentation
over data the app already stores (`batch-history-store`).

### B4. Settings — `settings-view.tsx`, `settings-nav.tsx`, `setting-row.tsx`, 8 panes

The IA is already right — eight panes plus search landed 2026-08-07. This is
mostly a restyle, plus two renames and one split the redesign argues for:

- **Advanced → Diagnostics.** `advanced-pane.tsx` is the debug-screenshot
  shortcut and a capture button — tools for handing this app's state to whoever
  is helping you. That is diagnostics, not experiments.
- **Experimental section out of the AI pane → its own Experiments pane.** A flag
  that changes how a run behaves does not belong buried inside AI settings.
- **New pane: Keys & creds.** Currently scattered (Anthropic key in AI, secrets
  handling implicit). The redesign collects them.

The row treatment is the valuable part: `risk` copy gets its own bordered block
with a red inset rail, `flag` renders as a red uppercase badge next to the label,
`doc` is a separate link for the *mechanism* rather than the warning. The current
`SettingRow` already refuses `details` on `danger` rows — keep that rule and
extend it: **a row with `risk` renders the risk unconditionally, never behind a
disclosure.**

Also: the rail becomes the settings nav while in settings (the panes *are* the
navigation), and the library list hides. Same surface, two jobs.

### B5. Test detail — `test-detail-view.tsx` + `step-row.tsx` + `run-output.tsx` + `script-view.tsx` + `run-triage.tsx`

823 lines plus satellites. The most-visited screen and the biggest reskin.

| Today | Redesign |
|---|---|
| Single layout | Two layouts, user-switchable: **Console** (3 columns) and **Timeline** (filmstrip over 2 columns) |
| — | Three breakpoints: wide 3-col / mid steps+stacked / narrow single |
| Status text | Verdict chip — one shape, six states (failed / passed / healed / retry / running / never), only colour, word and clock change |
| Run output | Raw log as a *drawer* that goes full black and takes the panel when opened |
| Steps list | `StepRow` with inset status rail, type chip, `Temp` |
| Screenshot | `CRT` bezel, untreated content, caption |
| Browser select | `BrowserDeck` — a card stack that fans open, because a run can target several engines |

**The six run states are the substantive idea here.** Today the detail view is
shaped around failure. The redesign gives `passed`, `healed`, `retry`, `running`
and `never` each their own summary panel answering the question that user
actually arrived with — "what held", "what did Auto-Heal change and was it
right", "attempt 1 vs attempt 2", "how far in", "what happens on the first run".
Only `failed` gets the diagnosis panel.

This is more than a reskin and it is why B5 is late in the order. Split it:
**B5a** = reskin the failed/console path to parity; **B5b** = the other five
state summaries (Phase C, §6.1).

### B6. Recorder — `recording-view.tsx` + `cookies-panel.tsx` + `add-step-dialog.tsx`

1,084 lines. The redesign's version is close to what exists (status row, tools,
step list, three-tab console) with three changes:

| Today | Redesign |
|---|---|
| Tools row | Four `ToolTile`s — mark, name, *and what it does* — folded away by default, pinned above the list |
| Add step dialog (1,170 lines) | Composes **in the list at the cursor**, not in a modal — the step is written where it will live |
| Assertion picker | Bottom sheet over the training window with the locator shown and six assertion kinds |
| — | `InsertGap` between every pair of steps; recording appends at the cursor |
| Three tabs | Same three (Console / Step details / Cookies), restyled |

Retiring `add-step-dialog.tsx` for an inline composer removes 1,170 lines and a
modal. Worth doing, but it is a behaviour change — keep it in Phase C (§6.2) and
reskin the existing dialog in B6.

### B7. Stats — `stats-view.tsx` + `flake-panel.tsx` + `suite-cost-panel.tsx` + `step-health-panel.tsx` + `divergence-panel.tsx`

975 lines plus five panels. Everything the current view has is in the redesign's
`health` mode: chart, KPI counts, capture overhead, stability, log search, run
table. The reskin is mostly `Panel` + `kpi` + `TagStack` + `Temp`.

Two structural moves:

- **Scope and range are stated once in the header** (`All tests ▾`, `30 days ▾`)
  and scope the entire page — chart, KPIs, tables. The run table's own test
  filter *follows* that rather than competing with it. Two controls for one
  question is how they disagree.
- **The run table gains two row kinds the data already distinguishes**: a
  baseline-update is not a run, and a run that only passed because Auto-Heal
  swapped a locator is not the same evidence as one that passed outright. Both
  render differently.

`Cost` and `Report` modes are new — Phase C (§6.4, §6.5).

### B8. Visual — `visual-view.tsx`

1,548 lines, the largest file in the renderer, and the screen where the redesign
adds the most. Current view has Current/Baseline/Diff, page-vs-element scope,
masks, accept-baseline, threshold. The redesign keeps all of it and reorganises
into rail + viewer + inspector.

| Today | Redesign |
|---|---|
| Frame selection | **Frame rail** — every frame with its diff %, a status-carrying thumbnail, "changed only" filter |
| 3 compare modes | 5 — adds **Wipe** (draggable divider) and **Blink** (600ms alternate) |
| Masks | Masks drawn *in the frame* as first-class objects, plus a managed list |
| Threshold | Slider drawn **against the actual frames**, so moving it shows what it will silence |
| — | "What moved" — per-region breakdown with measured boxes |
| — | Baseline provenance (run, commit, browser, viewport, who accepted, when) |
| — | Drift — this frame across the last 10 runs |

B8 reskins the existing five capabilities. Wipe, Blink, region breakdown,
baseline provenance and drift are Phase C (§6.6).

**One implementation note carried over from the mockup and worth keeping:** the
diff region boxes are *measured after layout*, never authored as percentages,
and re-measured on resize. A hardcoded percentage is only true at one container
height.

### B9. AI debug — `ai-debug-panel.tsx` + `ai-debug-chip.tsx`

1,347 lines. **The highest-risk reskin in the plan**, and CLAUDE.md says why: the
status icon's colour is the whole contract of a minimized job, a wrong colour is
silent, and nothing else catches it — not lint, not type-check, not the panel's
own tests.

The redesign's tones must map exactly onto the existing contract:

| Status | Existing contract | Redesign |
|---|---|---|
| idle / ready | blue | `--gl-cyan` |
| streaming / thinking | orange | `--gl-amber` |
| done / ready for review | green | `--gl-phos` |
| error / failed | red | `--gl-red` |

`renderer/main/ai-debug-icons.test.tsx` is extended, not replaced, and it covers
every surface the change reaches: panel header chip, minimized global chip,
sidebar sparkle, trainer step rows. Non-negotiable.

Everything else in the redesign's AI panel already exists: streaming, minimize-
not-cancel, the stale-script warning, the suggested-fix diff, follow-ups. The
"Sending" strip (what context is attached, and the token estimate) is the one
genuinely new element — and it is a *privacy* affordance, so it should ship with
the reskin rather than waiting for Phase C.

---

## 6. Phase C — the redesign's new features

Each is its own PR, each independently useful, ordered by value.

**6.1 The six run states** (from B5). Five new summary panels in test detail.
Data is already present in `RunRecord` and the heal journal.

**6.2 Inline step composer** (from B6). Retires `add-step-dialog.tsx`. The
`InsertGap` cursor is the prerequisite and the reason it can be moved.

**6.3 Change temp against real medians.** Wire `Temp` to `metrics-store`
per-test and per-step medians. Turns a decoration into a measurement.

**6.4 Stats → Cost mode.** CI spend, manual QA avoided, return on spend, waste
on flake, regressions caught; spend-by-test table with an earning/review verdict;
CI minutes trend. Needs a cost-per-minute setting and a "minutes per manual run"
assumption, both of which must be visible and editable — a number nobody can
check is a number nobody believes.

**6.5 Stats → Report mode.** The weekly digest preview, the channel list, and
exports (PDF / CSV / JUnit XML / public link). **This overlaps heavily with the
MCP plan's Phase 5 emit adapters** — see §7.3. Build the emitters once, surface
them here.

**6.6 Visual triage.** Wipe, Blink, region breakdown, baseline provenance, drift.

**6.7 Command palette (⌘K).** Does not exist in any form today. Run a test, run a
tag, open a view, debug the last failure, record, generate. Straightforward over
the existing router and query layer.

**6.8 Job ticker.** The top-strip live readout — one shape, five readings (one
run / several / batch / failed / idle-hidden). Needs a global run-state
subscription the app does not currently expose to the shell.

**6.9 Boot sequence.** 2.6s glitch-plate splash. Cheap, and the first thing
anyone sees. Should respect reduced motion by rendering statically.

---

## 7. Phase D — planned work, and where it lands in this design

The brief asks that already-planned features get design plans now, so they build
into existing UI rather than bolting on. Four are outstanding.

### 7.1 Routines (Batch v2) — [ROUTINES.md](ROUTINES.md), specified, not built

Three independent capabilities, sequenced 1 → 2 → 3: a saved named
configuration, a schedule, a flow builder.

**Where it lands.** Batch becomes a *list of Routines* with one Routine open,
rather than a single implicit checklist. Concretely, in the redesign's shell:

- The **views nav** entry "Batch" becomes "Routines", keeping its queue icon.
- The **rail**, which already has a second job in Settings (panes replace the
  library), gains a third: in Routines, the rail lists saved Routines. This is
  the pattern the redesign already establishes — one surface, context-dependent
  content — so it costs no new chrome.
- The **checklist** is unchanged; it is now the open Routine's body.
- The **header** gains the Routine's name (inline-editable, as test names already
  are) and its schedule chip.
- **Previous batches** stays, scoped to the open Routine.

Design notes that follow from the redesign's own rules:

- A schedule is a *fact about a job*, not a status — so the schedule chip uses
  neutral chrome, not phosphor. A Routine that is *currently running* uses the
  holo running chip, same as a batch row.
- ROUTINES.md's lane invariant (`runId === testId`, so two steps naming the same
  test can never run concurrently) must be a **save-time rejection with a visible
  reason**, not a silent serialisation. In the flow builder that is a red inset
  rail on the offending branch plus the `risk`-block treatment from B4 — the same
  vocabulary settings uses for "this can bite you".
- ROUTINES.md recommends *not* renaming the `batch:*` IPC channels,
  `batch-history.json`, `RunRecord.batchId` or the MCP `run_batch` tool. The
  redesign changes only the word in the UI. Nothing here disturbs that.

### 7.2 Test groups / folders — phase 1 and 3 exist on an unmerged branch

Not in `main`. The mockup anticipates it explicitly: `SiteIcon` is *"built as its
own component because folders will need exactly this next."*

**Where it lands.** The library rail. A group is a row that expands, using the
same disclosure vocabulary as the batch history drawer (`▸`/`▾`, `gl-fly`
animation, indented children). The group row carries:

- a `SiteIcon` — for a group, the monogram of the group's name rather than a host;
- the aggregate verdict in the fixed 46px meta cell the test rows already use, so
  groups and tests stack into one column with one edge;
- a count.

The views nav does not change. `run_group` over MCP needs no UI.

### 7.3 MCP Phase 5 — emit adapters (unstarted)

Five formats: JUnit XML, GitHub Actions annotations, OTLP JSON trace, ticket
payload (markdown), NDJSON/CSV of `step_metrics`. All are *emit, not send* — a
file or a payload, no stored credentials, no new outbound path.

**Where it lands: Stats → Report (§6.5).** The redesign already drew the surface
— an "Export" panel with four chips. That panel becomes the five emitters, and
the mockup's "Where it goes" channel list becomes what it honestly is: a list of
*emitters and their last-written file*, not a list of integrations that send.

Two things must be true in the UI and both come straight from the plan:

- **Every emitter runs through `redactWithSnapshot`.** Emitted files leave the
  machine by definition. The Export panel states this once, plainly, and a
  per-emitter `risk` block covers the two that carry the most (OTLP traces
  include network request URLs; NDJSON of `step_metrics` is unaggregated).
- The mockup's channel toggles imply outbound delivery this app does not do.
  Rewrite that copy before it ships, or it promises a Slack integration that does
  not exist.

### 7.4 MCP Phase 1c — capture parity (deferred)

Blocked on producing `replay.json`, and the plan says it lands in the Visual tab.
The redesign's **frame rail** (§B8) is the right home: a captured app state is
another frame series with its own diffs. No new screen.

### 7.5 The pipeline plan's Phase 4b / 5 — tree convergence

Not UI work, but this plan depends on §2 (the `dev:web` port), which is a slice of
it. Landing that slice on `main` reduces the 4b merge rather than complicating it —
it moves one already-reviewed directory from `shell/electron` to `main`, in the
direction convergence is going anyway.

---

## 8. Testing strategy

The brief's stated priority. The existing suite is 1,774 Vitest tests and 38
`check:*` scripts; the renderer alone has 58 test files and ~15,900 test lines.
None of that should be lost to a reskin.

### 8.1 The rule for Phase B

**A parity PR may not delete a test.** It may change a query — `getByRole`
targets move when chrome changes — but a test that existed to assert a behaviour
still asserts it afterwards. A test deleted in a reskin PR is the review's
stopping condition.

### 8.2 Where the reskin will break tests, and what to do about it

Known from this repo's own recorded gotchas:

- **`fireEvent.click` on `SidebarListItem` and Radix `TabsTrigger` does nothing** —
  they activate on mouse-down / pointer-down. Replacing them with our own buttons
  *fixes* this, and the tests that currently use `fireEvent.mouseDown` will need
  to move back to `click`. That is a real change and should be called out in each
  PR rather than done silently.
- **The SDK's `Select` is native-menu-backed**, so its options never enter the
  DOM. Where we keep it, keep the existing "assert the displayed value, cover
  persistence at the IPC layer" approach. Where the redesign draws its own menu
  (concurrency, stats scope, appearance choice), the options *are* in the DOM and
  can finally be driven directly — new coverage, cheaply.
- **Radix `Tooltip` cannot be opened in jsdom.** The redesign uses `title` for
  most hints; those are assertable as attributes. Where a tooltip carries copy
  nothing else states, keep the existing pattern: export the string and assert it,
  and make sure it is reachable without hover.
- **jsdom has no layout engine.** `getBoundingClientRect()` returns zeros. The
  redesign's `DiffLayer` measures real nodes, so its test needs the nominal-box
  install that `step-replayer.dom.test.ts` already does. Without it the measured
  boxes are all zero and the test proves nothing while passing.

### 8.3 New guards — four `check:*` scripts

The visual contract needs source-level guards, because the failure mode is silent
and neither type-check nor jsdom observes it. Modelled on `check:text-color`,
which exists for exactly this reason.

| Check | Pins |
|---|---|
| `check:theme-tokens` | Every `--gl-*` referenced in `renderer/` is declared in `tokens.css`. The direct answer to the `bg-muted` / `border-token-border` class of bug, and it should run against the *emitted* stylesheet as well as source. |
| `check:status-width` | Every status chip uses `STATUS_W`. A ragged status column is the exact thing the fixed width exists to prevent, and it degrades one row at a time. |
| `check:selection-neutral` | No selection treatment uses a status hue. Encodes "colour means outcome" so the next contributor inherits the rule. |
| `check:crt-untreated` | No scanline, grain, vignette or tint style is applied inside a `CRT`. Evidence must read as the browser rendered it; a screenshot the user is asked to judge must not be tinted by chrome. |

Plus one extension: **`check:text-color` widens** from `Text`'s colour to the
retired-SDK surfaces, or is retired itself as those surfaces stop using `Text`.
Decide per-PR; do not leave it asserting over a component nothing renders.

### 8.4 Visual verification

With `dev:web` on `main` (§2), each Phase B PR carries:

1. A screenshot of the screen at all three breakpoints (1440 / 1024 / 800),
   opened directly with `?view=` / `?test=`.
2. A console-clean check — `read_console_messages` with zero errors — **and an
   empty `window.__preview.misses`.** A miss means the screen is being reviewed
   against an unanswered channel, which renders as an empty state and reads as
   real data.
3. For screens with a status vocabulary (detail, batch, heals, stats), one
   screenshot per state, because the states are the design.

This is not a substitute for the Glaze-app pass (CLAUDE.md step 3), which still
happens once per screen.

### 8.5 Verify a test can fail

The repo's standing rule and it matters more than usual here. For each of the
four new checks, and for the AI-debug icon colours, break the thing deliberately
and confirm the test goes red. Several tests in this repo were written against
behaviour that turned out to differ from the assumption; the revert is what
catches it.

---

## 9. Sequenced summary

| # | Work | Depends on | Rough size |
|---|---|---|---|
| A1 | Port `dev:web` to `main` | — | 1 day |
| A2 | Tokens, fonts, atmosphere, reduced-motion floor | A1 | 1 day |
| A3 | Fifteen primitives + tests | A2 | 3–4 days |
| A4 | Shell: top strip, rail, views nav; retire light theme | A3 | 2 days |
| A5 | Retire SDK on shared components | A3 | 2 days |
| B1–B9 | Parity reskin, one screen per PR | A4, A5 | 2–4 days each; B5 and B8 at the top of that range |
| C | Nine new features, independently | their screen's B | 1–4 days each |
| D | Routines, groups, emit adapters, capture parity | C where noted | per ROUTINES.md and the MCP plan |

Phase A is ~9 days and unlocks everything. Phase B is the bulk. Phase C and D are
separable and can be reprioritised freely once the foundation is in.

---

## 10. Open questions

Not blocking, but each will need an answer before the PR it affects.

1. **Cost mode's inputs** (§6.4). Cost per CI minute and minutes-saved-per-manual-run
   are assumptions. Settings rows, or hardcoded with a visible "edit these"
   affordance?
2. **The `job` ticker's data source** (§6.8). The shell needs a global run-state
   subscription. Does that come from `recorder-store`, a new provider, or a
   query?
3. **Report mode's "Where it goes"** (§7.3). Confirmed as emit-only? If any of it
   ever sends, that is a new egress path and needs its own decision entry.
4. **`check:text-color`'s fate** (§8.3).
5. **CLAUDE.md's directory map is stale** — it lists `renderer/components/`,
   which does not exist. Worth fixing in A2 alongside adding `renderer/theme/`.

---

## 11. Why the four decisions went the way they did

**Bespoke layer over retheming.** The redesign's primitives are not SDK
primitives with different colours — zero radius, hairline boxes, inset status
rails and fixed status widths are not variants the SDK has. Retheming would cap
fidelity at "darker current app" while still exposing us to the invisible-class
bug family. A bespoke layer whose tokens we declare makes that bug checkable
(§8.3).

**Parity before features.** The mockup mixes a reskin with roughly nine new
capabilities. Landing them together makes every regression ambiguous between the
two, on PRs that would run to 1,500 lines. Separating them means each PR has one
review question.

**Dark only, stated.** The palette is near-black with phosphor accents and two
texture layers. A light variant is a second design, not a token swap, and the CRT
treatment has no light reading. Saying "dark only for now" is more honest than
shipping a light theme that is a worse version of the same idea — and it removes
an entire axis from the visual test matrix.

**Four knobs, not eight.** CRT overlay, ambient motion, code & step colours and
change temp each change what you can *read* or *learn*. Texture, glitch, hover
and typeface change how it feels. The first four earn a setting and a test
matrix; the second four earn a good default. Motion is not really a preference at
all — it is an accessibility obligation with a preference on top (§3.6).
