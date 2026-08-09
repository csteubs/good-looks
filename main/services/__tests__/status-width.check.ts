// Every status chip is exactly `STATUS_W` wide.
//
// WHY THIS IS A CHECK AND NOT A CODE REVIEW ITEM. The fixed width is what gives
// a column of status chips ONE EDGE instead of a ragged one, and that is the
// difference between a table you can scan down and a table you have to read.
// It fails ONE ROW AT A TIME: a single chip sized to its own content looks
// entirely correct in isolation, in a screenshot, and in the component test
// that renders it alone. It only reads as wrong beside the others, and by then
// nobody remembers which change did it.
//
// Nothing else in the toolchain can see this. jsdom has no layout engine, so
// `getBoundingClientRect()` returns zeros and a width assertion in a component
// test proves nothing while passing (CLAUDE.md). The dom suite also runs with
// `css: false`, so there is no cascade to ask. Source is the only place the
// answer exists.
//
// Run with: npm run check:status-width

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { STATUS_W } from "../../../renderer/theme/tokens.js";

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
const cssFiles = files.filter((f) => f.endsWith(".css"));
const tsFiles = files.filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

// ── The chip reads the token, rather than repeating the number ────────

{
  const primitives = readFileSync(join(THEME, "primitives.css"), "utf-8");
  const rule = /\.gl-status-chip\s*\{[^}]*\}/.exec(primitives)?.[0] ?? "";
  assert(rule !== "", "primitives.css declares a .gl-status-chip rule");
  assert(
    /width:\s*var\(--gl-status-w\)/.test(rule),
    "the status chip takes its width from --gl-status-w, not from a repeated literal",
  );
}

// ── Nobody overrides it ───────────────────────────────────────────────

{
  // A second rule setting a width on the chip wins by order or specificity and
  // is invisible from the primitive's own file.
  const offenders: string[] = [];
  for (const file of cssFiles) {
    const src = readFileSync(file, "utf-8");
    for (const m of src.matchAll(/([^{}]*gl-status-chip[^{}]*)\{([^}]*)\}/g)) {
      const selector = m[1].trim();
      const body = m[2];
      if (!/(^|[\s;])(min-|max-)?width\s*:/.test(body)) continue;
      if (/width:\s*var\(--gl-status-w\)/.test(body)) continue;
      offenders.push(`${file.slice(root.length + 1)}: ${selector}`);
    }
  }
  assert(
    offenders.length === 0,
    offenders.length === 0
      ? "no stylesheet re-sizes the status chip"
      : `these set their own width on a status chip, so the column goes ragged:\n     ${offenders.join("\n     ")}`,
  );
}

{
  // An inline width on a `<StatusChip>` beats every stylesheet there is.
  const offenders: string[] = [];
  for (const file of tsFiles) {
    const src = readFileSync(file, "utf-8");
    for (const m of src.matchAll(/<StatusChip\b[^>]*>/gs)) {
      if (/\bstyle=|\bwidth[=:]/.test(m[0])) {
        offenders.push(`${file.slice(root.length + 1)}: ${m[0].slice(0, 70)}…`);
      }
    }
  }
  assert(
    offenders.length === 0,
    offenders.length === 0
      ? "no call site sizes a StatusChip itself"
      : `an inline width beats every stylesheet:\n     ${offenders.join("\n     ")}`,
  );
}

// ── The number appears in exactly one place ───────────────────────────

{
  // `78px` written anywhere else is a second copy of the contract, and the two
  // will not be changed together.
  const offenders: string[] = [];
  for (const file of [...cssFiles, ...tsFiles]) {
    if (file.endsWith("theme/tokens.css") || file.endsWith("theme/tokens.ts")) continue;
    const src = readFileSync(file, "utf-8");
    src.split("\n").forEach((line, i) => {
      // Strip comments first: the reasoning around these rules names the number
      // constantly, and a check that flagged its own explanation would be
      // turned off within a week.
      const code = line.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");
      if (new RegExp(`\\b${STATUS_W}px\\b`).test(code)) {
        offenders.push(`${file.slice(root.length + 1)}:${i + 1}`);
      }
    });
  }
  assert(
    offenders.length === 0,
    offenders.length === 0
      ? `${STATUS_W}px is written down in exactly one place`
      : `a second copy of the status width, which will not be changed with the first:\n     ${offenders.join("\n     ")}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll status-width checks passed.");
