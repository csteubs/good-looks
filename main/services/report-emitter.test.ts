// Scoping an emit, and writing one without a dialog. R1 in
// docs/plans/test-runner-improvements.md.
//
// Two properties are worth a test here and neither is visible by looking at the
// panel.
//
// THE SCOPE. `buildReport` used to read the whole live run history and filter
// only by `testId`, so a JUnit file emitted after a twelve-test routine
// described every run the machine had ever kept. That file is well-formed, a CI
// dashboard ingests it without complaint, and it reports four thousand test
// cases including failures from months earlier. Nothing about it looks wrong —
// which is why the assertions below are about WHICH runs came back rather than
// about the bytes.
//
// THE REDACTION ON THE UNATTENDED PATH. `emitReportTo` writes with no dialog and
// no person, so nobody sees the file before it exists. `check:emit-redaction`
// pins the source-level rule; this pins the behaviour, by putting a credential
// in a run and asserting it is not in the bytes on disk.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The live run history the store hands back, and the scope the metrics query
 *  was asked for — both reachable from the mocks below. */
const h = vi.hoisted(() => ({
  runs: [] as unknown[],
  lastRowScope: null as Record<string, unknown> | null,
  rows: [] as unknown[],
}));

vi.mock("./run-history-store.js", () => ({
  runHistoryStore: { listLive: () => h.runs },
}));
vi.mock("./metrics-store.js", () => ({
  metricsStore: { handle: () => ({}) },
}));
vi.mock("../../shared/metrics-query.mjs", () => ({
  stepDurations: (_db: unknown, opts: Record<string, unknown>) => {
    h.lastRowScope = opts;
    return h.rows;
  },
}));
// The real one reads an encrypted store that only the app process can open. A
// fixed replacement is enough to answer the question this file asks, which is
// whether the unattended path redacts AT ALL.
vi.mock("./secret-redaction.js", () => ({
  redactWithSnapshot: (text: string) => text.split("hunter2-secret").join("••••"),
}));

import { buildReport, emitReportTo } from "./report-emitter.js";

const T0 = 1_700_000_000_000;

function run(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "r1",
    testId: "t1",
    testName: "Checkout",
    url: "https://shop.example.com",
    status: "passed",
    exitCode: 0,
    startedAt: T0,
    finishedAt: T0 + 1000,
    durationMs: 1000,
    ...over,
  };
}

/** The test names a JUnit report carries, which is the shortest way to say
 *  "these runs and no others" without asserting on XML.
 *
 *  `\bname=` rather than `name=`: the attribute is emitted after `classname`,
 *  and the word boundary is what stops this reading the class as the name. */
function namesIn(xml: string): string[] {
  return [...xml.matchAll(/<testcase[^>]*\bname="([^"]*)"/g)].map((m) => m[1]);
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gl-report-"));
  h.runs = [];
  h.rows = [];
  h.lastRowScope = null;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildReport — the scope", () => {
  beforeEach(() => {
    h.runs = [
      run({ id: "a", testId: "t1", testName: "Login", batchId: "b1", startedAt: T0 }),
      run({ id: "b", testId: "t2", testName: "Checkout", batchId: "b1", startedAt: T0 + 5_000 }),
      run({ id: "c", testId: "t1", testName: "Login", batchId: "b2", startedAt: T0 + 10_000 }),
      run({ id: "d", testId: "t3", testName: "Search", startedAt: T0 + 15_000 }),
    ];
  });

  it("an empty scope is the whole live history — the behaviour every existing caller relies on", () => {
    const { text, count } = buildReport("junit");
    expect(count).toBe(4);
    expect(namesIn(text)).toEqual(["Login", "Checkout", "Login", "Search"]);
  });

  it("selects one batch, which is the case a CI report exists for", () => {
    const { text, count } = buildReport("junit", { batchId: "b1" });
    expect(count).toBe(2);
    expect(namesIn(text)).toEqual(["Login", "Checkout"]);
  });

  it("selects one test", () => {
    expect(buildReport("junit", { testId: "t1" }).count).toBe(2);
  });

  it("ANDs the fields rather than widening — one batch AND one test", () => {
    const { text } = buildReport("junit", { batchId: "b1", testId: "t2" });
    expect(namesIn(text)).toEqual(["Checkout"]);
  });

  it("bounds a window by since and until, inclusive at both ends", () => {
    expect(buildReport("junit", { since: T0 + 5_000 }).count).toBe(3);
    expect(buildReport("junit", { until: T0 + 5_000 }).count).toBe(2);
    expect(buildReport("junit", { since: T0 + 5_000, until: T0 + 10_000 }).count).toBe(2);
  });

  it("selects exactly the named runs", () => {
    const { text } = buildReport("junit", { runIds: ["a", "d"] });
    expect(namesIn(text)).toEqual(["Login", "Search"]);
  });

  it("an EMPTY runIds selects nothing, rather than silently widening to everything", () => {
    // The bug this guards is the one the whole feature is about: a scope that
    // resolves to zero must produce an empty report, not the entire history.
    // Both readings are well-formed XML.
    expect(buildReport("junit", { runIds: [] }).count).toBe(0);
  });

  it("a run with an unusable startedAt falls outside a bounded window, not inside it", () => {
    h.runs = [run({ id: "x", testName: "Broken", startedAt: undefined })];
    expect(buildReport("junit", { since: T0 }).count).toBe(0);
    expect(buildReport("junit", {}).count).toBe(1);
  });
});

describe("buildReport — the metrics rows", () => {
  it("hands the scope to the QUERY, so the aggregates are computed over the scoped runs", () => {
    // Filtering these afterwards would drop whole steps while leaving the
    // surviving p95s computed over runs outside the scope.
    buildReport("csv", { batchId: "b1", testId: "t1", since: T0, until: T0 + 1, runIds: ["a"] });
    expect(h.lastRowScope).toMatchObject({
      testId: "t1",
      batchId: "b1",
      since: T0,
      until: T0 + 1,
      runIds: ["a"],
    });
  });
});

describe("emitReportTo — the unattended destination", () => {
  it("writes the bytes to the path it was given, with no dialog", () => {
    h.runs = [run({ testName: "Login" })];
    const out = join(dir, "report.xml");
    const result = emitReportTo("junit", out);

    expect(result.cancelled).toBe(false);
    expect(result.path).toBe(out);
    expect(result.count).toBe(1);
    const text = readFileSync(out, "utf8");
    expect(namesIn(text)).toEqual(["Login"]);
    expect(result.bytes).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("redacts on the unattended path — nobody sees this file before it exists", () => {
    h.runs = [run({ testName: 'fill("hunter2-secret")' })];
    const out = join(dir, "leaky.xml");
    emitReportTo("junit", out);

    const text = readFileSync(out, "utf8");
    expect(text).not.toContain("hunter2-secret");
    expect(text).toContain("••••");
  });

  it("carries the scope, so an unattended report is not the whole history", () => {
    h.runs = [
      run({ id: "a", batchId: "b1", testName: "Login" }),
      run({ id: "b", testName: "Unrelated" }),
    ];
    const out = join(dir, "scoped.xml");
    expect(emitReportTo("junit", out, { batchId: "b1" }).count).toBe(1);
    expect(namesIn(readFileSync(out, "utf8"))).toEqual(["Login"]);
  });

  it("refuses a relative path rather than resolving it against the process cwd", () => {
    expect(() => emitReportTo("junit", "report.xml")).toThrow(/absolute path/);
    expect(() => emitReportTo("junit", "")).toThrow(/absolute path/);
  });

  it("refuses an emitter it does not know", () => {
    expect(() => emitReportTo("nope" as never, join(dir, "x.xml"))).toThrow(/unknown emitter/);
  });

  it("reports a write it could not make, rather than taking the app down", () => {
    // A directory that does not exist is the user's environment, not a bug.
    expect(() => emitReportTo("junit", join(dir, "missing", "x.xml"))).toThrow(
      /Could not write that file/,
    );
  });
});
