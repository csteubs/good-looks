# The indie redesign — an implementation plan

**Status: Phase A is done; Phase B has reached every screen.** A1–A5 are landed,
and so are **B1 (Home)**, **B2 (Heals)**, **B3 (Batch)**, **B4 (Settings)**,
**B5a (Test detail, parity)**, **B6 (Recorder)**, **B7 (Stats)**, **B8 (Visual,
first slice)** and **B9 (AI debug — the status contract and the Sending strip)**
— see the ✅ marks in §4, §5 and §8.3. The app's frame is the redesign, so are
the five components every screen embeds, and every screen has been reached.

**Phase B is complete.** B8 was the last one open and closed on 2026-08-11 with
its frame rail, threshold-against-frames and the masks/baselines reskin.
**Phase C is nearly complete: §6.1, §6.2, §6.3, §6.4, §6.6, §6.7, §6.8 and §6.9
all landed 2026-08-12** — the five non-failure run-state summaries (which were
B5b), the inline step composer, change temp against real medians, Stats → Cost,
the whole of Visual triage (Wipe/Blink, baseline provenance, drift and the region
breakdown), the ⌘K command palette, the job ticker, and the boot sequence.
**§6.5 (Stats → Report) is what remains**, and it overlaps §7.3's MCP emit
adapters — build the emitters once, surface them there.
Where the rest of this says "would", it means would.

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

> **This was not hypothetical, and it is fixed.** While surveying the sidebar for
> A4, the SHIPPING app turned out to be doing the same thing already — every test
> row fetched `https://www.google.com/s2/favicons?domain=<host>`, so opening the
> app sent Google the hostname of every site under test. `SiteIcon` replaced it
> (2026-08-08), and `check:renderer-egress` now judges every absolute URL in the
> renderer against an allowlist of specific strings with written reasons.
> **The opt-in setting landed with §B4** (2026-08-10): Appearance → "Fetch site
> icons from the web", off by default on both sides of the IPC boundary, with a
> `flag` badge and a `risk` block naming icons.duckduckgo.com and saying the
> hostname is what gets sent. `check:renderer-egress` pins the defaults, the
> disclosure copy, and that no call site hardcodes the fetch on.

**The textures are 75MB.** With texture fixed at the `ember` default, the app
needs `acid-25.jpg` (4.2MB) and the grain plate `super-light-1.png` (4.2MB). Both
are used at low opacity, over-scaled, behind other content. Convert to WebP at the
resolution actually rendered and budget **under 400KB combined**; drop the other
thirteen plates from the repo entirely. `glitch.gif` (723KB) is already in the
tree and already used by `ai-debug-panel.tsx`.

> **Grain: solved in A2, and not with a plate.** An inline `feTurbulence` data
> URI is ~400 bytes, has no resolution to be wrong at, and needs no asset
> pipeline — the PNG was always going to look like noise at 3.8% opacity, and
> this *is* noise. `super-light-1.png` is not needed.
>
> **`ember` is still outstanding, and its source art is not in this repo.** The
> mockup zip is not checked in, so `acid-25.jpg` has to be supplied before the
> texture plate can ship. It first matters in **B1** (home's full-bleed textured
> plate), not in A2 — the three global overlay layers do not depend on it.

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

**A2. Tokens, fonts, atmosphere.** ✅ **Done, 2026-08-08.**
`renderer/theme/tokens.css`, self-hosted woff2, the three fixed overlay layers,
`data-atmo`/`data-glitch` roots, the reduced-motion floor. Landed with the app
still looking exactly as it does — nothing mounts `<Atmosphere />` until A4, and
`@font-face` is a declaration rather than a fetch, so a normal load requests no
font at all. `check:theme-tokens` shipped with it (§8.3). Two things resolved in
the building: the 500 → 400 / 600 → 700 mono mapping lives in the `@font-face`
weight RANGES rather than at the call sites, so no engine ever synthesises; and
the grain plate is an inline `feTurbulence` data URI (~400 bytes) instead of the
mockup's 4.2MB PNG. See DECISIONS 2026-08-08.

**A3. Primitives.** ✅ **Done, 2026-08-08.** The fifteen in §3.3, each with its
own test file. No screen consumes them yet. This is the PR where the visual
contract got pinned: fixed status width, selection-is-not-status,
CRT-content-is-untreated — all three as `check:*` scripts, plus a fourth
(no status hex may be written into a stylesheet) that fell out of building
`StatusChip` and `Btn` on one shared derivation. Also lands `renderer/theme/tokens.ts`
(the narrow set a `var()` cannot express) and `renderer/dev/specimen.tsx`, every
primitive in every state at `/?view=specimen`. See DECISIONS 2026-08-08.

**A4. Shell.** ✅ **Done, 2026-08-10.** `renderer/theme/shell/` (`TopStrip`,
`ChromeButton`, the `Rail` family) + `shell.css`, wired up by
`renderer/main/app-strip.tsx`; the rail restyle over `SplitView`, the views nav
pinned to the bottom, the rail handle. `<Atmosphere />` finally mounts.
`useTheme()` and the light theme are gone — with the `nativeTheme:*` IPC, the
preload bridge and the `nativeTheme:updated` push, since nothing called them any
more — and the Appearance pane reads "Dark only for now".

Four things resolved in the building. The strip is a new `header` SLOT on
`SplitView` rather than a sibling above it, because the rail handle reads that
context and hoisting the collapse state out would take `storageKey` persistence
and ⌃⌘S with it; the pinned `SidebarToggle` retires with it, which gives every
view title its 44px back. **The ⌘K and job-ticker slots render nothing** — an
affordance for a feature that does not exist teaches a shortcut that answers with
silence, so §6.7 and §6.8 land in props that are already there. The breadcrumb
takes `recording` explicitly, because the trainer replaces the outlet without
navigating and a router-derived trail would name the wrong screen. And the views
nav moving out of the scroller is a bug fix, not a restyle: `mt-auto` pinned it
to the bottom only while the library was short. See DECISIONS 2026-08-10.

**A5. Retire the SDK on the shared surfaces.** ✅ **Done, 2026-08-10.**
`step-row.tsx`, `pager.tsx`, `tag-cluster.tsx`, `log-inspector.tsx`,
`heals-panel.tsx` — the components every screen embeds — plus
`renderer/theme/shared.css`, the third stylesheet (primitives are what a screen
is built out of, `shell.css` is what it sits inside, this is what it embeds).

Three things worth carrying forward. The chips split by whether a label reports
an OUTCOME — `.gl-chip-tone` via `toneSurface()` for "Applied to the test",
neutral `.gl-chip` for "soft" or "During a run" — and neither is a `StatusChip`,
whose fixed width is a contract about columns these are not part of. The step
row KEEPS its own structure: drag, inline edit, replay and the run flash belong
to the step list's own reskin (§B5/§B6), so only the SDK left. And the tag
delete stopped turning red on hover, because an outcome hue on a hover state
reads as a result — the confirm dialog states the danger instead.

**`check:sdk-retired` ships with it** and is the point rather than an extra: the
premise erodes silently, one `import { Button }` at a time, in diffs where
nobody is looking at the import block. See DECISIONS 2026-08-10.

---

## 5. Phase B — parity reskin, screen by screen

Each PR: one screen, same behaviour, new chrome. The review question is "does it
still do everything it did?" — and the existing test file for that screen is the
answer, updated only where a query genuinely changed.

Ordered by risk-adjusted value: the screens with the most existing test coverage
and the least new layout go first, so the pattern is proven before the hard ones.

### B1. Home — `home-view.tsx` ✅ **Done, 2026-08-10**

Smallest screen, and the `BlackHole` loader already exists in the tree.

| Today | Redesign |
|---|---|
| SDK card layout | Full-bleed textured plate + radial falloff, centred column |
| — | Wordmark at 40px/`.2em`, glitch animation |
| — | Three stat readouts (tests / green last 7d / heals to review) |
| Buttons | `Btn go` "Run a test", `Btn ghost` "Generate from prompt" |

Landed with `renderer/theme/screens.css` (the fourth stylesheet — what one
screen IS) and four decisions worth carrying into B2–B9:

- **A number nothing supports renders as `—`, never `0`.** "0% green" with no
  runs in the window is a claim about a week that did not happen. Both
  directions are pinned, because over-correcting hides a suite that really is
  all red.
- **The readouts share the app's own query keys**, so they cost nothing and can
  never disagree with the screen you click through to.
- **`Btn go` reads "Record a test"**, not the mockup's "Run a test": nothing is
  selected on Home, so "run" has no object.
- **`echo` is ghosting in one ink**, not red/cyan fringing — that would spend
  two status hues on decoration at the largest type size in the product. Drawn
  as pseudo-elements so the wordmark is announced once.

**The texture plate shipped without its art.** `acid-25.jpg` is still not in the
repo (open question 6); the radial falloff and an ember wash carry the plate,
and the photograph drops into one `background-image` when it arrives.
`--gl-ember` is its own token and deliberately not `--gl-amber` — a texture is
not a status. See DECISIONS 2026-08-10.

### B2. Heals — `heals-view.tsx` + `heals-panel.tsx` ✅ **Done, 2026-08-10**

395 lines, two-pane, well covered. (`heals-panel.tsx` came earlier, with A5.)

The first screen where the fixed status width does real work — this list is the
only column in the app reporting four genuinely different states — and **only
two of the four take a hue**: `Accepted` is an outcome and `Applied` is the one
that should catch the eye, while `Suggested` is the open item (cyan) and
`Reverted` is settled with nothing to report. Two neutral chips is deliberate:
the width is fixed so they read as a column, and the WORD reports the state.

The toolbar went with the reskin — the strip's breadcrumb already says HEALS, so
the count moved to the journal panel's `id` slot and "Clear history" to its
`right` slot. The was/now block, the candidate rows and the amber notice are the
`.gl-heal-*` classes A5 already built, found in `shared.css` rather than copied.
See DECISIONS 2026-08-10.

| Today | Redesign |
|---|---|
| SDK list + detail | `Panel` journal (330px) + `Panel` detail |
| Status text | `StatusChip` at `STATUS_W`: Applied / Suggested / Accepted / Reverted |
| was/now | `label()` column + struck-through `was`, lit `now` |
| — | Amber warning block: "A heal that succeeded is not the same as a heal that was right" |
| Candidates list | Same, with a `use` affordance per row |

### B3. Batch — `batch-view.tsx` + `tag-cluster.tsx` ✅ **Done, 2026-08-10**

905 lines. The redesign keeps the information architecture the current view
already has (per-row engines and headedness landed 2026-08-07) and restyles it.

| Today | Redesign |
|---|---|
| Row controls | Fixed columns: drag handle, check, name, tags (118px), engines (84px), window (72px), time (46px), status (82px) |
| Engine icons | `CR` / `FF` / `WK` short codes; off stays visible at low contrast; per-engine result tints the code |
| Headless toggle | 72px cell reading `Headless` / `Headed`, amber when headed |
| Concurrency select | Menu where each option states its trade-off ("A laptop will thrash and report failures it caused") |
| Headless + screenshots | One bordered two-cell cluster at header height |
| History rows | Same rows, now expandable — drawer shows the batch's own per-test results and the settings it ran under |

New in B3: the concurrency menu copy, the history drawer.

**One correction to the line above, found in the building: the history drawer is
NOT all presentation over stored data.** `BatchRecord.results` carries every
test, its engine, duration and outcome — none of which was visible for a past
batch before — but there is no `captureArtifacts` and no `concurrency` on the
record, so "the settings it ran under" has nothing behind it. The drawer ships
with what exists; making the other half real is a backend field plus a decision
about records written before it, which is not a reskin.

Also landed: **`Menu`**, the box `MenuItem` always implied. The SDK `Select`
stays native everywhere else — but a native menu item is a string, and the whole
point here is the second line. See DECISIONS 2026-08-10.

### B4. Settings — `settings-view.tsx`, `settings-nav.tsx`, `setting-row.tsx`, 9 panes ✅ **Done, 2026-08-10**

**Shipped 2026-08-10.** The IA was already right — eight panes plus search
landed 2026-08-07 — so this was mostly a restyle, plus two renames and one split:

- **Advanced → Diagnostics.** ✅ `advanced-pane.tsx` is the debug-screenshot
  shortcut and a capture button — tools for handing this app's state to whoever
  is helping you. That is diagnostics, not experiments. "Advanced" is a promise
  about difficulty, and it attracts everything nobody could place.
- **Experimental section out of the AI pane → its own Experiments pane.** ✅ Both
  flags change how a RUN behaves, and a section heading is invisible from the
  sidebar, so its caveat only reached someone already reading the AI pane.
- **New pane: Keys & creds.** ⏳ **Deferred, with a reason.** Collecting the
  credentials means moving the Anthropic key and the LM Studio token away from
  the controls that VALIDATE them — the connection test and the model list, both
  in the AI pane, are how you find out a key works. A credentials pane that
  cannot tell you whether the credential is good is a worse home than the pane
  that can. This waits for a design that moves the validation too.

The row treatment was the valuable part and shipped whole: ✅ `risk` copy gets its
own bordered block with a red inset rail, `flag` renders as a red uppercase badge
next to the label, `doc` is a separate link for the *mechanism* rather than the
warning. `SettingRow` still refuses `details` on a `flag` row, and **a row with
`risk` renders it unconditionally** — structurally, because `risk` has no closed
state to be in. One thing only visible on screen: a flagged row that ALSO has a
risk block drops the row-level rail, because two red rails at two indents read as
a rendering glitch rather than as emphasis.

Also shipped with it, though neither is in the mockup: the **site-icon opt-in**
owed since §3.5, and the `gl-*` half of `check:renderer-classes` — the class
audit only ever looked at Tailwind's prefixes, so every class this theme layer
has added since A2 was unguarded.

Also: the rail becomes the settings nav while in settings (the panes *are* the
navigation), and the library list hides. Same surface, two jobs. ✅ **with a
caveat** — Settings is its own `BrowserWindow` here, so there is no library list
to hide and no single element to repurpose. What the sentence actually buys is
recognition, so `SettingsNav` is built from `Rail`/`RailGroup`/`RailRow`, the
same components the main window's library uses, with the search field in the
rail's pinned `search` slot.

### B5. Test detail — `test-detail-view.tsx` + `step-row.tsx` + `run-output.tsx` + `script-view.tsx` + `run-triage.tsx` — **B5a done, 2026-08-10**

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

**B5a shipped 2026-08-10.** ✅ The step list's status is an inset rail rather
than a tinted row, and selection went neutral with it. ✅ The verdict is a
`StatusChip`, with `running` on the holo treatment rather than a hue. ✅ The raw
log is a full-black console, and it now EXPANDS to take the pane — a drawer, not
a modal, because the verdict, the triage line and the log are one thought. ✅ The
triage line is the `Verdict` primitive, whose `tone` became optional so that
"evidence both ways" and "not enough evidence" can stay colourless. Toolbar,
tabs, checkboxes and the script bar are on the theme layer.

Two items in the table above are deliberately NOT in B5a, because neither is
parity: the **Console/Timeline layout switch** with its three breakpoints, and
**`BrowserDeck`** (the engine picker as a fanning card stack). The screenshot
`CRT` bezel is also still to come — the failed/console path does not show one,
and Visual (§B8) is where captured frames actually live.

One thing B5a needed that the plan did not anticipate: **the browser preview
could not finish a run**, so the failed path — this section's entire subject —
had no way to be looked at outside a packaged build on a Mac. The preview bridge
gained a push bus and a scripted, fixture-determined run; `?test=t-login` is now
a stable address for the failed console path.

### B6. Recorder — `recording-view.tsx` + `cookies-panel.tsx` + `add-step-dialog.tsx` ✅ **Reskin done, 2026-08-10**

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

**Shipped 2026-08-10, the reskin half.** ✅ The session-state chip, the tools
row, the refine banner and the three-tab console are on the theme layer. Two
things in it are more than restyling. The state chip: `Recording` was the SDK's
`error` variant — RED, the colour this palette spends on a failed run — on the
one screen where nothing has run yet; Recording / Editing / Replaying / Running
now take the holo `running` treatment and Paused goes neutral, because none of
them is an outcome. And Hard/Soft moved to the theme's `Segmented`, which is
plain buttons with `aria-pressed` rather than a pointer-down Radix control, so
the choice is assertable in a test for the first time.

Still Phase C, and deliberately: the four **`ToolTile`s**, the **inline composer**
that replaces the 1,170-line add-step modal, the **assertion bottom sheet**, and
`InsertGap` between every pair of steps (the existing `CursorGap` already covers
the cursor half of that). The tab strip's rules moved from `.gl-detail-tabs` to
`.gl-tabs` in `shared.css` when this screen became their second consumer —
that is the rule the four-stylesheet split states, applied.

One thing B6 needed that the plan did not anticipate: **the trainer had no
address in the browser preview.** `RootShell` swaps the outlet for
`RecordingView` only while `state.recording`, and nothing in a tab can make that
true, so a fifth of the app's UI could not be looked at outside a packaged
build. `?view=recorder` reports a live session over a fixture test's steps.

### B7. Stats — `stats-view.tsx` + `flake-panel.tsx` + `suite-cost-panel.tsx` + `step-health-panel.tsx` + `divergence-panel.tsx`

> **The reskin is done, 2026-08-10.** All five files are on the theme layer, with
> a Stats section in `renderer/theme/screens.css`. Every existing test survived; two queries changed, none were
> deleted. The reskin also found and closed a hole in `check:status-width`: a
> width a flex row can take back is not a fixed width, and the run table's status
> cell was squeezing the chip until the row reported a heal and dropped the
> outcome.
>
> **Two things in this section are NOT done.** The page-level scope + range is
> deferred — it cannot be honest until the flake and metrics handlers take a time
> window, or it scopes half the page and misreports the other half (DECISIONS).
> And `docs/plans/stats-categories.md` supersedes the "one page, three modes"
> shape below: the board of categories replaces it, and Cost and Report become
> two more categories rather than two more modes.

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

### B8. Visual — `visual-view.tsx` — **first slice done, 2026-08-10**

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
| — | ✅ "What moved" — per-region breakdown with measured boxes |
| — | Baseline provenance (run, commit, browser, viewport, who accepted, when) |
| — | Drift — this frame across the last 10 runs |

B8 reskins the existing five capabilities. Wipe, Blink, region breakdown,
baseline provenance and drift are Phase C (§6.6).

**First slice shipped 2026-08-10.** ✅ Captured frames are in the `CRT` bezel —
the primitive this screen is the reason for. ✅ The compare-mode switch is the
theme's `Segmented`, whose active item is neutral, which matters more here than
anywhere else: an accent-coloured segment sitting on a screenshot is a colour
the page did not put there. ✅ The browser preview now serves a captured run, so
the screen is reviewable at all — it previously rendered only its empty state,
which is why this slice is scoped the way it is rather than attempting 1,548
lines blind.

✅ **The frame rail, 2026-08-10.** Every frame now carries its diff PERCENTAGE
and there is a "changed only" filter. The percentage is the substantive part: a
run with forty frames and three real changes was a row of near-identical bars —
the strip could say THAT a frame changed but never by how much, so a 0.01%
antialiasing shift and a 40% layout break looked identical and triage meant
clicking through one frame at a time. The filter is offered only when it would
do something, and it always keeps the SELECTED frame even when that frame did
not change: dropping it while the viewer above still shows it would leave the
rail disagreeing with the picture, and the user with no handle to move off it.
The bars take the palette (phos/red for the two real outcomes, neutral for a
frame that was never attempted, an amber inset rail to mark a change — caution,
not an outcome, since the frame still passed).

✅ **The threshold, drawn against the frames, 2026-08-11.** The slider used to be
a number with no consequence on screen — "0.20%" says nothing about whether
moving it silences the change you are looking at or every change you have. It
now reads `flags 1 of 2` beside itself, counted over THIS run's frames and
updated from the drag rather than the committed value, so it answers while you
move it. The comparison is strictly-greater, matching the comparator that
produced the ratios: a preview that disagreed with the next run by one frame
would be worse than none, because it would be believed. Pinned by four tests on
the pure `framesOverThreshold`.

✅ **The masks / baselines manager, 2026-08-11.** It already existed as a
capability — `MasksBaselinesDialog` is the per-test managed view, and masks are
already drawn in the frame by the ignore-region editor — so this was a reskin:
square hairline rows on `--gl-panel` instead of rounded bordered cards (the SDK
weight read as a card, which is wrong for something you scan a dozen of), mono
micro-label headings, neutral chips (neither "which steps" nor "has geometry" is
a result), and amber on the mask glyph because a mask is a CAUTION about the
comparison — pixels deliberately not judged — rather than an outcome.

Doing it surfaced a fixture bug worth recording: `visual:listBaselines` was
answering with bare step ids under a `: string[]` annotation. That type-checked,
because the annotation was the thing being checked rather than `api.ts`'s actual
`BaselineEntry[]` — so the manager rendered four rows with no label and "Invalid
Date", which is exactly the "looks like a broken feature" failure the bridge's
own header warns about. **With this, §B8 is complete and so is Phase B.**

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

**Shipped 2026-08-10.** ✅ The four tones map onto the pre-redesign contract
exactly, and — the substantive change — the mapping is now **checkable**:
`toneFor` returns the palette tone as data, so the contract is asserted by value
instead of only by label. A wrong colour with a right label used to pass
everything in this repo. ✅ `ai-debug-icons.test.tsx` extended, plus a guard the
per-status assertions cannot make: the four meanings must stay in four DIFFERENT
colours, since two collapsing onto one is the failure that stops the icon
carrying information at all. ✅ The Sending strip, derived from the same `ctx`
the prompt is built from, with a drift test that fails if the builder attaches a
payload the strip does not name. Sizes are characters, not tokens — a token count
is a guess dressed as a measurement.

✅ **And the panel's chrome, in a follow-up the same day.** Ten icon-only SDK
buttons became `.gl-icon-btn` — the SDK was spending two different greys
(`muted`/`transparent`) on one job. "Send to AI" and "Send this data" take
`tone="ai"`, the holo border, because AI is not an outcome and because that is
the button which actually sends the payload the strip above it just itemised.
The prompt preview and code blocks became `.gl-console` on `--gl-black`: a
prompt is evidence of what was sent, the same category as run output and a
captured frame, and it should not look like our chrome.

---

## 6. Phase C — the redesign's new features

Each is its own PR, each independently useful, ordered by value.

**6.1 The six run states** (from B5). ✅ **Done, 2026-08-12.** Five new summary
panels in test detail, from data already present in `RunRecord` and the heal
journal. The state decision and its arithmetic are pure
(`renderer/lib/run-summary.ts`), the rendering is `run-summary-panel.tsx`, and
`RunOutput` now shows the six-state chip rather than pass/fail.

Four things the plan did not anticipate, all of which changed the shipped shape:

- **"retry" had to be translated.** The plan calls it "attempt 1 vs attempt 2",
  which presumes a runner with `retries` configured. This app configures none —
  every run is one attempt — so the two attempts are two RUNS. The question
  survives intact and the answer comes only from what `RunRecord` stores. When
  NOTHING differed, that is the most useful reading available and the one a user
  is least likely to reach alone: same engine, same pacing, same budget, opposite
  outcome, so the test is flaky rather than fixed.
- **Two of the six passed and are not phos.** `healed` is amber because a
  mis-heal usually succeeds (clicking the wrong button rarely throws), and a
  flaky `retry` is amber for the same reason. Reporting either as a plain pass
  is the app agreeing with the substitution.
- **The panel now renders with no live run.** It used to appear only once
  something had executed in this session, so opening a test cold said nothing
  whatsoever about it. That was invisible while the panel was about failure and
  indefensible once it was about state.
- **`.gl-heal-row` already existed** in `shared.css`, used by `heals-panel.tsx`,
  and the new rows silently inherited it (and leaked into that panel). This is
  the failure mode `check:renderer-classes` cannot see — the class resolves, to
  the wrong rule. Renamed to `.gl-run-heal-*`.

**6.2 Inline step composer** (from B6). ✅ **Done, 2026-08-12.**
`add-step-dialog.tsx` is now `step-composer.tsx`, and the panel opens BETWEEN
the two steps the new one will sit between, at the insert cursor, in both the
main window and the trainer panel.

**The line-count claim in this plan does not survive contact, and should not.**
§B6 says retiring the dialog "removes 1,170 lines and a modal". It removes the
modal. The lines are ten step kinds times their fields — the three-checkbox
wait, the CSS assert that refuses a malformed property, the element-state
expansion that emits several rows — every one of them behaviour with a test
behind it. Deleting them to hit a number would be deleting the feature. So the
forms are untouched and their tests are the same ones; what changed is the frame
around them.

What the frame had to grow back, having lost Radix:

- **Escape closes it**, bound on the panel. Without it the only way out of a
  half-filled composer is the mouse.
- **Add is disabled until the step will actually build.** The modal could afford
  a permanently-enabled confirm that did nothing — it stayed open, so "nothing
  happened" read as "I have not finished". A panel sitting in the list cannot: a
  button that silently declines is indistinguishable from a broken one.
- **A cap on the form's measure.** The dialog was `size="large"`; the panel
  inherits the width of the step list, which is most of the window, and an
  uncapped form puts a label and its control at opposite ends of a thousand
  pixels.

And one bug the change exposed rather than caused: the composer's reset effect
was clearing `locator`, which `TargetElementPicker` — a CHILD — had just seeded
from the picked element. A child's effects run before its parent's, so the reset
landed second and won. Invisible behind an always-enabled confirm; immediately
visible as a button that cannot be pressed. The reset is unnecessary now anyway,
because both call sites `key` the composer on the kind and the picked element,
so every open and every re-target is a fresh mount.

**6.3 Change temp against real medians.** ✅ **Done, 2026-08-12.** `Temp` now
reads `metrics-store`, per test and per step, and the step list is where it
earns its keep: forty durations, one lit row.

- **Per step, BOTH numbers are medians** — recent p50 against the p50 before it,
  not this run against a median. A single run's duration for a single step is
  noise (a GC pause, a slow DNS answer), and colouring it would light half the
  list on every run for reasons that are not about the test. What gets a colour
  is the step having CHANGED.
- **Per test, the metrics median is PREFERRED over the one §6.1 derives from run
  history, and the reason is retention.** `run-history.json` is pruned; the
  metrics DB is rolled up *before* retention runs, so after a prune it holds
  strictly more of a test's past. A median is exactly the statistic that
  degrades when its sample is silently truncated — the number stays plausible
  and stops being true. It falls back to the history median rather than to no
  median when metrics are unavailable: losing the better source must not mean
  losing the answer.
- **`testDurationTrend` counts PASSED runs only.** A run that died on step two
  is fast and one that timed out is as slow as the budget; either poisons a
  median being used to say whether a pass was unusual.

New: `testDurationTrend` in `shared/metrics-query.mjs`, returned on the existing
`metrics:slowness` channel when a test is named — the step list and the run
summary are one screen asking one question, and two channels would let them
answer it from two different reads of a database being written to while they
look.

**6.4 Stats → Cost mode.** ✅ **Done, 2026-08-12.** CI spend, manual testing
avoided, return on spend, failures caught and what flake cost — over a
spend-by-test table with an earning/review verdict. `renderer/lib/cost-model.ts`
holds the arithmetic; `renderer/main/cost-panel.tsx` renders it into Stats.

**The assumptions are ON THE PANEL, and that is the answer to this section's own
question.** A Settings row satisfies the letter of "visible and editable" and
defeats the point: a reader looking at "48m avoided" would have to know the
assumption exists, guess that Settings is where it lives, and go and find it,
before they could judge whether the figure means anything. The two inputs sit
directly under the numbers they produce, so the derivation is part of the
reading. They are also **not persisted** — they are a lens rather than a
preference, and storing them would put a third thing in the settings file to
migrate and back up in exchange for saving one number-typing.

Three refusals shaped the rest:

- **Time is never converted to money.** That needs a third assumption — an
  hourly rate for whoever would have done the testing — and it is the one this
  app has no business guessing: it varies by an order of magnitude, nobody would
  notice a bad default, and a currency figure carries far more authority than
  the guess behind it deserves. So spend is money, value is TIME, and the ratio
  is stated in its own unit (hours avoided per unit spent).
- **No currency symbol anywhere.** The rate is whatever the user typed, in
  whatever currency they think in; the app is never told which.
- **"Failures caught", not "regressions caught".** Whether a given failure was a
  regression, a broken test or flake is exactly what triage and the flake
  analysis answer probabilistically. Naming it what it is costs one word.

Flake is counted with §6.1's rule, reused rather than re-derived — a failure
directly followed by a pass with none of the recorded run settings changed. Two
definitions of flake in one app is how two surfaces end up disagreeing in front
of a user.

**6.5 Stats → Report mode.** The weekly digest preview, the channel list, and
exports (PDF / CSV / JUnit XML / public link). **This overlaps heavily with the
MCP plan's Phase 5 emit adapters** — see §7.3. Build the emitters once, surface
them here.

**6.6 Visual triage.** ✅ **Done, 2026-08-12** — Wipe, Blink, baseline
provenance, drift and the region breakdown. It was split into four PRs for the
reason B8 was split: `visual-view.tsx` is the largest file in the renderer and
the one where a change is most easily made blind.

**Why these two first.** A diff map is exact and nearly useless for triage: it
lights every changed pixel with equal weight, so a font-smoothing shift and a
button that moved 40px look identical. Wipe and Blink put the two frames in the
same PLACE instead and let the eye do the comparison it is very good at — which
is the question the three existing modes cannot answer.

- **Neither frame is treated.** Wipe CLIPS rather than fading, and Blink swaps a
  whole frame rather than cross-dissolving. The premise of both modes is that
  any difference on screen is a difference in the page, and a partly-transparent
  layer invents one. `check:crt-untreated` already pinned the rule; it binds
  hardest here.
- **Reduced motion makes Blink a MANUAL toggle rather than turning it off.** The
  alternation is not decoration on top of the information, it IS the
  information — a Blink that does not blink is a mode that does nothing. But it
  is also involuntary repeating full-frame motion, which is what somebody
  turning reduced motion on is asking not to be shown. Both are true, so the
  capability stays and only the involuntariness goes: the user swaps the frames
  at their own pace and gets the same comparison.
- **The wipe divider never reaches an edge.** Flush to one there is no handle
  left in the frame to drag it back with, and the mode reads as broken. It is
  also keyboard-driven, since it is the one control on this screen that
  otherwise needs a steady hand.
- **The modes are offered only when both frames exist.** A mode whose empty
  state is "both have to exist" is a mode that should not have been offered.

**Baseline provenance, and the three fields that do not exist.** This section
asks for "run, commit, browser, viewport, who accepted, when". Three of the six
are not in this app and were not invented: nothing reads the user's repository,
so there is no COMMIT in the picture at all; it is a single-user desktop app
with no identity, so WHO ACCEPTED would read back the same name forever; and
VIEWPORT is genuinely not on `RunRecord` — a test can carry `viewport` steps
that resize mid-run, so there is no single viewport for a run to report and
quoting the first would be wrong for any test that resizes. Fabricating them
would make the comparison less judgeable while looking like it makes it more.

What ships is the run, when it was pinned, the engine, headed-or-headless,
whether the baseline is element-scoped — and the one nobody would think to ask
for: **whether that run still exists.** Retention prunes run history and a
baseline outlives it, so a baseline can be perfectly valid and no longer
traceable to anything, which is a fact about how far the comparison can be
trusted. It says "run since pruned" rather than dropping the field, because a
provenance line missing a field reads as a rendering bug. It renders in `CRT`'s
`caption` — a prop that has existed since A3 documented as "what this frame IS"
and had no consumer until now.

**Drift — the question the screen could not ask.** Every mode above answers "did
this frame change?" for ONE run. Nothing in the app could answer the one that
follows: is it changing *repeatedly*? Those have different fixes. A frame that
changed once is a change to look at; a frame over threshold in six of the last
ten runs is a baseline nobody re-pinned, and reading it one run at a time makes
one standing problem look like six separate small ones. The strip sits under the
step row as context for the diff badge directly above it — not a finding of its
own, which is why it is twenty pixels and not a chart.

Four decisions in it, all of which could have gone wrong quietly:

- **A run with no reading is a GAP, never a zero.** A skipped step, capture off,
  a run predating the step, an `unable` comparison: none of those measured
  anything, and a zero-height bar in that slot says "this frame was identical
  that time", which is a claim nobody made. Both readings are a couple of pixels
  in the same 20px strip, so the distinction is pure geometry — and it shipped
  collapsed once already in the preview, where a floored bar was a single pixel
  and looked exactly like the dash meaning no reading. `check:drift-gap` pins
  the two properties that keep them apart: the floor is thick enough to read as
  a bar, and the gap marker floats clear of the baseline bars stand on. jsdom
  has no layout engine and the `dom` project runs with `css: false`, so nothing
  else in the gate can see it.
- **A single change is never drift.** One edit, one moved frame, one re-pin is
  the ordinary healthy case and the thing a readout like this most easily cries
  wolf about. It falls out of the two constants together — the smallest readable
  window is four runs, so one change is at most a quarter, under the 40% share —
  which means it is an emergent property rather than a branch, and a test pins
  it across the whole window range rather than at one point.
- **Bars scale to the window's own peak, not to 100%.** Diff ratios here are
  small numbers; a 4% change is a large one. Against a full axis every bar draws
  as the same flat line and the strip says nothing.
- **Only `drifting` gets a colour.** It is the one reading that asks for an
  action. A readout that colours its good news too is one where colour has
  stopped meaning anything.

It needs no new backend: one replay read per run in the window, sharing the
cache the viewer already fills, keyed per RUN so moving between steps of a run
costs nothing. That is exactly what separates it from the region breakdown,
which needs pixel analysis that does not exist yet.

**The region breakdown — "what moved".** The last piece, and the only one that
needed analysis the backend did not have. A diff map is exact and nearly useless
for triage: it lights every changed pixel with equal weight, so a paragraph of
font smoothing and a button that moved 40px look identical. This turns the same
pixels into a handful of MEASURED BOXES, ranked by how much of the change each
holds, and says each one's place in words.

- **A coarse grid, not per-pixel connected components, and that is the whole
  design.** Per-pixel components on a 1280×3000 screenshot produce hundreds of
  one- and two-pixel specks from antialiasing — which is exactly the noise this
  exists to see past, reproduced in a new shape and with a ranking that puts
  real change below it. Snapping to a grid first merges a paragraph's smoothing
  into one region and keeps a moved button its own, at 40×95 cells rather than
  3.8M pixels.
- **The changed-pixel mask is read back off the overlay pixelmatch already
  drew**, because it writes unchanged pixels as GREYSCALE and changed ones in a
  marker colour, so "r, g and b are not all equal" identifies them exactly. Both
  marker colours are now passed explicitly rather than defaulted — the invariant
  is what makes this safe, and "pixelmatch changed a default" would silently
  empty every breakdown. The alternative was a second full pixelmatch pass to
  recover information the first one already wrote down.
- **The words are half the feature.** "62% of the change, across the top" is a
  sentence somebody can check against the page; four numbers between 0 and 1 are
  not. Place is a three-by-three grid measured from each box's CENTRE — a corner
  reading calls a change through the middle of the page "top" and sends the
  reader to the wrong place, with nothing visibly wrong since the box on screen
  is still right.
- **Boxes are drawn on the DIFF map only.** Current and Baseline are the frames
  the user is asked to judge, and this screen's standing rule is that what is on
  them is what the page put there. The list switches modes for you rather than
  drawing over evidence, and picking a row scrolls its box into view — a
  full-page frame is routinely three times the height of its pane, so most
  regions are off-screen and a list that points at what you cannot see reads as
  broken.

**It uncovered a real bug in the frame overlays, which this fixes.** Masks and
the element-scope outline were positioned against the CRT's *pane* rather than
its picture — and the pane is a scroll viewport, so on any screenshot taller
than it (which is most of them) every overlay drifted by however much the frame
overflowed. `CRT` now wraps the image and its children in a plate that shrinks
to the image, which is what `StepScreenshot`'s own comment had claimed was true
since B8. The region boxes could not have been correct without it.

**6.7 Command palette (⌘K).** ✅ **Done, 2026-08-12.** Run a test, run a tag,
open a view, record, generate, reach the last failure. Ranking in
`renderer/lib/command-palette.ts`, overlay in `renderer/main/command-palette.tsx`,
and the strip's `command` slot is filled at last — half the debt
`top-strip.tsx` describes is discharged.

Four things the line above does not say:

- **"Debug the last failure" became "OPEN the last failure".** An AI debug
  session needs the script and the run output `test-detail-view` assembles, and
  a palette reaching across that boundary to fake the context would open a
  session about the wrong run. The row is named for what it does; the sparkle is
  one click away and already the right colour.
- **The scoring is deliberately small** — title prefix, then word prefix, then
  subsequence, with keyword matches always below every title match, and a
  shortness term that is a tie-break INSIDE a tier and can never cross between
  them. A palette's only real failure mode is a wrong FIRST row, because nobody
  reads the list: they type three letters and press Enter. A general fuzzy
  matcher guesses, and a palette that guesses is one where the top row moves for
  reasons the user cannot see.
- **Groups stop mattering the moment there is a query.** Browsed, the list is
  blocked into Actions / Tests / Tags / Views; searched, it is flat, because its
  order IS the answer and re-grouping would destroy what the search produced.
- **⌘K is the one shortcut in the app that does not exempt text fields.**
  `HistoryNav`'s ⌘[ does, because `[` is a character somebody might be typing;
  ⌘K produces none, and a palette you cannot open from the log search is one you
  learn not to trust.

✅ **Both slots are filled as of §6.8**, which closes the debt `top-strip.tsx`
describes. The ticker keeps the promise the empty slot was making: it renders
nothing at all when there is nothing to say.

**6.8 Job ticker.** ✅ **Done, 2026-08-12.** The top-strip live readout, and the
last of the two slots `top-strip.tsx` shipped empty in A4. The reading is in
`renderer/lib/job-ticker.ts`; the subscription and the markup are
`renderer/main/job-ticker.tsx`.

**The data source, which is §10's open question 2, is `recorder-store` — and the
codebase had already made the argument.** That store owns the live run map and
is the one provider mounted for the whole session; its own `runs:changed`
comment explains why a subscription on a route component is one that is not
listening on every other route. So: not a new provider, and not a poll.

**Which turned the batch half into a bug fix.** `batch:progress` had exactly one
subscriber — `batch-view`, a route component — so a batch you started and walked
away from was invisible from everywhere except the page you had left, and the
cache invalidation on `batch:done` only fired if you happened to be looking at
it. Both moved onto the store. The view keeps its own `batch` state, because
that variable answers a different question — "the record I am displaying", which
can be a historical one the user picked out of the list — and conflating the two
is what made the invalidation view-local in the first place.

Four decisions in the reading itself:

- **Idle renders nothing, and that took the most deciding.** An "idle" chip is a
  permanent word in the chrome that is true and useless: it costs the same
  attention every time the user looks at the strip and pays it back only in the
  rare moment it changes. Rendering nothing makes the ticker's PRESENCE the
  signal, which is what makes a glance work. A passing run gets the same
  treatment — good news does not belong in the chrome either.
- **A batch outranks its own member runs.** A batch executes tests, so its
  members are in the run map too; reporting "3 running" during a batch of eight
  is a true statement about a smaller thing than the one the user started. Its
  failure is likewise the batch's, not its last test's — three failures out of
  eight is one finding, and naming the last member to fail hides the other two.
- **Every label leads with its state, which is a truncation rule rather than a
  style one.** The strip gives this a couple of hundred pixels and test names
  exceed it. The first version put the verb last — "Login — wrong password shows
  an error failed" — where FAILED was the first thing cut, leaving a red dot
  beside what read as a name. Found on screen, not in a test.
- **A failure is a NOTICE, so it expires**, held twelve seconds and measured
  from when the run ENDED. `RunInfo` gained a `finishedAt` for it: measured from
  `startedAt`, a run longer than the hold window is already expired when it
  finishes, so the one notice this exists to give — a long run that failed while
  the user was elsewhere — is the exact one it would never give.

The pulsing dot is deliberately **not** marked `data-gl-motion="ambient"`.
`atmosphere.css` already decided this: motion that reports something is not
decoration, and its own comment names "a run status indicator that must still
pulse" as the example. Only `still` stops it.

**6.9 Boot sequence.** ✅ **Done, 2026-08-12.** The 2.6s glitch plate, on the
palette's only true black, wearing the same `echo` treatment as the Home
wordmark over a phosphor rule that fills for the hold
(`renderer/theme/shell/boot-plate.tsx`).

Three departures from the one-line brief, each of which the brief implies
without saying:

- **It is skippable, on any key or any click.** 2.6 seconds is right the first
  time and wrong the two-hundredth, and a splash you cannot get out of is the
  reason splashes have a bad name. The skip is deliberately not advertised — an
  on-screen "Skip" would make the plate look like something being endured — but
  it is the first thing anyone tries.
- **It covers the app rather than delaying it.** Everything below is mounted and
  interactive the whole time; the plate is a curtain over a running show, not a
  loading screen holding one up. It is inert to the pointer for the same reason,
  so the skip never reads as the app dropping input.
- **Reduced motion gets a different DURATION, not just a stiller plate** —
  900ms. "Render statically" taken literally is a motionless black rectangle
  held for 2.6 seconds, which does not read as a splash; it reads as a hang. The
  plate is a performance, and with the performance removed there is less to
  watch. The fill rule is drawn full and still rather than left empty, because a
  bar stuck at zero for the whole hold reads as stalled.

The `echo` treatment moved from `screens.css` to `shared.css` and is keyed on
`.gl-echo` rather than on `.gl-home-mark`: a second screen wanted it, which is
exactly the rule the four-stylesheet split states.

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

### 8.3 New guards — five `check:*` scripts

The visual contract needs source-level guards, because the failure mode is silent
and neither type-check nor jsdom observes it. Modelled on `check:text-color`,
which exists for exactly this reason.

| Check | Pins |
|---|---|
| `check:theme-tokens` ✅ | **Shipped in A2.** Every `--gl-*` referenced in `renderer/` is declared in `tokens.css` — the direct answer to the `bg-muted` / `border-token-border` class of bug — and it runs against the *emitted* stylesheet as well as source whenever `build-preview/` exists. Grew four things while being written, each guarding a silent failure: no token declared twice or empty; all three theme sheets imported *above* the `@source` lines (below them a pipeline drops them and the stylesheet loses the theme); every woff2 present **and really woff2** (a proxied download leaves an HTML error page with the right extension); and the overlay layers never taking the pointer — a full-viewport fixed layer that does makes the entire app unclickable with nothing on screen to say why. |
| `check:status-width` ✅ | **Shipped in A3.** Every status chip uses `STATUS_W`. A ragged status column is the exact thing the fixed width exists to prevent, and it degrades one row at a time. Also pins that `78px` is written down in exactly one file — a second copy will not be changed with the first. |
| `check:selection-neutral` ✅ | **Shipped in A3.** No selection treatment uses a status hue. Two tiers, from the palette's own token list: the outcome hues and violet are banned from any selection, hover or active state; `--gl-cyan` is declared "running / live / **focus**", so it is allowed on a caret or focus ring but never on a selection. |
| `check:crt-untreated` ✅ | **Shipped in A3.** No scanline, grain, vignette, filter, blend mode or shadow inside a `CRT` (the caption is exempt — it is chrome, not evidence). The z-index is asserted as a RELATIONSHIP to `--gl-z-atmo`, not as the number 610, so raising the overlays without raising the bezel fails. |

| `check:sdk-retired` ✅ | **Shipped in A5.** The surfaces already moved onto the theme layer import only structural or native-backed pieces from `@ui`. Not a style rule — a guard against erosion: a Phase B PR needs a button, `Button` is one import away and is what eighty other files still use, and a rounded control among square ones is invisible to jsdom, to type-check and to a reviewer reading a 400-line reskin diff. It asserts the mirror too (every retired surface must actually read the theme), because `pager.tsx` imports nothing from `@ui` at all and would otherwise pass vacuously. |

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
| A1 | Port `dev:web` to `main` | — | 1 day ✅ |
| A2 | Tokens, fonts, atmosphere, reduced-motion floor | A1 | 1 day ✅ |
| A3 | Fifteen primitives + tests | A2 | 3–4 days ✅ |
| A4 | Shell: top strip, rail, views nav; retire light theme | A3 | 2 days ✅ |
| A5 | Retire SDK on shared components | A3 | 2 days ✅ |
| B1–B9 | Parity reskin, one screen per PR | A4, A5 | 2–4 days each; B5 and B8 at the top of that range |
| C | Nine new features, independently | their screen's B | 1–4 days each |
| D | Routines, groups, emit adapters, capture parity | C where noted | per ROUTINES.md and the MCP plan |

Phase A landed on 2026-08-10 and unlocks everything. Phase B is the bulk. Phase C and D are
separable and can be reprioritised freely once the foundation is in.

---

## 10. Open questions

Not blocking, but each will need an answer before the PR it affects.

1. ~~**Cost mode's inputs** (§6.4)~~ — ✅ **Answered 2026-08-12: hardcoded
   defaults with a visible "edit these" affordance, in the Cost panel itself.**
   Not Settings rows. The reasoning is in §6.4 and in DECISIONS: a figure whose
   assumption lives on another screen is one the reader has to go looking for
   before they can judge it, which is the failure the requirement was written
   against.
2. ~~**The `job` ticker's data source** (§6.8)~~ — ✅ **Answered 2026-08-12:
   `recorder-store`.** Not a new provider and not a query. It already owns the
   live run map and is the one provider mounted for the whole session, and its
   own `runs:changed` comment had already made the argument: a subscription on a
   route component is not listening on any other route. The live BATCH moved
   there too, which was a bug fix — see §6.8.
3. **Report mode's "Where it goes"** (§7.3). Confirmed as emit-only? If any of it
   ever sends, that is a new egress path and needs its own decision entry.
4. ~~**`check:text-color`'s fate** (§8.3)~~ — answered for now in A5: **keep it**.
   The five shared components no longer render `Text`, but forty-odd files still
   do, so its subject is not gone until they are. Ask again per Phase B PR.
5. ~~**CLAUDE.md's directory map is stale**~~ — ✅ **Resolved in A2.**
   `renderer/components/` had already gone by the time A2 landed;
   `renderer/theme/` and the undocumented `renderer/trainer/` were added, and the
   test counts refreshed.
6. **The `ember` texture plate needs source art** (§3.5). `acid-25.jpg` is in the
   mockup zip, which is not checked in. **No longer blocking**: B1 shipped the
   plate without it — the radial falloff plus an ember wash — and the photograph
   is now a one-rule addition rather than a prerequisite. Still worth supplying.

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
