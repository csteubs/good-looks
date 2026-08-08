// Tests for duplicating a test.
//
// Two halves, and the second is the one that matters. Naming is pure and easy
// to reason about. What a copy INHERITS is not: every assertion here is about
// something that produces no error when it's wrong — a copy that reports a
// clean accessibility run it never had, a copy whose steps are the same array
// object as the original's, an imported copy whose sibling modules didn't come
// with it and which therefore fails on its first run, days later, naming a
// module nobody remembers.
//
// The store writes into a throwaway userData dir, so this exercises the real
// test-store and the real filesystem rather than mocks of them.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Step, TestRecord } from "../recorder/types.js";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-duplicate-test-"));
process.env.GLAZE_TEST_USERDATA = userData;

// Imported after the env var is set. The stub resolves `app.getPath` lazily on
// every call, but the scripts dir is derived at call time from it too, so this
// ordering is what keeps every write inside the temp dir.
const {
  duplicateTest,
  inheritedFields,
  nextDuplicateName,
  baseNameOf,
  DUPLICATED_FIELDS,
  DROPPED_FIELDS,
} = await import("./duplicate-test.js");
const { testStore } = await import("./test-store.js");
const { importedSandboxDir } = await import("./import-service.js");

const scriptsDir = path.join(userData, "recorder", "scripts");
const indexFile = path.join(userData, "recorder", "tests.json");

function step(id: string, over: Partial<Step> = {}): Step {
  return {
    id,
    type: "click",
    locator: { kind: "role", value: "button", name: "Submit" },
    timestamp: 1,
    ...over,
  } as Step;
}

function seed(over: Partial<TestRecord> = {}): TestRecord {
  const id = over.id ?? "src";
  const rec: TestRecord = {
    id,
    name: "Login",
    url: "https://example.test/login",
    createdAt: 100,
    updatedAt: 200,
    steps: [step("s1")],
    scriptPath: path.join(scriptsDir, `${id}.spec.ts`),
    ...over,
  };
  testStore.save(rec);
  fs.mkdirSync(path.dirname(rec.scriptPath), { recursive: true });
  if (!fs.existsSync(rec.scriptPath)) {
    fs.writeFileSync(rec.scriptPath, `test("${rec.name}", async ({ page }) => {});`, "utf-8");
  }
  return rec;
}

beforeEach(() => {
  fs.rmSync(path.join(userData, "recorder"), { recursive: true, force: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("baseNameOf", () => {
  it("strips a trailing copy marker", () => {
    expect(baseNameOf("Login [2]")).toBe("Login");
    expect(baseNameOf("Login [17]")).toBe("Login");
  });

  it("leaves a name with no marker alone", () => {
    expect(baseNameOf("Login")).toBe("Login");
  });

  it("only strips a marker at the END", () => {
    // A bracketed number mid-name is part of the name, not a copy marker.
    // Stripping it would make "Sprint [2] checkout" and "Sprint [9] checkout"
    // fight over one series of copy numbers.
    expect(baseNameOf("Sprint [2] checkout")).toBe("Sprint [2] checkout");
  });

  it("does not treat a non-numeric bracket as a marker", () => {
    expect(baseNameOf("Login [draft]")).toBe("Login [draft]");
  });
});

describe("nextDuplicateName", () => {
  it("numbers the first copy [2], counting the original as #1", () => {
    expect(nextDuplicateName("Login", ["Login"])).toBe("Login [2]");
  });

  it("walks past copies that already exist", () => {
    expect(nextDuplicateName("Login", ["Login", "Login [2]", "Login [3]"])).toBe("Login [4]");
  });

  it("fills the lowest gap rather than appending", () => {
    // A deleted [3] is reused. The alternative — always taking max+1 — leaves
    // permanent holes in the series that read as tests someone removed.
    expect(nextDuplicateName("Login", ["Login", "Login [2]", "Login [4]"])).toBe("Login [3]");
  });

  it("duplicates a copy off the ORIGINAL base, not off the copy's name", () => {
    // Without stripping, this returns "Login [2] [2]" and every generation
    // grows another bracket.
    expect(nextDuplicateName("Login [2]", ["Login", "Login [2]"])).toBe("Login [3]");
  });

  it("compares case-insensitively", () => {
    // The sidebar sorts by date, not name, so two rows differing only in case
    // are two rows nobody can tell apart.
    expect(nextDuplicateName("Login", ["login [2]"])).toBe("Login [3]");
  });

  it("ignores surrounding whitespace on both sides", () => {
    expect(nextDuplicateName("  Login  ", [" login [2] "])).toBe("Login [3]");
  });

  it("falls back for a name that is nothing but a marker", () => {
    // baseNameOf() empties it, and " [2]" would be a test with no name at all.
    expect(nextDuplicateName("[2]", [])).toBe("[2] [2]");
  });

  it("falls back for a blank name", () => {
    expect(nextDuplicateName("   ", [])).toBe("Test [2]");
  });

  it("is unaffected by unrelated names", () => {
    expect(nextDuplicateName("Login", ["Checkout [2]", "Signup"])).toBe("Login [2]");
  });
});

// Asserted here rather than through `duplicateTest`, deliberately. Records are
// re-read from JSON on every store access, so both the allowlist's omissions
// and the deep copy are invisible one level up: a test written against the
// saved records passes whether or not the cloning happens.
describe("inheritedFields", () => {
  const full = (): TestRecord => ({
    id: "src",
    name: "Login",
    url: "https://example.test",
    createdAt: 1,
    updatedAt: 2,
    steps: [step("s1")],
    scriptPath: "/tmp/src.spec.ts",
    hidden: true,
    a11yBaseline: { s1: ["color-contrast|button"] },
    tags: ["smoke"],
    variables: [{ name: "user", kind: "plain", value: "ada" }],
    datasets: [{ id: "d1", name: "row", values: { user: "grace" } }],
    visualMasks: [{ id: "m3", stepId: null, x: 0, y: 0, w: 1, h: 1 }],
  });

  it("takes the allowlisted fields", () => {
    const out = inheritedFields(full());
    expect(out).toMatchObject({ url: "https://example.test", tags: ["smoke"] });
    expect(out.steps).toHaveLength(1);
  });

  it("takes none of the dropped ones", () => {
    const out = inheritedFields(full()) as Record<string, unknown>;
    for (const field of DROPPED_FIELDS) {
      expect(out).not.toHaveProperty(field);
    }
  });

  it("omits an absent field rather than writing an explicit undefined", () => {
    // `"speed" in record` is false on a record that never had one; a copy
    // carrying `speed: undefined` serializes differently from every other
    // record and reads as a field that was set and then cleared.
    const out = inheritedFields({ ...full(), speed: undefined });
    expect(out).not.toHaveProperty("speed");
  });

  it("deep-copies every nested value it takes", () => {
    const src = full();
    const out = inheritedFields(src);

    expect(out.steps).not.toBe(src.steps);
    expect(out.steps?.[0]).not.toBe(src.steps[0]);
    expect(out.tags).not.toBe(src.tags);
    expect(out.variables?.[0]).not.toBe(src.variables?.[0]);
    expect(out.datasets?.[0]).not.toBe(src.datasets?.[0]);
    expect(out.visualMasks?.[0]).not.toBe(src.visualMasks?.[0]);
    // ...while still being equal, so "not shared" can't be satisfied by
    // dropping the data.
    expect(out.steps).toEqual(src.steps);
    expect(out.variables).toEqual(src.variables);
  });
});

describe("field lists", () => {
  it("never puts a field in both lists", () => {
    const dropped = new Set<string>(DROPPED_FIELDS);
    expect(DUPLICATED_FIELDS.filter((f) => dropped.has(f))).toEqual([]);
  });

  it("has no duplicate entries", () => {
    const all = [...DUPLICATED_FIELDS, ...DROPPED_FIELDS];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("duplicateTest", () => {
  it("refuses an id that isn't there", () => {
    expect(() => duplicateTest("nope")).toThrow(/not found/i);
  });

  it("creates a second record, leaving the original untouched", () => {
    const src = seed();
    const copy = duplicateTest(src.id);

    expect(copy.id).not.toBe(src.id);
    expect(copy.name).toBe("Login [2]");
    expect(testStore.get(src.id)).toMatchObject({ id: src.id, name: "Login" });
    expect(testStore.list()).toHaveLength(2);
  });

  it("stamps fresh timestamps rather than inheriting the original's", () => {
    const src = seed({ createdAt: 100, updatedAt: 200 });
    const copy = duplicateTest(src.id);

    // The sidebar sorts by createdAt descending. Inheriting it would file a
    // brand-new copy under the original's date, wherever that lands.
    expect(copy.createdAt).toBeGreaterThan(src.createdAt);
    expect(copy.updatedAt).toBe(copy.createdAt);
  });

  it("carries the configuration that describes the test", () => {
    const src = seed({
      tags: ["smoke"],
      speed: "slow",
      runBrowser: "firefox",
      runHeadless: true,
      captureArtifacts: true,
      recordLogs: true,
      a11yChecks: true,
      testTimeoutMs: 45_000,
      visualThreshold: 3,
      visualMasks: [{ id: "m1", stepId: "s1", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
      visualElementSteps: ["s1"],
      variables: [{ name: "user", kind: "plain", value: "ada" }],
      datasets: [{ id: "d1", name: "row", values: { user: "grace" } }],
      isFlow: true,
      flowParams: ["user"],
    });
    const copy = duplicateTest(src.id);

    expect(copy).toMatchObject({
      url: src.url,
      tags: ["smoke"],
      speed: "slow",
      runBrowser: "firefox",
      runHeadless: true,
      captureArtifacts: true,
      recordLogs: true,
      a11yChecks: true,
      testTimeoutMs: 45_000,
      visualThreshold: 3,
      visualElementSteps: ["s1"],
      isFlow: true,
      flowParams: ["user"],
    });
    expect(copy.variables).toEqual(src.variables);
    expect(copy.datasets).toEqual(src.datasets);
    expect(copy.visualMasks).toEqual(src.visualMasks);
  });

  it("drops the accepted accessibility baseline", () => {
    // Accepted violations describe runs of the ORIGINAL. Carrying them would
    // make the copy report a clean page it has never been run against.
    const src = seed({ a11yBaseline: { s1: ["color-contrast|button"] } });
    const copy = duplicateTest(src.id);

    expect(copy.a11yBaseline).toBeUndefined();
    expect(testStore.get(copy.id)?.a11yBaseline).toBeUndefined();
  });

  it("does not inherit hidden", () => {
    // The action navigates to the copy. A hidden one is a click whose entire
    // visible result is a test that isn't in the sidebar.
    const src = seed({ hidden: true });
    const copy = duplicateTest(src.id);

    expect(copy.hidden).toBeUndefined();
    expect(testStore.list().map((t) => t.id)).toContain(copy.id);
  });

  it("counts hidden tests when picking the number", () => {
    // list() filters hidden tests out, so a name taken by one would be handed
    // out as free and collide the day that test is restored.
    seed({ id: "src", name: "Login" });
    seed({ id: "ghost", name: "Login [2]", hidden: true });

    expect(duplicateTest("src").name).toBe("Login [3]");
  });

  it("keeps step ids, because per-step settings are stored by step id", () => {
    // visualMasks[].stepId and visualElementSteps point at steps. Regenerating
    // ids would silently unhook every mask the user drew, with the mask list
    // still looking populated.
    const src = seed({
      steps: [step("s1"), step("s2", { type: "fill", value: "x" })],
      visualElementSteps: ["s2"],
      visualMasks: [{ id: "m2", stepId: "s2", x: 0, y: 0, w: 0.5, h: 0.5 }],
    });
    const copy = duplicateTest(src.id);

    expect(copy.steps.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(copy.visualMasks?.[0].stepId).toBe("s2");
  });

  it("writes the copy's script to its own path", () => {
    const src = seed();
    const copy = duplicateTest(src.id);

    expect(copy.scriptPath).not.toBe(src.scriptPath);
    expect(fs.existsSync(copy.scriptPath)).toBe(true);
    expect(fs.existsSync(src.scriptPath)).toBe(true);
  });

  it("regenerates a generated test's spec so its title matches the copy", () => {
    // A generated spec embeds the test name in `test("…")`. Copying the file
    // verbatim would leave the copy's script announcing the original's name in
    // every run log and report.
    const src = seed({ name: "Login", steps: [step("s1")] });
    const copy = duplicateTest(src.id);

    const source = fs.readFileSync(copy.scriptPath, "utf-8");
    expect(source).toContain('test("Login [2]"');
    expect(source).not.toContain('test("Login"');
  });

  it("copies a hand-edited script word for word instead of regenerating", () => {
    const src = seed({ scriptEdited: true });
    fs.writeFileSync(src.scriptPath, "// hand written\nconst x = 1;\n", "utf-8");

    const copy = duplicateTest(src.id);

    expect(copy.scriptEdited).toBe(true);
    expect(fs.readFileSync(copy.scriptPath, "utf-8")).toBe("// hand written\nconst x = 1;\n");
  });

  it("carries a divergence flag with the script it describes", () => {
    // The copy's steps and script disagree in exactly the way the original's
    // do, so clearing the flag would hide a real mismatch on the copy.
    const src = seed({ scriptEdited: true, stepsDiverged: true, stepsDivergedReason: "unapplied" });
    const copy = duplicateTest(src.id);

    expect(copy.stepsDiverged).toBe(true);
    expect(copy.stepsDivergedReason).toBe("unapplied");
  });

  it("rebuilds a generated test whose script file has gone missing", () => {
    const src = seed();
    fs.rmSync(src.scriptPath);

    const copy = duplicateTest(src.id);

    expect(fs.readFileSync(copy.scriptPath, "utf-8")).toContain('test("Login [2]"');
  });

  it("refuses when a hand-edited script is missing, leaving no half-made record", () => {
    // There is nothing to rebuild from: the spec IS the test, and a copy
    // regenerated from lossily-parsed steps would be a different test under the
    // same name.
    const src = seed({ scriptEdited: true });
    fs.rmSync(src.scriptPath);

    expect(() => duplicateTest(src.id)).toThrow(/script file/i);
    expect(testStore.list()).toHaveLength(1);
  });

  it("does not carry unknown fields written by a future version", () => {
    // The allowlist is the point: a spread would carry whatever this record
    // happens to hold, so the next field added to TestRecord would ride into
    // every copy without anyone deciding it should.
    const src = seed();
    const raw = JSON.parse(fs.readFileSync(indexFile, "utf-8")) as Record<string, unknown>[];
    raw[0].lastRunSummary = { passed: 4 };
    fs.writeFileSync(indexFile, JSON.stringify(raw), "utf-8");

    const copy = duplicateTest(src.id) as unknown as Record<string, unknown>;

    expect(copy.lastRunSummary).toBeUndefined();
  });
});

describe("duplicateTest — imported tests", () => {
  /** Build an imported test that owns a sandbox directory. */
  function seedImported(id = "imp"): TestRecord {
    const sandbox = importedSandboxDir(id);
    const specPath = path.join(sandbox, "tests", "checkout.spec.ts");
    fs.mkdirSync(path.join(sandbox, "helpers"), { recursive: true });
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, 'import "../helpers/db.js";\ntest("Checkout", () => {});\n', "utf-8");
    fs.writeFileSync(path.join(sandbox, "helpers", "db.js"), "export const db = 1;\n", "utf-8");
    return seed({
      id,
      name: "Checkout",
      scriptPath: specPath,
      scriptEdited: true,
      sourceDir: "/somewhere/tests",
      sourceRoot: "/somewhere",
    });
  }

  it("copies the whole sandbox, keeping every file's position within it", () => {
    // The spec's own `../helpers/db.js` has to resolve in the copy. Copying the
    // spec alone produces a test that fails on its first run with the original
    // checkout long gone.
    const src = seedImported();
    const copy = duplicateTest(src.id);

    const newSandbox = importedSandboxDir(copy.id);
    expect(copy.scriptPath).toBe(path.join(newSandbox, "tests", "checkout.spec.ts"));
    expect(fs.existsSync(path.join(newSandbox, "helpers", "db.js"))).toBe(true);
    expect(fs.readFileSync(copy.scriptPath, "utf-8")).toContain('import "../helpers/db.js"');
  });

  it("keeps the copy's sandbox separate from the original's", () => {
    const src = seedImported();
    const copy = duplicateTest(src.id);

    fs.writeFileSync(path.join(importedSandboxDir(copy.id), "helpers", "db.js"), "changed\n");

    expect(fs.readFileSync(path.join(importedSandboxDir(src.id), "helpers", "db.js"), "utf-8")).toBe(
      "export const db = 1;\n",
    );
  });

  it("never regenerates an imported spec", () => {
    // Regenerating would emit a spec carrying neither the sibling imports nor
    // anything else the parser couldn't classify — with the original gone.
    const src = seedImported();
    const copy = duplicateTest(src.id);

    expect(fs.readFileSync(copy.scriptPath, "utf-8")).toContain('test("Checkout"');
  });

  it("skips a symlink instead of copying what it points at", () => {
    // The importer realpaths every sibling and refuses anything outside the
    // project, so a link should not be in a sandbox at all. If one ever is,
    // this copy must not be the thing that reads through it.
    const src = seedImported();
    const secret = path.join(userData, "id_rsa");
    fs.writeFileSync(secret, "PRIVATE KEY", "utf-8");
    fs.symlinkSync(secret, path.join(importedSandboxDir(src.id), "helpers", "linked.js"));

    const copy = duplicateTest(src.id);

    const linked = path.join(importedSandboxDir(copy.id), "helpers", "linked.js");
    expect(fs.existsSync(linked)).toBe(false);
  });

  it("falls back to a flat write for an import made before sandboxes existed", () => {
    // Those records sit directly in the scripts dir with their siblings beside
    // them, so a flat copy still finds them — and there is no directory to copy.
    const src = seed({
      id: "old",
      name: "Legacy",
      scriptPath: path.join(scriptsDir, "old.spec.ts"),
      scriptEdited: true,
      sourceDir: "/somewhere/tests",
    });
    fs.writeFileSync(src.scriptPath, 'test("Legacy", () => {});\n', "utf-8");

    const copy = duplicateTest(src.id);

    expect(path.dirname(copy.scriptPath)).toBe(scriptsDir);
    expect(fs.readFileSync(copy.scriptPath, "utf-8")).toContain('test("Legacy"');
  });
});
