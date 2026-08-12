// Nothing treats the inside of a CRT.
//
// THE RULE:
//
//   A SCREENSHOT THE USER IS BEING ASKED TO JUDGE MUST READ EXACTLY AS THE
//   BROWSER RENDERED IT.
//
// Everything this app puts in a CRT is evidence — a visual diff, a baseline, a
// failure frame — and the entire question being asked of it is "does this look
// right?". An amber cast from our own chrome is indistinguishable from an amber
// cast in the page under test. The user files the bug against their own site,
// or worse, accepts a baseline that our vignette darkened.
//
// This is the one rule in the design system that is about correctness rather
// than taste, and it is uniquely easy to break by accident: the atmosphere
// layers are FIXED and FULL-VIEWPORT, so anything not explicitly lifted above
// them is tinted by default. The bezel sits at z-index 610 for exactly that
// reason. Someone tidying up "why is this z-index so high?" would be undoing a
// correctness guarantee that looks like a magic number.
//
// Neither jsdom nor the type-checker can see any of it — the dom suite runs
// with `css: false` — so this reads source.
//
// Run with: npm run check:crt-untreated

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const THEME = join(root, "renderer/theme");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const primitives = readFileSync(join(THEME, "primitives.css"), "utf-8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const tokens = readFileSync(join(THEME, "tokens.css"), "utf-8");
const crtSource = readFileSync(join(THEME, "primitives/crt.tsx"), "utf-8");

// ── Nothing inside the bezel is treated ───────────────────────────────

{
  /** Properties that change how the content READS. `background-image` is in the
   *  list because that is how a scanline or grain plate would arrive; a flat
   *  `background` colour is fine and is what the black backing uses. */
  const TREATMENTS = [
    "filter",
    "backdrop-filter",
    "mix-blend-mode",
    "background-image",
    "background-blend-mode",
    "opacity",
    "box-shadow",
    "text-shadow",
  ];

  // The caption is chrome, not evidence, and styles freely.
  const EXEMPT = /\.gl-crt-caption\b/;

  const offenders: string[] = [];
  let rules = 0;
  for (const m of primitives.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = m[1].trim();
    if (!/\.gl-crt\b|\.gl-crt-/.test(selector) || EXEMPT.test(selector)) continue;
    rules++;
    for (const prop of TREATMENTS) {
      if (new RegExp(`(^|[\\s;{])${prop}\\s*:`).test(m[2])) {
        offenders.push(`${selector.replace(/\s+/g, " ")} → ${prop}`);
      }
    }
  }

  assert(rules > 0, `found ${rules} CRT rules to check (zero means the classes were renamed)`);
  assert(
    offenders.length === 0,
    offenders.length === 0
      ? "no treatment is applied to anything inside the bezel"
      : `these change how the evidence reads:\n     ${offenders.join("\n     ")}`,
  );
}

// ── The bezel is lifted above the global overlays ─────────────────────

{
  const crtRule = /\.gl-crt\s*\{[^}]*\}/.exec(primitives)?.[0] ?? "";
  const z = Number(/z-index:\s*(\d+)/.exec(crtRule)?.[1] ?? Number.NaN);
  const atmo = Number(/--gl-z-atmo:\s*(\d+)/.exec(tokens)?.[1] ?? Number.NaN);

  assert(Number.isFinite(z), "the CRT declares a z-index");
  assert(Number.isFinite(atmo), "tokens.css declares --gl-z-atmo");
  assert(
    z > atmo,
    // Not "z is 610": the point is the RELATIONSHIP. Raising the atmosphere
    // layer without raising the bezel would silently start tinting evidence,
    // and neither number is wrong on its own.
    `the CRT (${z}) sits above the atmosphere layers (${atmo}), so the overlays do not fall on it`,
  );

  // …and a MODAL sits above the CRT, which is the other end of the same
  // relationship. Radix dialogs ship at Tailwind's `z-50`, so before
  // `--gl-z-modal` existed every dialog opened on the Visual screen was drawn
  // BEHIND the bezel: description clipped mid-sentence, confirm button behind a
  // screenshot. Nothing else can catch that — the dialog mounts, the
  // accessibility tree lists its buttons, every test passes — so the ordering is
  // asserted here rather than left to whoever next raises one of the numbers.
  const modal = Number(/--gl-z-modal:\s*(\d+)/.exec(tokens)?.[1] ?? Number.NaN);
  assert(Number.isFinite(modal), "tokens.css declares --gl-z-modal");
  assert(
    modal > z,
    `a modal (${modal}) sits above the CRT (${z}), so a dialog is never drawn behind a screenshot`,
  );
  assert(
    /\.gl-z-modal\s*\{[^}]*z-index:\s*var\(--gl-z-modal\)/.test(primitives),
    "the .gl-z-modal class reads the token rather than repeating the number",
  );
}

// ── The component renders no overlay of its own ───────────────────────

{
  // A sibling div inside the screen would tint the frame exactly as well as a
  // filter would, and would look like a feature rather than a mistake.
  const inside = /gl-crt-screen[\s\S]*?<\/div>/.exec(crtSource)?.[0] ?? crtSource;
  const banned = ["gl-atmo-", "scanline", "vignette", "grain"];
  const found = banned.filter((b) => inside.includes(b));
  assert(
    found.length === 0,
    found.length === 0
      ? "crt.tsx renders no overlay inside the screen"
      : `an overlay inside the bezel: ${found.join(", ")}`,
  );

  // Same rule as the stylesheet, for the inline route around it.
  const inlineTreatment = /(filter|mixBlendMode|backdropFilter|opacity)\s*:/.exec(inside);
  assert(
    inlineTreatment === null,
    inlineTreatment === null
      ? "crt.tsx applies no inline treatment either"
      : `an inline treatment in crt.tsx: ${inlineTreatment[0]}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll CRT-untreated checks passed.");
