// Does an MCP run prune the app's run history the way the APP prunes it?
//
// ── The bug ────────────────────────────────────────────────────────────────
// `mcp/server.mjs` and `run-history-store.ts` both append to
// `recorder/run-history.json`, and they had drifted for months. PR #158
// ("Count every run in the Stats totals, not the last 1000") raised the app's
// cap from 1000 to 50000 and built the pruned tally underneath it, across 37
// files — and touched nothing under `mcp/`. The server kept the pre-#158
// policy: cap 1000, no tally.
//
// So ONE MCP run against a store the app had grown past a thousand records
// truncated it to a thousand, deleted the dropped runs' log files, and — because
// the tally was never written — took those runs out of the lifetime totals for
// good. Nothing throws. The Stats board just reports a smaller history than the
// machine actually has, which is the exact bug #158 existed to end.
//
// ── Why this check, and why it could not have existed before ───────────────
// Every existing mcp check reads source or imports pure modules; none of them
// can append a run and look at the file afterwards, because `saveRunRecord`
// lived inside `server.mjs` and importing that starts a server on stdio. That
// is why the drift was invisible for months, and it is why the function moved
// to `mcp/run-history.mjs` — the same reasoning that put the run plan in
// `mcp/run-plan.mjs`.
//
// Both writers are driven against ONE fixture tree and their outcomes compared,
// like `check:mcp-parity` §13 does for the two data-dir resolvers. Agreement is
// the property; neither side's number is asserted on its own, because a check
// that restates a constant agrees with a typo in it.
//
//   npm run check:mcp-run-history

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RUN_HISTORY_CAP } from "../../../shared/run-history-rules.mjs";
import { saveRunRecord } from "../../../mcp/run-history.mjs";
import type { RunRecord } from "../../recorder/types.js";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "gl-mcp-runhist-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { runHistoryStore } = await import("../run-history-store.js");

let failures = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}
function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const recorderDir = path.join(userData, "recorder");
const indexFile = path.join(recorderDir, "run-history.json");
const tallyFile = path.join(recorderDir, "run-history-pruned.json");
const logsDir = path.join(recorderDir, "logs");

/** One run, carrying only what either writer reads. */
function seeded(i: number): RunRecord {
  return {
    id: `seed-${i}`,
    testId: "t1",
    testName: "Alpha",
    url: "https://example.test",
    status: i % 4 === 0 ? "failed" : "passed",
    exitCode: i % 4 === 0 ? 1 : 0,
    // Distinct days, so the pruned DAY breakdown has something to get wrong.
    startedAt: Date.UTC(2026, 0, 1) + i * 60_000,
    finishedAt: Date.UTC(2026, 0, 1) + i * 60_000 + 1_000,
    durationMs: 1_000,
    logFile: path.join(logsDir, `seed-${i}.log`),
    logBytes: 4,
  } as RunRecord;
}

/** A store sitting exactly ON the cap, with a real log file per run — so a
 *  prune has something to delete and the deletion is observable. */
function seedAtCap(): void {
  fs.rmSync(recorderDir, { recursive: true, force: true });
  fs.mkdirSync(logsDir, { recursive: true });
  const records = Array.from({ length: RUN_HISTORY_CAP }, (_, i) => seeded(i));
  fs.writeFileSync(indexFile, JSON.stringify(records), "utf-8");
  // Only the oldest few need a real file; those are the ones a prune drops.
  for (let i = 0; i < 5; i++) fs.writeFileSync(records[i].logFile, "log", "utf-8");
}

function readTally(): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(tallyFile, "utf-8"));
  } catch {
    return null;
  }
}

// ── 1. The cap is ONE number, and it is the app's ─────────────────────
{
  seedAtCap();
  eq(
    JSON.parse(fs.readFileSync(indexFile, "utf-8")).length,
    RUN_HISTORY_CAP,
    "the seeded index sits exactly at the shared cap",
  );

  const newRun = { ...seeded(RUN_HISTORY_CAP), id: "from-mcp" };
  saveRunRecord(userData, newRun, "mcp log");

  const after = JSON.parse(fs.readFileSync(indexFile, "utf-8")) as RunRecord[];
  eq(after.length, RUN_HISTORY_CAP, "an MCP append prunes to the cap, not below it");
  // THE REGRESSION. At the old cap this said 1000, i.e. 49,000 records gone.
  assert(
    after.length > 1000,
    `an MCP run no longer truncates the history to the old 1000 (kept ${after.length})`,
  );
  assert(
    after.some((r) => r.id === "from-mcp"),
    "…and the run it was appending is one of the survivors",
  );
  assert(
    !after.some((r) => r.id === "seed-0"),
    "…while the oldest record really was dropped, so this is a prune and not a no-op",
  );
  assert(!fs.existsSync(seeded(0).logFile), "the dropped run's log file is deleted with it");
}

// ── 2. What the cap drops is REMEMBERED ───────────────────────────────
//
// The half that made the loss permanent. Deleting records is fine — the index
// is a cache. Deleting them without counting them is what makes "Total runs"
// smaller than the machine's real history, with nothing on screen to show it.
{
  const tally = readTally();
  assert(tally !== null, "an MCP prune writes the pruned tally the app maintains");
  eq(tally?.runs, 1, "…counting exactly the one run it dropped");
  eq((tally?.passed as number) + (tally?.failed as number), tally?.runs, "…coherently");
  assert(
    Array.isArray(tally?.days) && (tally?.days as unknown[]).length === 1,
    "…and bucketing it into the per-day breakdown the digest reads",
  );
}

// ── 3. THE PARITY. Both writers, one starting state, same outcome ─────
//
// The property that matters is not either number, it is that they agree — a
// check restating a constant agrees with a typo in it.
{
  seedAtCap();
  saveRunRecord(userData, { ...seeded(RUN_HISTORY_CAP), id: "via-mcp" }, "mcp log");
  const mcpCount = (JSON.parse(fs.readFileSync(indexFile, "utf-8")) as RunRecord[]).length;
  const mcpTally = readTally();

  seedAtCap();
  runHistoryStore.append({ ...seeded(RUN_HISTORY_CAP), id: "via-app" }, "app log");
  const appCount = (JSON.parse(fs.readFileSync(indexFile, "utf-8")) as RunRecord[]).length;
  const appTally = readTally();

  eq(mcpCount, appCount, "both writers leave the index the same length");
  eq(mcpTally?.runs, appTally?.runs, "both count the same number of pruned runs");
  eq(mcpTally?.passed, appTally?.passed, "…and agree on how many of them passed");
  eq(
    JSON.stringify(mcpTally?.days),
    JSON.stringify(appTally?.days),
    "…and produce an identical per-day breakdown",
  );
}

fs.rmSync(userData, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll MCP run-history checks passed.");
