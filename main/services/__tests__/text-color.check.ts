// Every `<Text color="…">` names a colour the design system actually has.
//
// WHY THIS EXISTS, and it is not the reason you would guess. TypeScript should
// catch this: `Text`'s `color` is a closed union in the SDK's own declaration.
// It does not. On this tree `npm run type-check` accepts
//
//     <Text color="totally-not-a-color">x</Text>
//
// with no error — verified by compiling exactly that. The SDK's component prop
// types are not enforced here at all, so every component prop in `renderer/` is
// effectively unchecked, and a misspelt variant is invisible from the moment it
// is written.
//
// The failure is silent by construction. `cva` falls through to the variant's
// DEFAULT when handed a key it does not know, so a bad colour renders as
// ordinary body text. Nothing throws, nothing logs, and the only symptom is a
// message that was supposed to be red and isn't.
//
// That is not hypothetical either. `add-step-dialog.tsx` shipped
// `color="danger"` — a colour no version of the design system has ever had — so
// the "that isn't a valid CSS property name" warning had been rendering in the
// default foreground since it was written. It was found by the Electron port,
// whose `@ui` library IS type-checked, and only when the two trees were merged.
//
// SOURCE-LEVEL, like check:ai-debug-scroll and check:scroll-layout, because the
// alternative cannot reach it: the one control that would exercise the message
// sits behind the SDK's `Select`, which is native-menu-backed and cannot be
// driven in jsdom (see CLAUDE.md).
//
// Run with: npm run check:text-color

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

/**
 * The colours `Text` accepts.
 *
 * Pinned here rather than imported, because this check is a plain script with
 * no bundler and `renderer/ui` is TSX. It IS verified against the component
 * below, so the copy cannot drift silently — the same shape as every other
 * pinned constant here.
 */
const TEXT_COLORS = [
  "primary",
  "secondary",
  "tertiary",
  "quaternary",
  "disabled",
  "link",
  "inherit",
  "accent",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "magenta",
];

/** Where `Text`'s colour variants are declared.
 *
 *  This used to point at the SDK's `text-variants.d.ts`, outside the repo, and
 *  skip the cross-check with a note when the SDK was absent. The port off Glaze
 *  moved the component in-tree, so the file is now ALWAYS present and its
 *  absence means someone moved it — which makes skipping the wrong response.
 *  A missing source here fails, because the alternative is a check that quietly
 *  stops cross-checking anything and still prints ok. */
const TEXT_VARIANTS_SRC = join(root, "renderer/ui/primitives.tsx");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// ── The pinned union still matches the component ──────────────────────

{
  let src = "";
  try {
    src = statSync(TEXT_VARIANTS_SRC).isFile() ? readFileSync(TEXT_VARIANTS_SRC, "utf-8") : "";
  } catch {
    src = "";
  }
  assert(src !== "", `Text's variants are readable at ${TEXT_VARIANTS_SRC}`);

  if (src !== "") {
    // The `color: { … }` block of `textVariants`' cva config. Non-greedy to the
    // first closing brace at the same indent, which is how the block is written.
    const m = src.match(/\n {4}color: \{\n([\s\S]*?)\n {4}\},/);
    assert(Boolean(m), "the component declares a colour map this check can read");
    if (m) {
      const declared = [...m[1].matchAll(/^\s{6}([a-z-]+):/gm)].map((x) => x[1]).sort();
      const pinned = [...TEXT_COLORS].sort();
      assert(
        JSON.stringify(declared) === JSON.stringify(pinned),
        `the pinned union matches the component's (component: ${declared.join(",")})`,
      );
    }
  }
}

// ── Every literal colour in the renderer is one of them ───────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

{
  // Only literal `color="…"` on a Text element. An expression (`color={x}`) is
  // out of reach of a source check and is left alone rather than guessed at.
  const bad: string[] = [];
  let checked = 0;
  for (const file of walk(join(root, "renderer"))) {
    const src = readFileSync(file, "utf-8");
    for (const m of src.matchAll(/<Text\b[^>]*?\scolor="([^"]+)"/gs)) {
      checked++;
      if (!TEXT_COLORS.includes(m[1])) {
        bad.push(`${file.slice(root.length + 1)}: color="${m[1]}"`);
      }
    }
  }
  assert(checked > 0, `found ${checked} literal Text colours to check (a zero here means the regex rotted)`);
  assert(
    bad.length === 0,
    bad.length === 0
      ? "every literal Text colour is one the design system defines"
      : `unknown Text colours, which render as default body text:\n     ${bad.join("\n     ")}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll text-colour checks passed.");
