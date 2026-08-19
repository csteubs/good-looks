// The insight-report store: primary data, so the failure modes that matter
// are the quiet ones — a cap that silently loses the report it just saved, a
// normalizer that erases a deleted test's action from history, a clear that
// leaves a shadow state saying a report was generated last Tuesday.
//
// Driven against the real store writing into a throwaway userData dir.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-insight-reports-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { insightReportStore, INSIGHT_REPORTS_VERSION } = await import("./insight-report-store.js");
const indexFile = path.join(userData, "recorder", "insight-reports.json");

function reset(): void {
  fs.rmSync(indexFile, { force: true });
}

function report(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    cadence: "weekly",
    periodStart: 1_000,
    periodEnd: 2_000,
    generatedAt: 2_000,
    provider: "ollama",
    model: "m",
    headline: "A headline.",
    sections: [{ title: "S", body: "Body." }],
    actions: [{ kind: "debug-test", testId: "t1", testName: "Login", label: "Why." }],
    stats: {
      runs: 1,
      failed: 0,
      previousRuns: 0,
      flakyRuns: 0,
      healedSteps: 0,
      healFailures: 0,
      visualChanges: null,
      newClusters: null,
      a11yNewSteps: 0,
      testsCreated: 0,
      unreviewedScriptChanges: 0,
      expiringSignatures: 0,
    },
    sending: [{ label: "Run counts", chars: 42 }],
    promptChars: 100,
    answerChars: 50,
    durationMs: 300,
    firstTokenMs: 10,
    read: false,
    ...over,
  };
}

beforeEach(reset);

describe("insightReportStore", () => {
  it("round-trips a report and lists newest first", () => {
    insightReportStore.save(report() as never);
    insightReportStore.save(report({ id: "r2", generatedAt: 3_000 }) as never);
    const list = insightReportStore.list();
    expect(list.map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(insightReportStore.get("r1")?.headline).toBe("A headline.");
  });

  it("caps at 24, dropping the OLDEST", () => {
    for (let i = 0; i < 30; i++) {
      insightReportStore.save(report({ id: `r${i}`, generatedAt: 1_000 + i }) as never);
    }
    const list = insightReportStore.list();
    expect(list).toHaveLength(24);
    expect(list[0].id).toBe("r29");
    expect(list.some((r) => r.id === "r0")).toBe(false);
  });

  it("a stored action for a since-deleted test SURVIVES a read", () => {
    // Parse-time validation already happened against the tests the model was
    // shown; re-validating against the live library on read would rewrite
    // history every time a test is deleted. The action renders disabled
    // instead — that check belongs to the view.
    insightReportStore.save(report() as never);
    const back = insightReportStore.get("r1");
    expect(back?.actions).toEqual([
      { kind: "debug-test", testId: "t1", testName: "Login", label: "Why." },
    ]);
  });

  it("markRead flips once and feeds unreadCount", () => {
    insightReportStore.save(report() as never);
    expect(insightReportStore.unreadCount()).toBe(1);
    expect(insightReportStore.markRead("r1")).toBe(true);
    expect(insightReportStore.markRead("r1")).toBe(false);
    expect(insightReportStore.unreadCount()).toBe(0);
    expect(insightReportStore.get("r1")?.read).toBe(true);
  });

  it("state round-trips through partial saves", () => {
    insightReportStore.saveState({ lastGeneratedAt: 5_000 });
    insightReportStore.saveState({ lastError: { at: 6_000, kind: "connection", message: "down" } });
    const state = insightReportStore.state();
    expect(state.lastGeneratedAt).toBe(5_000);
    expect(state.lastError).toMatchObject({ kind: "connection", message: "down" });
  });

  it("clearAll removes the reports AND the state", () => {
    insightReportStore.save(report() as never);
    insightReportStore.saveState({ lastGeneratedAt: 5_000, lastSeenAppVersion: "1.0.0" });
    expect(insightReportStore.clearAll()).toBe(1);
    expect(insightReportStore.list()).toEqual([]);
    // A user deleting everything does not expect a shadow memory of when the
    // deleted things were made.
    expect(insightReportStore.state().lastGeneratedAt).toBeNull();
    expect(insightReportStore.state().lastSeenAppVersion).toBeNull();
  });

  it("a corrupt file reads as empty rather than throwing", () => {
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.writeFileSync(indexFile, "{ not json", "utf-8");
    expect(insightReportStore.list()).toEqual([]);
    expect(insightReportStore.state().lastGeneratedAt).toBeNull();
  });

  it("an unrecognized version reads as empty rather than half-parsing", () => {
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.writeFileSync(
      indexFile,
      JSON.stringify({ version: INSIGHT_REPORTS_VERSION + 1, state: {}, reports: [report()] }),
      "utf-8",
    );
    expect(insightReportStore.list()).toEqual([]);
  });

  it("a hand-edited report missing its identity is dropped, not restored broken", () => {
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.writeFileSync(
      indexFile,
      JSON.stringify({
        version: INSIGHT_REPORTS_VERSION,
        state: {},
        reports: [report(), report({ id: "" }), report({ id: "r3", headline: "" })],
      }),
      "utf-8",
    );
    expect(insightReportStore.list().map((r) => r.id)).toEqual(["r1"]);
  });

  it("save refuses a report that does not normalize instead of writing junk", () => {
    expect(insightReportStore.save(report({ headline: "" }) as never)).toBeNull();
    expect(insightReportStore.list()).toEqual([]);
  });
});
