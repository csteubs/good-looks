// Source-level contracts of the Script IDE that jsdom cannot observe.
//
//   npm run check:script-ide-layout
//
// Four of them, each a failure that rendered fine in every unit test:
//
//  1. The editor's theme (`script-editor-theme.ts`) reads `--gl-*` tokens
//     through CodeMirror's `EditorView.theme`, which injects CSS at runtime —
//     so nothing `check:theme-tokens` audits ever sees those reads. A token
//     renamed in tokens.css would leave the editor reading a name that
//     resolves to nothing: transparent gutters, invisible selection, no error.
//     This check lists every `var(--gl-…)` the theme reads and finds each
//     declaration.
//  2. The editor's font size and line height come from ONE token pair; a
//     literal px in the theme would size the gutter and the content apart.
//  3. One scroll container. The theme must set `height: 100%` on the editor
//     and `overflow: auto` on `.cm-scroller`, and the host (`editor.css`) must
//     be a `min-height: 0` flex child — a second scroller around the editor
//     breaks CodeMirror's viewport virtualisation on a long spec, and jsdom
//     renders both layouts identically.
//  4. The CodeMirror host is the renderer's one lazy chunk: `script-view.tsx`
//     must reach it with `import()`, the chunk must import no `.css` (a second
//     emitted stylesheet fails `check:renderer-classes`), and the chunk must
//     stay under a byte budget so a later `import "typescript"` or a full
//     `prettier` inside it fails the gate rather than shipping.

import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

let failures = 0;
function assert(ok: boolean, label: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
}

// ── 1. every token the theme reads is declared ───────────────────────────
const theme = read("renderer/main/script-editor-theme.ts");
const tokens = read("renderer/theme/tokens.css");
const declared = new Set(Array.from(tokens.matchAll(/^\s*(--gl-[\w-]+)\s*:/gm), (m) => m[1]));
const reads = new Set(Array.from(theme.matchAll(/var\((--gl-[\w-]+)\)/g), (m) => m[1]));
assert(reads.size >= 12, `the theme reads --gl-* tokens (found ${reads.size})`);
for (const name of reads) {
  assert(declared.has(name), `tokens.css declares ${name}, which the editor theme reads`);
}

// ── 2. one size pair, no literal px for type metrics ─────────────────────
assert(/fontSize:\s*"var\(--gl-code-size\)"/.test(theme), "the theme's font size is --gl-code-size");
assert(/lineHeight:\s*"var\(--gl-code-line\)"/.test(theme), "the theme's line height is --gl-code-line");
assert(
  !/(fontSize|lineHeight):\s*"\d/.test(theme),
  "no literal px font size or line height in the theme (the gutter and content would size apart)",
);
const editorCss = read("renderer/theme/editor.css");
const host = editorCss.match(/\.gl-script-ide\s*\{([^}]*)\}/);
assert(host !== null, "editor.css declares .gl-script-ide");
if (host) {
  assert(/font-size:\s*var\(--gl-code-size\)/.test(host[1]), ".gl-script-ide sizes its font from --gl-code-size");
  assert(/line-height:\s*var\(--gl-code-line\)/.test(host[1]), ".gl-script-ide sizes its lines from --gl-code-line");
  // ── 3. one scroll container ────────────────────────────────────────────
  assert(/min-height:\s*0/.test(host[1]), ".gl-script-ide is min-height: 0, so it shrinks to the pane");
  assert(/flex:\s*1 1 auto/.test(host[1]), ".gl-script-ide fills the pane (flex: 1 1 auto)");
  assert(!/overflow/.test(host[1]), ".gl-script-ide sets no overflow of its own — the scroller is CodeMirror's");
}
const rootRule = theme.match(/"&":\s*\{([^}]*)\}/);
assert(rootRule !== null && /height:\s*"100%"/.test(rootRule[1]), "the theme gives .cm-editor height: 100%");
const scroller = theme.match(/"\.cm-scroller":\s*\{([^}]*)\}/);
assert(scroller !== null && /overflow:\s*"auto"/.test(scroller[1]), "the theme gives .cm-scroller overflow: auto");
// Rules only — the file's comments are allowed to name what they leave alone.
const editorRules = editorCss.replace(/\/\*[\s\S]*?\*\//g, "");
assert(
  !/\.cm-editor|\.cm-scroller|\.cm-content/.test(editorRules),
  "editor.css leaves CodeMirror's own elements to the theme (a stylesheet rule loses to the runtime-injected base)",
);

// ── 4. the lazy chunk ─────────────────────────────────────────────────────
const face = read("renderer/main/script-view.tsx");
assert(/React\.lazy\(\(\) => import\("\.\/script-editor-cm"\)\)/.test(face), "script-view.tsx loads the CodeMirror host with import()");
assert(!/^import .* from "\.\/script-editor-cm"/m.test(face) || /^import type/m.test(face), "script-view.tsx has no static value import of the host");
const hostSrc = read("renderer/main/script-editor-cm.tsx");
assert(!/import\s+"[^"]*\.css"/.test(hostSrc), "script-editor-cm.tsx imports no stylesheet");
assert(!/from "\.\.\/theme/.test(hostSrc), "script-editor-cm.tsx imports nothing from renderer/theme (that would pull a stylesheet)");
assert(/contentAttributes\.of\(\{[^}]*"aria-label"/.test(hostSrc), "the editor's content carries an aria-label");

// Budget: build the renderer once into a temp dir and weigh the chunk that
// carries CodeMirror. Measured 2026-08-22 at roughly 150 KB gzipped with
// basicSetup-equivalent extensions + lang-javascript + lint; the budget
// leaves room for merge/autocomplete, not for a TypeScript compiler.
const BUDGET_GZ = 260 * 1024;
const outDir = mkdtempSync(join(tmpdir(), "gl-script-ide-layout-"));
try {
  const build = spawnSync(
    "npx",
    ["vite", "build", "--logLevel", "error", "--outDir", outDir, "--emptyOutDir"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert(build.status === 0, `vite build succeeds (${(build.stderr || "").trim().split("\n").slice(-2).join(" ")})`);
  const assets = join(outDir, "assets");
  const js = readdirSync(assets).filter((f) => f.endsWith(".js"));
  const chunks = js
    .map((f) => ({ f, src: readFileSync(join(assets, f), "utf8") }))
    .filter((c) => /cm-content|cm-scroller/.test(c.src));
  assert(chunks.length >= 1, `a built chunk contains CodeMirror (found ${chunks.length})`);
  // The entry chunks (one per window) must NOT be where CodeMirror lives.
  const entries = js.filter((f) => /^(main-window|settings-window|trainer-window|recorder-chrome)-/.test(f));
  for (const e of entries) {
    const src = readFileSync(join(assets, e), "utf8");
    assert(!/cm-scroller/.test(src), `${e} does not carry CodeMirror (it is loaded on demand)`);
  }
  for (const c of chunks) {
    const gz = gzipSync(Buffer.from(c.src)).length;
    assert(gz <= BUDGET_GZ, `${c.f} is within the editor budget: ${Math.round(gz / 1024)} KB gz of ${BUDGET_GZ / 1024} KB`);
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll script-ide-layout checks passed.");
