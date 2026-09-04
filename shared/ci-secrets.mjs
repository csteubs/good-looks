// How a secret reaches an unattended run, and what happens when it does not (R7).
//
// ── The problem ───────────────────────────────────────────────────────────
// A secret variable's value is encrypted through the operating system's secure
// storage and only the app process can decrypt it. So an MCP or CLI run has
// never been able to supply one, and `secretVariableNames` exists so a run says
// that up front instead of finding out at the login form — before it, the
// generated spec's `process.env.GLAZE_SECRET_<NAME> ?? ""` typed EMPTY STRINGS
// into the form and failed on an assertion much further down, with nothing in
// the output connecting the two.
//
// R7 is the contract that lets CI supply them instead. It does NOT weaken the
// app's storage: nothing here decrypts anything. It adds a second, explicit
// source that a CI operator populates deliberately.
//
// ── The rule that makes this safe to add ──────────────────────────────────
// The plan states it in one sentence: "The same values must feed the redaction
// snapshot, or the CLI's own log output and any emitted report will contain the
// credential." A secret is typed INTO the page, so it comes back out in a
// Playwright error, a failing assertion's diff, a page-content dump. Supplying
// one without redacting it turns a run log into a credential store.
//
// That is why `resolveCiSecrets` returns the VALUES as well as the env, and why
// `mcp/run-plan.mjs` threads them into `sanitizeOutput` — the single choke point
// everything written or returned already passes through. `check:ci-secrets`
// pins that an injected secret is always also a redacted one.
//
// ── Why the env name carries the test id ──────────────────────────────────
// Two tests can each declare `PASSWORD` and mean different credentials. A
// library-wide `GOOD_LOOKS_SECRET_PASSWORD` would hand one test's staging
// password to another test's production login, which is a failure mode with no
// error message at all — the run succeeds, against the wrong account.

/** Prefix for the per-test, per-name variables a CI operator sets. */
export const CI_SECRET_PREFIX = "GOOD_LOOKS_SECRET_";

/** How the GENERATED SPEC references a secret. One spelling, because the
 *  generator emits it and this resolves it, and a disagreement is a run that
 *  types an empty string into a login form. */
export function specSecretEnvName(name) {
  return `GLAZE_SECRET_${name}`;
}

/** Environment variables are conventionally `[A-Z0-9_]`, and a test id is a
 *  uuid with hyphens in it. Upper-cased with every other character folded to
 *  `_`, so the name a CI operator has to type is derivable from what
 *  `list_tests` shows them. */
function envSafe(part) {
  return String(part).toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** The variable a CI operator sets for one test's one secret. */
export function ciSecretEnvName(testId, name) {
  return `${CI_SECRET_PREFIX}${envSafe(testId)}__${envSafe(name)}`;
}

/**
 * Resolve every secret one test declares.
 *
 * Order, most explicit first:
 *   1. `GOOD_LOOKS_SECRET_<TESTID>__<NAME>` in the environment.
 *   2. The `--secrets-file` map, keyed `<testId>.<name>` or just `<name>`.
 *   3. Nothing — the name comes back in `missing`, and the caller REFUSES BY
 *      NAME rather than running with an empty string.
 *
 * There is deliberately no fourth layer reaching for the app's encrypted store.
 * This runs in plain Node, where that API does not exist; pretending otherwise
 * would mean a resolution path that behaves differently depending on whether an
 * Electron happens to be importable.
 *
 * @returns {{env: Record<string,string>, values: string[], missing: string[]}}
 *   `env` is what the child process gets, `values` is what must be redacted out
 *   of everything it produces, and `missing` is what to refuse over. `values`
 *   is returned SEPARATELY rather than derived from `env` by the caller, so
 *   there is one place that knows a supplied secret is also a redacted one.
 */
export function resolveCiSecrets(test, { env = {}, fileValues = {} } = {}) {
  const declared = (test?.variables ?? [])
    .filter((v) => v?.kind === "secret" && v?.name)
    .map((v) => v.name);

  const out = { env: {}, values: [], missing: [] };
  for (const name of declared) {
    const fromEnv = env[ciSecretEnvName(test.id, name)];
    // Scoped key first: a bare `<name>` in a secrets file is a convenience for
    // a single-test pipeline, and must not beat an operator who was explicit
    // about which test they meant.
    const fromFile = fileValues[`${test.id}.${name}`] ?? fileValues[name];
    const value = fromEnv ?? fromFile;
    // An empty string is a MISSING secret, not a supplied one. Treating it as
    // supplied is exactly the old failure — a login form filled with nothing
    // and an assertion failing several steps later.
    if (typeof value !== "string" || value === "") {
      out.missing.push(name);
      continue;
    }
    out.env[specSecretEnvName(name)] = value;
    out.values.push(value);
  }
  return out;
}

/**
 * Credentials this process was handed by the ENVIRONMENT rather than declared
 * as a test's secret variable.
 *
 * `resolveCiSecrets` above answers "what did this test ask for", and that is
 * the right question for supplying a value — a variable belongs to a test. It
 * is the wrong question for REDACTION, because a credential can reach a run
 * without any test declaring it. The test mailbox is the one that does:
 * `shared/glaze-runtime-source.mjs` reads `GLAZE_MAILBOX_TOKEN` straight from
 * the environment inside the `emailCode` step, so on a CI runner the token is
 * present, is sent as a bearer, and is named by nothing in `test.variables`.
 *
 * A failure inside that step — a 401 from the mailbox, a timeout, any
 * Playwright error quoting the request — then carries a live bearer token into
 * whatever the run produces, and `junitReportFor` writes that into a file a CI
 * system publishes as a build artifact. The app has no equivalent gap:
 * `allRedactableValues()` covers the mailbox token for every one of its send
 * paths. It is only out here, where the encrypted store cannot be read and the
 * environment is the whole supply, that the budget has to be widened by hand.
 *
 * The ENDPOINT is deliberately absent. `GLAZE_MAILBOX_URL` is not a credential
 * — it is guarded by the token, the Worker fails closed without one, and
 * `main/services/secret-redaction.ts` states the cost of redacting it: a run
 * that cannot say which host it polled is a run nobody can debug.
 *
 * Nothing else on this path qualifies today, and that was checked rather than
 * assumed. A Shopify crawler signature cannot reach an unattended run at all:
 * `mcp/store.mjs` reads the plaintext register — hosts and expiries — and the
 * header values live in an encrypted blob beside it that this process cannot
 * open. If a credential ever does arrive by a new variable, it belongs here,
 * because "what this process resolved" is the budget and a value outside it is
 * a value nothing will strip.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string[]} values to redact, never to inject as a variable
 */
export function ambientCiSecretValues(env = {}) {
  const token = env.GLAZE_MAILBOX_TOKEN;
  return typeof token === "string" && token !== "" ? [token] : [];
}

/** The sentence a refusal prints. Names the variables to set rather than saying
 *  "secrets are unavailable", because the operator's next question is always
 *  "what do I call them" and the answer is derivable but not guessable. */
export function describeMissingSecrets(test, missing) {
  const names = missing.map((n) => `  ${ciSecretEnvName(test.id, n)}`).join("\n");
  return (
    `"${test.name ?? test.id}" declares ${missing.length} secret variable` +
    `${missing.length === 1 ? "" : "s"} with no value here: ${missing.join(", ")}.\n` +
    `Set ${missing.length === 1 ? "it" : "them"} in the environment:\n${names}\n` +
    `…or pass --secrets-file with a JSON object keyed "${test.id}.<name>" or "<name>".`
  );
}
