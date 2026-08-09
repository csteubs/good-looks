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
 * Pinned here rather than imported, because the SDK is outside the repo and a
 * check that cannot run without it is a check that stops running. It IS
 * verified against the SDK below whenever the SDK is present, so the copy
 * cannot drift silently — the same shape as every other pinned constant here.
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

/** Where the SDK's own declaration lives, when this machine has one. */
const SDK_TEXT_VARIANTS = [
  join(root, "../../../sdk/current/@glaze/core/components/text-variants.d.ts"),
  join(root, "../../../../../../sdk/current/@glaze/core/components/text-variants.d.ts"),
];

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// ── The pinned union still matches the SDK ────────────────────────────

{
  const found = SDK_TEXT_VARIANTS.find((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (!found) {
    // Not a failure: a machine without the SDK can still run everything below,
    // which is the part that catches real bugs.
    console.log("note the SDK is not installed here, so the pinned union was not cross-checked");
  } else {
    const src = readFileSync(found, "utf-8");
    const m = src.match(/color\?:\s*([^;]+);/);
    assert(Boolean(m), "the SDK declares a colour union that this check can read");
    if (m) {
      const declared = [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]).sort();
      const pinned = [...TEXT_COLORS].sort();
      assert(
        JSON.stringify(declared) === JSON.stringify(pinned),
        `the pinned union matches the SDK's (SDK: ${declared.join(",")})`,
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
