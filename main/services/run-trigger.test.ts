// `trigger` on a RunRecord: the vocabulary, and the narrowing the store does.
//
// The field answers "who started this run" — a person, a Routine's schedule, or
// an MCP client. Every failure mode here is silent, which is why it is tested at
// all: a trigger that fails to narrow puts an unvalidated string into a chip, a
// trigger defaulted on read invents evidence about runs nobody classified, and a
// trigger that quietly disappears turns an overnight Routine failure into what
// looks like someone debugging at their desk.
//
// Driven against the real store writing into a throwaway userData dir, in the
// idiom of run-history-failure-reason.test.ts.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  RUN_TRIGGERS,
  RUN_TRIGGER_DESCRIPTIONS,
  normalizeRunTrigger,
} from "../../shared/run-trigger.mjs";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-run-trigger-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { runHistoryStore } = await import("./run-history-store.js");

const indexFile = path.join(userData, "recorder", "run-history.json");

function appendRun(id: string, trigger?: unknown) {
  return runHistoryStore.append(
    {
      id,
      testId: "t1",
      testName: "Alpha",
      url: "https://example.test",
      status: "passed",
      exitCode: 0,
      startedAt: 1_800_000_000_000,
      finishedAt: 1_800_000_001_000,
      // Cast at the call site so a hostile value can be driven through the same
      // door a real caller uses. The store's job is to not trust it.
      ...(trigger === undefined ? {} : { trigger: trigger as "manual" }),
    },
    "log",
  );
}

beforeEach(() => {
  fs.rmSync(indexFile, { force: true });
});

describe("the run-trigger vocabulary", () => {
  it("admits exactly the four triggers, and narrows anything else to undefined", () => {
    for (const t of RUN_TRIGGERS) expect(normalizeRunTrigger(t)).toBe(t);
    expect([...RUN_TRIGGERS]).toEqual(["manual", "schedule", "mcp", "cli"]);
  });

  it("does NOT admit `replay` — a re-run is replayOfRunId, a different axis", () => {
    // Folding "replay" in here would cost the field its one question: a replay
    // started by a person and one started by an MCP client would be the same
    // value. If this ever changes, the reason must be recorded in DECISIONS.md.
    expect(normalizeRunTrigger("replay")).toBeUndefined();
  });

  it("narrows a value from a newer writer rather than carrying it through", () => {
    // run-history.json is written by the app AND the standalone MCP server, and
    // will be by the CLI — processes that ship on their own schedules. A
    // packaged app can therefore read a trigger it has never heard of, and
    // "unknown" is the honest answer; passing it along would put an
    // unvalidated string into every surface that renders one.
    expect(normalizeRunTrigger("gitlab")).toBeUndefined();
    expect(normalizeRunTrigger("Manual")).toBeUndefined();
    expect(normalizeRunTrigger("")).toBeUndefined();
    expect(normalizeRunTrigger(null)).toBeUndefined();
    expect(normalizeRunTrigger(7)).toBeUndefined();
    expect(normalizeRunTrigger({ toString: () => "manual" })).toBeUndefined();
  });

  it("describes every trigger, so a mark can never render without a meaning", () => {
    // The description is the ONLY naming table, because the Stats row marks a
    // trigger with a glyph rather than a word — so this string is what hover
    // and assistive tech get, and a trigger without one is an icon nobody can
    // name. Adding a member to RUN_TRIGGERS without a description fails here.
    for (const t of RUN_TRIGGERS) {
      expect(RUN_TRIGGER_DESCRIPTIONS[t]?.length).toBeGreaterThan(0);
    }
  });
});

describe("runHistoryStore.append — trigger", () => {
  it("round-trips each known trigger through the index", () => {
    for (const t of RUN_TRIGGERS) {
      expect(appendRun(`r-${t}`, t).trigger).toBe(t);
    }
    const byId = new Map(runHistoryStore.list().map((r) => [r.id, r.trigger]));
    expect(byId.get("r-schedule")).toBe("schedule");
    expect(byId.get("r-mcp")).toBe("mcp");
    expect(byId.get("r-cli")).toBe("cli");
  });

  it("leaves an unrecognised trigger OFF the record entirely", () => {
    // Not "" and not the raw string: absent, so it reads as unknown — the same
    // state as a run recorded before the field existed.
    const rec = appendRun("r-bad", "totally-not-a-trigger");
    expect(rec.trigger).toBeUndefined();
    expect("trigger" in rec).toBe(false);
    expect(JSON.parse(fs.readFileSync(indexFile, "utf-8"))[0].trigger).toBeUndefined();
  });

  it("leaves an absent trigger absent — never defaulted to manual on write", () => {
    // The runner defaults at its entry point, so a caller reaching the store
    // with nothing is a caller that genuinely does not know. Writing "manual"
    // here would make every such run claim a person was present.
    const rec = appendRun("r-none");
    expect(rec.trigger).toBeUndefined();
    expect("trigger" in rec).toBe(false);
  });

  it("keeps a stopped scheduled run distinguishable from a manual one", () => {
    // The pairing that motivates the field: same test, same outcome, different
    // origin. Without `trigger` these two rows are identical.
    appendRun("r-night", "schedule");
    appendRun("r-desk", "manual");
    const runs = runHistoryStore.list();
    expect(runs.find((r) => r.id === "r-night")?.trigger).toBe("schedule");
    expect(runs.find((r) => r.id === "r-desk")?.trigger).toBe("manual");
  });
});
