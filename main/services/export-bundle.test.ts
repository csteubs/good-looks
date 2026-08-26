// What may leave the library, and what a bundle's records say (R10).
//
// Under `main/services/` rather than beside the module: vitest's node project
// takes `main/**`, `mcp/**` and `renderer/lib/**`, so a test file in `shared/`
// matches NEITHER project and is silently never run.
//
// The property worth guarding is not "these fields are copied" — it is that the
// exported record is REBUILT, so a field nobody has thought about does not ship
// by inheritance, and that no path from the authoring machine survives.

import { describe, expect, it } from "vitest";

import {
  bundlePath,
  bundleRecord,
  EXPORTED_FIELDS,
  planExport,
  secretNames,
  specSource,
  WITHHELD_FIELDS,
} from "../../shared/export-bundle.mjs";

const AUTHOR_SCRIPTS = "/Users/someone/Library/Application Support/Good Looks!/recorder/scripts";

const recorded = {
  id: "t-login",
  name: "Login",
  url: "https://shop.example/login",
  createdAt: 1,
  updatedAt: 2,
  steps: [{ id: "s1", type: "click" }],
  scriptPath: `${AUTHOR_SCRIPTS}/t-login.spec.ts`,
  tags: ["smoke"],
  variables: [{ name: "PASSWORD", kind: "secret" }],
};

const imported = {
  id: "t-imported",
  name: "Imported",
  url: "https://shop.example/",
  createdAt: 3,
  updatedAt: 4,
  steps: [],
  scriptPath: `${AUTHOR_SCRIPTS}/imported/t-imported/tests/checkout.spec.ts`,
  sourceDir: "/Users/someone/projects/their-suite/tests",
};

describe("bundleRecord", () => {
  it("carries no path from the authoring machine", () => {
    // The load-bearing one. A bundle is committed to a repository or uploaded
    // as a CI artifact, so an absolute path puts a username and a directory
    // layout in both.
    const out = JSON.stringify(bundleRecord(recorded)?.record);
    expect(out).not.toContain("/Users/");
    expect(out).not.toContain("Application Support");
    expect(bundleRecord(recorded)?.record.scriptPath).toBe("t-login.spec.ts");
  });

  it("REBUILDS rather than spreads, so an unknown field cannot ride along", () => {
    // Spreading and pruning is right the day it is written. The next field
    // added to TestRecord would ship without anyone deciding that it should —
    // which is the same argument normalizeRawStep makes at the capture
    // boundary, in the other direction.
    const built = bundleRecord({ ...recorded, somethingNobodyHasThoughtAbout: "leaks" });
    expect(built?.record).not.toHaveProperty("somethingNobodyHasThoughtAbout");
  });

  it("withholds every field listed as withheld", () => {
    const noisy = { ...recorded } as Record<string, unknown>;
    for (const key of Object.keys(WITHHELD_FIELDS)) noisy[key] = "present-in-the-store";
    const built = bundleRecord(noisy);
    for (const key of Object.keys(WITHHELD_FIELDS)) {
      expect(built?.record, `${key} must not travel`).not.toHaveProperty(key);
    }
  });

  it("keeps `hidden`, so --all means the same set on the runner as in the app", () => {
    expect(bundleRecord({ ...recorded, hidden: true })?.record.hidden).toBe(true);
  });

  it("rewrites an imported test's sourceDir to a truthy, pathless position", () => {
    // Not dropped. The unattended runner reads sourceDir as a BOOLEAN — "is
    // this someone else's Playwright project" — and skips every fixture when it
    // is set. Dropping it would flip an imported test from uninstrumented to
    // instrumented on the runner, which is a behaviour change dressed as a
    // redaction.
    const built = bundleRecord(imported);
    expect(built?.record.sourceDir).toBe("imported/t-imported");
    expect(String(built?.record.sourceDir)).not.toContain("/Users/");
    expect(Boolean(built?.record.sourceDir)).toBe(true);
  });

  it("puts an imported spec at its position inside the sandbox", () => {
    expect(bundleRecord(imported)?.record.scriptPath).toBe(
      "imported/t-imported/tests/checkout.spec.ts",
    );
  });

  it("refuses a record whose id cannot name a path", () => {
    // No safe default. Inventing one would put a spec somewhere nobody asked
    // for — the same refusal scriptRelSegments makes, for the same reason.
    for (const id of ["../escape", "a/b", "", undefined, 7]) {
      expect(bundleRecord({ ...recorded, id })).toBeNull();
    }
  });

  it("never carries a secret's value, because the record never holds one", () => {
    // Belt: a secret variable's `value` is documented as always absent, and
    // this asserts the export does not become the first place one appears.
    const built = bundleRecord({
      ...recorded,
      variables: [{ name: "PASSWORD", kind: "secret", value: "hunter2" }],
    });
    expect(JSON.stringify(built?.record)).not.toContain("hunter2");
  });
});

describe("bundlePath", () => {
  it("writes forward slashes whatever the exporting machine uses", () => {
    // A library authored on Windows stores `\` and the bundle is read on
    // whichever runner it lands on. Writing the exporter's separator makes a
    // bundle that only works on machines like the one it came from, which is
    // the class of bug this whole item exists to end.
    expect(bundlePath(["imported", "t-1", "tests", "a.spec.ts"])).toBe(
      "imported/t-1/tests/a.spec.ts",
    );
  });
});

describe("specSource", () => {
  it("takes one file for a recorded test", () => {
    expect(specSource(recorded)).toEqual({ kind: "file", segments: ["t-login.spec.ts"] });
  });

  it("takes the whole sandbox for an imported one", () => {
    // The spec relative-imports its siblings, so a spec copied without them
    // fails to LOAD rather than failing a test — and a load failure names the
    // import, not the library that did not travel.
    expect(specSource(imported)).toEqual({
      kind: "tree",
      segments: ["imported", "t-imported"],
    });
  });
});

describe("secretNames", () => {
  it("names the secret variables and nothing else", () => {
    expect(
      secretNames({
        variables: [
          { name: "PASSWORD", kind: "secret" },
          { name: "USER", kind: "plain", value: "a@b.c" },
          { name: "CODE", kind: "generated" },
        ],
      }),
    ).toEqual(["PASSWORD"]);
  });

  it("answers empty for a test with no variables at all", () => {
    expect(secretNames({})).toEqual([]);
  });
});

describe("planExport", () => {
  it("exports the tests that need a secret and NAMES them", () => {
    // The decision worth pinning. A suite of thirty where two want a password
    // is twenty-eight tests that run on the runner today, so refusing the whole
    // export would be refusing the feature. But nobody should discover the two
    // from a failing assertion at a login form.
    const plan = planExport([recorded, imported]);
    expect(plan.records).toHaveLength(2);
    expect(plan.needsSecrets).toEqual([
      { id: "t-login", name: "Login", names: ["PASSWORD"] },
    ]);
  });

  it("sets aside a record it cannot build a path from, rather than dropping it silently", () => {
    const plan = planExport([recorded, { ...recorded, id: "../escape" }]);
    expect(plan.records).toHaveLength(1);
    expect(plan.unusable).toEqual([{ id: "../escape", name: "Login" }]);
  });

  it("answers an empty plan for anything that is not a list", () => {
    for (const bad of [null, undefined, {}, "tests"]) {
      expect(planExport(bad).records).toEqual([]);
    }
  });
});

describe("the two field lists", () => {
  it("do not overlap", () => {
    // A field in both is a decision made twice and read once.
    const both = EXPORTED_FIELDS.filter((f) => f in WITHHELD_FIELDS);
    expect(both).toEqual([]);
  });

  it("give every withheld field a reason", () => {
    // "We forgot" and "we decided" look identical in a list that only names
    // what is kept.
    for (const [field, reason] of Object.entries(WITHHELD_FIELDS)) {
      expect(reason.length, `${field} needs a reason`).toBeGreaterThan(10);
    }
  });
});
