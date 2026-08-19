// setFailureReason: the manual-wins rule and the failed-runs-only rule.
//
// Both failure modes are silent. An auto assignment that overwrote a user's
// answer would look exactly like a working feature — the label changes, the
// screen stays plausible — and a reason on a passed run would surface in the
// "Failures by reason" breakdown as a failure that never happened.
//
// Driven against the real store writing into a throwaway userData dir.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-run-reason-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { runHistoryStore } = await import("./run-history-store.js");

const indexFile = path.join(userData, "recorder", "run-history.json");

function appendRun(over: { id: string; status?: "passed" | "failed" }): string {
  const rec = runHistoryStore.append(
    {
      id: over.id,
      testId: "t1",
      testName: "Alpha",
      url: "https://example.test",
      status: over.status ?? "failed",
      exitCode: over.status === "passed" ? 0 : 1,
      startedAt: 1_800_000_000_000,
      finishedAt: 1_800_000_001_000,
    },
    "log",
  );
  return rec.id;
}

beforeEach(() => {
  fs.rmSync(indexFile, { force: true });
});

describe("setFailureReason", () => {
  it("labels a failed run and the record round-trips through list()", () => {
    appendRun({ id: "r1" });
    const rec = runHistoryStore.setFailureReason("r1", "timing", "user");
    expect(rec?.failureReasonId).toBe("timing");
    expect(rec?.failureReasonBy).toBe("user");
    expect(runHistoryStore.list().find((r) => r.id === "r1")?.failureReasonId).toBe("timing");
  });

  it("stores the signal for an auto assignment and drops it on a manual one", () => {
    appendRun({ id: "r1" });
    const auto = runHistoryStore.setFailureReason("r1", "regression", "auto", "server-error");
    expect(auto?.failureReasonSignal).toBe("server-error");
    const manual = runHistoryStore.setFailureReason("r1", "timing", "user");
    expect(manual?.failureReasonSignal).toBeUndefined();
  });

  it("never lets auto overwrite an existing label — the user's or its own", () => {
    appendRun({ id: "r1" });
    runHistoryStore.setFailureReason("r1", "timing", "user");
    const after = runHistoryStore.setFailureReason("r1", "regression", "auto", "server-error");
    expect(after?.failureReasonId).toBe("timing");
    expect(after?.failureReasonBy).toBe("user");

    appendRun({ id: "r2" });
    runHistoryStore.setFailureReason("r2", "regression", "auto", "server-error");
    const second = runHistoryStore.setFailureReason("r2", "network", "auto", "network-error");
    expect(second?.failureReasonId).toBe("regression");
  });

  it("lets the user recategorize an automatic label, and clear it", () => {
    appendRun({ id: "r1" });
    runHistoryStore.setFailureReason("r1", "regression", "auto", "server-error");
    expect(runHistoryStore.setFailureReason("r1", "environment", "user")?.failureReasonBy).toBe(
      "user",
    );
    const cleared = runHistoryStore.setFailureReason("r1", null, "user");
    expect(cleared?.failureReasonId).toBeUndefined();
    expect(cleared?.failureReasonBy).toBeUndefined();
    // Cleared means CLEARED on disk, not stored as null.
    const raw = JSON.parse(fs.readFileSync(indexFile, "utf-8")) as Record<string, unknown>[];
    expect("failureReasonId" in raw[0]).toBe(false);
  });

  it("auto never clears", () => {
    appendRun({ id: "r1" });
    runHistoryStore.setFailureReason("r1", "timing", "user");
    // A user clear is honoured; an auto "clear" is a no-op by contract.
    runHistoryStore.setFailureReason("r1", null, "auto");
    expect(runHistoryStore.list()[0].failureReasonId).toBe("timing");
  });

  it("refuses a passed run, an unknown run, and a baseline-update event", () => {
    appendRun({ id: "r1", status: "passed" });
    expect(runHistoryStore.setFailureReason("r1", "timing", "user")).toBeNull();
    expect(runHistoryStore.setFailureReason("missing", "timing", "user")).toBeNull();
    const event = runHistoryStore.logBaselineUpdate("t1", "Alpha", 1, "step");
    expect(runHistoryStore.setFailureReason(event.id, "timing", "user")).toBeNull();
  });

  it("keeps the label on a tombstoned run — aggregates by reason must hold still", () => {
    appendRun({ id: "r1" });
    runHistoryStore.setFailureReason("r1", "timing", "user");
    runHistoryStore.markTestDeleted("t1");
    const rec = runHistoryStore.list().find((r) => r.id === "r1");
    expect(rec?.testDeleted).toBe(true);
    expect(rec?.failureReasonId).toBe("timing");
  });
});
