# Why visual diffs feel flaky — research

**Status:** research. One recommendation is a small code change; the rest is
sequencing. Written 2026-08-08 from the note *"VizDif — Make 'accept all' a
button or remove it — viz tests are flaky as s\*\*\* unless tuned finely"*, and
its follow-up *"Figure out ways to improve viz dif tuning: ergonomics, engine,
utility"*.

Companion documents: [ARCHITECTURE.md](ARCHITECTURE.md),
[DECISIONS.md](DECISIONS.md).

## The headline

**The flakiness is very unlikely to be a tuning problem.** The screenshots
themselves are taken without any of Playwright's stabilization options, so the
comparison is being handed genuinely different pixels and is reporting that
correctly. Turning the threshold up trades one wrong answer for another: it
stops flagging the animation, and it stops flagging the regression too.

`main/services/capture-fixture-source.ts:268` — the entire call:

```js
await page.screenshot({ path: path.join(ctx.dir, index + ".png"), timeout: SHOT_TIMEOUT_MS });
```

Checked against the installed Playwright's own types
(`node_modules/playwright-core/types/types.d.ts:11637`):

> `animations` — *"Defaults to `allow` that leaves animations untouched."*

So **every CSS animation, transition and Web Animation is live at the moment of
capture**. A spinner mid-rotation, a modal mid-fade, a hover transition that has
not finished, a skeleton shimmer — each produces different pixels on every run,
forever, at any threshold. Playwright ships `animations: "disabled"` precisely
for this: finite animations fast-forward to completion, infinite ones reset to
their initial state and resume after the shot.

Two things are already fine and worth not "fixing": `caret` defaults to
`"hide"`, so a blinking cursor is not the problem; and `scale` defaults to
`"device"`, which is stable on one machine (it would only matter if baselines
were ever shared between machines with different DPI).

## The second cause: nothing waits for the page to settle

Settling exists — `main/services/settle-fixture-source.ts` waits for `load`,
then network quiet, then fonts and a painted frame. But it is gated to one
speed (`main/services/playwright-runner.ts:888`):

```ts
let settling = speed === "crawl" && !rec.sourceDir;
```

So at Fast/Medium/Slow, a screenshot is taken as soon as the action's promise
resolves — which can be **before a webfont swaps** (every glyph shifts), before
a lazy image decodes (a block of pixels appears), or before layout settles after
an insert. All three read as visual changes nobody made.

The fixture's own header already names this seam: *"post-settle is the one
moment the DOM is known to be stable."* Capture is taken at a moment nobody has
claimed is stable.

## What tuning actually exists

For completeness, since the note asks about tuning specifically:

| Knob | Where | Notes |
|---|---|---|
| Per-test threshold | `TestRecord.visualThreshold`, default `0.1`% | Presets `[0, 0.1, 0.5, 1, 5, 10]` labelled Strict→Very lenient, `visual-view.tsx:409` |
| Per-pixel sensitivity | `visual-diff.ts:123`, fixed at `0.1` | Passed to pixelmatch as its `threshold`; deliberately not user-facing |
| Ignore regions | `TestRecord.visualMasks` | Normalized rects, per-step or all-steps; both images painted identically |
| Element scope | per-step Page/Element toggle | Crops both sides to the acted-on element's rect |

`pixelmatch` is called with **only** `{ threshold: sensitivity }`
(`visual-diff.ts:183`); everything else is a pixelmatch default. Worth stating
because the naming invites the wrong conclusion: the default `includeAA: false`
means *"do not skip anti-aliasing detection"*
(`node_modules/pixelmatch/index.js:7`, and the README: *"If `true`, disables
detecting and ignoring anti-aliased pixels"*). So **antialiasing is already
detected and already ignored** — subpixel text rendering is not a source of
noise here, and setting `includeAA: true` would make things worse, not better.

Note the vocabulary collision, because it makes conversations about this
confusing: the app's **threshold** is *percent of pixels allowed to differ*,
while pixelmatch's **threshold** is *per-pixel colour distance*. The app passes
its `sensitivity` into pixelmatch's `threshold`.

One more engine-level trap, and it is the one most likely to be mistaken for
flakiness: a **size mismatch degrades the whole step to `"unable"`**, not to
"changed" (`visual-diff.ts:160`). A scrollbar appearing, a responsive breakpoint,
or a page that got taller means that step silently stops comparing. `"unable"`
is not currently prominent in the UI, so a step that has quietly never been
compared looks the same as one that passes.

## Recommendations, in order

1. ✅ **Pass `animations: "disabled"`** to `page.screenshot()`. One option, in
   one place, addressing the single largest source of run-to-run difference.
   **Done on 2026-08-08** — `check:visual-pipeline` pins it, because the option
   is invisible from outside the fixture and would be easy to drop.
2. **Settle before a capture, not just at Crawl.** Either enable the settle
   fixture whenever `captureArtifacts` is on, or extract a smaller
   "wait for fonts + one painted frame" that runs before each shot. Cheaper than
   full crawl settling and targets exactly the fonts/layout class of noise.
   Costs capture time — which the app already measures, so the trade is visible
   rather than guessed at. The install order is already correct for this: the
   settle fixture patches first so capture wraps outside it, *"A screenshot
   taken before the settle would catch the page mid-load, which is both a worse
   artifact and a source of visual-diff noise."*
3. **Make `"unable"` visible.** A step that stopped comparing (size mismatch,
   missing geometry) currently looks like a step that passed. The reason string
   already exists on every one of them.
4. **Then, and only then, revisit thresholds.** With 1–3 in place the noise
   floor is a different shape, and any threshold advice given before that is
   advice about the old noise.

Explicitly **not** recommended: `includeAA: true` (see above — it would count
antialiasing as change), and exposing pixelmatch's per-pixel sensitivity as a
second user-facing slider. Two knobs that both mean "sensitivity" but measure
different things is how tuning becomes folklore.

## The accept-all question

The note offers two options: make "accept all" a button, or remove it. **It was
already removed** — deliberately, on 2026-08-04 (`DECISIONS.md:1097`, *"Removed
run-level Accept All & Re-baseline from visual diffs"*). The backend survives
and is unreachable from the UI: `acceptRunBaseline`
(`visual-baseline-ops.ts:41`) → `visual:acceptRun` → `api.visual.acceptRun` →
**zero renderer call sites**.

⚠️ `docs/ARCHITECTURE.md` described the removed button as present until
2026-08-08. Anyone reading the docs would reasonably have concluded the feature
was broken rather than withdrawn. That is now fixed, and it is probably part of
why this note exists.

**Recommendation: do not bring accept-all back yet.** The reasoning is the
headline above. While diffs flag things nobody changed, a one-click "accept
everything" is a button whose most common use is to re-baseline noise — and it
will eventually swallow a real regression on a run where the user assumed the
flags were noise again. Fix the capture, see what the flag rate looks like, and
if per-step accepting is *then* still tedious, bring it back knowing the flags
mean something.

If it does come back, the pattern is already in the same file: the a11y panel's
"Accept all for this run" (`visual-view.tsx:1198`, `a11y-panel.tsx:184`) is the
identical shape with a confirmation dialog. Note that
`renderer/main/visual-view.test.tsx`'s api mock stubs `acceptStep` but not
`acceptRun`, so it would need extending.

## Ergonomics, separately

Worth doing regardless of the above, ordered by how often they would help:

- **Say what changed, not just how much.** "0.42% of pixels changed" does not
  distinguish a moved button from a font swap. The diff already has the changed
  pixels — a bounding box of the changed region, and whether the change is
  concentrated or spread, would let someone judge from the badge.
- **Accept from the keyboard while scrubbing.** Reviewing a 20-step run means 20
  round trips through a mouse; an accept key with the timeline focused makes
  per-step accepting cheap enough that accept-all matters less.
- **Suggest a mask.** When the same region changes on the same step across
  several runs, that region is a clock, a carousel or an ad. The data to spot
  that is already on disk in the retained runs.
- **"Unable" needs to be visible.** Every failure mode degrades to
  `{state:"unable", reason}`. A step that has silently never compared is worse
  than one that fails, and the reason is already carried.
