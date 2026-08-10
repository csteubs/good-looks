// Every class the renderer uses actually produces CSS, and every custom
// property it reads is actually declared.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────
// This repo has now shipped the same bug three times.
//
//   1. `bg-muted` styled nothing for months (DECISIONS 2026-08-06).
//   2. The whole `border-token-*` family, likewise (same entry).
//   3. The port: twenty-eight class names and fourteen custom properties came
//      across from the SDK's vocabulary with nothing on the other end. The
//      Stats pass/fail chart drew no bars over 677 runs of data. The Script
//      view had no syntax highlighting at all. The "this step is new" and
//      "this step just ran" outlines never drew, because `outline: 1px solid
//      var(--undeclared)` is invalid at computed-value time and drops the whole
//      shorthand. And `text-secondary` — 62 call sites — resolved to a PANEL
//      FILL, giving 1.4:1 contrast that read as a deliberately dim label.
//
// All three were found by accident, by a person looking at the screen. Nothing
// else can find them: an unknown class is not an error, it emits no rule, the
// element keeps whatever it inherited, and the result looks like a design
// choice rather than a defect. `lint` sees a string. `type-check` sees a
// string. jsdom has no cascade to ask (the dom suite runs with `css: false`),
// so no component test can tell a class that works from one that does not.
//
// ── HOW ────────────────────────────────────────────────────────────────
// THE ORACLE IS THE STYLESHEET TAILWIND ACTUALLY EMITS. Not a list of expected
// names, and not a reimplementation of Tailwind's resolution rules — either
// would be a second source of truth that can agree with the code while both are
// wrong. This builds the renderer and asks the output.
//
// Run with: npm run check:renderer-classes

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const root = process.cwd();
const RENDERER = join(root, "renderer");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// ── Sources ────────────────────────────────────────────────────────────

function walk(dir: string, match: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|__tests__/.test(p)) walk(p, match, out);
    } else if (match.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Strip comments before scanning.
 *
 *  Not cosmetic: `renderer/theme/tokens.css` explains itself with `var(--gl-x)`
 *  as a stand-in name, and a checker that reads prose reports a token nobody
 *  wrote. A check with a false positive in it gets an allowlist, and an
 *  allowlist is how a check stops being read. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const tsFiles = walk(RENDERER, /\.(ts|tsx)$/);
const cssFiles = walk(RENDERER, /\.css$/);

// ── Build, and read what Tailwind emitted ──────────────────────────────

const outDir = mkdtempSync(join(tmpdir(), "glaze-renderer-classes-"));
let css = "";
try {
  execFileSync(
    "npx",
    ["vite", "build", "--logLevel", "error", "--outDir", outDir, "--emptyOutDir"],
    { cwd: root, stdio: ["ignore", "ignore", "pipe"], encoding: "utf-8" },
  );
  const assets = join(outDir, "assets");
  const sheets = readdirSync(assets).filter((f) => f.endsWith(".css"));
  // Built into a FRESH directory every run. Vite hashes filenames and does not
  // clear stale ones, so auditing a reused `build/` can read a stylesheet from
  // an older run — which during this investigation reported a fix as not having
  // worked when it had.
  assert(sheets.length === 1, `exactly one stylesheet was emitted (got ${sheets.length})`);
  css = sheets.map((f) => readFileSync(join(assets, f), "utf-8")).join("\n");
  assert(css.length > 0, "the emitted stylesheet is not empty");
} catch (err) {
  console.error("FAIL could not build the renderer to audit its CSS");
  console.error(String(err));
  process.exit(1);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

// ── 1. Classes ─────────────────────────────────────────────────────────

/** A class is "emitted" if it appears in a selector — bare (`.bg-panel`) or
 *  behind escaped variant prefixes (`.focus-visible\:ring-focus-ring`). A class
 *  used ONLY with a variant is perfectly fine, so anchoring on `.` alone would
 *  report working code. */
const emitted = new Map<string, boolean>();
function isEmitted(cls: string): boolean {
  const hit = emitted.get(cls);
  if (hit !== undefined) return hit;
  const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(?:\\.|\\\\:)${escaped}(?![a-zA-Z0-9_-])`).test(css);
  emitted.set(cls, found);
  return found;
}

/** Colour- and type-bearing utility prefixes — the families where a missing
 *  token is invisible. `(?<![\w-])` is load-bearing: without it `text-bottom`
 *  matches inside `align-text-bottom`, which is a real class. */
const UTILITY =
  /(?<![\w-])(?:bg|text|border|ring|fill|stroke|outline|divide|placeholder|accent|caret|shadow|from|to|via|decoration)(?:-[trblxyse])?-[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\w-])/g;

/** Corroboration that a string literal is a class list at all, so a CSS
 *  property name in `transition-[border-color,box-shadow]` or a sentence in a
 *  prompt is not mistaken for one. */
const LOOKS_LIKE_CLASSES =
  /(?<![\w-])(?:flex|grid|rounded|absolute|relative|inline-flex|truncate|shrink-0|w-full|h-full|min-w-0|items-center|justify-between|overflow-hidden|whitespace-pre-wrap|px-\d|py-\d|p-\d|gap-\d|size-\d|mt-\d|ml-\d)(?![\w-])/;

const missingClasses = new Map<string, string[]>();
for (const file of tsFiles) {
  const src = stripComments(readFileSync(file, "utf-8"));
  for (const m of src.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
    let literal = m[1] ?? m[2] ?? m[3] ?? "";
    // Arbitrary values carry raw CSS (`transition-[border-color,box-shadow]`,
    // `text-[var(--color-token-string)]`). Their INSIDES are not class names.
    literal = literal.replace(/\[[^\]]*\]/g, "[]");
    const tokens = [...literal.matchAll(UTILITY)].map((x) => x[0]);
    if (tokens.length === 0) continue;
    if (!tokens.some(isEmitted) && !LOOKS_LIKE_CLASSES.test(literal)) continue;
    for (const token of tokens) {
      if (isEmitted(token)) continue;
      const line = src.slice(0, m.index).split("\n").length;
      const where = `${relative(root, file)}:${line}`;
      const list = missingClasses.get(token) ?? [];
      if (list.length < 3) list.push(where);
      missingClasses.set(token, list);
    }
  }
}

for (const [cls, where] of missingClasses) {
  console.error(`     ${cls} — used at ${where.join(", ")} but no rule is emitted`);
}
assert(
  missingClasses.size === 0,
  `every utility class the renderer uses produces CSS (${missingClasses.size} do not)`,
);

// ── 1b. The theme layer's OWN class names ──────────────────────────────
//
// The audit above only looks at Tailwind's colour- and type-bearing prefixes,
// which is the right scope for the bug it was written for. But since A2 the
// renderer has a second class vocabulary — the redesign's `gl-*` layer — and it
// has exactly the same failure mode with none of the same coverage: a `.tsx`
// saying `className="gl-setting-groupp"` compiles, lints, type-checks and
// renders as an unstyled div. That is `bg-muted` again, in our own namespace.
//
// Same oracle as above, deliberately: a `gl-*` class may also be used only
// behind a variant, so `isEmitted` matches `.foo` AND `\:foo`.
//
// `gl-` is a prefix nothing else in this tree uses, so no corroboration that
// the literal "looks like classes" is needed — unlike `text-bottom`, a token
// starting `gl-` inside a string literal is a class name or a bug either way.
{
  const missingTheme = new Map<string, string[]>();
  for (const file of tsFiles) {
    const src = stripComments(readFileSync(file, "utf-8"));
    for (const m of src.matchAll(/(?<![\w-])gl-[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\w-])/g)) {
      const token = m[0];
      if (isEmitted(token)) continue;
      const line = src.slice(0, m.index).split("\n").length;
      const where = `${relative(root, file)}:${line}`;
      const list = missingTheme.get(token) ?? [];
      if (list.length < 3) list.push(where);
      missingTheme.set(token, list);
    }
  }

  for (const [cls, where] of missingTheme) {
    console.error(`     ${cls} — used at ${where.join(", ")} but no rule is emitted`);
  }
  assert(
    missingTheme.size === 0,
    `every gl-* class the renderer uses produces CSS (${missingTheme.size} do not)`,
  );

  // The pattern's own liveness. If a refactor renames the prefix or the theme
  // classes stop being written as plain literals, the loop above quietly audits
  // nothing and reports a clean pass forever.
  let seen = 0;
  for (const file of tsFiles) {
    seen += [
      ...stripComments(readFileSync(file, "utf-8")).matchAll(
        /(?<![\w-])gl-[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\w-])/g,
      ),
    ].length;
  }
  assert(seen > 50, `found ${seen} gl-* class uses to judge (a small number means the pattern rotted)`);
}

// ── 1c. No style rule nested inside another style rule ────────────────
//
// THIS IS THE HOLE THAT SHIPPED A DEAD SCREEN. A bad three-way merge spliced
// the Stats section INSIDE `.gl-detail-tabs [role="tab"] { … }`, so every
// `.gl-stats-*` rule became a descendant of a tab. Nothing caught it:
//
//   • It is VALID CSS. Nesting is supported, so the build succeeded.
//   • The audit above passed, because it asks whether a selector containing
//     the class appears in the emitted sheet — and it did, nested.
//   • The type-checker, lint and 2,195 tests have no opinion about CSS at all.
//
// The only symptom was a screen rendering unstyled, which reads as "the reskin
// was not applied" rather than as a merge artifact.
//
// So: in THIS project's stylesheets, a style rule never nests inside another
// style rule. Nesting under an AT-rule is fine and used — `@media`,
// `@supports`, `@keyframes`, `@font-face` — so the walk below tracks which kind
// of block it is inside rather than banning depth outright.
{
  /** Block kinds, innermost last. `true` means "this block is a style rule". */
  function nestedRuleIn(src: string): { line: number; selector: string } | null {
    const clean = stripComments(src);
    const stack: boolean[] = [];
    let buf = "";
    let line = 1;
    for (const ch of clean) {
      if (ch === "\n") line++;
      if (ch === "{") {
        const head = buf.trim();
        const isAtRule = head.startsWith("@");
        // A style rule opening while already inside a style rule is the bug.
        if (!isAtRule && stack.length > 0 && stack[stack.length - 1]) {
          return { line, selector: head.slice(0, 60) };
        }
        stack.push(!isAtRule);
        buf = "";
        continue;
      }
      if (ch === "}") {
        stack.pop();
        buf = "";
        continue;
      }
      if (ch === ";") {
        buf = "";
        continue;
      }
      buf += ch;
    }
    return null;
  }

  let audited = 0;
  const nested: string[] = [];
  for (const file of cssFiles) {
    if (!file.includes("/theme/")) continue;
    audited++;
    const hit = nestedRuleIn(readFileSync(file, "utf-8"));
    if (hit) nested.push(`${relative(root, file)}:${hit.line} — \`${hit.selector}\` opens inside another rule`);
  }
  assert(audited > 0, `found ${audited} theme stylesheets to audit (zero means the path filter rotted)`);
  for (const n of nested) console.error(`     ${n}`);
  assert(
    nested.length === 0,
    "no theme stylesheet nests a style rule inside another style rule (a bad merge does this, it stays valid CSS, and the nested rules silently apply to nothing)",
  );
}

// ── 2. Custom properties ───────────────────────────────────────────────

const declared = new Set<string>();
for (const file of [...cssFiles]) {
  for (const m of stripComments(readFileSync(file, "utf-8")).matchAll(
    /(--[a-zA-Z0-9_-]+)\s*:/g,
  )) {
    declared.add(m[1]);
  }
}
// Tailwind's own theme variables (`--color-*`, `--text-*`, `--font-*`, the
// default palette) are declared by the framework, not by us — take them from
// the emitted stylesheet rather than hard-coding a list.
for (const m of css.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) declared.add(m[1]);

const missingProps = new Map<string, string[]>();
for (const file of [...cssFiles, ...tsFiles]) {
  const src = stripComments(readFileSync(file, "utf-8"));
  for (const m of src.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*([,)])/g)) {
    // A `var()` WITH a fallback still renders something, so it is not a defect
    // — only a bare read of an undeclared name is.
    if (m[2] === ",") continue;
    if (declared.has(m[1])) continue;
    const line = src.slice(0, m.index).split("\n").length;
    const where = `${relative(root, file)}:${line}`;
    const list = missingProps.get(m[1]) ?? [];
    if (list.length < 3) list.push(where);
    missingProps.set(m[1], list);
  }
}

for (const [prop, where] of missingProps) {
  console.error(`     ${prop} — read at ${where.join(", ")} but never declared`);
}
assert(
  missingProps.size === 0,
  `every custom property the renderer reads is declared (${missingProps.size} are not)`,
);

// ── 3. The specific collision that caused the worst of it ──────────────
//
// `text-secondary` resolving to `var(--secondary)` — the secondary SURFACE —
// is what made 62 labels illegible while looking intentional. It came back the
// moment `--color-secondary` existed as a theme key, because Tailwind derives
// `bg-*` and `text-*` from the same one. Pinned by VALUE rather than by the
// key's absence, so it fails whatever route the wrong colour arrives by.
const textSecondary = css.match(/\.text-secondary\{([^}]*)\}/);
assert(textSecondary !== null, "`text-secondary` emits a rule");
assert(
  textSecondary !== null && !/var\(--secondary\)/.test(textSecondary[1]),
  "`text-secondary` is the text ramp, not the secondary surface colour",
);

// ── Result ─────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nrenderer classes: all good.");
