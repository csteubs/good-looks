// The GitHub Action (R14) — what a source check can pin about a file no test
// executes.
//
// `.github/workflows/action-selftest.yml` is the real proof: it uses the action
// the way a stranger would (`uses: ./`) against a library built from nothing on
// a runner where this app has never been installed. That is the ONE
// configuration none of the local checks can stand up, and it is where the plan
// says R14's failure mode lives — "shipping a workflow template that cannot
// work".
//
// This covers the three things the self-test CANNOT see, all of which fail
// silently or dangerously:
//
//   1. SCRIPT INJECTION. `${{ inputs.x }}` inside a `run:` block is substituted
//      BEFORE bash parses the line, so a value carrying `; rm -rf …` is not an
//      argument, it is the next command. A workflow that passes a PR title, a
//      branch name or an issue body into this action makes every input
//      attacker-controlled. The self-test passes benign values and would never
//      notice. This repo already draws that boundary for a branch name
//      (shared/branch-paths.mjs) and for an imported project.
//   2. A SECOND SPELLING OF THE PLAYWRIGHT PIN. The version must be read from
//      package.json, never written here. `shared/browser-install.mjs` decides
//      whether a browser is present by reading the INSTALLED Playwright's
//      browsers.json, so the CLI, the installer and the detector have to be
//      looking at one tree — a literal here drifts the day the pin moves, and
//      the symptom is a run launching a browser that is not there.
//   3. FLAG DRIFT. Every selector the action offers becomes a CLI flag. An
//      unknown flag is a REFUSAL by design (`cli/args.mjs`), so a renamed flag
//      turns every run through the action into exit 3 — which the self-test
//      WOULD catch, but only for the flags it happens to exercise.
//   4. DOCUMENTED-INPUT DRIFT. An input this action accepts and no document
//      names is an input nobody can find. `retries` shipped with R24 and
//      appeared in neither `docs/GITHUB-ACTION.md` nor `docs/CI-GUIDE.md` —
//      the second of which is the IN-APP manual, so the app itself described
//      an Action it no longer had. Nothing failed: both tables are prose, and
//      prose that has stopped being true reads exactly like prose that has
//      not. Derived from `action.yml` rather than listed here, for the same
//      reason as the flag table above.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

let failures = 0;
function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}
const read = (rel: string): string => readFileSync(resolve(root, rel), "utf8");

const action = read("action.yml");
const selftest = read(".github/workflows/action-selftest.yml");

// ── 1. No input is spliced into a shell script ───────────────────────
//
// The blocks are found by indentation rather than by parsing YAML: js-yaml is
// only transitively present in this tree, and a guard resting on a transitive
// dependency is its own trap.
function runBlocks(yaml: string): string[] {
  const out: string[] = [];
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const opener = /^(\s*)run: \|\s*$/.exec(lines[i]);
    if (!opener) continue;
    const indent = opener[1].length;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() !== "" && (line.length - line.trimStart().length) <= indent) break;
      body.push(line);
    }
    out.push(body.join("\n"));
  }
  return out;
}

const blocks = runBlocks(action);
// Without this the loop below passes by iterating over nothing — the shape this
// repository keeps meeting, and the reason every scan here states its own size.
assert(blocks.length >= 3, `action.yml has run: blocks to scan (found ${blocks.length})`);

const spliced = blocks.flatMap((block, n) =>
  block
    .split("\n")
    .filter((line) => /\$\{\{\s*(inputs|github\.event|env)\./.test(line))
    .map((line) => `block ${n + 1}: ${line.trim()}`),
);
assert(
  spliced.length === 0,
  "no action input reaches a shell script through ${{ }} — they are passed as " +
    `environment variables and read as "$VAR". Found: ${spliced.join(" / ") || "none"}`,
);

// And the env blocks that replace it are really there, so the rule above cannot
// be satisfied by an action that takes no inputs at all.
assert(
  /GOOD_LOOKS_USERDATA: \$\{\{ inputs\.library \}\}/.test(action),
  "…and the library path reaches the run as GOOD_LOOKS_USERDATA, the same override the CLI and MCP honour",
);

// ── 2. The Playwright pin is READ, not written ───────────────────────

assert(
  /require\('\.\/package\.json'\)\.dependencies\['@playwright\/test'\]/.test(action),
  "the action reads its Playwright version out of package.json",
);
const literal = /@playwright\/test@\d+\.\d+/.exec(action);
assert(
  literal === null,
  `…and never writes one down (found ${literal?.[0] ?? "none"}) — a second spelling drifts the day the pin moves`,
);

// ── 3. Every flag the action emits is a flag the CLI accepts ─────────
//
// Read out of `cli/args.mjs` rather than listed here, so a flag added there is
// covered the day it lands and a flag RENAMED there fails this immediately.

const args = read("cli/args.mjs");
function flagSet(name: string): Set<string> {
  const block = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`, "s").exec(args);
  return new Set([...(block?.[1] ?? "").matchAll(/"(--[a-z-]+)"/g)].map((m) => m[1]));
}
// `run`'s two tables, plus the flags the OTHER subcommand checks inline —
// `parseInstallArgs` compares `--with-deps` directly rather than through a Set,
// and the action drives both subcommands. Derived rather than listed, because a
// hand-list is one that stops covering the flag added next week; this check
// found the omission on its own first run.
const inlineFlags = new Set(
  [...args.matchAll(/arg === "(--[a-z-]+)"/g)].map((m) => m[1]),
);
const known = new Set([...flagSet("VALUE_FLAGS"), ...flagSet("BOOL_FLAGS"), ...inlineFlags]);
assert(known.size >= 8, `cli/args.mjs's flag tables were read (found ${known.size})`);
assert(
  inlineFlags.has("--with-deps"),
  "…including the ones a subcommand checks inline, which the tables do not carry",
);

const emitted = [...action.matchAll(/args\+=\((--[a-z-]+)/g)].map((m) => m[1]);
assert(emitted.length >= 6, `action.yml emits CLI flags to check (found ${emitted.length})`);
const unknown = [...new Set(emitted)].filter((f) => !known.has(f));
assert(
  unknown.length === 0,
  `every flag the action emits is one cli/args.mjs accepts — an unknown flag is a ` +
    `REFUSAL there, so a rename turns every run through the action into exit 3. ` +
    `Found: ${unknown.join(", ") || "none"}`,
);

// ── 4. The exit contract is named, not left as a number ──────────────
//
// A CI operator reading a red step should not have to find the contract to
// learn that 2 means their selector stopped matching.
for (const code of ["0", "1", "2", "3"]) {
  assert(
    new RegExp(`^\\s*${code}\\)`, "m").test(action),
    `the action names what exit ${code} means`,
  );
}

// ── 5. The self-test uses the action, and asserts on its results ─────

assert(
  /uses: \.\/$/m.test(selftest),
  "the self-test uses the action from this repository root, the way a caller would",
);
for (const [code, what] of [
  ["1", "a suite with a failure"],
  ["2", "a selector that matched nothing"],
  ["0", "a passing selection"],
] as const) {
  assert(
    new RegExp(`\\[ "\\$code" = "${code}" \\]`).test(selftest),
    `…and asserts exit ${code} for ${what}`,
  );
}
assert(
  /grep -q 'Failed at step' results\.xml/.test(selftest),
  "…and that the JUnit message names the failing STEP — the end of the chain the " +
    "reporter, the line map and the emitter make up, which nothing else runs together",
);
// The PROPERTY, not a particular string: the fixture's scriptPath must be an
// absolute path that cannot exist on the runner. Spelled `/opt/…` rather than a
// `/Users/…` home because `check:repo-hygiene` refuses a hardcoded home
// directory tree-wide — so this asserts "absolute and foreign", which is what
// actually matters, instead of pinning a spelling that guard would reject.
const scriptPaths = [...selftest.matchAll(/"scriptPath": "([^"]+)"/g)].map((m) => m[1]);
assert(
  scriptPaths.length >= 2,
  `the self-test's fixture library declares scriptPaths (found ${scriptPaths.length})`,
);
assert(
  scriptPaths.every((p) => p.startsWith("/") && !p.startsWith("/home/runner")),
  "…and every one is an absolute path that cannot exist on the runner, which is " +
    `what a copied library carries (R10). Found: ${scriptPaths.join(", ")}`,
);

// ── 6. Every input is documented, in both places that document them ──
//
// `docs/GITHUB-ACTION.md` is the reference and `docs/CI-GUIDE.md` is the same
// table rendered INSIDE THE APP (Settings → Documentation). An input missing
// from the second is one a user of the app cannot discover at all.

function declaredInputs(yaml: string): string[] {
  const start = yaml.indexOf("\ninputs:\n");
  if (start === -1) return [];
  const rest = yaml.slice(start + 1);
  const end = rest.search(/\n[a-z]/);
  const block = end === -1 ? rest : rest.slice(0, end + 1);
  return [...block.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);
}

const inputs = declaredInputs(action);
assert(inputs.length >= 10, `action.yml declares inputs to check (found ${inputs.length})`);

for (const [doc, label] of [
  ["docs/GITHUB-ACTION.md", "the Action reference"],
  ["docs/CI-GUIDE.md", "the in-app CI guide"],
] as const) {
  const text = read(doc);
  // A row in an inputs table, not a passing mention: `| \`name\` |`. Anchoring
  // on the backticked name alone would be satisfied by a sentence elsewhere in
  // the file, which is not what a reader looking up an input finds.
  const rows = new Set(
    [...text.matchAll(/^\| `([a-z][a-z0-9-]*)` \|/gm)].map((m) => m[1]),
  );
  assert(rows.size >= 10, `${label} has an inputs table to read (found ${rows.size} rows)`);
  const undocumented = inputs.filter((name) => !rows.has(name));
  assert(
    undocumented.length === 0,
    `every input action.yml accepts has a row in ${label} — an input no document ` +
      `names is one nobody can find. Missing: ${undocumented.join(", ") || "none"}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll GitHub Action checks passed.");
