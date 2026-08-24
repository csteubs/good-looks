// Standalone wiring guard for HTTP basic auth — the invariants an adversarial
// review found broken in the first draft, pinned so they cannot silently
// regress. Each is a call site or handler body that unit tests can't reach
// (the run flow, the IPC handlers), the same reason check:auto-heal-wiring and
// check:capture-egress read source directly.
//
// Run with:
//   npx tsx main/services/__tests__/basic-auth.check.ts
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, rel), "utf8");

let failures = 0;
function assert(ok: boolean, label: string): void {
  if (!ok) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}
/** A window of `src` starting at `marker` — enough to cover one short handler
 *  body or callback. The handlers here are a dozen lines; 900 chars is ample. */
function windowAt(src: string, marker: string, span = 900): string {
  const i = src.indexOf(marker);
  return i < 0 ? "" : src.slice(i, i + span);
}
/** A balanced `{ … }` block starting at the first `{` after `marker`. */
function blockAt(src: string, marker: string): string {
  const start = src.indexOf(marker);
  if (start < 0) return "";
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return "";
}

const generator = read("../script-generator.ts");
const runner = read("../playwright-runner.ts");
const recorder = read("../recorder-service.ts");
const handlers = read("../../handlers/index.ts");

// ── 1. The credential is SCOPED on both halves — the leak the review found ──
//
// Without an origin scope, Playwright answers any 401 during a run and the
// trainer answers any challenge in the page, so the password would travel to a
// third-party subresource or a redirect host. The run half emits `origin:`; the
// trainer half routes the decision through the shared `answersLoginFor`.
{
  const emit = generator.slice(generator.indexOf("HTTP basic auth"));
  assert(
    /httpCredentials/.test(emit) && /originClause/.test(emit) && /credentialOrigin\(/.test(emit),
    "the generator scopes httpCredentials to the test's origin",
  );
  const login = blockAt(recorder, 'wc.on("login"');
  assert(
    /answersLoginFor\(/.test(login),
    "the trainer login handler scopes through answersLoginFor (never answers a foreign origin)",
  );
  assert(
    recorder.includes('from "../../shared/basic-auth.mjs"'),
    "the trainer imports the shared scope rule, not a private copy",
  );
}

// ── 2. Every path that generates a spec passes basicAuth ─────────────────────
//
// A path that regenerates a spec (or its line map) WITHOUT basicAuth produces a
// spec two preamble lines shorter than the one on disk: the reporter's line
// numbers then miss, and a replay omits the credentials and fails at the wall.
{
  // The line-map path — off-by-two step highlighting if it drops basicAuth.
  const fnBody = windowAt(runner, "export function generatedStepLineMap", 1200);
  assert(
    /generateSpecDetailed\([^)]*basicAuth: rec\.basicAuth/s.test(fnBody),
    "generatedStepLineMap passes basicAuth (or the reporter highlights the wrong step)",
  );

  // The replay-run path — a re-run of a past run must carry the credentials.
  assert(
    /steps: replaySteps,[^;]*basicAuth: rec\.basicAuth/s.test(runner),
    "the replay-run spec passes basicAuth (or re-running a past run fails at the wall)",
  );

  // The canonical regeneration path.
  const testStore = read("../test-store.ts");
  assert(
    /basicAuth: record\.basicAuth/.test(testStore),
    "testStore.regenerateScript passes basicAuth",
  );
}

// ── 3. The IPC handlers keep the record and the spec in step ─────────────────
{
  // Saving/clearing basic auth must regenerate — otherwise the on-disk spec the
  // runner executes stays stale and the UI lies about what a run does.
  const setBa = windowAt(handlers, '"tests:setBasicAuth"');
  assert(
    /regenerateScript\(rec\)/.test(setBa),
    "tests:setBasicAuth regenerates the spec (saving basic auth must affect runs)",
  );
  // Deleting the referenced secret must clear the now-dangling credential, or
  // the run silently authenticates with an empty password.
  const setVars = windowAt(handlers, '"tests:setVariables"', 2000);
  assert(
    /rec\.basicAuth/.test(setVars) && /delete rec\.basicAuth/.test(setVars),
    "tests:setVariables clears a basicAuth whose secret was removed",
  );
}

// ── 3b. The live page is the THIRD consumer, and it scopes ───────────────────
{
  // Added 2026-08-24 with the live page's credential support. Nothing in this
  // check asserts a CARDINALITY, so it stayed green whether a third surface
  // scoped correctly, scoped wrongly, or did not scope at all — and an unscoped
  // `httpCredentials` answers ANY server's 401, which is the leak this whole
  // file exists to keep closed.
  const live = read("../live-page-service.ts");
  assert(
    /credentialOrigin\(/.test(live),
    "the live page derives its scope from the SHARED credentialOrigin, not a rule of its own",
  );
  // From the RECORD, not from the address it was handed. The renderer passes
  // the `${var}`-interpolated URL, so scoping off that would give a live page a
  // different origin from the run for the same test — the third dialect.
  assert(
    /credentialOrigin\(rec\?\.url\)\s*\?\?\s*credentialOrigin\(rec\?\.baseUrl\)/.test(live),
    "…off the record's own url/baseUrl, in that precedence, exactly as the run and the trainer do",
  );
  assert(
    !/setHTTPCredentials/.test(live),
    "…and never through setHTTPCredentials, which is deprecated and cannot carry an origin at all",
  );
}

// ── 4. The renderer refreshes the secret-status the basic-auth warning reads ─
{
  const panel = read("../../../renderer/main/variables-panel.tsx");
  const invalidate = blockAt(panel, "const invalidate = () =>");
  assert(
    /secretStatus/.test(invalidate),
    "the Variables panel invalidates secretStatus (or the 'no stored value' warning goes stale)",
  );
}

if (failures > 0) {
  console.error(`\n${failures} basic-auth check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll basic-auth checks passed");
