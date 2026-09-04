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

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

// ── 2b. And no OTHER file in main/ emits behind its back ─────────────
//
// Sections 1 and 2 watch one file, which was right while one file was the only
// way to obtain bytes. `emitReportTo` (R1) makes the emit path reachable
// without a dialog, so the next caller — a run-end report, an MCP tool, the CLI
// — is the one that can quietly import `junitXml` directly and skip everything
// above. The rule in docs/plans/test-runner-improvements.md §3.5 is that every
// new egress path extends this check in the same commit that adds it; this is
// that extension, and it is written to cover callers that do not exist yet.

/** Every `.ts` under `main/`, minus tests and the check scripts themselves. */
function mainSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      mainSources(full, out);
    } else if (entry.name.endsWith(".ts") && !/\.(test|check)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const emitAbsolute = resolve(root, emitPath);
const otherCallers: string[] = [];
for (const file of mainSources(resolve(root, "main"))) {
  if (file === emitAbsolute) continue;
  const source = withoutComments(read(file.slice(root.length + 1)));
  // The import is the tell, not the call: a file that does not import an
  // emitter cannot call one, and matching bare names would flag any local
  // function that happened to share a spelling.
  const importsEmitters = /from\s+["'][^"']*shared\/emitters\.mjs["']/.test(source);
  if (!importsEmitters) continue;
  // A type-only import carries no runtime reach — `EmitterId` is the whole
  // point of the module's `.d.mts` and every handler that names an emitter has
  // it. Only a VALUE import can emit.
  const valueImport = new RegExp(
    String.raw`import\s+(?!type\s)[^;]*?from\s+["'][^"']*shared/emitters\.mjs["']`,
    "s",
  ).test(source);
  if (!valueImport) continue;
  if (emitterFns.some((fn) => new RegExp(String.raw`\b${fn}\s*\(`).test(source))) {
    otherCallers.push(file.slice(root.length + 1));
  }
}

assert(
  otherCallers.length === 0,
  "no file under main/ other than the emit service calls an emitter — a second " +
    "caller does not inherit redactWithSnapshot and would produce a valid file " +
    `with a live credential in it. Found: ${otherCallers.join(", ") || "none"}`,
);

// ── 2c. The non-interactive destination cannot be handed a redactor ──
//
// `emitReportTo` writes without a dialog, so nothing on its path asks a person
// to look at the result. If it ever accepted a redactor from its caller, the
// caller could pass an identity function and the file would look identical.
// Redaction on this path is not a parameter; it is the one in `buildReport`.

const emitToSignature = withoutComments(service).match(
  /export function emitReportTo\(([\s\S]*?)\)\s*:/,
);
assert(
  emitToSignature !== null,
  `${emitPath} exports emitReportTo — the non-interactive destination this section guards`,
);
if (emitToSignature) {
  assert(
    !/redact/i.test(emitToSignature[1]),
    "emitReportTo takes no redactor from its caller — it must use the one in " +
      "buildReport, or an unattended write could opt out of redaction silently",
  );
}

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

// ── 4. The UNATTENDED side: cli/ and mcp/ ────────────────────────────
//
// Sections 1-2c watch `main/`, which was the whole egress surface while the
// only way to obtain bytes was through a process that can read the encrypted
// secrets store. R1's `--junit` is the first emit path OUTSIDE it: plain `.mjs`
// under Node, where `redactWithSnapshot` does not exist and cannot.
//
// §3.5 of docs/plans/test-runner-improvements.md is the rule being satisfied —
// "each new egress path must extend that check's scan set in the same commit
// that adds it". This is that extension.
//
// What it pins is the same shape as `main/`'s, translated to what this side
// HAS. There is no snapshot to require, so the requirement is instead:
//
//   a. exactly one file out here calls an emitter, so a second one cannot
//      quietly inherit nothing;
//   b. it passes a `redact:` and never `NO_REDACTION`;
//   c. it takes secret VALUES from its caller and never a redactor — the same
//      rule as `emitReportTo`, and for the same reason: a caller that could
//      pass a redactor could pass an identity function, and the file would look
//      identical;
//   d. it never reads run history. The scope is a security boundary: a run the
//      APP produced took its secrets from a store this process cannot open, so
//      those values are not in hand and could not be redacted out. Building
//      from one invocation's own results is what makes that structural.

/** Every `.mjs` under a directory, minus tests. */
function unattendedSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      unattendedSources(full, out);
    } else if (entry.name.endsWith(".mjs") && !/\.test\.mjs$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const UNATTENDED_EMIT_PATH = "cli/junit.mjs";
const unattendedCallers: string[] = [];
for (const dir of ["cli", "mcp"]) {
  for (const file of unattendedSources(resolve(root, dir))) {
    const rel = file.slice(root.length + 1);
    const source = withoutComments(read(rel));
    if (!/from\s+["'][^"']*shared\/emitters\.mjs["']/.test(source)) continue;
    if (emitterFns.some((fn) => new RegExp(String.raw`\b${fn}\s*\(`).test(source))) {
      unattendedCallers.push(rel);
    }
  }
}

assert(
  unattendedCallers.length === 1 && unattendedCallers[0] === UNATTENDED_EMIT_PATH,
  `exactly one file outside main/ calls an emitter, and it is ${UNATTENDED_EMIT_PATH} — ` +
    "a second caller out here has no redactor to inherit and would write a valid " +
    `file with a live credential in it. Found: ${unattendedCallers.join(", ") || "none"}`,
);

const unattended = withoutComments(read(UNATTENDED_EMIT_PATH));

assert(
  /redact:\s*\(text\)\s*=>\s*redact\(text, values\)/.test(unattended),
  `${UNATTENDED_EMIT_PATH} passes a redactor built from the resolved secret values`,
);
assert(
  !/NO_REDACTION/.test(unattended),
  `${UNATTENDED_EMIT_PATH} does not reach for NO_REDACTION`,
);

// (c) — VALUES in, never a redactor. Checked on the exported signatures rather
// than the body, because that is where a caller's reach would have to appear.
const exportedSignatures = [...unattended.matchAll(/export function \w+\(([\s\S]*?)\)\s*\{/g)].map(
  (m) => m[1],
);
assert(
  exportedSignatures.length >= 2,
  `${UNATTENDED_EMIT_PATH} exports the build and the write (found ${exportedSignatures.length})`,
);
assert(
  exportedSignatures.every((sig) => !/redact/i.test(sig)),
  `${UNATTENDED_EMIT_PATH} takes secret VALUES from its caller, never a redactor — ` +
    "one that could be handed a redactor could be handed an identity function",
);

// (c2) — the builder NAMES the fields it forwards, never spreads the result.
// A unit test cannot reach this: `junitXml` reads a fixed set, so a spread
// produces byte-identical output today. It stops being identical the day an
// emitter reads a field a result happens to carry — and a run result carries
// `vars`, a dataset row's VALUES, on the dataset paths. A spread is how the
// capture boundary keeps being re-opened one field at a time; the same shape
// applies to a file that leaves the machine.
assert(
  !/\.\.\.r\b/.test(unattended),
  `${UNATTENDED_EMIT_PATH} names each field it forwards instead of spreading the ` +
    "result — a spread carries every field added upstream into a file that leaves the machine",
);

// (d) — the scope. No store, no history read: the report is built from the
// results of one invocation, which is the only set whose secrets this process
// resolved and can therefore redact.
assert(
  !/runHistory|listRuns|run-history|createStore|readJsonFile/.test(unattended),
  `${UNATTENDED_EMIT_PATH} reads no run history — a report scoped wider than this ` +
    "invocation could include an app run whose secret values are unreadable here",
);
// The CALL, not the import line. This pinned the exact spelling of
// `import { resolveCiSecrets } from …` and went red the moment a second name
// was added to the same import — on a change that WIDENED the redaction, which
// is a guard punishing a fix for the property it is meant to protect.
assert(
  /resolveCiSecrets\(test, \{ env, fileValues: secretFile \}\)\.values/.test(
    withoutComments(read("cli/run.mjs")),
  ),
  "cli/run.mjs resolves the secret values through resolveCiSecrets — R7's rule that " +
    "whatever supplies a secret to a run also feeds the redaction",
);
// …and the half `resolveCiSecrets` structurally cannot answer. A credential
// can reach a run without any test declaring it: the `emailCode` step reads
// `GLAZE_MAILBOX_TOKEN` from the environment itself, so it is supplied, sent as
// a bearer, and named by nothing in `test.variables`. R7's rule is about what
// SUPPLIES the run, not about what a test asked for.
assert(
  /ambientCiSecretValues\(env\)/.test(withoutComments(read("cli/run.mjs"))),
  "…and unions in the credentials the ENVIRONMENT supplied, which no test declares",
);
assert(
  /GLAZE_MAILBOX_TOKEN/.test(withoutComments(read("shared/ci-secrets.mjs"))) &&
    !/GLAZE_MAILBOX_URL/.test(
      withoutComments(read("shared/ci-secrets.mjs")).slice(
        withoutComments(read("shared/ci-secrets.mjs")).indexOf("export function ambientCiSecretValues"),
      ),
    ),
  "…the token and NOT the endpoint — a run that cannot say which host it polled is one nobody can debug",
);
assert(
  /writeJunitReport\(options\.junit, outcome\.results, \{ secretValues \}\)/.test(
    withoutComments(read("cli/run.mjs")),
  ),
  "…and hands them to the writer along with THIS invocation's results",
);

// ── Result ───────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall emit-redaction checks passed");
