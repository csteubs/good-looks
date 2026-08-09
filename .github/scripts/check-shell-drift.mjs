#!/usr/bin/env node
/**
 * Fail when the Glaze tree and the Electron tree drift apart.
 *
 * `main` builds on the Glaze SDK; `shell/electron` builds on stock Electron.
 * They are the same application, and 72% of their shared files are either
 * byte-identical or differ by one import specifier. The remaining difference is
 * supposed to be a short, enumerable list of shell-boundary files — everything
 * else drifting is a feature that landed on one side and not the other.
 *
 * That is not hypothetical. The trees silently reached 13 commits apart once,
 * and within an hour of being brought level a settings redesign put them apart
 * again. Drift here is invisible: both branches are green, both apps run, and
 * the only symptom is a feature that exists in one build and not the other —
 * discovered whenever someone happens to use the other build.
 *
 * Run locally:   npm run check:shell-drift
 * Against refs:  node .github/scripts/check-shell-drift.mjs origin/main HEAD
 *
 * ── After convergence ──────────────────────────────────────────────────────
 * If the two trees ever become one, the counterpart ref stops existing and this
 * exits 0 with a note. It is deliberately not an error: a guard that goes red
 * because the problem it guards against was SOLVED trains people to ignore it.
 */

import { execFileSync } from "node:child_process";
import process from "node:process";
import console from "node:console";

const [refA = "origin/main", refB = "HEAD"] = process.argv.slice(2);

/**
 * The seam. These rewrites are the entire sanctioned difference between the two
 * trees' imports, so a file differing ONLY by them is not drift.
 */
const SEAM = [
  [/@glaze\/core\/backend/g, "@shell/backend"],
  [/@glaze\/core\/components/g, "@ui"],
  [/@glaze\/core\/hooks/g, "@ui"],
  [/glaze-backend-stub/g, "shell-backend-stub"],
  // The IPC types are the one seam whose replacement is a RELATIVE path, so it
  // is spelled differently depending on the importing file's depth. Both sides
  // collapse to one marker rather than one rewriting into the other.
  [/@glaze\/core\/ipc/g, "<host-types>"],
  [/(?:\.\.\/)+lib\/host-types/g, "<host-types>"],
];

/**
 * Files the port genuinely rewrote, with the reason. Every entry is a place
 * where the two shells cannot share an implementation.
 *
 * **Adding to this list should be a deliberate act.** It is the difference
 * between "these two shells legitimately differ here" and "a feature landed on
 * one side"; if an entry cannot be given a reason in the same terms as the ones
 * below, it is probably the latter.
 */
const SHELL_BOUNDARY = new Map([
  ["main/index.ts", "main-process entry: custom scheme registration and host-handler wiring"],
  ["main/services/playwright-runner.ts", "spawns need ELECTRON_RUN_AS_NODE=1 or process.execPath relaunches the app"],
  ["main/services/recorder-service.ts", "executeJavaScriptInIsolatedWorld via the pageExecutor adapter"],
  ["main/windows/trainer-panel-window.ts", "BrowserWindow options differ between the shells"],
  ["main/windows/window-paths.ts", "app:// URLs and the preload path"],
  ["renderer/main/index.tsx", "window entry point"],
  ["renderer/settings/index.tsx", "window entry point"],
  ["renderer/trainer/index.tsx", "window entry point"],
  ["renderer/preload.ts", "the preload IS the shell boundary"],
  ["renderer/styles.css", "the Glaze framework injected its theme; the port declares Tailwind and the token bridge explicitly"],
  [
    "main/services/__tests__/text-color.check.ts",
    "cross-checks Text's pinned colour union against wherever the component is declared: the SDK's text-variants.d.ts on Glaze, renderer/ui/primitives.tsx on the port. Same 15 colours, different source of truth — and the port's is in-tree, so a missing source is a failure there rather than a skip",
  ],
]);

/**
 * Paths expected on exactly one side. Each is a shell implementation or its
 * counterpart, never application logic.
 */
const ONE_SIDED = [
  /^main\/shell\//, // the Electron adapter itself
  /^renderer\/ui\//, // the rebuilt component library
  /^renderer\/dev\//, // the browser preview (and, on the Glaze side, parity probes)
  /^main\/services\/__tests__\/(glaze|shell)-backend-stub\.ts$/, // the two names for one stub
  /^renderer\/global\.d\.ts$/,
  /^renderer\/lib\/host-types\.ts$/,
  /^renderer\/lib\/logging\.ts$/,
  /^main\/tsconfig\.json$/,
];

const SOURCE = /^(main|renderer|mcp)\/.*\.(ts|tsx|mjs|css)$/;

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
}

function refExists(ref) {
  try {
    git("rev-parse", "--verify", `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

function sourceFiles(ref) {
  return git("ls-tree", "-r", "--name-only", ref)
    .split("\n")
    .filter((f) => SOURCE.test(f));
}

function normalise(text) {
  return SEAM.reduce((s, [from, to]) => s.replace(from, to), text);
}

function oneSided(path) {
  return ONE_SIDED.some((re) => re.test(path));
}

// ── Run ──────────────────────────────────────────────────────────────────────

for (const ref of [refA, refB]) {
  if (!refExists(ref)) {
    console.log(`ok   shell drift — ${ref} does not exist; nothing to compare.`);
    console.log("     (Expected once the two trees converge into one.)");
    process.exit(0);
  }
}

const a = new Set(sourceFiles(refA));
const b = new Set(sourceFiles(refB));

const failures = [];

for (const file of [...a].sort()) {
  if (oneSided(file)) continue;
  if (!b.has(file)) {
    failures.push({ file, why: `exists on ${refA} but not ${refB}` });
    continue;
  }
  if (SHELL_BOUNDARY.has(file)) continue;

  const left = normalise(git("show", `${refA}:${file}`));
  const right = normalise(git("show", `${refB}:${file}`));
  if (left !== right) {
    failures.push({ file, why: "differs after normalising the import seam" });
  }
}

for (const file of [...b].sort()) {
  if (oneSided(file) || a.has(file)) continue;
  failures.push({ file, why: `exists on ${refB} but not ${refA}` });
}

// A boundary entry for a file that no longer differs is not a failure, but it
// is stale — it would hide real drift in that file from then on.
const stale = [...SHELL_BOUNDARY.keys()].filter((file) => {
  if (!a.has(file) || !b.has(file)) return false;
  return normalise(git("show", `${refA}:${file}`)) === normalise(git("show", `${refB}:${file}`));
});

if (failures.length === 0) {
  console.log(`ok   shell drift — ${refA} and ${refB} agree outside the shell boundary`);
  console.log(`     ${a.size} source files compared, ${SHELL_BOUNDARY.size} boundary exceptions.`);
  if (stale.length > 0) {
    console.log("");
    console.log("note the following boundary exceptions no longer differ and can be removed:");
    stale.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(0);
}

console.error(`FAIL shell drift — ${failures.length} file(s) differ between ${refA} and ${refB}\n`);
for (const { file, why } of failures) {
  console.error(`  ${file}\n      ${why}`);
}
console.error(
  "\nThese trees are the same application built on two shells. A file differing\n" +
    "here is normally a change that landed on one side only — port it across.\n\n" +
    "If it is genuinely a place the two shells cannot share an implementation,\n" +
    "add it to SHELL_BOUNDARY in this file WITH a reason.",
);
process.exit(1);
