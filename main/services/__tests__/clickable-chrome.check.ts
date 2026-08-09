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
// SOURCE-LEVEL, for the reason check:scroll-layout and check:ai-debug-scroll
// are: jsdom has no layout engine, so a rendered test cannot observe one
// element covering another — `library-sidebar.test.tsx` clicks that same "+"
// button and passed happily for the entire life of the bug, because in jsdom
// the overlay has no box. And the dom project runs with `css: false`, so a
// computed-cursor assertion would read "" in the fixed and broken cases alike.
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
  assert(
    /className="drag-region[^"]*"/.test(panelView),
    "trainer-panel-view.tsx: keeps a drag region — with hiddenInset there is no other way to move the panel",
  );
}

// ── 4. Buttons look clickable ──────────────────────────────────────────────
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
