// Standalone regression check for the emitters' redaction. REDESIGN §6.5/§7.3.
//
// AN EMITTED FILE LEAVES THE MACHINE BY DEFINITION. That is the whole premise
// of the feature — the user writes a JUnit report to attach to a CI job, a
// ticket body to paste into a tracker, an OTLP trace to load into a collector.
// So a secret that survives into one of those files is not a local leak; it is
// a secret in a file somebody is about to forward.
//
// And it would look exactly like a file that HAD been redacted. `redact` in
// `shared/emitters.mjs` is an option with a working default (`NO_REDACTION`),
// which is right for the module — it is pure, the MCP may have no secrets store,
// and a required parameter would force every caller to invent one. It is
// precisely wrong for the app: `report-emitter.ts` has `redactWithSnapshot`
// available and every call must pass it. One branch that forgets produces a
// perfectly valid file with a live credential in it, and nothing anywhere goes
// red.
//
// Neither the type-checker nor a unit test catches that. The option is optional
// by design, so omitting it type-checks; and a test of `report-emitter.ts` would
// have to stand up an encrypted secrets store and a save dialog to observe the
// difference, which is why this is source-level instead.
//
// Three things are pinned:
//
//   1. Every emitter call in the app's emit path passes a `redact:`.
//   2. None of them passes `NO_REDACTION` — the escape hatch exists for the
//      MCP and for tests, and reaching for it here would satisfy (1) while
//      defeating it.
//   3. The IPC layer has no channel that returns emitted TEXT. Redaction
//      happens in the main process; a channel handing bytes to the renderer
//      would move the payload across the boundary before it was cleaned, and
//      the redaction would then be applied to a copy.
//
// No test runner exists for these (see package.json) — plain assertions + a
// non-zero exit code stand in for one. Run with:
//   npm run check:emit-redaction

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

function read(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

// ── 1. Every emitter call redacts ────────────────────────────────────

const emitPath = "main/services/report-emitter.ts";
const service = read(emitPath);

/** The emitters, read out of the shared module rather than listed here — a
 *  hand-written list is one that stops covering the emitter added next week,
 *  which is exactly the one nobody remembers to check. */
const moduleSource = read("shared/emitters.mjs");
const emitterFns = [...moduleSource.matchAll(/^export function (\w+)\(/gm)]
  .map((m) => m[1])
  .filter((name) => name !== "emitFileName");

assert(
  emitterFns.length >= 5,
  `found ${emitterFns.length} emitter functions to check (a small number means the pattern rotted)`,
);

for (const fn of emitterFns) {
  // Every call site of the function in the service, with its argument list up
  // to the closing paren of the options object.
  const calls = [...service.matchAll(new RegExp(`\\b${fn}\\(([^;]*?)\\)`, "gs"))];
  if (calls.length === 0) {
    // Not every emitter has to be wired yet; what matters is that the ones that
    // ARE wired redact. A missing one is reported so it cannot be silent.
    console.log(`  –  ${fn} is not called from ${emitPath} yet`);
    continue;
  }
  for (const call of calls) {
    assert(
      /redact:\s*redactWithSnapshot/.test(call[1]),
      `${emitPath}: ${fn}(…) passes redact: redactWithSnapshot`,
    );
  }
}

// ── 2. The escape hatch is not used here ─────────────────────────────

/**
 * Comments stripped first, and that is not fussiness.
 *
 * The first version of this scanned the raw file and went red on the service's
 * OWN comment explaining the rule — a guard that fires on the sentence
 * documenting it is a guard that teaches people to delete the documentation.
 * What matters is whether the identifier is REACHED FOR, which is a fact about
 * code.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

assert(
  !/NO_REDACTION/.test(withoutComments(service)),
  `${emitPath} does not reach for NO_REDACTION — it exists for the MCP and for ` +
    "tests, and using it here would satisfy the check above while defeating it",
);

// ── 3. No IPC channel returns emitted text ───────────────────────────

const handlers = read("main/handlers/index.ts");
const reportChannels = [...handlers.matchAll(/ipcMain\.handle\(\s*"(report:[^"]+)"/g)].map(
  (m) => m[1],
);
assert(
  reportChannels.length > 0,
  "main/handlers/index.ts registers at least one report: channel (zero means this check is watching nothing)",
);
assert(
  reportChannels.every((c) => c === "report:emit"),
  `report: channels are limited to the emit VERB — found ${reportChannels.join(", ")}. ` +
    "A channel that returns bytes moves the payload across the IPC boundary before " +
    "redaction, which makes the redaction a formality applied to a copy",
);

const apiSource = read("renderer/lib/api.ts");
assert(
  !/invoke<\s*string\s*>\("report:/.test(apiSource),
  "renderer/lib/api.ts has no report: call typed to return a string — the renderer never holds the emitted text",
);

// ── Result ───────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall emit-redaction checks passed");
