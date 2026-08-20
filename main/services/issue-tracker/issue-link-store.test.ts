// Which defects already have issues.
//
// The property under test is the KEY, and specifically that it does not include
// the run. A visual difference or an accessibility violation reappears on every
// run, so a run-keyed link would report "not yet filed" every time and the
// feature would produce one duplicate issue per run. Everything else here is in
// service of that one fact.
//
// Runs against a real temp userData dir rather than a mocked `fs`: what matters
// is what survives a write and a read.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { DefectSource } from "../../../renderer/lib/issue-types.js";

let dir: string;
let store: typeof import("./issue-link-store.js").issueLinkStore;

const ISSUE = { id: "iss-1", identifier: "ENG-42", url: "https://linear.app/x/issue/ENG-42" };

const visualOn = (runId: string): DefectSource => ({
  kind: "visual",
  testId: "t1",
  runId,
  stepId: "s5",
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-issue-links-"));
  process.env.GLAZE_TEST_USERDATA = dir;
  ({ issueLinkStore: store } = await import("./issue-link-store.js"));
});

afterEach(() => {
  delete process.env.GLAZE_TEST_USERDATA;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a link survives the next run", () => {
  it("finds a link filed against a DIFFERENT run", () => {
    // The whole design. Without this the same difference files a fresh issue
    // every run, which is how the feature becomes the one everyone mutes.
    store.save("linear", visualOn("run-1"), ISSUE);
    expect(store.find("linear", visualOn("run-2"))?.identifier).toBe("ENG-42");
  });

  it("does not confuse two steps in the same test", () => {
    store.save("linear", visualOn("run-1"), ISSUE);
    expect(
      store.find("linear", { kind: "visual", testId: "t1", runId: "run-1", stepId: "s9" }),
    ).toBeNull();
  });

  it("does not confuse two kinds of defect on ONE step", () => {
    // A step can carry a visual change AND an accessibility violation at once.
    // Filing one must not make the other look already-reported.
    store.save("linear", visualOn("run-1"), ISSUE);
    expect(
      store.find("linear", {
        kind: "a11y",
        testId: "t1",
        runId: "run-1",
        stepId: "s5",
        ruleId: "color-contrast",
      }),
    ).toBeNull();
  });

  it("does not confuse two rules on one step", () => {
    const a11y = (ruleId: string): DefectSource => ({
      kind: "a11y",
      testId: "t1",
      runId: "run-1",
      stepId: "s5",
      ruleId,
    });
    store.save("linear", a11y("color-contrast"), ISSUE);
    expect(store.find("linear", a11y("color-contrast"))?.identifier).toBe("ENG-42");
    expect(store.find("linear", a11y("image-alt"))).toBeNull();
  });

  it("keeps one link per defect when filed twice", () => {
    // Filing again after the first issue was deleted in the tracker should
    // leave one link, not two — otherwise `find` starts depending on order.
    store.save("linear", visualOn("run-1"), ISSUE);
    store.save("linear", visualOn("run-2"), { ...ISSUE, id: "iss-2", identifier: "ENG-99" });
    expect(store.forTest("t1")).toHaveLength(1);
    expect(store.find("linear", visualOn("run-3"))?.identifier).toBe("ENG-99");
  });
});

describe("a failure with no step", () => {
  it("is keyed by its run, because there is no step to recur on", () => {
    // The one case where run-keying is correct: nothing identifies the defect
    // except the run it happened in.
    const first: DefectSource = { kind: "failure", testId: "t1", runId: "run-1", stepId: null };
    const second: DefectSource = { kind: "failure", testId: "t1", runId: "run-2", stepId: null };
    store.save("linear", first, ISSUE);
    expect(store.find("linear", first)?.identifier).toBe("ENG-42");
    expect(store.find("linear", second)).toBeNull();
  });

  it("is distinct from a failure blamed on a step", () => {
    store.save("linear", { kind: "failure", testId: "t1", runId: "run-1", stepId: "s5" }, ISSUE);
    expect(
      store.find("linear", { kind: "failure", testId: "t1", runId: "run-1", stepId: null }),
    ).toBeNull();
  });
});

describe("reading a whole test at once", () => {
  it("returns only that test's links", () => {
    store.save("linear", visualOn("run-1"), ISSUE);
    store.save("linear", { kind: "visual", testId: "t2", runId: "run-1", stepId: "s1" }, ISSUE);
    expect(store.forTest("t1")).toHaveLength(1);
    expect(store.forTest("t1")[0].testId).toBe("t1");
  });

  it("forgets a deleted test's links without touching the others", () => {
    store.save("linear", visualOn("run-1"), ISSUE);
    store.save("linear", { kind: "visual", testId: "t2", runId: "run-1", stepId: "s1" }, ISSUE);
    store.removeTest("t1");
    expect(store.forTest("t1")).toHaveLength(0);
    expect(store.forTest("t2")).toHaveLength(1);
  });
});

describe("degrading rather than throwing", () => {
  it("reads a corrupt index as no links", () => {
    // A settings or panel load that throws here would take out a whole view for
    // a feature that is optional.
    fs.mkdirSync(path.join(dir, "recorder"), { recursive: true });
    fs.writeFileSync(path.join(dir, "recorder", "issue-links.json"), "{ not json", "utf-8");
    expect(store.forTest("t1")).toEqual([]);
    expect(store.find("linear", visualOn("run-1"))).toBeNull();
  });

  it("stamps a recurrence without losing the link", () => {
    store.save("linear", visualOn("run-1"), ISSUE);
    store.touch("linear", visualOn("run-2"));
    const link = store.find("linear", visualOn("run-3"));
    expect(link?.identifier).toBe("ENG-42");
    expect(typeof link?.lastCommentedAt).toBe("number");
  });
});

describe("an insight report's link", () => {
  const reportSource: DefectSource = { kind: "insight-report", reportId: "ins-1" };

  it("round-trips through the one key derivation", () => {
    // The report source maps onto the same keyFor slots the defects use (the
    // report id where a step id goes), so the write and the read cannot spell
    // the key differently — the exact failure this store's separator history
    // is about.
    store.save("linear", reportSource, ISSUE);
    expect(store.find("linear", reportSource)?.identifier).toBe("ENG-42");
    expect(store.find("linear", { kind: "insight-report", reportId: "ins-2" })).toBeNull();
  });

  it("never collides with a defect link, and claims no test", () => {
    store.save("linear", visualOn("run-1"), ISSUE);
    store.save("linear", reportSource, { id: "iss-2", identifier: "ENG-43", url: "https://x/43" });
    expect(store.find("linear", visualOn("run-9"))?.identifier).toBe("ENG-42");
    expect(store.find("linear", reportSource)?.identifier).toBe("ENG-43");
    // A report link badges no test row.
    expect(store.forTest("t1").map((l) => l.identifier)).toEqual(["ENG-42"]);
  });
});

describe("allA11y", () => {
  // The Accessibility view's rule board badges every row from one read, and a
  // rule filed from ANY occurrence must be found — the filter is by kind, with
  // no test or step coordinate involved.
  it("returns a11y links across tests and nothing else", () => {
    store.save(
      "linear",
      { kind: "a11y", testId: "t1", runId: "r1", stepId: "s1", ruleId: "color-contrast" },
      ISSUE,
    );
    store.save(
      "linear",
      { kind: "a11y", testId: "t2", runId: "r2", stepId: "s9", ruleId: "image-alt" },
      { id: "iss-2", identifier: "ENG-43", url: "https://linear.app/x/issue/ENG-43" },
    );
    store.save("linear", { kind: "visual", testId: "t1", runId: "r1", stepId: "s1" }, ISSUE);

    const links = store.allA11y();
    expect(links.map((l) => l.ruleId).sort()).toEqual(["color-contrast", "image-alt"]);
    expect(links.every((l) => l.kind === "a11y")).toBe(true);
  });
});
