#!/usr/bin/env node

/**
 * Thin wrapper that resolves the glaze CLI from the Glaze SDK.
 * Uses explicit SDK paths so `npm run build` etc. work without
 * relying on PATH.
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Ancestors of `from`, nearest first, so a fixed `../../..` hop can be replaced
 * by a search. The hop only holds while this file sits at the project root: run
 * from a git worktree (`.claude/worktrees/<branch>/`) and it lands three
 * directories short, so lint, type-check and build all fail with "CLI not
 * found" — which reads like a broken SDK install rather than a path arithmetic
 * problem.
 */
function ancestors(from: string): string[] {
  const out: string[] = [];
  let dir = from;
  for (;;) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

const candidates = [
  // Unchanged, and still first: in a normal checkout these hit immediately and
  // the search below never runs.
  resolve(__dirname, "../glaze-core/cli/glaze.js"),
  resolve(__dirname, "../../../sdk/current/@glaze/core/cli/glaze.js"),
  ...ancestors(__dirname).map((dir) => resolve(dir, "sdk/current/@glaze/core/cli/glaze.js")),
];

const cli = candidates.find(existsSync);
if (!cli) {
  console.error("[glaze] CLI not found. Searched:");
  candidates.forEach((p) => console.error(`  - ${p}`));
  process.exit(1);
}

await import(cli);
