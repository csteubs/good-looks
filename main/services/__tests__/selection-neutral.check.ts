// Selection is never a status hue.
//
// THE RULE, and it is the load-bearing one of the whole palette:
//
//   COLOUR MEANS OUTCOME — pass, fail, flaky, running. Nothing else.
//
// A selected row drawn in green is a second thing on that row claiming to
// report a result, and on a row that is both SELECTED and FAILING the two
// treatments are arguing about what the colour means. So selection gets a
// neutral treatment: white at low alpha, a lift plus a ring, no hue at all.
//
// WHY IT NEEDS A CHECK RATHER THAN A CONVENTION. The next person to add a
// selectable surface will reach for the accent colour, because that is what
// every other design system on earth does, and it will look completely
// deliberate in review — a blue selected row is not a bug anywhere else. The
// damage is not to the selected row; it is to every status chip on the screen,
// which each become slightly harder to trust.
//
// TWO TIERS, because the design's own token list distinguishes them:
//
//   • The four OUTCOME hues (phos/amber/red) and the AI accent (violet) may
//     never appear on a selection, hover or active state. Ever.
//   • `--gl-cyan` is declared as "running / live / FOCUS", so it is allowed on
//     a focus ring or a caret — but still never on a selection, where it would
//     be indistinguishable from "this row is running".
//
// Run with: npm run check:selection-neutral

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { TONE, SEL_BG, SEL_RING } from "../../../renderer/theme/tokens.js";

const root = process.cwd();

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(join(root, "renderer"));

/** Selectors that mean "this one is chosen". Cyan is banned here too. */
const SELECTION = /\[aria-pressed=|\[aria-current=|\[data-selected|\.selected\b|\.is-selected\b/;

/** Selectors that mean "the pointer or the keyboard is here". Cyan is allowed,
 *  because the palette declares it the focus colour; the outcome hues are not. */
const TRANSIENT = /:hover\b|:focus\b|:focus-visible\b|\[data-active/;

/** How a hue can be named in a stylesheet: as a token, or written out. */
function mentions(body: string, name: string, hex: string): boolean {
  return body.includes(`var(--gl-${name})`) || body.toLowerCase().includes(hex.toLowerCase());
}

// ── The neutral values really are neutral ─────────────────────────────

{
  // If these two ever gain a hue, every rule below would pass while every
  // selection in the app turned coloured. Checked first for that reason.
  for (const [label, value] of [
    ["SEL_BG", SEL_BG],
    ["SEL_RING", SEL_RING],
  ] as const) {
    assert(
      /^rgba\(255,\s*255,\s*255,/.test(value),
      `${label} is neutral white, not a hue (it is "${value}")`,
    );
  }
}

// ── No stylesheet colours a chosen state ──────────────────────────────

{
  const banned: Array<[string, string]> = [
    ["phos", TONE.phos],
    ["amber", TONE.amber],
    ["red", TONE.red],
    ["violet", TONE.violet],
  ];

  const selectionOffenders: string[] = [];
  const transientOffenders: string[] = [];
  let selectionRules = 0;

  for (const file of files.filter((f) => f.endsWith(".css"))) {
    const src = readFileSync(file, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of src.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const selector = m[1].trim();
      const body = m[2];
      const where = `${file.slice(root.length + 1)}: ${selector.replace(/\s+/g, " ")}`;

      if (SELECTION.test(selector)) {
        selectionRules++;
        for (const [name, hex] of [...banned, ["cyan", TONE.cyan] as [string, string]]) {
          if (mentions(body, name, hex)) selectionOffenders.push(`${where} → ${name}`);
        }
      } else if (TRANSIENT.test(selector)) {
        for (const [name, hex] of banned) {
          if (mentions(body, name, hex)) transientOffenders.push(`${where} → ${name}`);
        }
      }
    }
  }

  // A zero here would mean the selectors moved and this check had quietly
  // stopped looking at anything — the failure mode every source-level check has.
  assert(
    selectionRules > 0,
    `found ${selectionRules} selection rules to check (zero means the selectors were renamed)`,
  );
  assert(
    selectionOffenders.length === 0,
    selectionOffenders.length === 0
      ? "no selection treatment uses a status hue"
      : `selection is claiming an outcome it cannot know:\n     ${selectionOffenders.join("\n     ")}`,
  );
  assert(
    transientOffenders.length === 0,
    transientOffenders.length === 0
      ? "no hover or focus treatment uses an outcome hue either"
      : `hover/focus in an outcome colour, which reads as a result:\n     ${transientOffenders.join("\n     ")}`,
  );
}

// ── Nor does any component, inline ────────────────────────────────────

{
  // Narrower than the CSS pass by necessity — an inline style is an expression,
  // not a rule, and this cannot evaluate one. It catches the shape that would
  // actually be written: a ternary on `selected` reaching for a TONE.
  const offenders: string[] = [];
  for (const file of files.filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f))) {
    const src = readFileSync(file, "utf-8");
    src.split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (/\bselected\b/.test(code) && /\bTONE\.\w+/.test(code)) {
        offenders.push(`${file.slice(root.length + 1)}:${i + 1} — ${code.trim().slice(0, 80)}`);
      }
    });
  }
  assert(
    offenders.length === 0,
    offenders.length === 0
      ? "no component picks a TONE from a `selected` branch"
      : `a selected state reaching for a status hue:\n     ${offenders.join("\n     ")}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll selection-neutral checks passed.");
