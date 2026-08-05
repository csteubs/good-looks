// Standalone regression check for test variables, secrets and redaction.
//
// The reason this check exists rather than a unit test per module: the property
// worth guarding is a CROSS-MODULE one. A secret is safe only if it stays out
// of the generated spec, out of the run log on disk, and out of the outgoing
// webhook payload — three different files, one guarantee. A test that checks
// them individually would still pass on the day a fourth path opens.
//
// The other half is normalization. `normalizeVariables` sits directly behind an
// IPC boundary and its output becomes a JS identifier in a generated spec, so a
// name it lets through wrong produces a spec that doesn't parse.
//
// Bundled with esbuild + the @glaze/core/backend stub (safeStorage, app.getPath)
// — see package.json. Run with:
//   npm run check:variables

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { setEncryptionAvailable } from "./glaze-backend-stub.js";
import { redact, REDACTED, setSecretSnapshotForTesting } from "../secret-redaction.js";
import { testSecretsStore } from "../test-secrets-store.js";
import { runHistoryStore } from "../run-history-store.js";
import { buildAlertPayload, redactPayload } from "../alert-service.js";
import { generateSpec } from "../script-generator.js";
import {
  collectVarRefs,
  isValidVariableName,
  normalizeDatasets,
  normalizeVariables,
  type Step,
  type TestVariable,
} from "../../recorder/types.js";

// Set BEFORE any store function runs. The stub resolves this lazily on every
// call, so assigning it after the imports is fine — and keeps the imports at
// the top where the linter wants them.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-variables-check-"));
process.env.GLAZE_TEST_USERDATA = userData;

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(
      `FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  } else {
    console.log(`ok   ${label}`);
  }
}

const step = (partial: Partial<Step> & Pick<Step, "type">): Step =>
  ({ id: "s", timestamp: 0, ...partial }) as Step;

async function main(): Promise<void> {
  // ── 1. redact() — the pure core ──────────────────────────────────────────
  assertEqual(
    redact("logging in as hunter2 now", ["hunter2"]),
    `logging in as ${REDACTED} now`,
    "a secret value is replaced wherever it appears",
  );
  assertEqual(
    redact("hunter2 hunter2", ["hunter2"]),
    `${REDACTED} ${REDACTED}`,
    "every occurrence is replaced, not just the first",
  );
  // The prefix case: replacing the SHORT secret first would leave "!" dangling
  // next to a [redacted] label — a partial leak that reads as fully redacted.
  assertEqual(
    redact("value=hunter2! and hunter2", ["hunter2", "hunter2!"]),
    `value=${REDACTED} and ${REDACTED}`,
    "a secret that is a prefix of another does not leave the longer one's tail behind",
  );
  assertEqual(
    redact("a b c", ["a", "b"]),
    "a b c",
    "values under 4 characters are left alone (they would match constantly)",
  );
  assertEqual(redact("nothing here", []), "nothing here", "no secrets means no change");

  // ── 2. The secrets store ────────────────────────────────────────────────
  setEncryptionAvailable(true);
  await testSecretsStore.set("test-1", "password", "hunter2-secret");
  await testSecretsStore.set("test-1", "apiKey", "sk-live-abcdef");
  await testSecretsStore.set("test-2", "password", "other-secret");

  assertEqual(
    await testSecretsStore.names("test-1"),
    ["apiKey", "password"],
    "names() returns the stored secret names, sorted",
  );
  assertEqual(
    (await testSecretsStore.valuesFor("test-1")).password,
    "hunter2-secret",
    "valuesFor() returns a test's own values for run injection",
  );
  assertEqual(
    (await testSecretsStore.valuesFor("test-1")).other,
    undefined,
    "valuesFor() is scoped to one test",
  );
  // Redaction must span tests: one test's log can echo another's credential if
  // they share an account, and scoping redaction per-test would miss it.
  assert(
    (await testSecretsStore.allValues()).includes("other-secret"),
    "allValues() spans every test, so redaction can't miss a cross-test leak",
  );

  await testSecretsStore.clear("test-1", "apiKey");
  assertEqual(
    await testSecretsStore.names("test-1"),
    ["password"],
    "clear() removes one secret and leaves the rest",
  );
  await testSecretsStore.clearTest("test-1");
  assertEqual(
    await testSecretsStore.names("test-1"),
    [],
    "clearTest() removes every secret for a deleted test",
  );

  // The on-disk blob must not contain plaintext. The stub's "encryption" is a
  // reversible marker, so this proves the value went through safeStorage at
  // all — the bug it guards is writing the JSON directly.
  const blobPath = path.join(userData, "recorder", "test-secrets.bin");
  const onDisk = fs.readFileSync(blobPath, "utf-8");
  assert(
    onDisk.startsWith("stub:"),
    "secrets are written through safeStorage, not as plain JSON",
  );

  // ── 3. A secret never reaches the generated spec ─────────────────────────
  const variables: TestVariable[] = [
    { name: "email", kind: "plain", value: "user@example.com" },
    { name: "password", kind: "secret" },
  ];
  const spec = generateSpec({
    name: "login",
    url: "https://example.com",
    steps: [
      step({ type: "fill", locator: { k: "label", v: "Email" }, value: "${email}" }),
      step({ type: "fill", locator: { k: "label", v: "Password" }, value: "${password}" }),
    ],
    variables,
  });
  assert(
    !spec.includes("hunter2-secret"),
    "the generated spec contains no secret value",
  );
  assert(
    spec.includes("process.env.GLAZE_SECRET_password"),
    "the generated spec references the secret through the environment",
  );
  // A secret's value must not survive a round-trip through the record either —
  // tests.json is plain JSON on disk.
  assertEqual(
    normalizeVariables([{ name: "password", kind: "secret", value: "hunter2-secret" }]),
    [{ name: "password", kind: "secret" }],
    "a secret's value is stripped before it can be persisted on the record",
  );

  // ── 4. A secret never reaches the run log on disk ────────────────────────
  setSecretSnapshotForTesting(["hunter2-secret"]);
  const record = runHistoryStore.append(
    {
      testId: "test-1",
      testName: "login",
      url: "https://example.com",
      status: "failed",
      exitCode: 1,
      startedAt: 1000,
      finishedAt: 2000,
    },
    'Error: expected value "hunter2-secret" but got ""\n',
  );
  const written = fs.readFileSync(record.logFile, "utf-8");
  assert(!written.includes("hunter2-secret"), "the persisted run log contains no secret value");
  assert(written.includes(REDACTED), "the persisted run log shows the value was redacted");

  // ── 5. A secret never reaches the outgoing webhook ───────────────────────
  const payload = buildAlertPayload({
    kind: "run",
    testName: "login",
    status: "failed",
    changedSteps: 0,
    // A step recorded before variables existed carries its typed value in the
    // label — which is exactly how a password ends up in an alert.
    failedLabel: 'getByLabel("Password").fill("hunter2-secret")',
    durationMs: 1200,
    browser: "chromium",
  });
  assert(payload !== null, "a failed run produces an alert payload");
  const safe = redactPayload(payload!, ["hunter2-secret"]);
  assert(
    !JSON.stringify(safe).includes("hunter2-secret"),
    "no secret survives anywhere in the outgoing payload",
  );
  assert(
    JSON.stringify(safe).includes(REDACTED),
    "the outgoing payload shows the value was redacted",
  );
  // Redaction must not quietly drop the rest of the payload's information.
  assertEqual(safe.detail.testName, "login", "redaction leaves non-secret detail intact");
  assertEqual(safe.event, "run", "redaction leaves the payload's shape intact");

  // ── 6. Variable-name validation ─────────────────────────────────────────
  //
  // A name becomes `V.<name>` in the generated spec, so anything that isn't a
  // plain identifier emits a spec that doesn't parse.
  for (const bad of ["1st", "has-dash", "has space", "", "has.dot", "a".repeat(41)]) {
    assert(!isValidVariableName(bad), `rejects the invalid variable name ${JSON.stringify(bad)}`);
  }
  for (const good of ["email", "_private", "order2", "camelCaseName"]) {
    assert(isValidVariableName(good), `accepts the valid variable name ${JSON.stringify(good)}`);
  }
  assertEqual(
    normalizeVariables([
      { name: "ok", kind: "plain", value: "v" },
      { name: "1bad", kind: "plain", value: "v" },
      { name: "ok", kind: "plain", value: "dupe" },
    ]).map((v) => v.name),
    ["ok"],
    "invalid names are dropped and duplicates collapse to the first",
  );
  // Case-SENSITIVE dedupe: `user` and `User` are different JS properties, so
  // folding them (as tags do) would silently merge two distinct variables.
  assertEqual(
    normalizeVariables([
      { name: "user", kind: "plain" },
      { name: "User", kind: "plain" },
    ]).length,
    2,
    "variable names dedupe case-sensitively, unlike tags",
  );
  assertEqual(normalizeVariables("not an array"), [], "hostile input normalizes to an empty list");

  // ── 7. Dataset normalization ────────────────────────────────────────────
  assertEqual(
    normalizeDatasets([
      { id: "d1", name: "GBP", values: { currency: "GBP", "bad-name": "x", n: 5 } },
      { id: "d1", name: "dupe", values: {} },
      { name: "no id", values: {} },
    ]),
    [{ id: "d1", name: "GBP", values: { currency: "GBP" } }],
    "datasets drop duplicate ids, id-less rows, invalid names and non-string values",
  );
  assertEqual(normalizeDatasets(42), [], "hostile dataset input normalizes to an empty list");

  // ── 8. Variable reference collection ────────────────────────────────────
  assertEqual(
    collectVarRefs(step({ type: "fill", value: "${email}" })),
    ["email"],
    "a step's value reference is collected",
  );
  assertEqual(
    collectVarRefs(step({ type: "assert", text: "Order ${id} for ${email}" })),
    ["id", "email"],
    "multiple references in one field are collected in order",
  );
  assertEqual(
    collectVarRefs(step({ type: "goto", url: "https://x/${env}" })),
    ["env"],
    "a URL reference is collected — every interpolatable field is scanned",
  );
  assertEqual(
    collectVarRefs(step({ type: "runFlow", flowArgs: { user: "${email}" } })),
    ["email"],
    "a flow argument's reference is collected",
  );
  assertEqual(
    collectVarRefs(step({ type: "fill", value: "costs ${9.99}" })),
    [],
    "a ${...} that isn't an identifier is left alone, not treated as a variable",
  );

  setEncryptionAvailable(false);
  fs.rmSync(userData, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll variables checks passed");
}

void main();
