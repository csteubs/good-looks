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
// Bundled with esbuild + the @shell/backend stub (safeStorage, app.getPath)
// — see package.json. Run with:
//   npm run check:variables

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { setEncryptionAvailable } from "./shell-backend-stub.js";
import { MASKED, redact, REDACTED, setSecretSnapshotForTesting } from "../secret-redaction.js";
import { testSecretsStore } from "../test-secrets-store.js";
import { runHistoryStore } from "../run-history-store.js";
import { buildAlertPayload, redactPayload } from "../alert-service.js";
import { bindFlowStep, generateSpec } from "../script-generator.js";
import {
  collectVarRefs,
  isValidVariableName,
  mergeSessionVariables,
  normalizeDatasets,
  normalizeVariables,
  resolveStepForReplay,
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

  // ── 8b. Every field the GENERATOR interpolates is one the bookkeeping sees ─
  //
  // The invariant, and the reason this is a loop over a table rather than four
  // hand-written asserts: `script-generator.ts` decides which fields become
  // `V.name` in the spec, and `mapInterpolatable` decides which fields are
  // scanned for references, substituted for a trainer preview and bound by a
  // flow call. Nothing in the types ties those two lists together. When they
  // drifted — `apiBody` and the values of `apiHeaders` were interpolated by
  // the generator and invisible to everything else — the symptoms were a
  // variable reported as unused (so the Variables tab offered to delete a
  // token the run still needed) and a flow parameter that never reached an API
  // step in the flow's body.
  //
  // Both halves are asserted per row on purpose. Checking only "the traversal
  // knows about it" would pass vacuously on the day the generator stops
  // interpolating the field at all.
  const apiStep = (over: Partial<Step>): Step =>
    step({ type: "api", apiMethod: "POST", url: "https://api.example.com/x", ...over });

  const interpolated: { field: string; step: Step }[] = [
    { field: "value", step: step({ type: "fill", locator: { k: "label", v: "Email" }, value: "${tok}" }) },
    { field: "text", step: step({ type: "assert", assert: "text", locator: { k: "label", v: "Email" }, text: "${tok}" }) },
    { field: "url", step: step({ type: "goto", url: "https://example.com/${tok}" }) },
    { field: "apiBody", step: apiStep({ apiBody: '{"q":"${tok}"}' }) },
    { field: "apiHeaders", step: apiStep({ apiHeaders: { Authorization: "Bearer ${tok}" } }) },
  ];

  for (const { field, step: one } of interpolated) {
    const oneSpec = generateSpec({
      name: "interp",
      url: "https://example.com",
      steps: [one],
      variables: [{ name: "tok", kind: "plain", value: "abc" }],
    });
    assert(
      oneSpec.includes("V.tok"),
      `the generator interpolates a variable in ${field}`,
    );
    assert(
      collectVarRefs(one).includes("tok"),
      `collectVarRefs sees the reference in ${field} — the usage count cannot invite deleting it`,
    );
  }

  // ── 8c. An API step inside a parameterised flow binds the caller's args ───
  //
  // `bindFlowStep` substitutes textually at generation time. Before the shared
  // traversal it rewrote value/text/url/flowArgs only, so a flow whose body
  // posted `${password}` to an endpoint shipped those eleven characters as the
  // request body — a login flow that looked parameterised and was not.
  assertEqual(
    bindFlowStep(apiStep({ apiBody: '{"pw":"${password}"}' }), { password: "${storePw}" }).apiBody,
    '{"pw":"${storePw}"}',
    "a flow argument binds into an API step's body",
  );
  assertEqual(
    bindFlowStep(apiStep({ apiHeaders: { Authorization: "Bearer ${token}" } }), {
      token: "${apiToken}",
    }).apiHeaders,
    { Authorization: "Bearer ${apiToken}" },
    "a flow argument binds into an API step's header value",
  );
  assertEqual(
    bindFlowStep(apiStep({ apiHeaders: { "X-${name}": "v" } }), { name: "nope" }).apiHeaders,
    { "X-${name}": "v" },
    "a header NAME is left alone — the token grammar is re-checked at emission",
  );

  // ── 9. Merging a trainer session's variables back into the record ───────
  //
  // The trainer declares into the SESSION, because a new recording has no
  // record to declare against — its id is a UUID nothing has been saved under.
  // What lands on disk is therefore a merge, and the direction it can fail in
  // is destructive: a session seeded from the record and then written back
  // WHOLESALE would delete anything the Variables tab added in another window
  // while the trainer was open.
  assertEqual(
    mergeSessionVariables(
      [{ name: "email", kind: "plain", value: "a@b.c" }],
      [{ name: "storePassword", kind: "secret" }],
    ),
    [
      { name: "email", kind: "plain", value: "a@b.c" },
      { name: "storePassword", kind: "secret" },
    ],
    "a variable only the record has survives the trainer's save",
  );
  assertEqual(
    mergeSessionVariables(
      [{ name: "email", kind: "plain", value: "old" }],
      [{ name: "email", kind: "plain", value: "new" }],
    ),
    [{ name: "email", kind: "plain", value: "new" }],
    "the session's copy wins for a name both have, and does not duplicate it",
  );
  assertEqual(
    mergeSessionVariables([], []),
    [],
    "a session that declared nothing writes nothing",
  );
  assertEqual(
    mergeSessionVariables(undefined, undefined),
    [],
    "a record and a session that predate variables merge to an empty list",
  );
  // Normalized on the way OUT, not per half — so the cap and the secret-value
  // strip apply to what actually lands on the record.
  assertEqual(
    mergeSessionVariables([], [{ name: "pw", kind: "secret", value: "hunter2" }]),
    [{ name: "pw", kind: "secret" }],
    "a secret's value never reaches the record through the merge",
  );
  assertEqual(
    mergeSessionVariables([], [{ name: "1bad", kind: "plain", value: "x" }]),
    [],
    "an invalid name declared in a session is dropped like any other",
  );

  // ── 10. Replaying a step that references a variable ─────────────────────
  //
  // The trainer's per-step ▶ hands the step to an injected replayer that acts
  // on exactly what it is given, so every reference has to be substituted
  // before it goes — or the preview types the seventeen characters
  // `${storePassword}` into the field and the user concludes the feature does
  // not work. Secrets included: the value has to reach the page for the login
  // to happen. What must NOT follow it is the trainer's own output, which is
  // what `usedValues` is for.
  const declared: TestVariable[] = [
    { name: "email", kind: "plain", value: "a@b.c" },
    { name: "pw", kind: "secret" },
    { name: "orderId", kind: "captured" },
  ];
  const stored = { pw: "hunter2-secret" };
  assertEqual(
    resolveStepForReplay(step({ type: "fill", value: "${email}" }), declared, stored).step.value,
    "a@b.c",
    "a plain variable is substituted before the step is replayed",
  );
  assertEqual(
    resolveStepForReplay(step({ type: "fill", value: "${orderId}" }), declared, stored).step.value,
    "",
    "a captured variable falls back to its default, which is empty before the capture runs",
  );
  const secretReplay = resolveStepForReplay(
    step({ type: "fill", value: "${pw}" }),
    declared,
    stored,
  );
  assertEqual(
    secretReplay.step.value,
    "hunter2-secret",
    "a secret IS resolved for the replay — the page is where the password has to end up",
  );
  assertEqual(
    secretReplay.usedValues,
    ["hunter2-secret"],
    "the resolved value comes back so the caller can keep it out of the logs",
  );
  assertEqual(secretReplay.missingSecrets, [], "a secret with a stored value is not reported missing");

  // Declared, never given a value. Substituting "" would fill a blank password
  // and fail somewhere else entirely, several steps later.
  const noValue = resolveStepForReplay(step({ type: "fill", value: "${pw}" }), declared, {});
  assertEqual(noValue.missingSecrets, ["pw"], "a secret with no stored value is reported, not guessed");
  assertEqual(noValue.step.value, "${pw}", "and nothing is substituted for it");

  assertEqual(
    resolveStepForReplay(step({ type: "fill", value: "costs ${9.99}" }), declared, stored).step.value,
    "costs ${9.99}",
    "a ${...} that isn't a declared identifier is left as text, as the generator leaves it",
  );
  assertEqual(
    resolveStepForReplay(step({ type: "goto", url: "https://x/${email}" }), declared, stored).step.url,
    "https://x/a@b.c",
    "every interpolatable field is substituted, not just value",
  );
  assertEqual(
    resolveStepForReplay(step({ type: "assert", text: "Hi ${email}" }), declared, stored).step.text,
    "Hi a@b.c",
    "an assertion's expected text is substituted too",
  );
  assertEqual(
    resolveStepForReplay(step({ type: "click" }), declared, stored).usedValues,
    [],
    "a step with no references reports no values to mask",
  );

  // The masking half, over the same `redact` the run log uses. The trainer
  // masks EVERY variable value, not only the secret ones — the Console echoes
  // what it filled, and that panel is persisted to disk and fed to "Debug with
  // AI" on the step.
  assertEqual(
    redact('filled value="hunter2-secret"', secretReplay.usedValues, MASKED),
    'filled value="****"',
    "a resolved value is masked out of what the trainer prints back",
  );
  assertEqual(
    redact("Value: a@b.c", ["a@b.c"], MASKED),
    "Value: ****",
    "a plain variable's value is masked in the trainer too",
  );

  // ── 11. The trainer's route to a variable, at source level ──────────────
  //
  // Everything above is reachable from a function call. This is not: the
  // "Use variable…" item lives inside a `webContents.on("context-menu")`
  // handler on the training browser, which needs a real Electron window to
  // fire — and the renderer half is covered by component tests that stub the
  // action rather than produce it. So the JOIN between them is guarded here,
  // lexically, the same way check:trainer-panel guards its push channels.
  //
  // What breaks if it drifts is silent in the way this file cares about: the
  // menu item stops reaching a trainer, the user goes on typing the password
  // into the page, and it is recorded verbatim into the spec — which is the
  // failure the whole variables feature exists to remove.
  const src = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
  const service = src("main/services/recorder-service.ts");
  assert(
    /label:\s*"Use variable…"/.test(service),
    "the training browser's right-click menu offers Use variable",
  );
  assert(
    /"Use variable…"[\s\S]{0,200}ctxAction\(\{\s*kind:\s*"fill"/.test(service),
    "picking it pushes a `fill` context action carrying the right-clicked element",
  );
  for (const view of ["renderer/main/recording-view.tsx", "renderer/trainer/trainer-panel-view.tsx"]) {
    // Both trainers reach the composer through the same fall-through branch
    // (`setAddKind(a.kind as AddStepKind)`), so what has to be true is that
    // neither returns early on an unknown kind before it.
    assert(
      /setAddKind\(a\.kind as AddStepKind\)/.test(src(view)),
      `${view} forwards an unhandled context-action kind to the composer`,
    );
    assert(
      /onCreateVariable=\{addVariable\}/.test(src(view)),
      `${view} lets the trainer declare a variable mid-session`,
    );
  }
  assert(
    /"fill"/.test(src("renderer/main/step-composer.tsx")),
    "the composer knows the fill kind the menu item opens",
  );

  // The replay path, which no unit test can drive — `runStep` needs a live
  // webContents and a session. Both halves are lexical because both are silent
  // when they go: an unresolved step types `${name}` into the field, and an
  // unmasked result prints the user's password into the Console tab, onto disk
  // in debug-logs.json, and into the prompt "Debug with AI" builds from it.
  assert(
    /buildReplayScript\(resolved\.step\)/.test(service),
    "the injected replayer is handed the RESOLVED step, never the one holding the reference",
  );
  assert(
    /maskValues\(\s*\(await execWithTimeout/.test(service),
    "the replay result is masked before anything downstream sees it",
  );
  assert(
    /valuesFor\(session\.testId\)/.test(service),
    "a secret's value is read for the replay — the page is where a password has to end up",
  );
  assert(
    !/\bredact\(l\.m, values\)/.test(service),
    "the trainer's mask is passed explicitly, not left to default to the run log's [redacted]",
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
