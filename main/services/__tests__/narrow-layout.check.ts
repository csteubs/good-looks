// Standalone regression check for the narrow-window contract.
//
// The bug: `minWindowWidth` was 390 while the widest toolbar needed 688px
// beside a 240px sidebar. Below ~928px the run controls left the viewport —
// `Run test` on test detail, `Run 0` on batch — and NOTHING could bring them
// back: `document.scrollWidth` equalled the viewport and no ancestor had
// `overflow-x: auto`. The app was allowing a window size its own primary
// actions fell out of.
//
// Two independent properties hold the fix, and they fail in opposite
// directions, so both are pinned:
//
//  1. The FLOOR. `minWindowWidth` must stay at or above the measured
//     requirement. Lower it and the overflow returns.
//  2. The GRIDS. Rows and option blocks must not use track/basis values that
//     can shrink below their own content. Fix the floor alone and a future
//     `grid-cols-2` reintroduces the collapse *above* the floor, where the
//     window size is no longer protecting anything.
//
// Source-level for the same reason as check:scroll-layout — jsdom has no layout
// engine, so nothing rendered here can observe a column collapsing or a control
// leaving the viewport. The widths below were measured in `npm run dev:web`
// against the real stylesheet; see docs/DECISIONS.md.
//
// Run with: npm run check:narrow-layout

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const read = (rel: string): string => readFileSync(resolve(here, rel), "utf8");

/** Measured in the browser preview against the real stylesheet:
 *  test detail's toolbar needs 688px of content pane, beside a 240px sidebar.
 *  Batch's widest row needs 678px. 928 is the binding requirement; the shipped
 *  floor carries a little slack over it. */
const MEASURED_REQUIREMENT = 928;

// ── 1. The floor ──────────────────────────────────────────────────────────
//
// `MEASURED_REQUIREMENT` IS IN CSS PIXELS, which is the unit the toolbar was
// measured in and NOT the unit a window is sized in. Those were the same number
// until the interface-scale setting shipped; they are not any more, and the
// difference runs the wrong way — a floor of 960 POINTS is 768 CSS pixels at
// 125%, comfortably under the requirement below, so the guarantee would lapse
// at exactly the setting someone turns up because they cannot read the app.
//
// So `main/index.ts` now wraps each of these in `scaled(...)`, and this check
// reads the CSS-pixel argument out of the wrapper. Both spellings are accepted:
// the point is the number, and a bare literal is still correct at 100%. What is
// NOT acceptable is the regex quietly matching neither — a floor it cannot find
// is a floor it cannot judge — which is what the `m !== null` assert is for.
{
  const main = read("../../../main/index.ts");
  /** `= 960` or `= scaled(960)` — the CSS-pixel measurement either way. */
  const cssPixels = (name: string): number | null => {
    const m = main.match(new RegExp(`const\\s+${name}\\s*=\\s*(?:scaled\\()?(\\d+)`));
    return m ? Number(m[1]) : null;
  };

  const width = cssPixels("minWindowWidth");
  assert(width !== null, "main/index.ts: declares minWindowWidth");
  if (width !== null) {
    assert(
      width >= MEASURED_REQUIREMENT,
      `main/index.ts: minWindowWidth (${width}) must be >= ${MEASURED_REQUIREMENT}, the widest toolbar's measured requirement — below it, "Run test" and "Run 0" leave the viewport with no horizontal scroll to reach them`,
    );
  }

  // The default must not sit below the floor, or the app opens at a size it
  // immediately clamps.
  const dflt = cssPixels("windowWidth");
  if (width !== null && dflt !== null) {
    assert(
      dflt >= width,
      `main/index.ts: default windowWidth (${dflt}) must be >= minWindowWidth (${width})`,
    );
  }

  // And the floor has to REACH the window as a scaled value. Declaring it in
  // CSS pixels and then handing the raw number to `new BrowserWindow` would
  // pass every assertion above while shipping the bug they describe.
  assert(
    /minWidth:\s*minWindowWidth/.test(main) && /const\s+minWindowWidth\s*=\s*scaled\(/.test(main),
    "main/index.ts: the window's minWidth is the CSS-pixel floor put through scaled()",
  );
  assert(
    /attachUiScale\(mainWindow,\s*\{/.test(main),
    "main/index.ts: the main window hands its floor to attachUiScale, so a scale change re-applies it",
  );
}

// ── 2. The grids ──────────────────────────────────────────────────────────
{
  const detail = read("../../../renderer/main/test-detail-view.tsx");
  const screens = read("../../../renderer/theme/screens.css");

  // MOVED INTO screens.css IN B5a, and this check moved with it — same shape as
  // `.gl-home` (B1) and `.gl-batch-name` (B3). Two assertions rather than one,
  // because a rule that resolves and a view that uses it are separate facts:
  // renaming the class in the .tsx leaves this rule perfect and unreferenced,
  // and it would still pass a check that only read the stylesheet.
  const runOptions = screens.match(/\.gl-run-options\s*\{([^}]*)\}/);
  assert(runOptions !== null, "screens.css: found the .gl-run-options rule");
  assert(
    /className="gl-run-options"/.test(detail),
    "test-detail-view.tsx: the run-options block still carries `gl-run-options`",
  );
  if (runOptions) {
    const body = runOptions[1];
    // The 0 floor in `minmax(0, 1fr)` is the whole bug: it lets a column shrink
    // under its own text, and these labels are overflow:visible, so the text
    // spills across its neighbour rather than clipping. `auto` ==
    // minmax(min-content, max-content) — it still wraps, it just cannot go
    // under a word.
    const tracks = body.match(/grid-template-columns:\s*([^;]+);/);
    assert(tracks !== null, ".gl-run-options: declares its column tracks explicitly");
    if (tracks) {
      assert(
        /\bauto\b/.test(tracks[1]) && !/1fr/.test(tracks[1]),
        `.gl-run-options: tracks are content-sized, not \`1fr\` (got "${tracks[1].trim()}") — a fractional track floors at zero and lets a label paint across its neighbour`,
      );
      // `max-content` forbids wrapping outright, which pushed the toolbar's own
      // minimum past this window's DEFAULT width — a rare overlap traded for a
      // guaranteed one.
      assert(
        !/max-content/.test(tracks[1]),
        ".gl-run-options: tracks are not `max-content`, which forbids wrapping and pushes the toolbar wider than the default window",
      );
    }
  }
  // Since 2026-09-26 the toggles sit in a popover behind "Options · N", and
  // that is what lets the test's name and every control share one line. The
  // panel must be OUT OF FLOW: a static panel would open by growing the head,
  // pushing the tab strip and the steps down every time it is opened — the
  // variable-height head this change exists to end.
  const panel = screens.match(/\.gl-run-options-panel\s*\{([^}]*)\}/);
  assert(
    panel !== null && /position:\s*absolute/.test(panel[1]),
    ".gl-run-options-panel: positioned absolutely, so opening it overlays the screen rather than growing the head",
  );
  assert(
    /className="gl-run-options-panel[^"]*"/.test(detail) && /hidden=\{!optionsOpen\}/.test(detail),
    "test-detail-view.tsx: the toggles live in `.gl-run-options-panel`, hidden (not unmounted) while closed",
  );
  assert(
    !/grid-cols-2|grid-cols-\[/.test(detail),
    "test-detail-view.tsx: the run-options block has not gone back to a Tailwind grid utility",
  );

  const batch = read("../../../renderer/main/batch-view.tsx");

  // Every other cell in a batch row is fixed-width, so the flexible cell absorbs
  // the entire squeeze. Without a floor that bottoms out at width:0 and the test
  // name disappears entirely rather than truncating — a row with no name at all,
  // which makes the checkbox beside it meaningless.
  //
  // THE PROPERTY MOVED, THE CONTRACT DID NOT. B3 reskinned this screen, so the
  // floor is a named rule in `renderer/theme/screens.css` rather than a Tailwind
  // class in the markup. This reads it there, and still checks the view carries
  // the class — a rule nothing uses is a guard that passes over a row it no
  // longer describes.
  const nameRule = screens.replace(/\/\*[\s\S]*?\*\//g, "").match(/\.gl-batch-name\s*\{([^}]*)\}/);
  assert(nameRule !== null, "screens.css: found the .gl-batch-name rule");
  assert(
    /className="gl-batch-name"/.test(batch),
    "batch-view.tsx: the row's test-name cell still carries `gl-batch-name`",
  );
  assert(
    nameRule !== null && /min-width:\s*(\d+)px/.test(nameRule[1]),
    ".gl-batch-name: carries a min-width floor so the name truncates instead of vanishing",
  );
  assert(
    nameRule !== null && !/min-width:\s*0\b/.test(nameRule[1]),
    ".gl-batch-name: the floor is not zero — `min-width: 0` is the bug, not the fix",
  );
}

// ── 3. Test detail's head, now that it is one row ─────────────────────────
{
  const detail = read("../../../renderer/main/test-detail-view.tsx");
  const screens = read("../../../renderer/theme/screens.css").replace(/\/\*[\s\S]*?\*\//g, "");

  // The head used to be two stacked lines — `Toolbar` puts its content over its
  // actions — so the controls always had the pane's full width to themselves
  // and §1's floor was the only thing they could outgrow. On one row they share
  // that width with the test's name, and the controls alone want about 840px
  // against the 688px this app's smallest window leaves the pane. So the row has
  // to be able to break, and something has to decide WHICH SIDE GIVES.
  //
  // Source-level for this file's usual reason: jsdom has no layout engine, so a
  // rendered test cannot observe a row that fails to wrap or a field squeezed
  // under its own value. `test-detail-view.test.tsx` owns the half that IS
  // observable there — that the identity and the controls are siblings on one
  // row, and that every control is inside the group.
  assert(
    /className="gl-detail-head-row"/.test(detail),
    "test-detail-view.tsx: the head's single row still carries `gl-detail-head-row`",
  );
  assert(
    /className="gl-detail-ident"/.test(detail),
    "test-detail-view.tsx: the name/URL column still carries `gl-detail-ident`",
  );
  assert(
    /className="gl-detail-tools"/.test(detail),
    "test-detail-view.tsx: the control group still carries `gl-detail-tools`",
  );

  const rowRule = screens.match(/\.gl-detail-head-row\s*\{([^}]*)\}/);
  assert(rowRule !== null, "screens.css: found the .gl-detail-head-row rule");
  if (rowRule) {
    assert(
      /flex-wrap:\s*wrap/.test(rowRule[1]),
      "`.gl-detail-head-row` wraps — the controls want ~840px and this app's smallest window leaves the pane 688px, so without a wrap `Run test` goes back off the viewport with no horizontal scroll to reach it",
    );
  }

  // The floor is what makes the wrap happen at all. A `flex-1 min-w-0` identity
  // column shrinks to nothing rather than pushing the controls onto their own
  // line, so the name would vanish and the controls would still be crushed —
  // the same "min-width: 0 is the bug, not the fix" as `.gl-batch-name` above.
  const identRule = screens.match(/\.gl-detail-ident\s*\{([^}]*)\}/);
  assert(identRule !== null, "screens.css: found the .gl-detail-ident rule");
  if (identRule) {
    const floor = identRule[1].match(/min-width:\s*(\d+)px/);
    assert(
      floor !== null && Number(floor[1]) > 0,
      ".gl-detail-ident: carries a non-zero min-width — it is the floor that decides when the controls wrap to their own line instead of squeezing the name to nothing",
    );
  }

  // And the controls may not grow into the slack. `flex-grow` here would stretch
  // the group across a wide window and open gaps between its own buttons, which
  // is the shape that made the band look assembled rather than designed.
  const toolsRule = screens.match(/\.gl-detail-tools\s*\{([^}]*)\}/);
  assert(toolsRule !== null, "screens.css: found the .gl-detail-tools rule");
  if (toolsRule) {
    assert(
      /flex:\s*0\s+1\s+auto/.test(toolsRule[1]),
      ".gl-detail-tools: is `flex: 0 1 auto` — it may shrink onto a narrow line but never grow into a wide one",
    );
    assert(
      /margin-inline-start:\s*auto/.test(toolsRule[1]),
      ".gl-detail-tools: keeps the auto start margin — on a line of its own there is no identity column to push it right, and without it the controls ragged-left under the name",
    );
  }

  // `Run test` and `Stop` are the same box. They are not the same word — `Stop`
  // is 31px narrower — and with the group right-aligned that difference pulled
  // every control on the band sideways the moment a run started. Both branches
  // have to carry the class: one of them alone still resizes, and it resizes in
  // the state nobody is looking at the stylesheet in.
  assert(
    (detail.match(/className="gl-detail-run"/g) ?? []).length === 2,
    "test-detail-view.tsx: BOTH the run and the stop button carry `gl-detail-run` — the band shifts sideways when a run starts if only one does",
  );
  const runRule = screens.match(/\.gl-detail-run\s*\{([^}]*)\}/);
  assert(runRule !== null, "screens.css: found the .gl-detail-run rule");
  if (runRule) {
    assert(
      /min-width:\s*\d+px/.test(runRule[1]),
      ".gl-detail-run: pins a width, so swapping `Run test` for `Stop` does not move the controls beside it",
    );
  }

  // The two fields inherit `min-width: 0` from `.gl-input`, which is right for a
  // step row and wrong here: proportional shrink takes it out of the small items
  // first in relative terms, and the engine trigger reached 61px — "Chromium"
  // rendered as "Chro…", a control that cannot show the value it reports. The
  // floors leave that shrink to the identity column, which truncates the name.
  for (const [cls, what] of [
    ["gl-detail-engine", "the engine trigger"],
    ["gl-detail-secs", "the timeout field"],
  ] as const) {
    assert(
      new RegExp(`className="[^"]*\\b${cls}\\b`).test(detail),
      `test-detail-view.tsx: ${what} still carries \`${cls}\``,
    );
    const rule = screens.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`));
    assert(rule !== null, `screens.css: found the .${cls} rule`);
    const floor = rule ? rule[1].match(/min-width:\s*(\d+)px/) : null;
    assert(
      floor !== null && Number(floor[1]) > 0,
      `.${cls}: carries a non-zero min-width floor — ${what} shares a line with ~840px of controls and \`.gl-input\` would otherwise let it shrink under its own value`,
    );
  }
}

// ── 4. Visual's run header ────────────────────────────────────────────────
{
  const visual = read("../../../renderer/main/visual-view.tsx");
  const screens = read("../../../renderer/theme/screens.css").replace(/\/\*[\s\S]*?\*\//g, "");

  // THREE BUGS OF ONE KIND, all measured in `npm run dev:web` at ordinary window
  // sizes — NOT narrow ones, which is why the floor in §1 protected none of them.
  //
  // 2026-08-11: the header was one flex row with a `min-w-0 flex-1` title column
  // followed by Re-run, Masks & baselines, the threshold and the pager, all
  // `shrink-0`. Those four took ~1000px of a 1140px pane, the title column was
  // squeezed to 141px against 168px of content, and the two badges — "passed"
  // and "1 visual change" — spilled past its right edge. `elementFromPoint` at
  // the end of the word returned the Re-run BUTTON: the outcome was being
  // painted underneath a control, unreadable.
  //
  // 2026-08-17, in the screen's full reskin: the tool group was a single rigid
  // item wider than the panel on any window under about 1500px, and the LAST
  // control — "Masks & baselines" — was simply clipped off the edge. Present in
  // the DOM, nothing to scroll, impossible to click.
  //
  // 2026-08-17, reported off the shipped reskin: the band held the verdict chip,
  // the change chip and the timestamp as well as the controls, so ITS WIDTH
  // DEPENDED ON THE RUN'S OUTCOME. A run with findings grew a chip and pushed
  // "Masks & baselines" onto a second line — a toolbar that reflows when a test
  // starts failing moves its controls exactly when somebody is reaching for
  // them. The chips moved up into the panel header, where what they displace is
  // the test NAME.
  //
  // THE ORDER OF WHAT GIVES IS THE WHOLE CONTRACT, and it is the same in all
  // three. The name may truncate — it lives in `.gl-panel-id`, which the Panel
  // primitive documents as ellipsing by definition, and the run list repeats it
  // per row. The verdict may not: it is a `StatusChip`, pinned unshrinkable by
  // `check:status-width`, inside `.gl-panel-right`, which is `flex: 0 0 auto`.
  // And the controls may not either — which is what the wrapping below buys.
  //
  // NOT A FLOOR AND NOT `overflow: hidden`. A floor big enough for the controls
  // overflows the header at this app's own minimum window size, which is the §1
  // bug reintroduced above the floor. And `overflow: hidden` stops the overlap
  // while still eating the content — a status chip that silently drops its last
  // word is the failure DECISIONS records for `.gl-status-chip` on 2026-08-09.
  //
  // Source-level for this file's usual reason: jsdom has no layout engine, so
  // nothing rendered in a test can observe a chip painted under a button, a
  // control clipped off a panel, or a band that reflows on one run and not
  // another.
  assert(
    /className="gl-visual-head"/.test(visual),
    "visual-view.tsx: found the run's tool band (.gl-visual-head)",
  );

  // ── What is ABOUT the run sits in the panel header ──────────────────────
  //
  // Matched on the `right={headline}` prop and the block that builds it, rather
  // than on "a StatusChip appears somewhere in the file": the whole point is
  // WHERE it appears, and a check that only asks whether it exists would go
  // green the moment it slid back down into the band.
  const headline = visual.match(/const headline = \(\s*<>([\s\S]*?)<\/>\s*\);/);
  assert(headline !== null, "visual-view.tsx: found the panel header's headline block");
  assert(
    /<Panel\b[\s\S]{0,600}?\bright=\{headline\}/.test(visual),
    "visual-view.tsx: the headline is in the panel header's `right` slot, which `.gl-panel-right` pins at `flex: 0 0 auto` — the verdict is never the thing that gives",
  );
  if (headline) {
    assert(
      /<StatusChip tone=\{replay\.status === "passed"/.test(headline[1]),
      "visual-view.tsx: the run's verdict is a StatusChip in the panel header, whose width neither a flex row nor a wrap may reclaim",
    );
    assert(
      /changedCount > 0/.test(headline[1]),
      "visual-view.tsx: the change count is in the panel header too — leaving it in the band is what made the band's width depend on the run's outcome",
    );
  }
  // The name AND the time are the reference, in the one cell allowed to give.
  assert(
    /<Panel\b[\s\S]{0,600}?\bid=\{`\$\{replay\.testName\} · \$\{fmtDateTime\(replay\.startedAt\)\}`\}/.test(
      visual,
    ),
    "visual-view.tsx: the test name and the run's time sit in the panel header's `id` slot, which truncates by definition — they are the cell that may give",
  );

  // ── And the band's WIDTH carries no run state, so it is one width ───────
  //
  // The run-wide accepts live here now (they were full-width banners over the
  // stage), so the band may READ the run's counts — but only to disable. What
  // it must never do is mount a control conditionally on them: a button that
  // appears when a run has findings shoves "Re-run" and "Masks & baselines"
  // sideways exactly when someone is reaching for them, which is the reflow
  // this whole section exists to prevent.
  const band = visual.match(/\{\/\* The tool band[\s\S]*?\n {6}<\/div>/);
  assert(band !== null, "visual-view.tsx: found the tool band's markup");
  if (band) {
    for (const [what, re] of [
      ["the verdict chip", /<StatusChip/],
      ["the run's timestamp", /fmtDateTime/],
      ["a control mounted on the change count", /\{changedCount\s*>\s*0\s*\?/],
    ] as const) {
      assert(
        !re.test(band[0]),
        `visual-view.tsx: the tool band does not carry ${what} — anything that appears on some runs and not others makes the toolbar reflow when a run starts failing`,
      );
    }
    // The accept is in the band, disabled-gated rather than render-gated —
    // present on every run at the same width, actionable only when the run has
    // something to accept. (Accessibility's counterpart left this screen with
    // the rest of a11y, for the Accessibility view.)
    assert(
      /disabled=\{changedCount === 0/.test(band[0]),
      "visual-view.tsx: the run-wide visual accept is in the band and DISABLED when there is nothing to accept — not unmounted, which changes the band's width",
    );
  }

  const headRule = screens.match(/\.gl-visual-head\s*\{([^}]*)\}/);
  assert(headRule !== null, "screens.css: found the .gl-visual-head rule");
  if (headRule) {
    assert(
      /flex-wrap:\s*wrap/.test(headRule[1]),
      "`.gl-visual-head` wraps — at this app's own minimum window the threshold and the two buttons still outgrow the panel together",
    );
    assert(
      !/overflow:\s*hidden/.test(headRule[1]),
      "`.gl-visual-head` does not clip — hiding the overflow would swallow a control rather than move it",
    );
  }

  const toolsRule = screens.match(/\.gl-visual-head-tools\s*\{([^}]*)\}/);
  assert(toolsRule !== null, "screens.css: found the .gl-visual-head-tools rule");
  if (toolsRule) {
    assert(
      /flex-wrap:\s*wrap/.test(toolsRule[1]),
      "`.gl-visual-head-tools` wraps — as one rigid item it is wider than the panel under ~1500px and its last control is clipped off the edge",
    );
    assert(
      !/flex:\s*0\s+0/.test(toolsRule[1]),
      "`.gl-visual-head-tools` is not a rigid item — `flex: 0 0 auto` is the shape that clipped `Masks & baselines` off the panel",
    );
  }
}


// ── 5. The trainer's tile strip and context band (Direction A, 2026-09-01) ─
//
// The trainer's old tool row was this check's blind spot: its occupant count
// swung 5→9 as transients (the armed-assert prompt, the replay result, the
// selection note) injected themselves INLINE, so the row reflowed exactly
// while the user was reaching for it — the same failure §4 bans on Visual's
// header, unguarded on the one surface where the user is mid-gesture hundreds
// of times per session. The replacement's contract has two halves:
//
//  a. The STRIP is furniture. Four ToolTiles, in both trainers, mounted in
//     every session state — disabled-gated, never render-gated — and the
//     strip does not wrap: the tiles are `flex: 1 1 0` + `min-width: 0`, so a
//     narrow pane shrinks their text, never their geometry.
//  b. The CONTEXT BAND is where every transient lives, over a RESERVED
//     min-height — a transient arriving changes what the band says, never
//     where the tiles are.
//
// Source-level like everything here: jsdom cannot see a row reflow.

{
  const TRAINERS: [string, string, string][] = [
    ["../../../renderer/main/recording-view.tsx", "gl-trainer-tiles", "recording-view"],
    ["../../../renderer/trainer/trainer-panel-view.tsx", "gl-panelwin-tiles", "trainer-panel-view"],
  ];

  for (const [rel, stripClass, label] of TRAINERS) {
    const src = read(rel);

    const stripStart = src.indexOf(stripClass);
    const zoneStart = src.indexOf("<BarContextZone");
    assert(stripStart !== -1, `${label}: renders the ${stripClass} strip`);
    assert(
      zoneStart !== -1 && zoneStart > stripStart,
      `${label}: the reserved BarContextZone sits under the strip — the transients' one home`,
    );
    const strip = src.slice(stripStart, zoneStart);

    assert(
      (strip.match(/<ToolTile/g) ?? []).length === 4,
      `${label}: the strip holds exactly four ToolTiles — membership is a constant of the session`,
    );
    assert(
      !/selection\./.test(strip) &&
        !/assertMode/.test(strip) &&
        !/replayStatus/.test(strip) &&
        !/suggestion/.test(strip),
      `${label}: no transient state reaches the strip — armed prompts, replay results, ` +
        "selection counts and the next-action chip are context-band occupants, and one of " +
        "them back in the strip is the reflow returning",
    );
    assert(
      !/selection\.ids\.length > 0 \? \(/.test(src),
      `${label}: no bar control is render-gated on the selection — the shape that made ` +
        "Create flow appear mid-reach is retired for disabled-gating",
    );
  }

  const screens = read("../../../renderer/theme/screens.css");
  for (const cls of ["gl-trainer-tiles", "gl-panelwin-tiles"]) {
    const m = screens.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`));
    assert(m !== null, `screens.css: .${cls} has a rule`);
    if (m) {
      assert(
        !/flex-wrap/.test(m[1]),
        `.${cls} does not wrap — the strip's height is part of the no-reflow contract; ` +
          "tiles shrink instead (see .gl-tooltile)",
      );
    }
  }
  for (const cls of ["gl-trainer-context", "gl-panelwin-context"]) {
    const m = screens.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`));
    assert(m !== null, `screens.css: .${cls} has a rule`);
    if (m) {
      assert(
        /min-height/.test(m[1]),
        `.${cls} reserves its height — delete the min-height and an arriving transient ` +
          "moves the strip, which is the defect this architecture replaced",
      );
      assert(
        !/flex-wrap/.test(m[1]),
        `.${cls} does not wrap — a wrap container wraps its occupants BEFORE a truncatable ` +
          "one shrinks, so the armed content grew the band 34→69px at panel width in the e2e " +
          "and moved the list; the prompt truncates instead",
      );
    }
  }

  const primitives = read("../../../renderer/theme/primitives.css");
  const tile = primitives.match(/\.gl-tooltile\s*\{([^}]*)\}/);
  assert(tile !== null, "primitives.css: .gl-tooltile has a rule");
  if (tile) {
    assert(
      /flex:\s*1 1 0/.test(tile[1]) && /min-width:\s*0/.test(tile[1]),
      ".gl-tooltile shrinks (`flex: 1 1 0` + `min-width: 0`) rather than pushing a sibling " +
        "out or wrapping the strip — the other half of the same contract",
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll narrow-layout checks passed");
