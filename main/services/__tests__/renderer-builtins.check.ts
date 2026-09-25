// No Node builtin is reachable from the renderer.
//
// WHY THIS EXISTS. The renderer runs in a browser context (an Electron renderer
// with no Node integration, or an ordinary tab for `npm run dev:web`). Vite
// serves a Node builtin imported there as a stub that THROWS when it is
// touched, and in the dev server that happens at module load. `shared/` is
// imported by both sides, so a builtin added to a shared module the renderer
// happens to reach takes the renderer down — and nothing else notices:
//
//   • `type-check` is happy: the .d.mts beside the module says nothing about
//     what the implementation imports.
//   • Vitest is happy: its projects run under Node (jsdom included), where
//     `node:crypto` is real.
//   • `npm run build` is happy, and so is the packaged app, IF tree-shaking
//     drops the code that touches the builtin. It printed a warning and
//     shipped. That is luck, not a property.
//
// That is exactly how `shared/steps-digest.mjs` gained `node:crypto` (#325):
// `renderer/lib/run-summary.ts` imported only `comparableDigests` from it, the
// build tree-shook the hash away, and the browser preview — plus the renderer
// under `npm run dev` — died at load with "Module "node:crypto" has been
// externalized for browser compatibility". The fix split the reading half out
// into `shared/run-digest.mjs`; this check is what keeps it split.
//
// WHAT IT DOES. Walks the import graph from every renderer source file
// (relative specifiers and the three Vite aliases), across into `shared/` and
// anywhere else a path leads, and fails naming the chain for any file that
// imports a Node builtin (`node:*` or a bare builtin name). `import type` is
// skipped — it is erased before anything runs. Packages from node_modules are
// not followed: Vite bundles them, and one that needs Node is a different bug.
//
// `renderer/preload.ts` is excluded: it is the one renderer-tree file that runs
// with Node (bundled by esbuild into the preload, see scripts/build-main.mjs).
//
// ── How this check could lie, and what stops it ──────────────────────
//
// IT COULD GO BLIND: a resolver that silently stops following imports visits
// one file per entry and finds nothing. Two guards: the number of files
// reached is floored, and the detector is run first against a synthetic graph
// with a planted violation two hops away and must flag it.
//
// Run with: npm run check:renderer-builtins

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

/** The renderer's entry set: every source file under `root` that runs in the
 *  browser context. Tests run under Node and are not shipped. */
function entries(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (
        /\.(tsx?|mjs|js)$/.test(name) &&
        !/\.test\.tsx?$/.test(name) &&
        !name.endsWith(".d.ts") &&
        name !== "preload.ts"
      )
        out.push(p);
    }
  };
  walk(root);
  return out;
}

const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith("_")));

function isBuiltin(spec: string): boolean {
  if (spec.startsWith("node:")) return true;
  return BUILTINS.has(spec.split("/")[0]);
}

/** Comments out, so a builtin NAMED in prose is not read as an import. Line
 *  comments only where `//` opens the line — a mid-line `//` is as likely to
 *  be a URL inside a string as a comment. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every runtime import specifier in one file. Type-only imports and
 *  re-exports are skipped: they are erased before anything runs. */
function specifiers(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  const staticRe = /\b(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*["']([^"']+)["']/g;
  for (const m of code.matchAll(staticRe)) {
    if (m[2]) continue;
    out.push(m[4]);
  }
  for (const m of code.matchAll(/\bimport\s*["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

/** A relative or aliased specifier, resolved to a file on disk, or null for a
 *  package (not followed) or a path that does not exist. */
function resolveSpec(from: string, spec: string, aliases: Record<string, string>): string | null {
  let base: string | null = null;
  if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else {
    for (const [alias, target] of Object.entries(aliases)) {
      if (spec === alias || spec.startsWith(alias + "/")) {
        base = join(target, spec.slice(alias.length));
        break;
      }
    }
  }
  if (base === null) return null;
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    base + ".ts",
    base + ".tsx",
    base + ".mjs",
    base + ".js",
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile() && /\.(tsx?|mjs|js)$/.test(c)) return c;
  }
  return null;
}

interface Violation {
  file: string;
  builtin: string;
  chain: string[];
}

/** Breadth-first from the entries, so the chain reported is a shortest one. */
function scan(
  roots: string[],
  aliases: Record<string, string>,
): { reached: number; violations: Violation[] } {
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const r of roots) {
    if (!parent.has(r)) {
      parent.set(r, null);
      queue.push(r);
    }
  }
  const violations: Violation[] = [];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      if (isBuiltin(spec)) {
        const chain: string[] = [];
        for (let f: string | null = file; f; f = parent.get(f) ?? null) chain.unshift(f);
        violations.push({ file, builtin: spec, chain });
        continue;
      }
      const next = resolveSpec(file, spec, aliases);
      if (next && !parent.has(next)) {
        parent.set(next, file);
        queue.push(next);
      }
    }
  }
  return { reached: parent.size, violations };
}

// ── 1. The detector can fail ─────────────────────────────────────────

{
  const dir = mkdtempSync(join(tmpdir(), "renderer-builtins-"));
  try {
    mkdirSync(join(dir, "renderer"));
    mkdirSync(join(dir, "shared"));
    writeFileSync(
      join(dir, "renderer", "view.tsx"),
      [
        'import type { Hash } from "node:crypto";',
        "// a comment naming node:fs is not an import",
        'import { compare } from "../shared/compare.mjs";',
        'import { helper } from "@x/helper";',
        "export const v = compare(helper);",
      ].join("\n"),
    );
    writeFileSync(join(dir, "renderer", "helper.ts"), "export const helper = 1;\n");
    writeFileSync(
      join(dir, "shared", "compare.mjs"),
      'export { digest } from "./hash.mjs";\nexport const compare = (x) => x;\n',
    );
    writeFileSync(
      join(dir, "shared", "hash.mjs"),
      'import { createHash } from "node:crypto";\nexport const digest = () => createHash("sha256");\n',
    );
    writeFileSync(join(dir, "shared", "clean.mjs"), 'import path from "path";\n');

    const { reached, violations } = scan(entries(join(dir, "renderer")), {
      "@x": join(dir, "renderer"),
    });
    assert(
      violations.length === 1 &&
        violations[0].builtin === "node:crypto" &&
        violations[0].chain.map((f) => relative(dir, f)).join(" > ") ===
          "renderer/view.tsx > shared/compare.mjs > shared/hash.mjs",
      "detector: flags a builtin two hops away and names the chain (type imports, comments and unreached files ignored)",
    );
    assert(reached === 4, `detector: follows relative, aliased and re-export edges (reached ${reached}, expected 4)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 2. The real renderer ─────────────────────────────────────────────

// The same three aliases vite.config.ts declares. Read off the config rather
// than restated, so an alias added there is followed here.
const viteConfig = readFileSync(join(REPO, "vite.config.ts"), "utf8");
const aliases: Record<string, string> = {};
for (const m of viteConfig.matchAll(/"(@[\w-]+)":\s*path\.resolve\(here,\s*"([^"]+)"\)/g)) {
  aliases[m[1]] = join(REPO, m[2]);
}
assert(
  ["@ui", "@renderer", "@main"].every((a) => a in aliases),
  `read the Vite aliases off vite.config.ts (${Object.keys(aliases).join(", ")})`,
);

const roots = entries(join(REPO, "renderer"));
const { reached, violations } = scan(roots, aliases);

// Floored: the renderer is several hundred files and reaches dozens of shared
// modules. A resolver gone blind reaches roughly the entry count and no more.
const shared = [...new Set([...violations.map((v) => v.file)])];
assert(roots.length > 200, `renderer entry set is non-trivial (${roots.length} files)`);
assert(
  reached > roots.length + 10,
  `the walk leaves the renderer tree (${reached} files reached from ${roots.length} entries)`,
);

for (const v of violations) {
  console.error(
    `     ${v.builtin} imported by ${relative(REPO, v.file)}\n     via ${v.chain.map((f) => relative(REPO, f)).join(" > ")}`,
  );
}
assert(
  violations.length === 0,
  violations.length === 0
    ? "no Node builtin is reachable from the renderer"
    : `${violations.length} Node builtin import(s) reachable from the renderer (${shared.map((f) => relative(REPO, f)).join(", ")})`,
);

// The specific split this check was written for: the renderer compares digests
// through the crypto-free half and never reaches the hashing half.
{
  const runSummary = readFileSync(join(REPO, "renderer", "lib", "run-summary.ts"), "utf8");
  assert(
    /from "(?:\.\.\/)+shared\/run-digest\.mjs"/.test(runSummary),
    "run-summary.ts compares digests through shared/run-digest.mjs",
  );
}

console.log(failures === 0 ? "\nrenderer-builtins: OK" : `\nrenderer-builtins: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
