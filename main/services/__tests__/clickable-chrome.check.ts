// The app's chrome must be clickable, and must LOOK clickable.
//
// Two properties, one root cause, and both were invisible to every other gate
// in this repo.
//
// 1. NOTHING MAY COVER THE TOP STRIP.
//
//    `renderer/main/root-view.tsx` carried a `drag-region fixed left-0 right-0
//    top-0 h-13` div — a transparent, full-width, 52px-tall window-drag overlay
//    left over from the Glaze SDK era, when the host window was frameless and
//    the web content owned the title bar.
//
//    The main window is not frameless. `main/index.ts` passes no `frame` and no
//    `titleBarStyle`, so it keeps Electron's DEFAULT native title bar: the OS
//    strip drags the window and that div dragged nothing at all.
//
//    What it did do was eat the top 52px of the app. A `fixed` element is
//    positioned, and positioned boxes paint above in-flow content REGARDLESS of
//    DOM order, so the overlay won every hit test in that band. The casualty
//    was the sidebar header, which is where the "+" (Add test) button lives:
//    clicking it did nothing, and hovering it didn't even change the cursor,
//    because the pointer never reached the button. New-test creation — the
//    app's primary entry point — was unreachable by mouse, and it read as a
//    disabled feature rather than an obstructed one.
//
// 2. BUTTONS MUST ASK FOR THE POINTER CURSOR.
//
//    `body` sets `cursor: default` app-wide and Tailwind v4's preflight sets
//    the same on `button`, so a Button that does not say `cursor-pointer`
//    silently has no hover affordance. The app's own theme layer already treats
//    pointer-on-hover as the house rule (`.gl-btn`, `.gl-menu-item`,
//    `button.gl-tag-stack` in renderer/theme/primitives.css); the ported `@ui`
//    Button had lost it.
//
// 3. THE TRAINER PAIR MUST BOTH ACCEPT THE FIRST MOUSE.
//
//    macOS spends a click on an INACTIVE window activating it, and does not
//    pass it to the web contents unless `acceptFirstMouse` is set. The trainer
//    panel floats `alwaysOnTop` over the training browser and is where the user
//    arms an assertion, adds a step or scrolls the list — so each window is
//    routinely the inactive one when the user turns to the other.
//
//    The panel had this from the day it shipped. The training browser did not,
//    for months, and the asymmetry cost far more there: in an ordinary window a
//    swallowed click is a button press to repeat, but in a RECORDER the capture
//    script's listener never fires, so the interaction is simply absent from the
//    step list while the page has visibly responded to nothing. It was reported
//    as the trainer being flaky and "clicks failing to register".
//
//    Checked as a PAIR, and the panel's `alwaysOnTop` is checked with them,
//    because that flag is the whole premise: if the panel stops floating over
//    the browser, neither window is routinely inactive and this stops being
//    required. Asserting the two flags without it would pin a conclusion whose
//    reason nobody could find.
//
// SOURCE-LEVEL, for the reason check:scroll-layout and check:ai-debug-scroll
// are: jsdom has no layout engine, so a rendered test cannot observe one
// element covering another — `library-sidebar.test.tsx` clicks that same "+"
// button and passed happily for the entire life of the bug, because in jsdom
// the overlay has no box. And the dom project runs with `css: false`, so a
// computed-cursor assertion would read "" in the fixed and broken cases alike.
//
// Property 3 is source-level for a DIFFERENT and stronger reason, and it is
// worth being honest about what this does and does not prove. `acceptFirstMouse`
// has no getter — Electron exposes it as a constructor option and nothing reads
// it back — and the behaviour it controls is the OS window server deciding what
// to do with a click on an unfocused window. e2e/ cannot reach it either:
// `_electron` drives web contents, not the macOS event stream, so there is no
// way to synthesize "a click arriving at an inactive window" from a test. This
// therefore pins the INTENT and would catch the flag being dropped; it cannot
// observe the OS honouring it. That is the whole of what automation can do
// here, which is precisely why the reasoning above is written down at length
// rather than left to the assertion.
//
// Verified to fail against the original code, both halves.
//
// Run with: npm run check:clickable-chrome

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

function read(rel: string): string {
  return readFileSync(resolve(here, rel), "utf8");
}

// ── 1. The premise: the main window has a native title bar ─────────────────
//
// Everything below depends on this. If the main window ever goes frameless,
// the web content DOES have to supply a drag region, and the right answer
// changes from "no overlay" to "an overlay that cannot swallow clicks". This
// check must be revisited then rather than silently keeping the ban.
{
  const main = read("../../../main/index.ts");
  const opts = main.slice(main.indexOf("mainWindow = new BrowserWindow({"));
  const block = opts.slice(0, opts.indexOf("});") + 3);

  assert(block.includes('windowKey: "main"'), "main/index.ts: found the main BrowserWindow options");
  assert(
    !/\bframe\s*:\s*false/.test(block),
    "main/index.ts: main window is NOT frameless — if this changes, the drag-region ban below needs revisiting",
  );
  assert(
    !/\btitleBarStyle\s*:/.test(block),
    "main/index.ts: main window keeps the default native title bar — if this changes, the drag-region ban below needs revisiting",
  );
}

// ── 2. No full-bleed drag overlay in the main window's renderer ─────────────
//
// The shape that is banned is an element that is BOTH a drag region and
// stretched across the frame: `fixed` plus a horizontal span. The `Toolbar` and
// `Sidebar` header are drag regions too and are deliberately fine — they are
// in-flow, they are the chrome, and their own buttons sit inside them.
{
  const MAIN_WINDOW_SOURCES = [
    "../../../renderer/main/root-view.tsx",
    "../../../renderer/main/router.tsx",
    "../../../renderer/main/home-view.tsx",
    "../../../renderer/main/recording-view.tsx",
  ];

  for (const rel of MAIN_WINDOW_SOURCES) {
    let src: string;
    try {
      src = read(rel);
    } catch {
      continue; // a view that no longer exists isn't a failure
    }
    const name = rel.split("/").pop();

    // Every className string mentioning drag-region, comments excluded — the
    // explanation of why the overlay is gone describes the markup it removed.
    const withoutComments = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const classLists = [...withoutComments.matchAll(/className="([^"]*)"/g)].map((m) => m[1]);

    for (const list of classLists) {
      if (!/\bdrag-region\b/.test(list)) continue;
      const spansTheFrame = /\b(?:inset-0|left-0|right-0|w-full|w-screen)\b/.test(list);
      const isOverlay = /\b(?:fixed|absolute)\b/.test(list);
      assert(
        !(isOverlay && spansTheFrame),
        `${name}: no full-bleed drag-region overlay ("${list}") — a positioned box paints above the chrome and swallows the sidebar's + button`,
      );
    }

    // The z-index lift that existed only to raise that overlay went with it.
    //
    // Checked against RAW source, comments included, and that is the whole
    // point. Tailwind v4 extracts class candidates from raw file text and does
    // NOT skip comments, so a comment that spells the utility out regenerates
    // the rule into the built CSS for a class no element carries. The dead rule
    // changes no behaviour, but it makes the built bundle lie: grepping a
    // shipped build for it then reports this fix as missing when it is present,
    // which is exactly how an hour went missing on 2026-08-09. Describe the
    // removed utility in prose; do not spell it.
    assert(
      !/:not\(:has\(\[data-toolbar\]\)\)_\.drag-region\]:z-/.test(src),
      `${name}: no drag-region z-index lift, in markup OR in a comment — Tailwind scans comments too, and the regenerated dead rule makes built CSS misreport this fix`,
    );
  }
}

// ── 3. The trainer panel keeps its drag region, and needs it ───────────────
//
// The mirror image, asserted so this check cannot be "fixed" by deleting drag
// regions everywhere: that window IS frameless-ish (`titleBarStyle:
// "hiddenInset"`), so its header is the only way to move it.
{
  const panelWindow = read("../../../main/windows/trainer-panel-window.ts");
  assert(
    /titleBarStyle:\s*"hiddenInset"/.test(panelWindow),
    "trainer-panel-window.ts: the panel window has no native title strip",
  );
  const panelView = read("../../../renderer/trainer/trainer-panel-view.tsx");
  // Matched as a class TOKEN anywhere in the list, not as the start of the
  // string. The original form (`className="drag-region…`) also failed when the
  // class merely moved — the B-phase reskin put the header's own theme class
  // first — which is a red check reporting a working drag region. A guard that
  // cries about class order is one people learn to edit rather than read.
  const dragRegion = [...panelView.matchAll(/className="([^"]*)"/g)].some((m) =>
    m[1].split(/\s+/).includes("drag-region"),
  );
  assert(
    dragRegion,
    "trainer-panel-view.tsx: keeps a drag region — with hiddenInset there is no other way to move the panel",
  );
}

// ── 4. The trainer pair both accept the first mouse ────────────────────────
//
// See property 3 in the header for the mechanism, and for what this can and
// cannot prove.
{
  const panelWindow = read("../../../main/windows/trainer-panel-window.ts");
  const recorder = read("../../../main/services/recorder-service.ts");

  // The premise. Everything below follows from the panel floating over the
  // browser; without it, neither window is routinely the inactive one.
  assert(
    /alwaysOnTop:\s*true/.test(panelWindow),
    "trainer-panel-window.ts: the panel floats over the training browser — the premise for both flags below",
  );

  /**
   * The options object of one `new BrowserWindow({...})`, found by its
   * `windowKey`.
   *
   * SCOPED, not a whole-file grep, and the difference is not pedantry: both
   * files could gain a second window, and a check that answers "the flag
   * appears somewhere in this file" would go green for a flag set on the wrong
   * one. Bounded by the first line at the construction's own indentation that
   * closes it, which is what the app's own formatting guarantees.
   */
  function windowOptions(src: string, key: string): string | null {
    const at = src.indexOf(`windowKey: "${key}"`);
    if (at === -1) return null;
    const open = src.lastIndexOf("new BrowserWindow({", at);
    if (open === -1) return null;
    const close = src.indexOf("\n    });", open);
    return close === -1 ? src.slice(open) : src.slice(open, close);
  }

  const panelOpts = windowOptions(panelWindow, "trainer-panel");
  assert(panelOpts !== null, "trainer-panel-window.ts: found the panel's BrowserWindow options");
  assert(
    !!panelOpts && /acceptFirstMouse:\s*true/.test(panelOpts),
    "trainer-panel-window.ts: the panel accepts the first mouse — otherwise the click that reaches for a tool is spent activating it",
  );

  const recorderOpts = windowOptions(recorder, "recorder");
  assert(
    recorderOpts !== null,
    "recorder-service.ts: found the training browser's BrowserWindow options",
  );
  assert(
    !!recorderOpts && /acceptFirstMouse:\s*true/.test(recorderOpts),
    "recorder-service.ts: the training browser accepts the first mouse — without it every click returning from the panel is swallowed, and in a recorder a swallowed click is a step that is never recorded",
  );
}

// ── 5. Buttons look clickable ──────────────────────────────────────────────
{
  const primitives = read("../../../renderer/ui/primitives.tsx");
  const base = primitives.match(/export const buttonVariants = cva\(\s*(?:\/\/[^\n]*\n\s*)*"([^"]*)"/);
  assert(base !== null, "primitives.tsx: found the buttonVariants base class list");
  if (base) {
    assert(
      /\bcursor-pointer\b/.test(base[1]),
      "primitives.tsx: Button asks for cursor-pointer — `body` and Tailwind v4 preflight both set `cursor: default`, so without it a button gives no hover affordance",
    );
  }

  // `body { cursor: default }` is the reason the line above is load-bearing.
  // If it goes, the comment on buttonVariants stops being true.
  const styles = read("../../../renderer/styles.css");
  assert(
    /body\s*\{[^}]*cursor:\s*default/.test(styles),
    "styles.css: body still sets `cursor: default` — the premise for Button's explicit cursor-pointer",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll clickable-chrome checks passed");
