// Every `--gl-*` the renderer reads is a token the theme layer actually
// declares — and the theme layer actually reaches the bundle.
//
// WHY THIS EXISTS. This repo has shipped the same bug twice: `bg-muted` and the
// whole `border-token-*` family emitted NO CSS AT ALL and styled nothing for
// months (DECISIONS 2026-08-06). Both were found by accident. Neither lint,
// type-check, nor any component test can see the difference between a class or
// custom property that resolves and one that does not, because the failure is
// not an error — `var(--gl-tx-l)` with a typo'd name simply produces nothing,
// the declaration is dropped, and the element inherits. The symptom is text in
// the wrong colour on one surface, which reads as a design choice.
//
// docs/REDESIGN.md §8.3 names this as the direct answer to that class of bug,
// and it is the reason the redesign gets its own token layer rather than
// borrowing the design system's: a name we declare ourselves is a name we can
// check.
//
// SOURCE-LEVEL, like check:text-color and check:scroll-layout, for the same
// reason all three are: jsdom has no cascade worth asking (the dom suite runs
// with `css: false`), so the only place this is observable is the text.
//
// Run with: npm run check:theme-tokens

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const TOKENS_CSS = join(root, "renderer/theme/tokens.css");
const STYLES_CSS = join(root, "renderer/styles.css");
const THEME_DIR = join(root, "renderer/theme");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// ── What tokens.css declares ──────────────────────────────────────────

/** Declarations only — `--gl-x: value`, not `var(--gl-x)` reads.
 *
 *  The colon is what separates the two, so the pattern requires it. Without
 *  that, a token that is only ever READ inside tokens.css (`--gl-a: var(--gl-b)`)
 *  would count as declared and this whole check would pass vacuously. */
function declaredTokens(css: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of css.matchAll(/^\s*(--gl-[a-z0-9-]+)\s*:/gm)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return counts;
}

const tokensSrc = readFileSync(TOKENS_CSS, "utf-8");
const declared = declaredTokens(tokensSrc);

assert(declared.size > 0, `tokens.css declares ${declared.size} tokens (zero here means the regex rotted)`);

{
  // A token declared twice in one `:root` is a silent overwrite: the second
  // wins, the first is dead, and both look right in review.
  const dupes = [...declared.entries()].filter(([, n]) => n > 1).map(([t, n]) => `${t} ×${n}`);
  assert(
    dupes.length === 0,
    dupes.length === 0
      ? "no token is declared twice"
      : `declared more than once, so the earlier value is dead:\n     ${dupes.join("\n     ")}`,
  );
}

{
  // An empty value parses fine and resolves to nothing at every call site.
  const empty = [...tokensSrc.matchAll(/^\s*(--gl-[a-z0-9-]+)\s*:\s*;/gm)].map((m) => m[1]);
  assert(
    empty.length === 0,
    empty.length === 0
      ? "every token has a value"
      : `declared with an empty value:\n     ${empty.join("\n     ")}`,
  );
}

// ── Every reference resolves ──────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(p)) out.push(p);
  }
  return out;
}

{
  // `var(--gl-x)` and `var(--gl-x, fallback)`, wherever they appear — a .css
  // rule, a `style={{}}` object, a template literal. All three are the same
  // string to the browser and the same failure when the name is wrong.
  const bad: string[] = [];
  let checked = 0;
  for (const file of walk(join(root, "renderer"))) {
    const src = readFileSync(file, "utf-8");
    for (const m of src.matchAll(/var\(\s*(--gl-[a-z0-9-]+)/g)) {
      // tokens.css is allowed to build one token out of another.
      if (file === TOKENS_CSS) continue;
      checked++;
      if (!declared.has(m[1])) {
        bad.push(`${file.slice(root.length + 1)}: var(${m[1]})`);
      }
    }
  }
  console.log(`note ${checked} var(--gl-*) reads across renderer/`);
  assert(
    bad.length === 0,
    bad.length === 0
      ? "every var(--gl-*) read names a token tokens.css declares"
      : `undeclared tokens — these resolve to nothing and the declaration is dropped:\n     ${bad.join("\n     ")}`,
  );
}

// ── The theme layer actually reaches the app ──────────────────────────

// A token file nobody imports declares nothing, and that failure looks exactly
// like every rule in it being wrong. All three windows load renderer/styles.css,
// so that is the one edge to check.
{
  const styles = readFileSync(STYLES_CSS, "utf-8");
  for (const sheet of ["tokens.css", "fonts.css", "atmosphere.css"]) {
    assert(
      new RegExp(`@import\\s+"\\./theme/${sheet.replace(".", "\\.")}"`).test(styles),
      `renderer/styles.css imports theme/${sheet}`,
    );
  }

  // `@import` must precede every other at-rule except `@charset`/`@layer`. The
  // SDK's build prepends its own two imports to this file, so ours only stay
  // legal while they sit above `@source` — and a dropped import is a stylesheet
  // that silently loses the theme rather than one that errors.
  //
  // Line-anchored, because the file's own header comment says the words
  // "@source directives" — matching that instead of the at-rule made this
  // assertion fail against a perfectly ordered stylesheet the first time it
  // ran, which is a good demonstration of why it is worth pinning at all.
  const firstSource = styles.search(/^\s*@source\b/m);
  const lastImport = styles.lastIndexOf('@import "./theme/');
  assert(
    firstSource === -1 || lastImport < firstSource,
    "the theme @imports sit above the first @source, so no pipeline can drop them",
  );
}

// ── The two atmosphere rules that cannot be observed anywhere else ────

// jsdom has no cascade (the dom suite runs with `css: false`), so these two
// live here. Both are cheap to break and expensive to notice.
{
  const atmo = readFileSync(join(THEME_DIR, "atmosphere.css"), "utf-8");

  // A full-viewport fixed overlay that takes the pointer makes the ENTIRE app
  // unclickable — every button, every row, everywhere, with no error and
  // nothing on screen to suggest why. It is the single worst thing this file
  // can do and it is one deleted line away.
  const layerRule = /\.gl-atmo-layer\s*\{[^}]*\}/.exec(atmo)?.[0] ?? "";
  assert(
    /pointer-events:\s*none/.test(layerRule),
    "the overlay layers never take the pointer (without this the whole app stops responding)",
  );

  // The floor, in CSS as well as in resolveAtmo(). This is the backstop for the
  // window between first paint and React mounting, when no `data-atmo` is on
  // the root yet — the one moment the resolver cannot cover.
  const floor = /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/.exec(atmo)?.[0] ?? "";
  assert(
    floor.includes('data-gl-motion="ambient"') && /animation:\s*none/.test(floor),
    "atmosphere.css stops ambient motion under prefers-reduced-motion before React mounts",
  );
  assert(
    !/\[data-atmo="still"\]/.test(floor),
    "the reduced-motion floor leaves `still` alone — it may only make the app quieter",
  );
}

// ── Every font file the CSS names is on disk ──────────────────────────

// There is deliberately no network fallback in fonts.css (see its header), so a
// mispathed woff2 does not fail loudly — it falls through to the system font and
// the app just quietly stops looking like itself.
{
  const fontsSrc = readFileSync(join(THEME_DIR, "fonts.css"), "utf-8");
  const refs = [...fontsSrc.matchAll(/url\("\.\/([^"]+\.woff2)"\)/g)].map((m) => m[1]);
  assert(refs.length > 0, `fonts.css names ${refs.length} font files`);
  const missing = refs.filter((rel) => !existsSync(join(THEME_DIR, rel)));
  assert(
    missing.length === 0,
    missing.length === 0
      ? "every font file fonts.css names is present"
      : `named but missing, so the app silently falls back to the system font:\n     ${missing.join("\n     ")}`,
  );

  // Real woff2, not an HTML error page saved with the right extension — which
  // is exactly what a proxied or rate-limited download leaves behind.
  const notWoff2 = refs.filter((rel) => {
    const p = join(THEME_DIR, rel);
    if (!existsSync(p)) return false;
    return readFileSync(p).subarray(0, 4).toString("latin1") !== "wOF2";
  });
  assert(
    notWoff2.length === 0,
    notWoff2.length === 0
      ? "every font file is a real woff2"
      : `not woff2 despite the extension:\n     ${notWoff2.join("\n     ")}`,
  );
}

// ── The emitted stylesheet, when there is one ─────────────────────────

// REDESIGN §8.3 asks for this to run against the emitted CSS as well as the
// source, because everything above is still only a claim about text files: it
// cannot see an import that a build silently drops. `npm run build:preview`
// produces one; when it has not been run, this is skipped rather than failed,
// on the same reasoning as check:text-color's SDK cross-check — a check that
// needs a build to have happened is a check that stops being run.
{
  const assetsDir = join(root, "build-preview/assets");
  const emitted = existsSync(assetsDir)
    ? readdirSync(assetsDir).filter((f) => f.endsWith(".css"))
    : [];
  if (emitted.length === 0) {
    console.log("note no build-preview/ output, so the emitted stylesheet was not cross-checked");
    console.log("     (`npm run build:preview` then re-run to include it)");
  } else {
    const css = emitted.map((f) => readFileSync(join(assetsDir, f), "utf-8")).join("\n");
    const absent = [...declared.keys()].filter((t) => !css.includes(t));
    assert(
      absent.length === 0,
      absent.length === 0
        ? `all ${declared.size} tokens survive into the emitted stylesheet`
        : `declared in tokens.css but absent from the built CSS:\n     ${absent.join("\n     ")}`,
    );
    assert(
      /@font-face/.test(css) && css.includes("Space Mono"),
      "the self-hosted @font-face rules survive into the emitted stylesheet",
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll theme-token checks passed.");
