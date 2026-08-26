// `good-looks export` — the disk half (R10).
//
// Under `main/services/` for the reason cli-ingest.test.ts is: vitest's node
// project takes `main/**`, `mcp/**` and `renderer/lib/**`, so a test file in
// `cli/` matches NEITHER project and is silently never run.
//
// What is worth testing here is not that files are copied. It is the NEGATIVE:
// that a directory holding run history, logs, an API key, a webhook URL and an
// encrypted secrets store produces a bundle carrying none of them. A denylist
// would pass a test that names the files it excludes; this builds a store with
// every kind of thing in it and asserts on what came out.

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportCommand, parseExportArgs } from "../../cli/export.mjs";

const AUTHOR = "/Users/authoring-person/Library/Application Support/Good Looks!/recorder/scripts";
const API_KEY = "sk-this-must-not-travel";

let dataDir: string;
let outDir: string;
let out: string[];
let err: string[];

const deps = () => ({ out: (s: string) => out.push(s), err: (s: string) => err.push(s), dataDir });
const run = (options: Partial<Parameters<typeof exportCommand>[0]> = {}) =>
  exportCommand({ out: outDir, dryRun: false, json: false, force: false, ...options }, deps());

/** Everything in the bundle, as one string — the only way to assert that a
 *  thing is ABSENT without naming where it would have been. */
function bundleText(root: string): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      parts.push(p.slice(root.length));
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) parts.push(readFileSync(p, "utf-8"));
    }
  };
  if (existsSync(root)) walk(root);
  return parts.join("\n");
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "gl-export-"));
  dataDir = join(base, "lib");
  outDir = join(base, "bundle");
  out = [];
  err = [];

  const recorder = join(dataDir, "recorder");
  mkdirSync(join(recorder, "scripts", "imported", "t-imported", "tests"), { recursive: true });
  mkdirSync(join(recorder, "logs"), { recursive: true });
  mkdirSync(join(recorder, "artifacts", "run-1"), { recursive: true });
  mkdirSync(join(recorder, "browsers", "chromium-1234"), { recursive: true });

  writeFileSync(
    join(recorder, "tests.json"),
    JSON.stringify([
      {
        id: "t-login",
        name: "Login",
        url: "https://shop.example/login",
        createdAt: 1,
        updatedAt: 2,
        steps: [{ id: "s1", type: "click" }],
        scriptPath: `${AUTHOR}/t-login.spec.ts`,
        tags: ["smoke"],
        variables: [{ name: "PASSWORD", kind: "secret" }],
      },
      {
        id: "t-imported",
        name: "Imported",
        url: "https://shop.example/",
        createdAt: 3,
        updatedAt: 4,
        steps: [],
        scriptPath: `${AUTHOR}/imported/t-imported/tests/checkout.spec.ts`,
        sourceDir: "/Users/authoring-person/projects/their-suite/tests",
      },
    ]),
  );

  writeFileSync(join(recorder, "scripts", "t-login.spec.ts"), "// login\n");
  writeFileSync(join(recorder, "scripts", "imported", "t-imported", "tests", "checkout.spec.ts"), "import '../helper';\n");
  writeFileSync(join(recorder, "scripts", "imported", "t-imported", "helper.ts"), "export const h = 1;\n");

  // Everything a store holds that a runner has no business receiving.
  writeFileSync(join(recorder, "recorder-settings.json"), JSON.stringify({ llmApiKey: API_KEY }));
  writeFileSync(join(recorder, "run-history.json"), JSON.stringify([{ id: "run-1", status: "passed" }]));
  writeFileSync(join(recorder, "logs", "run-1.log"), "a password appeared in this log\n");
  writeFileSync(join(recorder, "artifacts", "run-1", "step-1.png"), "PNGDATA");
  writeFileSync(join(recorder, "test-secrets.bin"), "ENCRYPTEDSECRETS");
  writeFileSync(join(recorder, "alert-webhook.bin"), "ENCRYPTEDWEBHOOK");
  writeFileSync(join(recorder, "shopify-signatures.json"), JSON.stringify({ entries: [{ host: "x" }] }));
  writeFileSync(join(recorder, "heal-journal.json"), JSON.stringify([{ id: "h1" }]));
  writeFileSync(join(recorder, "insight-reports.json"), JSON.stringify([{ id: "i1" }]));
  writeFileSync(join(recorder, "metrics.db"), "SQLITEDATA");
  writeFileSync(join(recorder, "browsers", "chromium-1234", "chrome"), "BINARY");
});

afterEach(() => {
  rmSync(join(dataDir, ".."), { recursive: true, force: true });
});

describe("what a bundle contains", () => {
  it("writes tests.json and the specs, and nothing else at all", () => {
    expect(run()).toBe(0);
    const names = readdirSync(join(outDir, "recorder")).sort();
    expect(names).toEqual(["scripts", "tests.json"]);
  });

  it("carries no credential, no history and no artifact from the store", () => {
    // The whole point, asserted as an absence over the WHOLE bundle rather
    // than file by file — a per-file assertion passes for a file nobody
    // thought to name.
    run();
    const text = bundleText(outDir);
    // Not vacuous: every assertion below is an ABSENCE, and an empty string
    // satisfies all of them. This is the positive half that says the walk ran.
    expect(text).toContain("// login");
    for (const secret of [
      API_KEY,
      "ENCRYPTEDSECRETS",
      "ENCRYPTEDWEBHOOK",
      "a password appeared in this log",
      "PNGDATA",
      "SQLITEDATA",
      "BINARY",
      "run-1",
      "heal-journal",
      "insight-reports",
      "shopify",
    ]) {
      expect(text, `${secret} must not reach the bundle`).not.toContain(secret);
    }
  });

  it("carries no path from the authoring machine", () => {
    run();
    const text = bundleText(outDir);
    expect(text).not.toContain("/Users/");
    expect(text).not.toContain("Application Support");
  });

  it("does not copy browsers", () => {
    // Hundreds of megabytes and platform-specific. `good-looks install` puts
    // the right one on the runner in seconds, which is why the usage says so.
    run();
    expect(existsSync(join(outDir, "recorder", "browsers"))).toBe(false);
  });

  it("takes an imported test's whole sandbox, so its relative imports resolve", () => {
    run();
    expect(existsSync(join(outDir, "recorder", "scripts", "imported", "t-imported", "helper.ts"))).toBe(true);
  });
});

describe("symlinks", () => {
  it("copies files, never a link's target, and says it skipped one", () => {
    // copyFileSync FOLLOWS a symlink. An imported project shipping
    // `helpers.js -> ~/.ssh/id_rsa` would otherwise put that file's contents
    // in a directory somebody commits. The same rule copyRelativeImports
    // applies on the way IN.
    const secretFile = join(dataDir, "..", "not-for-you.txt");
    writeFileSync(secretFile, "PRIVATEKEYMATERIAL");
    symlinkSync(secretFile, join(dataDir, "recorder", "scripts", "imported", "t-imported", "leak.ts"));

    expect(run()).toBe(0);
    expect(bundleText(outDir)).not.toContain("PRIVATEKEYMATERIAL");
    expect(out.join("\n")).toContain("symlink");
  });
});

describe("secrets", () => {
  it("exports the rest and names the tests that will not run", () => {
    // The decision. Refusing the whole export over two tests that want a
    // password would be refusing the feature; letting a CI operator find out
    // at a login form is the failure this names instead.
    expect(run()).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("1 test(s) will not run until CI supplies their secrets");
    expect(text).toContain("Login — PASSWORD");
    expect(existsSync(join(outDir, "recorder", "tests.json"))).toBe(true);
  });
});

describe("what it refuses", () => {
  it("refuses to write into the library it is reading", () => {
    expect(exportCommand({ out: dataDir, dryRun: false, json: false, force: false }, deps())).toBe(3);
    expect(err.join("\n")).toContain("this library's own directory");
  });

  it("refuses a directory that already has files in it, and names the way through", () => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "someone-elses-work.txt"), "x");
    expect(run()).toBe(3);
    expect(err.join("\n")).toContain("--force");
    expect(existsSync(join(outDir, "someone-elses-work.txt"))).toBe(true);
  });

  it("…and writes into it with --force", () => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "someone-elses-work.txt"), "x");
    expect(run({ force: true })).toBe(0);
    expect(existsSync(join(outDir, "recorder", "tests.json"))).toBe(true);
  });

  it("answers 2 for a library with no tests, not 0", () => {
    // A bundle of nothing is indistinguishable from a bundle that worked,
    // right up until the pipeline reports a clean pass over no tests. Code 2
    // exists for exactly that shape.
    writeFileSync(join(dataDir, "recorder", "tests.json"), "[]");
    expect(run()).toBe(2);
  });

  it("answers 2 when no test has a spec on this disk", () => {
    rmSync(join(dataDir, "recorder", "scripts"), { recursive: true, force: true });
    expect(run()).toBe(2);
    expect(err.join("\n")).toContain("None of the");
  });
});

describe("a test whose spec is not on disk", () => {
  it("is left out and named, rather than shipped as a record pointing at nothing", () => {
    // A bundle holding a record with no spec reports "no tests found" on the
    // runner, which reads as a broken library rather than a missing file.
    rmSync(join(dataDir, "recorder", "scripts", "t-login.spec.ts"));
    expect(run()).toBe(0);
    const written = JSON.parse(readFileSync(join(outDir, "recorder", "tests.json"), "utf-8"));
    expect(written.map((t: { id: string }) => t.id)).toEqual(["t-imported"]);
    expect(out.join("\n")).toContain("t-login");
  });
});

describe("--dry-run", () => {
  it("reports and writes nothing", () => {
    expect(run({ dryRun: true })).toBe(0);
    expect(existsSync(outDir)).toBe(false);
    expect(out.join("\n")).toContain("Would export");
  });
});

describe("--json", () => {
  it("prints a summary a pipeline can read", () => {
    expect(run({ json: true })).toBe(0);
    const summary = JSON.parse(out.join("\n"));
    expect(summary.exported).toBe(2);
    expect(summary.needsSecrets).toEqual([{ id: "t-login", name: "Login", names: ["PASSWORD"] }]);
  });
});

describe("parseExportArgs", () => {
  it("requires a destination — there is no default", () => {
    // Same rule as `run`'s selector and `ingest`'s directory. A command that
    // creates what it is pointed at must not guess where.
    expect(parseExportArgs([])).toEqual({ ok: false, error: "Where to? Pass --out <dir>." });
  });

  it("refuses an unknown flag rather than exporting with defaults", () => {
    expect(parseExportArgs(["--out", "/tmp/x", "--pretty"])).toMatchObject({ ok: false });
  });

  it("refuses a bare positional, naming the flag", () => {
    expect(parseExportArgs(["/tmp/x"])).toMatchObject({ ok: false });
  });

  it("refuses --out with no value, and with a flag as its value", () => {
    expect(parseExportArgs(["--out"])).toMatchObject({ ok: false });
    expect(parseExportArgs(["--out", "--json"])).toMatchObject({ ok: false });
  });

  it("refuses two destinations", () => {
    expect(parseExportArgs(["--out", "/a", "--out", "/b"])).toMatchObject({ ok: false });
  });

  it("reads the flags it accepts", () => {
    expect(parseExportArgs(["--out", "/tmp/x", "--force", "--dry-run", "--json"])).toEqual({
      ok: true,
      options: { out: "/tmp/x", force: true, dryRun: true, json: true },
    });
  });

  it("answers help", () => {
    expect(parseExportArgs(["--help"])).toEqual({ ok: "help" });
    expect(parseExportArgs(["-h"])).toEqual({ ok: "help" });
  });
});
