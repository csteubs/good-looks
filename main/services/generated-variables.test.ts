// Generated variables: a fresh value per run, produced by glazeGenerate in
// the spec's V header. The properties that matter: WHERE the call sits (before
// the GLAZE_VARS spread, so a dataset row can pin the value), that the spec
// string comes from OUR allowlist (it lands in source as a literal), and that
// the record never stores a value for one (fresh-per-run is the contract).

import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

import { describe, expect, it } from "vitest";

import { generateSpec } from "./script-generator.js";
import { glazeRuntimeSource } from "../../shared/glaze-runtime-source.mjs";
import { normalizeVariables } from "../recorder/types.js";
import type { Step, TestVariable } from "../recorder/types.js";

function gen(variables: TestVariable[], steps: Step[] = []): string {
  return generateSpec({
    name: "t",
    url: "https://x.test",
    steps,
    variables,
  } as Parameters<typeof generateSpec>[0]);
}

const GENERATED: TestVariable = { name: "userEmail", kind: "generated", genSpec: "email" };

describe("the V header", () => {
  it("calls glazeGenerate with the spec and the variable name, and imports the runtime", () => {
    const src = gen([GENERATED]);
    expect(src).toContain('userEmail: glazeGenerate("email", "userEmail"),');
    expect(src).toContain('import { glazeGenerate } from "./glaze-runtime.mjs";');
  });

  it("skips the runtime import when no variable is generated", () => {
    const src = gen([{ name: "city", kind: "plain", value: "Berlin" }]);
    expect(src).not.toContain("glazeGenerate");
  });

  it("puts generated values BEFORE the env spread, so a dataset row pins them", () => {
    const src = gen([GENERATED]);
    const genAt = src.indexOf("glazeGenerate(");
    const spreadAt = src.indexOf("...JSON.parse(process.env.GLAZE_VARS");
    expect(genAt).toBeGreaterThan(-1);
    expect(spreadAt).toBeGreaterThan(genAt);
  });

  it("keeps secrets AFTER the spread — a row still can't shadow one", () => {
    const src = gen([GENERATED, { name: "password", kind: "secret" }]);
    const spreadAt = src.indexOf("...JSON.parse(process.env.GLAZE_VARS");
    const secretAt = src.indexOf("password: process.env.");
    expect(secretAt).toBeGreaterThan(spreadAt);
  });

  it("never interpolates a forged genSpec — the generator allowlists independently", () => {
    const forged: TestVariable = { name: "x", kind: "generated" };
    (forged as unknown as Record<string, unknown>).genSpec = '"); require("fs"); ("';
    const src = gen([forged]);
    expect(src).toContain('x: glazeGenerate("string", "x"),');
    expect(src).not.toContain("require(");
  });
});

describe("the boundary", () => {
  it("drops a generated variable's value and defaults its genSpec", () => {
    const [v] = normalizeVariables([
      { name: "e", kind: "generated", value: "stale@example.com", genSpec: "email" },
    ]);
    expect(v.value).toBeUndefined();
    expect(v.genSpec).toBe("email");
    const [d] = normalizeVariables([{ name: "s", kind: "generated" }]);
    expect(d.genSpec).toBe("string");
    const [bad] = normalizeVariables([{ name: "b", kind: "generated", genSpec: "ssn" }]);
    expect(bad.genSpec).toBe("string");
  });

  it("leaves the other kinds' values alone", () => {
    const [v] = normalizeVariables([{ name: "city", kind: "plain", value: "Lyon" }]);
    expect(v.value).toBe("Lyon");
  });
});

describe("the runtime generator", () => {
  it("produces the shapes each spec promises, and logs the choice", async () => {
    // Import the EMITTED runtime as real JS — the same file a run loads.
    const dir = mkdtempSync(join(tmpdir(), "gl-runtime-"));
    const file = join(dir, "glaze-runtime.mjs");
    writeFileSync(file, glazeRuntimeSource);
    const mod = (await import(pathToFileURL(file).href)) as {
      glazeGenerate: (spec: string, name: string) => string;
    };

    const logged: string[] = [];
    const orig = console.log;
    console.log = (line: unknown) => logged.push(String(line));
    try {
      const email = mod.glazeGenerate("email", "e");
      expect(email).toMatch(/^gl-[a-z0-9]{8}@example\.com$/);
      expect(mod.glazeGenerate("number", "n")).toMatch(/^\d{6}$/);
      expect(mod.glazeGenerate("uuid", "u")).toMatch(/^[0-9a-f-]{36}$/i);
      expect(mod.glazeGenerate("name", "p")).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(mod.glazeGenerate("string", "s")).toMatch(/^[a-z0-9]{10}$/);
      // Unknown specs degrade to a string rather than throwing mid-run.
      expect(mod.glazeGenerate("nope", "x")).toMatch(/^[a-z0-9]{10}$/);
    } finally {
      console.log = orig;
    }
    // The run log is the only place "which email did this run use?" can be
    // answered after the fact.
    expect(logged.some((l) => l.startsWith("[glaze-generate] e = gl-"))).toBe(true);
  });

  it("two calls differ — the whole point", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-runtime-"));
    const file = join(dir, "glaze-runtime.mjs");
    writeFileSync(file, glazeRuntimeSource);
    const mod = (await import(pathToFileURL(file).href)) as {
      glazeGenerate: (spec: string, name: string) => string;
    };
    const orig = console.log;
    console.log = () => {};
    try {
      expect(mod.glazeGenerate("string", "a")).not.toBe(mod.glazeGenerate("string", "a"));
    } finally {
      console.log = orig;
    }
  });
});
