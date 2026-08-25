// How a secret reaches an unattended run, and why supplying one is only safe
// because the same values feed the redaction (R7).
//
// WHY THIS IS A CHECK, AND WHY IT IS THE STRICT ONE. Until R7 the MCP could not
// supply a secret at all, and `mcp/run-plan.mjs` said so in a comment: "There is
// deliberately NO GLAZE_SECRET_* key here, and there cannot be one … so a future
// edit that starts injecting secrets has to confront the redaction question
// rather than quietly creating a plaintext-credentials path in a file
// get_run_log serves back."
//
// This IS that edit. So the rule it replaces has to be replaced by a stronger
// one rather than deleted: a secret may be injected, but only by a path that
// also hands the value to `sanitizeOutput`. The failure being guarded is
// specific and silent — a secret is typed INTO the page, so it comes back out
// in a Playwright error, an assertion diff or a page-content dump, and the run
// log is written to disk and served back by `get_run_log`.
//
// Run with: npm run check:ci-secrets

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CI_SECRET_PREFIX,
  ciSecretEnvName,
  describeMissingSecrets,
  resolveCiSecrets,
  specSecretEnvName,
} from "../../../shared/ci-secrets.mjs";
import { redact, REDACTED } from "../../../shared/secret-redaction.mjs";
import { sanitizeOutput } from "../../../mcp/run-plan.mjs";
import type { TestRecord } from "../../recorder/types.js";

const root = process.cwd();
let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function code(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

const runner = code("mcp/run-tests.mjs");
const plan = code("mcp/run-plan.mjs");

const TEST = {
  id: "6f1c-aa",
  name: "Login",
  variables: [
    { name: "PASSWORD", kind: "secret" },
    { name: "TOKEN", kind: "secret" },
    { name: "user", kind: "plain", value: "sam" },
  ],
} as const satisfies Pick<TestRecord, "id" | "name" | "variables">;

// ── 1. A supplied secret is a redacted secret ────────────────────────────
//
// THE property. Everything else here supports it.
{
  const value = "hunter2-long-enough";
  const resolved = resolveCiSecrets(TEST, {
    env: { [ciSecretEnvName(TEST.id, "PASSWORD")]: value },
  });
  assert(
    resolved.env[specSecretEnvName("PASSWORD")] === value,
    "a secret set in the environment reaches the spec's env reference",
  );
  assert(
    resolved.values.includes(value),
    "…and the same value comes back in `values`, which is what gets redacted",
  );
  const out = sanitizeOutput(`Timeout waiting for input filled with ${value}`, resolved.values);
  assert(!out.includes(value), "…so it does not survive sanitizeOutput");
  assert(out.includes(REDACTED), "…and the output says something was removed");
}

// ── 2. The runner cannot inject without redacting ────────────────────────
//
// Source-level, because this is a coupling between two statements that are
// individually correct: `Object.assign(env, secrets.env)` and
// `sanitizeOutput(output, secrets.values)` both read fine alone, and the bug is
// having only the first.
{
  assert(
    /Object\.assign\(env, secrets\.env\)/.test(runner),
    "the runner injects the resolved secrets into the child env",
  );
  // Matches whatever is handed in as the first argument, not the bare
  // identifier: the run's output gained an appended Auto-Heal summary (R49),
  // added INSIDE the choke point. Anchoring on `output` alone would have gone
  // red for text being routed through redaction correctly, which teaches the
  // next person to loosen the assertion rather than keep the coupling. What is
  // still pinned is the one that matters — the values.
  assert(
    /sanitizeOutput\([^,]*\boutput\b[^,]*, secrets\.values\)/.test(runner),
    "…and redacts the run's output with the SAME resolved values",
  );
  // Both come off ONE `resolveCiSecrets` call INSIDE executeTest, so they
  // cannot describe different sets. Scoped to that function rather than to the
  // file: `runSelection` legitimately resolves too, to decide whether to skip,
  // and counting file-wide reports that correct code as broken — which is how
  // an assertion gets loosened until it means nothing.
  const executeBody =
    /async function executeTest\([\s\S]*?\n {2}\}\n/.exec(runner)?.[0] ?? "";
  assert(executeBody.length > 0, "isolated executeTest's own body");
  const resolves = (executeBody.match(/resolveCiSecrets\(/g) ?? []).length;
  assert(
    resolves === 1,
    `executeTest resolves the secrets exactly once (${resolves}) — injection and redaction ` +
      `read the same object`,
  );
  assert(
    /Object\.assign\(env, secrets\.env\)/.test(executeBody) &&
      /sanitizeOutput\([^,]*\boutput\b[^,]*, secrets\.values\)/.test(executeBody),
    "…and both halves are inside it, reading that one object",
  );
}

// ── 3. `runEnv` still mints no secret of its own ─────────────────────────
//
// The original rule, narrowed rather than dropped. `runEnv` is shared with the
// app's runner, whose secrets come from a store this process cannot read; the
// injection belongs to the caller that also holds the values for redaction.
{
  const runEnvBody = /export function runEnv\(\{[\s\S]*?\n\}/.exec(plan)?.[0] ?? "";
  assert(runEnvBody.length > 0, "isolated runEnv's own body");
  assert(
    !/GLAZE_SECRET/.test(runEnvBody.replace(/\/\/.*$/gm, "")),
    "runEnv itself still mints no GLAZE_SECRET_* key",
  );
}

// ── 4. A missing secret is a refusal BY NAME, never an empty string ──────
//
// The old failure: the generated spec resolves `process.env.GLAZE_SECRET_<NAME>
// ?? ""`, so an unsupplied secret typed an EMPTY STRING into the login form and
// failed on an assertion several steps later, with nothing connecting the two.
{
  const none = resolveCiSecrets(TEST, { env: {} });
  assert(none.missing.length === 2, "both declared secrets are reported missing");
  assert(
    Object.keys(none.env).length === 0,
    "…and NOTHING is injected — never an empty string standing in for a credential",
  );
  // An empty value is missing, not supplied. Otherwise an operator who exports
  // the variable but leaves it blank gets the old silent failure back.
  const blank = resolveCiSecrets(TEST, {
    env: { [ciSecretEnvName(TEST.id, "PASSWORD")]: "" },
  });
  assert(
    blank.missing.includes("PASSWORD"),
    "an empty value is MISSING, not a supplied credential",
  );
}

// ── 5. The refusal names variables, and never a value ────────────────────
{
  const value = "super-secret-value";
  const partial = resolveCiSecrets(TEST, {
    env: { [ciSecretEnvName(TEST.id, "PASSWORD")]: value },
  });
  const message = describeMissingSecrets(TEST, partial.missing);
  assert(
    message.includes(ciSecretEnvName(TEST.id, "TOKEN")),
    "the refusal names the variable to set",
  );
  assert(!message.includes(value), "…and never quotes a value that DID resolve");
  assert(
    message.includes(CI_SECRET_PREFIX),
    "…using the documented prefix rather than an invented one",
  );
  assert(
    /only the names/.test(message) || !message.includes("PASSWORD"),
    "…and does not list a secret that was supplied as though it were missing",
  );
}

// ── 6. The env name is scoped to the test ────────────────────────────────
//
// Two tests can each declare `PASSWORD` and mean different credentials. A
// library-wide name would hand one test's staging password to another test's
// production login — a failure with no error message at all, because the run
// succeeds against the wrong account.
{
  const a = ciSecretEnvName("test-one", "PASSWORD");
  const b = ciSecretEnvName("test-two", "PASSWORD");
  assert(a !== b, "the same secret name in two tests resolves to two variables");
  assert(
    /^[A-Z0-9_]+$/.test(a),
    `the variable is shell-safe (${a}) — a uuid's hyphens are not usable in an env name`,
  );
  const scoped = resolveCiSecrets(TEST, {
    fileValues: { [`${TEST.id}.PASSWORD`]: "scoped-value", PASSWORD: "bare-value" },
  });
  assert(
    scoped.env[specSecretEnvName("PASSWORD")] === "scoped-value",
    "a scoped secrets-file key beats a bare one — being explicit must not lose",
  );
}

// ── 7. The dry run answers the same question the run does ────────────────
//
// A dry run that reports a test as skipped while the real run executes it is
// worse than one that says nothing.
{
  assert(
    /resolveCiSecrets\(t, \{ env: secretEnv, fileValues: secretFile \}\)\.missing/.test(runner),
    "the dry run reports what would ACTUALLY be missing, not merely what is declared",
  );
  assert(
    !/declares secret variable\(s\)/.test(runner),
    "…rather than the blanket 'declares a secret' rule R7 replaced",
  );
}

// ── 8. The redaction rule itself is the app's ────────────────────────────
//
// Longest-first, so a secret that is a prefix of another does not leave the
// longer one's tail sitting next to a [redacted] label — a partial leak that
// reads as if it were complete.
{
  const out = redact("a hunter2 and a hunter2extra", ["hunter2", "hunter2extra"]);
  assert(!out.includes("extra"), "a longer secret is redacted whole, prefix or not");
  assert(
    redact("pw is ab", ["ab"]).includes("ab"),
    "a value under 4 characters is left alone — a log full of [redacted] is a log nobody reads",
  );
  assert(
    code("main/services/secret-redaction.ts").includes("shared/secret-redaction.mjs"),
    "the app redacts through the same shared rule rather than its own copy",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll CI-secret checks passed.");
