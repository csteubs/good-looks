// The ingest boundary (R12), and whether it still agrees with RunRecord.
//
// The plan requires an ingress path to extend the guard family — check:step-ingest,
// check:capture-egress, check:deep-link — in the commit that adds it. This is that
// guard for `good-looks ingest`.
//
// Two properties, and the second is the one a unit test cannot see.
//
// 1. THE PATH RULE. A stored `logFile` must always be inside this library's logs
//    directory. `runHistoryStore.readLog` reads it with no containment check and
//    `searchLogs` reads every live record's and returns excerpts, so a foreign
//    path stored here is readable through the app's search box.
//    `cli-ingest.test.ts` proves the behaviour; this asserts the structure that
//    makes it hold — the gate does not return the field, and the caller derives
//    it from the id.
//
// 2. FIELD AGREEMENT. The gate rebuilds a record field by field, so it and
//    `RunRecord` drift the moment either changes alone. Two directions, both
//    silent:
//      - a field the gate copies that RunRecord does not declare puts an
//        undeclared key in the app's store;
//      - a REQUIRED RunRecord field the gate does not produce means every
//        ingested record is missing something the app's readers assume.
//
// Run with: npm run check:run-ingest

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { normalizeIngestedRun } from "../../../shared/run-ingest.mjs";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    console.error(`FAIL ${label}`);
    failures++;
  }
}

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

const gate = read("shared/run-ingest.mjs");
const command = read("cli/ingest.mjs");
const bin = read("bin/good-looks.mjs");
const types = read("main/recorder/types.ts");

// ── 1. The path rule ───────────────────────────────────────────────────────
{
  // The gate must not hand back a logFile at all. Returning the incoming one is
  // the whole vulnerability; returning a derived one would put path knowledge in
  // a module that has no filesystem.
  const returned = normalizeIngestedRun({
    id: "run-1",
    testId: "t",
    testName: "n",
    url: "u",
    status: "passed",
    exitCode: 0,
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    logFile: "/etc/passwd",
    logBytes: 9,
  });
  assert(returned !== null, "gate: accepts a well-formed record");
  assert(
    returned !== null && !("logFile" in returned),
    "gate: returns NO logFile, so a foreign path cannot reach the store",
  );
  assert(
    !JSON.stringify(returned).includes("/etc/passwd"),
    "gate: …and the incoming path appears nowhere in what it returns",
  );

  // The caller derives both paths from the id. Anchored on the writes rather
  // than on the identifier: a mention of `record.logFile` in a comment must not
  // satisfy or fail this.
  assert(
    /logFile: path\.join\(localLogs, `\$\{record\.id\}\.log`\)/.test(command),
    "cli: writes a logFile derived from the id and this library's logs directory",
  );
  assert(
    /const from = path\.join\(sourceLogs, `\$\{record\.id\}\.log`\)/.test(command),
    "cli: reads the source log by id too, never from the record's own path",
  );
  assert(
    !/record\.logFile/.test(command.replace(/\/\/[^\n]*/g, "")),
    "cli: never reads the incoming logFile in code",
  );

  // The id becomes a filename, so it is validated before it is used as one.
  assert(
    /if \(!isIngestableRunId\(raw\.id\)\) return null;/.test(gate),
    "gate: refuses a record whose id is not usable as a filename",
  );
  assert(
    normalizeIngestedRun({ id: "../../escape" }) === null,
    "gate: …and a traversal id is refused for real, not only in source",
  );

  // logBytes describes a file this machine has, so it cannot come from the wire.
  assert(/logBytes: 0,/.test(gate), "gate: zeroes logBytes rather than trusting the sender");
  assert(
    /logBytes: Buffer\.byteLength\(logText/.test(command),
    "cli: …and recomputes it from the log it actually copied",
  );
}

// ── 2. Field agreement with RunRecord ──────────────────────────────────────
{
  const interfaceStart = types.indexOf("export interface RunRecord {");
  const body = types.slice(interfaceStart, types.indexOf("\n}", interfaceStart));
  assert(interfaceStart > -1 && body.includes("testId"), "isolated the RunRecord interface");

  const declared = new Map<string, boolean>(); // name -> required
  for (const [, name, optional] of body.matchAll(/^ {2}(\w+)(\??):/gm)) {
    declared.set(name, optional !== "?");
  }
  assert(declared.size > 30, `read RunRecord's fields (${declared.size})`);

  // What the gate produces: the literal it builds plus every `opt("x", …)`.
  const literalStart = gate.indexOf("const out = {");
  const literal = gate.slice(literalStart, gate.indexOf("};", literalStart));
  const produced = new Set<string>();
  // `[,:]`, not `:` alone. Half the literal uses shorthand properties
  // (`testId,`), and anchoring on the colon reported every one of them missing
  // — a FAIL naming working code, which is the safe direction to be wrong in
  // but still wrong.
  for (const [, name] of literal.matchAll(/^ {4}(\w+)[,:]/gm)) produced.add(name);
  for (const [, name] of gate.matchAll(/opt\("(\w+)"/g)) produced.add(name);
  assert(produced.size > 20, `read the fields the gate produces (${produced.size})`);

  // Direction one: nothing undeclared reaches the store.
  const undeclared = [...produced].filter((f) => !declared.has(f));
  assert(
    undeclared.length === 0,
    undeclared.length === 0
      ? "every field the gate produces is one RunRecord declares"
      : `the gate produces ${undeclared.join(", ")}, which RunRecord does not declare`,
  );

  // Direction two: nothing required is missing. `logFile` is the one exemption,
  // and it is the point of the module — the caller supplies it.
  const missing = [...declared]
    .filter(([name, required]) => required && name !== "logFile" && !produced.has(name))
    .map(([name]) => name);
  assert(
    missing.length === 0,
    missing.length === 0
      ? "every REQUIRED RunRecord field is one the gate produces (logFile excepted)"
      : `the gate never produces required field(s): ${missing.join(", ")}`,
  );
  assert(
    declared.get("logFile") === true && !produced.has("logFile"),
    "…and logFile is required by RunRecord and deliberately absent from the gate",
  );

  // `ingestedAt` marks a run this machine did not perform. Without it the cost
  // and duration aggregates mix a container's hardware into a laptop's with no
  // way to separate them.
  assert(declared.has("ingestedAt"), "RunRecord can say a run was ingested rather than performed");
  assert(
    /ingestedAt: stamp,/.test(command),
    "…and ingest stamps it, so the timing readouts can exclude foreign runs",
  );
}

// ── 2b. Site Health travels with the run ──────────────────────────────────
//
// Two halves, two rules. The per-host SUMMARY is a field on the record and
// goes through the gate like every other optional field (through the shared
// normaliser, not a copy of it). The per-page ARTIFACT is a file beside the
// log, copied into a directory named from the ids the gate accepted — with
// the test id checked by the same token rule as the run id, because here it
// is a path segment too. And every ingested run is rolled into metrics.db
// through the same `recordRun` the MCP's own runs use; before that, a CI
// run reached the database only when the app happened to rebuild it.
{
  assert(
    /opt\("siteHealth", normalizeSiteHealthSummary\(raw\.siteHealth\)\)/.test(gate),
    "gate: admits the Site Health summary through the shared normaliser",
  );
  assert(
    /isIngestableRunId\(testId\) \|\| !isIngestableRunId\(runId\)/.test(command) && /SITE_HEALTH_FILE/.test(command),
    "ingest: copies site-health.json only under ids that pass the token rule, both segments",
  );
  assert(
    /fs\.copyFileSync\(from, path\.join\(dest, SITE_HEALTH_FILE\)\)/.test(command),
    "ingest: …and COPIES it (a stored foreign path would be the logFile bug again)",
  );
  assert(
    /await recordRun\(dataDir, entry\.record, journal, entry\.logText\)/.test(command),
    "ingest: rolls every ingested run into metrics.db through the MCP's recordRun",
  );
}

// ── 3. It is reachable ─────────────────────────────────────────────────────
{
  // The check:mcp-boot lesson: a subcommand not wired into the entry point is
  // unreachable however well its module is tested.
  assert(/command === "ingest"/.test(bin), "bin: dispatches the ingest subcommand");
  assert(/ingest\s+carry a CI job/.test(bin), "bin: …and lists it in the usage text");
  assert(
    /saveRunRecords/.test(command),
    "cli: writes through the shared run-history writer, so the cap and tally are not a second copy",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll ingest boundary checks passed.");
