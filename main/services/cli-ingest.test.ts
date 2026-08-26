/**
 * `good-looks ingest` — carrying a CI job's runs back into this library (R12).
 *
 * Here rather than under `cli/` because vitest's node project takes `main/**`,
 * `mcp/**` and `renderer/lib/**`: a test file beside the code it covers would
 * match NEITHER project and be silently never run. Same placement as
 * `cli-junit.test.ts` and `cli-base-url.test.ts`, for the same reason.
 *
 * ── What most of this file is actually about ───────────────────────────────
 * Not "does it copy rows". A run record arrives from a machine this one does
 * not control, and two of its fields are a path and a filename. The app's
 * `runHistoryStore.readLog` does `readFileSync(rec.logFile)` with no
 * containment check, and `searchLogs` reads EVERY live record's `logFile` and
 * returns an excerpt around each match — so a stored foreign path is an
 * arbitrary-file-read oracle over the whole disk, exposed through a search box.
 *
 * The invariant that prevents it is narrow and worth stating exactly: **the
 * `logFile` on a stored record is always inside this library's own logs
 * directory, whatever the incoming record said.** Several tests below assert
 * only that.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ingestCommand, parseIngestArgs, type IngestOptions } from "../../cli/ingest.mjs";
import {
  INGEST_MAX_TEXT,
  isIngestableRunId,
  normalizeIngestedRun,
  planIngest,
} from "../../shared/run-ingest.mjs";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** A minimal record that passes every REQUIRED check. */
function validRun(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run-1",
    testId: "t-one",
    testName: "One",
    url: "https://example.com",
    status: "passed",
    exitCode: 0,
    startedAt: 1_787_727_709_749,
    finishedAt: 1_787_727_712_296,
    durationMs: 2547,
    // Present, absolute, and from somewhere else — as it always is in reality.
    logFile: "/home/runner/work/x/recorder/logs/run-1.log",
    logBytes: 109,
    ...over,
  };
}

/** A library directory with a run history and, optionally, logs beside it. */
function libraryWith(runs: unknown[], logs: Record<string, string> = {}): string {
  const dir = tempDir("gl-lib-");
  mkdirSync(join(dir, "recorder", "logs"), { recursive: true });
  writeFileSync(join(dir, "recorder", "run-history.json"), JSON.stringify(runs), "utf8");
  for (const [id, text] of Object.entries(logs)) {
    writeFileSync(join(dir, "recorder", "logs", `${id}.log`), text, "utf8");
  }
  return dir;
}

function run(source: string, dataDir: string, options: Partial<{ dryRun: boolean; json: boolean }> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = ingestCommand(
    { dir: source, dryRun: false, json: false, ...options },
    { out: (s: string) => out.push(s), err: (s: string) => err.push(s), dataDir, now: () => 1_700_000_000_000 },
  );
  const history = () => {
    const file = join(dataDir, "recorder", "run-history.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>[]) : [];
  };
  return { code, out: out.join("\n"), err: err.join("\n"), history };
}

describe("normalizeIngestedRun", () => {
  it("keeps a well-formed record", () => {
    const out = normalizeIngestedRun(validRun());
    expect(out?.id).toBe("run-1");
    expect(out?.status).toBe("passed");
    expect(out?.durationMs).toBe(2547);
  });

  it("NEVER returns the incoming logFile", () => {
    // The whole reason the module exists. `readLog` and `searchLogs` read this
    // path with no containment check, so carrying it is an arbitrary read.
    const out = normalizeIngestedRun(validRun({ logFile: "/Users/someone/.ssh/id_rsa" }));
    expect(out).not.toBeNull();
    expect(out).not.toHaveProperty("logFile");
    expect(JSON.stringify(out)).not.toContain("id_rsa");
  });

  it("zeroes logBytes rather than trusting the incoming count", () => {
    // It describes a file this machine does not have. The caller recomputes it
    // from the log it actually copied.
    expect(normalizeIngestedRun(validRun({ logBytes: 999_999 }))?.logBytes).toBe(0);
  });

  it("refuses an id that could escape the logs directory", () => {
    for (const id of [
      "../../../../tmp/escape",
      "a/b",
      "a\\b",
      ".",
      "..",
      ".hidden",
      "",
      "/absolute",
      "a".repeat(129),
      7,
      null,
    ]) {
      expect(isIngestableRunId(id)).toBe(false);
      expect(normalizeIngestedRun(validRun({ id }))).toBeNull();
    }
  });

  it("admits the ids this application actually mints", () => {
    for (const id of ["8f11fcc8-181f-4ea8-8b16-4f3ba4d91329", "run-1", "R2.d_3"]) {
      expect(isIngestableRunId(id)).toBe(true);
    }
  });

  it("refuses a record missing any REQUIRED field", () => {
    // Not half-ingestable: there is no honest value to invent for a status or a
    // start time, and a record stored with one would be evidence nobody made.
    for (const key of [
      "testId",
      "testName",
      "status",
      "startedAt",
      "finishedAt",
      "durationMs",
      "exitCode",
    ]) {
      const missing = validRun();
      delete missing[key];
      expect(normalizeIngestedRun(missing), `missing ${key}`).toBeNull();
    }
    expect(normalizeIngestedRun(validRun({ status: "nonsense" }))).toBeNull();
    expect(normalizeIngestedRun(validRun({ startedAt: "yesterday" }))).toBeNull();
    expect(normalizeIngestedRun(validRun({ durationMs: -1 }))).toBeNull();
    expect(normalizeIngestedRun(validRun({ exitCode: Number.NaN }))).toBeNull();
  });

  it("drops a bad OPTIONAL field without losing the run", () => {
    // The property that matters more than the refusals. A record with one
    // unusable optional still carries the outcome and the timing, which is what
    // the flake verdict reads.
    const out = normalizeIngestedRun(
      validRun({
        runBrowser: "chrome-canary",
        speed: "ludicrous",
        trigger: "root",
        endedBy: "exploded",
        healedSteps: "many",
        note: "x".repeat(INGEST_MAX_TEXT + 1),
      }),
    );
    expect(out?.id).toBe("run-1");
    expect(out).not.toHaveProperty("runBrowser");
    expect(out).not.toHaveProperty("speed");
    expect(out).not.toHaveProperty("trigger");
    expect(out).not.toHaveProperty("endedBy");
    expect(out).not.toHaveProperty("healedSteps");
    expect(out).not.toHaveProperty("note");
  });

  it("carries no key the sender invented", () => {
    // REBUILDS rather than filters. A spread would carry the next unknown key
    // into a store the app reads through a cast.
    const out = normalizeIngestedRun(validRun({ evilExtraKey: "carried?", __proto__mark: 1 }));
    expect(out).not.toHaveProperty("evilExtraKey");
    expect(out).not.toHaveProperty("__proto__mark");
  });

  it("drops hasTrace, because the trace did not travel", () => {
    // Carrying it lights up an Open Trace button pointing at a file nothing
    // copied. Absent is the truth.
    expect(normalizeIngestedRun(validRun({ hasTrace: true }))).not.toHaveProperty("hasTrace");
  });

  it("drops failedStepIndex and stepCount, which RunRecord does not declare", () => {
    // A real CI record carries both — `mcp/run-tests.mjs` writes them — and the
    // app's RunRecord declares neither. Storing undeclared keys is the
    // rebuild-never-filter rule broken in slow motion, and nothing app-side
    // reads them off a run.
    const out = normalizeIngestedRun(validRun({ failedStepIndex: 1, stepCount: 2 }));
    expect(out).not.toHaveProperty("failedStepIndex");
    expect(out).not.toHaveProperty("stepCount");
  });

  it("narrows trigger and provenance through their OWN gates, not a second copy", () => {
    const out = normalizeIngestedRun(
      validRun({
        trigger: "cli",
        provenance: {
          revision: "c0ffee1",
          // Refused by the provenance gate; must not cost the record its revision.
          repositoryUrl: "javascript:alert(1)",
        },
      }),
    );
    expect(out?.trigger).toBe("cli");
    expect(out?.provenance).toEqual({ revision: "c0ffee1" });
  });

  it("rejects a control character in free text", () => {
    const nl = String.fromCharCode(10);
    expect(normalizeIngestedRun(validRun({ testName: `One${nl}Two` }))).toBeNull();
    expect(normalizeIngestedRun(validRun({ note: `a${nl}b` }))).not.toHaveProperty("note");
  });

  it("refuses anything that is not a plain object", () => {
    for (const bad of [null, undefined, 7, "abc", true, [], [validRun()]]) {
      expect(normalizeIngestedRun(bad)).toBeNull();
    }
  });
});

describe("planIngest", () => {
  it("skips ids this library already has", () => {
    const plan = planIngest(["run-1"], [validRun(), validRun({ id: "run-2" })]);
    expect(plan.fresh.map((r) => r.id)).toEqual(["run-2"]);
    expect(plan.duplicate).toBe(1);
  });

  it("dedupes WITHIN the incoming batch too", () => {
    // Two artifact zips unpacked over each other is a real thing, and without
    // this both copies are fresh — which doubles a test's run count and
    // manufactures flake out of arithmetic.
    const plan = planIngest([], [validRun(), validRun()]);
    expect(plan.fresh).toHaveLength(1);
    expect(plan.duplicate).toBe(1);
  });

  it("counts unusable apart from duplicate", () => {
    // They deserve different sentences: one means look at what produced the
    // directory, the other means you have run the command before.
    const plan = planIngest(["run-1"], [validRun(), { id: "../escape" }, validRun({ id: "run-2" })]);
    expect(plan).toMatchObject({ duplicate: 1, unusable: 1 });
    expect(plan.fresh).toHaveLength(1);
  });

  it("survives a history that is not an array", () => {
    expect(planIngest([], null as unknown as unknown[])).toMatchObject({ fresh: [], duplicate: 0 });
  });
});

describe("ingestCommand", () => {
  it("carries runs in, rewriting the log path into THIS library", () => {
    const source = libraryWith([validRun(), validRun({ id: "run-2", status: "failed", exitCode: 1 })], {
      "run-1": "log one",
      "run-2": "log two",
    });
    const local = libraryWith([]);
    const r = run(source, local);

    expect(r.code).toBe(0);
    const stored = r.history();
    expect(stored).toHaveLength(2);
    for (const rec of stored) {
      expect(rec.logFile).toBe(join(local, "recorder", "logs", `${rec.id}.log`));
    }
    expect(readFileSync(join(local, "recorder", "logs", "run-1.log"), "utf8")).toBe("log one");
  });

  it("stores a log path inside this library even when the record names a secret", () => {
    // THE ONE THAT MATTERS. Without it, the app's log search reads this path and
    // returns excerpts of whatever is there.
    const secret = join(tempDir("gl-secret-"), "id_rsa");
    writeFileSync(secret, "PRIVATE KEY MATERIAL", "utf8");

    const source = libraryWith([validRun({ logFile: secret })]);
    const local = libraryWith([]);
    const r = run(source, local);

    const [stored] = r.history();
    expect(stored.logFile).toBe(join(local, "recorder", "logs", "run-1.log"));
    // The path is not stored, so nothing can later read it...
    expect(JSON.stringify(r.history())).not.toContain(secret);
    // ...and its contents were never read into the store either.
    expect(readFileSync(join(local, "recorder", "logs", "run-1.log"), "utf8")).not.toContain(
      "PRIVATE KEY",
    );
    expect(readFileSync(secret, "utf8")).toBe("PRIVATE KEY MATERIAL");
  });

  it("writes nothing outside the logs directory for a traversal id", () => {
    // The escape target is a path this test OWNS and removes first. Asserting a
    // fixed absolute path was the first version, and a leftover from breaking
    // the guard on purpose then failed the next honest run — a test that reports
    // on the state of /tmp rather than on what this ingest did.
    const outside = tempDir("gl-escape-");
    const target = join(outside, "escaped");
    rmSync(`${target}.log`, { force: true });

    // Enough `..` hops to climb out of <local>/recorder/logs and back down.
    const hops = "../".repeat(target.split("/").length + 4);
    const source = libraryWith([validRun({ id: `${hops}${target.replace(/^\//, "")}` })]);
    const local = libraryWith([]);
    const r = run(source, local);

    expect(r.history()).toHaveLength(0);
    expect(r.out).toContain("could not be read and were refused");
    expect(existsSync(`${target}.log`)).toBe(false);
  });

  it("stamps ingestedAt, so the timing aggregates can tell a container apart", () => {
    const source = libraryWith([validRun()], { "run-1": "x" });
    const local = libraryWith([]);
    const [stored] = run(source, local).history();
    expect(stored.ingestedAt).toBe(1_700_000_000_000);
  });

  it("recomputes logBytes from the log it actually copied", () => {
    const source = libraryWith([validRun({ logBytes: 999_999 })], { "run-1": "seven!" });
    const local = libraryWith([]);
    const [stored] = run(source, local).history();
    expect(stored.logBytes).toBe(6);
  });

  it("is safe to run twice", () => {
    // The natural way to use this is to point it at whatever artifact directory
    // is on hand and let it work out what is new.
    const source = libraryWith([validRun()], { "run-1": "x" });
    const local = libraryWith([]);
    run(source, local);
    const second = run(source, local);

    expect(second.history()).toHaveLength(1);
    expect(second.out).toContain("already in this library");
    expect(second.out).toContain("Nothing new");
  });

  it("keeps a run whose log did not travel", () => {
    // The outcome, the timing and the commit are what the flake verdict reads;
    // losing the row because a file is missing would throw away the evidence
    // this command exists to carry.
    const source = libraryWith([validRun()]);
    const local = libraryWith([]);
    const r = run(source, local);

    expect(r.history()).toHaveLength(1);
    expect(r.out).toContain("without a log file beside them");
    expect(readFileSync(join(local, "recorder", "logs", "run-1.log"), "utf8")).toContain(
      "did not travel",
    );
  });

  it("accepts the artifact unpacked at either level", () => {
    // Half the time a CI zip gives you the library, half the time its recorder/.
    const source = libraryWith([validRun()], { "run-1": "x" });
    const local = libraryWith([]);
    const r = run(join(source, "recorder"), local);
    expect(r.code).toBe(0);
    expect(r.history()).toHaveLength(1);
  });

  it("--dry-run reports and writes nothing", () => {
    const source = libraryWith([validRun()], { "run-1": "x" });
    const local = libraryWith([]);
    const r = run(source, local, { dryRun: true });

    expect(r.out).toContain("Would ingest 1 run");
    expect(r.history()).toHaveLength(0);
    expect(existsSync(join(local, "recorder", "logs", "run-1.log"))).toBe(false);
  });

  it("--json prints the counts a script can read", () => {
    const source = libraryWith([validRun(), { id: "../escape" }], { "run-1": "x" });
    const local = libraryWith([]);
    const r = run(source, local, { json: true });
    expect(JSON.parse(r.out)).toMatchObject({ ingested: 1, alreadyPresent: 0, unusable: 1 });
  });

  it("refuses this library's own directory by name", () => {
    // Harmless — every record would be a duplicate — which is exactly why it is
    // worth naming. "0 new, 412 already present" is true and leaves you no wiser.
    const local = libraryWith([validRun()]);
    const r = run(local, local);
    expect(r.code).toBe(3);
    expect(r.err).toContain("own directory");
  });

  it("refuses a directory that is not a library, rather than reporting nothing to do", () => {
    const empty = tempDir("gl-empty-");
    const local = libraryWith([]);
    const r = run(empty, local);
    expect(r.code).toBe(3);
    expect(r.err).toContain("No run history under");
  });

  it("refuses a directory that does not exist", () => {
    const local = libraryWith([]);
    const r = run(join(local, "nope"), local);
    expect(r.code).toBe(3);
    expect(r.err).toContain("No such directory");
  });

  it("refuses a run history that is not a JSON array", () => {
    const source = tempDir("gl-bad-");
    mkdirSync(join(source, "recorder"), { recursive: true });
    writeFileSync(join(source, "recorder", "run-history.json"), "{ not an array }", "utf8");
    const local = libraryWith([]);
    const r = run(source, local);
    expect(r.code).toBe(3);
    expect(r.err).toContain("not a readable run history");
  });
});

describe("parseIngestArgs", () => {
  // The parser returns a union, so the tests narrow it the same way
  // `cli-base-url.test.ts` does rather than repeating a cast per assertion.
  const opts = (argv: string[]) =>
    (parseIngestArgs(argv) as { ok: true; options: IngestOptions }).options;
  const why = (argv: string[]) => (parseIngestArgs(argv) as { ok: false; error: string }).error;

  it("takes the directory positionally", () => {
    expect(parseIngestArgs(["./artifact"])).toEqual({
      ok: true,
      options: { dir: "./artifact", dryRun: false, json: false },
    });
  });

  it("reads --dry-run and --json", () => {
    expect(opts(["d", "--dry-run", "--json"])).toEqual({ dir: "d", dryRun: true, json: true });
  });

  it("REFUSES an unknown option rather than ingesting with defaults", () => {
    // A misspelt flag must not quietly become "ingest with whatever you assumed"
    // against the user's real run history.
    expect(parseIngestArgs(["d", "--dryrun"])).toMatchObject({ ok: false });
    expect(why(["d", "--dryrun"])).toContain("--dryrun");
  });

  it("has NO default directory", () => {
    expect(parseIngestArgs([])).toMatchObject({ ok: false });
    expect(why([])).toContain("Which directory");
  });

  it("refuses two directories rather than silently using one", () => {
    expect(why(["a", "b"])).toContain("one directory at a time");
  });

  it("answers --help without needing a directory", () => {
    expect(parseIngestArgs(["--help"])).toEqual({ ok: "help" });
    expect(parseIngestArgs(["-h"])).toEqual({ ok: "help" });
  });
});

describe("the real binary", () => {
  it("dispatches `ingest` and exits 0", () => {
    // The `check:mcp-boot` lesson in miniature: a subcommand that is not wired
    // into bin/ is unreachable no matter how well its module tests pass.
    const source = libraryWith([validRun()], { "run-1": "x" });
    const local = libraryWith([]);
    const stdout = execFileSync(
      process.execPath,
      [resolve(process.cwd(), "bin", "good-looks.mjs"), "ingest", source],
      { env: { ...process.env, GOOD_LOOKS_USERDATA: local }, encoding: "utf8" },
    );
    expect(stdout).toContain("Ingested 1 run");
    const stored = JSON.parse(
      readFileSync(join(local, "recorder", "run-history.json"), "utf8"),
    ) as Record<string, unknown>[];
    expect(stored).toHaveLength(1);
    expect(stored[0].logFile).toBe(join(local, "recorder", "logs", "run-1.log"));
  });
});

describe("retries (R24)", () => {
  // CI is where `--retries` is used, so a run that recovered on a retry is
  // exactly the run this command exists to carry back. Both fields are
  // OPTIONAL on RunRecord, so `check:run-ingest` stayed green while the gate
  // dropped them — the loss would have been silent, and the flake verdict
  // would have read a green history for a test that went red every run.
  it("carries a retried pass, so the flake verdict still sees the failure", () => {
    const out = normalizeIngestedRun({
      ...validRun(),
      attempt: 2,
      passedOnRetry: true,
    });
    expect(out).not.toBeNull();
    expect(out!.attempt).toBe(2);
    expect(out!.passedOnRetry).toBe(true);
  });

  it("refuses an unusable attempt without losing the run", () => {
    // An optional field judged on its own: a bad value costs itself, never the
    // record. The run's outcome and timing are what the verdict reads.
    const out = normalizeIngestedRun({
      ...validRun(),
      attempt: "two" as unknown as number,
      passedOnRetry: "yes" as unknown as boolean,
    });
    expect(out).not.toBeNull();
    expect("attempt" in out!).toBe(false);
    expect("passedOnRetry" in out!).toBe(false);
    expect(out!.status).toBe(validRun().status);
  });

  it("leaves a run that never retried carrying neither field", () => {
    const out = normalizeIngestedRun(validRun());
    expect("attempt" in out!).toBe(false);
    expect("passedOnRetry" in out!).toBe(false);
  });
});
