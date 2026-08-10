// Reading a run's recorded console + network back off disk.
//
// The capture fixture does the STRUCTURAL scrubbing (header allowlist, masked
// query parameters) because it is the only code running at write time. It
// cannot do secret redaction: the user's configured secret values live in an
// encrypted store in the MAIN process, and the fixture runs inside Playwright's.
// So redaction happens here, on read — the last point before this data can
// reach a UI or an LLM prompt. If that link is ever broken, a secret typed
// during recording and echoed by the page goes to a hosted model.
//
// Run with: npm run check:run-logs

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-run-logs-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { artifactStore } = await import("../artifact-store.js");
const { setSecretSnapshotForTesting, REDACTED } = await import("../secret-redaction.js");
const { readStepStructures } = await import("../../../mcp/artifacts.mjs");
const { buildStepStructures } = await import("../../recorder/types.js");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const TEST_ID = "t1";
const RUN_ID = "r1";

function runDir(): string {
  const dir = path.join(userData, "recorder", "artifacts", TEST_ID, RUN_ID);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function write(name: string, body: unknown): void {
  fs.writeFileSync(path.join(runDir(), name), JSON.stringify(body, null, 2), "utf-8");
}

// ── Nothing recorded ─────────────────────────────────────────────────
assert(artifactStore.readLogs(TEST_ID, RUN_ID) === null, "a run with no log files reads as null");
assert(artifactStore.hasLogs(TEST_ID, RUN_ID) === false, "hasLogs is false for such a run");
assert(
  artifactStore.readLogs("missing-test", "missing-run") === null,
  "a run that does not exist at all reads as null",
);

// ── Round trip ───────────────────────────────────────────────────────
setSecretSnapshotForTesting([]);
write("console.json", {
  testId: TEST_ID,
  runId: RUN_ID,
  dropped: 12,
  entries: [{ step: 1, ts: 1, type: "error", text: "boom", url: "https://x.test/a.js", line: 9 }],
});
write("network.json", {
  testId: TEST_ID,
  runId: RUN_ID,
  dropped: 3,
  headersFiltered: true,
  entries: [
    {
      step: 1,
      ts: 1,
      ms: 40,
      method: "GET",
      url: "https://x.test/api",
      resourceType: "fetch",
      status: 500,
      ok: false,
    },
  ],
});

{
  const logs = artifactStore.readLogs(TEST_ID, RUN_ID);
  assert(logs !== null, "both files present → logs are returned");
  assert(logs?.console.length === 1, "console entries round-trip");
  assert(logs?.network.length === 1, "network entries round-trip");
  assert(logs?.consoleDropped === 12, "the recorder's console drop count is preserved");
  assert(logs?.networkDropped === 3, "…and its network drop count");
  assert(logs?.headersFiltered === true, "headersFiltered is reported");
  assert(artifactStore.hasLogs(TEST_ID, RUN_ID) === true, "hasLogs is true once files exist");
}

// ── Secret redaction on the way out ──────────────────────────────────
{
  setSecretSnapshotForTesting(["hunter2", "sk-live-9999"]);
  write("console.json", {
    dropped: 0,
    entries: [
      { step: 0, ts: 0, type: "log", text: "logging in with hunter2", url: "", line: 0 },
      { step: 1, ts: 0, type: "error", text: "auth failed for sk-live-9999", url: "", line: 0 },
    ],
  });
  write("network.json", {
    dropped: 0,
    headersFiltered: true,
    entries: [
      {
        step: 0,
        ts: 0,
        ms: 1,
        method: "POST",
        url: "https://x.test/login?u=hunter2",
        resourceType: "fetch",
        status: 200,
        ok: true,
      },
    ],
  });

  const logs = artifactStore.readLogs(TEST_ID, RUN_ID);
  const serialized = JSON.stringify(logs);
  assert(serialized.indexOf("hunter2") < 0, "a secret in console text never leaves the store");
  assert(serialized.indexOf("sk-live-9999") < 0, "…nor a secret in an error message");
  assert(serialized.indexOf(REDACTED) >= 0, "…and the redaction is visible rather than silent");
  assert(
    logs?.console[0].text.indexOf("logging in with") === 0,
    "the surrounding text survives redaction",
  );
  assert(
    logs?.network[0].url.indexOf("https://x.test/login") === 0,
    "a secret inside a URL is redacted without destroying the URL",
  );
  setSecretSnapshotForTesting([]);
}

// ── Partial and corrupt files ────────────────────────────────────────
{
  fs.rmSync(path.join(runDir(), "network.json"));
  const logs = artifactStore.readLogs(TEST_ID, RUN_ID);
  assert(logs !== null, "console alone is still worth returning");
  assert(logs?.network.length === 0, "…with an empty network list rather than a crash");
}

{
  fs.writeFileSync(path.join(runDir(), "network.json"), "{ not json", "utf-8");
  const logs = artifactStore.readLogs(TEST_ID, RUN_ID);
  assert(logs !== null, "a corrupt network file does not take the console down with it");
  assert(logs?.network.length === 0, "…and reads as empty");
}

{
  fs.writeFileSync(path.join(runDir(), "console.json"), "{ also not json", "utf-8");
  assert(
    artifactStore.readLogs(TEST_ID, RUN_ID) === null,
    "both files corrupt reads as null rather than an empty-but-present result",
  );
  // hasLogs is a cheap existence probe, so a corrupt file still counts as
  // "recorded" — the distinction the UI needs is "was recording on?", and
  // answering that must not require parsing megabytes.
  assert(artifactStore.hasLogs(TEST_ID, RUN_ID) === true, "hasLogs still reports the files exist");
}

// ── Missing fields ───────────────────────────────────────────────────
{
  write("console.json", {});
  write("network.json", { entries: [], headersFiltered: false });
  const logs = artifactStore.readLogs(TEST_ID, RUN_ID);
  assert(logs?.console.length === 0, "a file with no entries array reads as empty");
  assert(logs?.consoleDropped === 0, "a missing drop count defaults to zero");
  assert(
    logs?.headersFiltered === false,
    "headersFiltered:false is honoured — it means every header was recorded",
  );
}

// ── The page-structure record, and its two readers ───────────────────
//
// Written once by the run, read by the app (buildStepStructures, over IPC) and
// by the MCP server (readStepStructures, a separate .mjs reimplementation —
// the app's is compiled TypeScript the MCP cannot import). Two readers of one
// artifact is exactly where a format drifts, and neither side would throw: the
// app would show a card missing half its evidence while the MCP answered a
// model with the other half.
{
  const matchSet = {
    stepId: "s1",
    stepIndex: 4,
    stepLabel: "Click button",
    method: "click",
    originalLocator: { k: "role", role: "button", name: "Pause" },
    matchCount: 10,
    matches: [
      {
        index: 0,
        tag: "button",
        testid: "video-pause",
        classes: ["player-control"],
        ancestors: ["div[data-testid=video-player]"],
        visible: true,
        enabled: true,
      },
    ],
  };
  const healFailure = {
    outcome: "exhausted",
    stepId: "s1",
    stepIndex: 4,
    stepLabel: "Click button",
    method: "click",
    originalLocator: { k: "role", role: "button", name: "Pause" },
    candidates: [
      { locator: { k: "testid", v: "video-pause" }, description: "button", score: 0.9, matchedPastRun: true },
    ],
  };

  assert(
    artifactStore.hasHealFailures(TEST_ID, RUN_ID) === false,
    "a run with neither file reports no page structure",
  );
  assert(readStepStructures(userData, TEST_ID, RUN_ID) === null, "…and the MCP reader agrees");

  artifactStore.writeStepMatches(TEST_ID, RUN_ID, [matchSet]);
  artifactStore.writeHealFailures(TEST_ID, RUN_ID, [healFailure as never]);

  assert(artifactStore.hasHealFailures(TEST_ID, RUN_ID) === true, "either file counts as recorded");

  const app = buildStepStructures(
    artifactStore.readHealFailures(TEST_ID, RUN_ID),
    artifactStore.readStepMatches(TEST_ID, RUN_ID),
  );
  const mcp = readStepStructures(userData, TEST_ID, RUN_ID) ?? [];

  assert(app.length === 1 && mcp.length === 1, "both readers join the two files into ONE step");
  assert(
    app[0].matchCount === 10 && mcp[0].matchCount === 10,
    "both carry the true match count — a capped list that stays silent reads as the whole set",
  );
  assert(
    app[0].matches.length === 1 && mcp[0].matches.length === 1,
    "both carry what the locator actually matched",
  );
  assert(
    app[0].candidates.length === 1 && mcp[0].candidates.length === 1,
    "both carry what Auto-Heal ranked beside it",
  );
  assert(
    app[0].outcome === "exhausted" && mcp[0].outcome === "exhausted",
    "both carry the heal outcome",
  );
  assert(
    app[0].matches[0].testid === "video-pause" && mcp[0].matches[0].testid === "video-pause",
    "the field names agree across the two implementations",
  );

  // Either file alone is a complete answer to a different question: a locator
  // that was ambiguous and then HEALED writes matches and no heal failure.
  fs.rmSync(path.join(runDir(), "heal-failures.json"), { force: true });
  const matchOnlyApp = buildStepStructures(
    artifactStore.readHealFailures(TEST_ID, RUN_ID),
    artifactStore.readStepMatches(TEST_ID, RUN_ID),
  );
  const matchOnlyMcp = readStepStructures(userData, TEST_ID, RUN_ID) ?? [];
  assert(
    matchOnlyApp.length === 1 && matchOnlyMcp.length === 1,
    "a match record with no heal failure still reports, on both sides",
  );
  assert(
    matchOnlyApp[0].outcome === undefined && matchOnlyMcp[0].outcome === undefined,
    "…and neither invents a heal outcome for it",
  );
}

fs.rmSync(userData, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll run-log checks passed");
