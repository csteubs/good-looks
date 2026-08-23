// HTTP basic auth: the model, the emission, and the parse-back.
//
// The property that matters most is what is NOT here: the password. The record
// stores only the NAME of a secret variable (`passwordVar`), the generated
// spec reads `process.env.GLAZE_SECRET_<name>`, and the value itself stays on
// the one encrypted path every secret already travels — so a credential never
// lands in tests.json, in the spec source, or in anything a model is shown.
//
// The real proof — a browser actually getting past a 401 wall with the emitted
// credentials, and the trainer getting past the same wall — is
// e2e/basic-auth.spec.ts. This is the laptop-speed half: the boundary, the
// emission shape, and the parser regression the `test.use` line exposed.
//
// VERIFIED TO FAIL: dropping `use` from extractTestBodies' skip list fails
// "does not double the steps on re-parse"; emitting the username without q()
// fails "a hostile username cannot break out".

import { describe, expect, it } from "vitest";

import { generateSpec, generateSpecDetailed } from "./script-generator.js";
import { parseSpecDetailed } from "./spec-parser.js";
import { normalizeBasicAuth, normalizeStep } from "../recorder/types.js";
import { answersLoginFor, credentialOrigin } from "../../shared/basic-auth.mjs";
import { generatedStepLineMap } from "./playwright-runner.js";
import type { Step, TestVariable } from "../recorder/types.js";

const STEPS: Step[] = [
  normalizeStep({ id: "g", timestamp: 0, type: "goto", url: "https://x.test" }) as Step,
  normalizeStep({
    id: "s1",
    timestamp: 0,
    type: "click",
    locator: { k: "role", role: "button", name: "Go" },
  }) as Step,
];
const SECRET: TestVariable[] = [{ name: "wallPw", kind: "secret" }];

function spec(basicAuth?: { username: string; passwordVar: string }): string {
  return generateSpec({ name: "t", url: "https://x.test", steps: STEPS, variables: SECRET, basicAuth });
}

describe("normalizeBasicAuth — the boundary", () => {
  it("keeps a well-formed credential", () => {
    expect(normalizeBasicAuth({ username: "admin", passwordVar: "wallPw" })).toEqual({
      username: "admin",
      passwordVar: "wallPw",
    });
  });

  it("rebuilds rather than filters — an unknown key never survives", () => {
    const out = normalizeBasicAuth({
      username: "a",
      passwordVar: "p",
      password: "hunter2",
      extra: "x",
    }) as unknown as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["passwordVar", "username"]);
    // The obvious wrong shape — a literal password smuggled in — is dropped,
    // not stored.
    expect("password" in out).toBe(false);
  });

  it("refuses a passwordVar that is not a valid variable name", () => {
    // The name becomes an env-var identifier (secretEnvName) and a secrets-store
    // lookup; an invalid one would silently mean "no password".
    expect(normalizeBasicAuth({ username: "a", passwordVar: "not a name" })).toBeUndefined();
    expect(normalizeBasicAuth({ username: "a", passwordVar: "1x" })).toBeUndefined();
    expect(normalizeBasicAuth({ username: "a", passwordVar: "" })).toBeUndefined();
  });

  it("a credential with no password reference is not a credential", () => {
    expect(normalizeBasicAuth({ username: "only-a-user" })).toBeUndefined();
  });

  it("an empty username is allowed — some walls only check the password", () => {
    expect(normalizeBasicAuth({ passwordVar: "wallPw" })).toEqual({
      username: "",
      passwordVar: "wallPw",
    });
  });

  it("rejects non-objects outright", () => {
    expect(normalizeBasicAuth(null)).toBeUndefined();
    expect(normalizeBasicAuth("basic")).toBeUndefined();
    expect(normalizeBasicAuth(["u", "p"])).toBeUndefined();
  });
});

describe("emission", () => {
  it("emits test.use({ httpCredentials }) reading the secret's env var, scoped to origin", () => {
    const src = spec({ username: "admin", passwordVar: "wallPw" });
    expect(src).toContain(
      'test.use({ httpCredentials: { username: "admin", password: process.env.GLAZE_SECRET_wallPw ?? "", origin: "https://x.test" } });',
    );
    // The password VALUE appears nowhere — only the env read.
    expect(src).not.toContain("hunter2");
  });

  it("scopes the credential to the test's own origin, not every 401", () => {
    // Without `origin`, Playwright answers ANY server's 401 during the run, so
    // a third-party subresource or redirect would receive the password. The
    // origin comes from the test's URL, keeping the port.
    const src = generateSpec({
      name: "t",
      url: "https://secure.example.com:8443/app/login?next=/x",
      steps: STEPS,
      variables: SECRET,
      basicAuth: { username: "admin", passwordVar: "wallPw" },
    });
    expect(src).toContain('origin: "https://secure.example.com:8443"');
  });

  it("falls back to no scope only when the URL is not absolute", () => {
    const src = generateSpec({
      name: "t",
      url: "not-a-url",
      steps: STEPS,
      variables: SECRET,
      basicAuth: { username: "admin", passwordVar: "wallPw" },
    });
    // Still emitted (the feature works), but unscoped — an exotic case: a
    // basic-auth wall needs a real address to sit behind.
    expect(src).toContain("httpCredentials");
    expect(src).not.toContain("origin:");
  });

  it("emits nothing without basicAuth — existing specs regenerate byte-identically", () => {
    expect(spec()).not.toContain("test.use");
    expect(spec()).not.toContain("httpCredentials");
  });

  it("a hostile username cannot break out of the generated source", () => {
    const src = spec({ username: '"});evil();//', passwordVar: "wallPw" });
    // q() escapes the quote, so the payload stays inside the string literal.
    expect(src).toContain('username: "\\"});evil();//"');
    const useLine = src.split("\n").find((l) => l.startsWith("test.use"))!;
    expect(() => new Function("test", "process", useLine)).not.toThrow();
  });

  it("a stored record with a forged passwordVar emits nothing", () => {
    // The generator re-gates independently of the boundary: records on disk
    // predate normalizeBasicAuth and are regenerated from raw JSON.
    const src = spec({ username: "a", passwordVar: "x; rm -rf /" });
    expect(src).not.toContain("test.use");
    expect(src).not.toContain("rm -rf");
  });

  it("the line map still points at the right steps", () => {
    const { source, lineMap } = generateSpecDetailed({
      name: "t",
      url: "https://x.test",
      steps: STEPS,
      variables: SECRET,
      basicAuth: { username: "admin", passwordVar: "wallPw" },
    });
    const lines = source.split("\n");
    for (const [line, stepIndex] of Object.entries(lineMap)) {
      const text = lines[Number(line) - 1];
      expect(text, `line ${line} for step ${stepIndex}`).toContain(
        stepIndex === 0 ? "page.goto" : ".click(",
      );
    }
  });
});

describe("parse-back", () => {
  it("does not double the steps on re-parse", () => {
    // `test.use(` matches the test-call scan; without the skip its indexOf("=>")
    // found the REAL test's arrow and extracted the body a second time — every
    // hand edit of a basic-auth spec silently duplicated every step.
    const src = spec({ username: "admin", passwordVar: "wallPw" });
    const parsed = parseSpecDetailed(src);
    expect(parsed.steps.map((s) => s.type)).toEqual(["goto", "click"]);
    expect(parsed.skipped).toBe(0);
  });
});

describe("origin scoping — the credential leak fix", () => {
  // The security decision, factored into a pure predicate so it is testable
  // without Electron. The generator emits `origin` from the same rule, and the
  // trainer's login handler calls answersLoginFor directly. A credential goes
  // ONLY to the test's own origin — a third-party subresource or a redirect to
  // another host is refused.
  it("answers the test's own origin", () => {
    expect(answersLoginFor("https://a.test/login", null, "https://a.test/api")).toBe(true);
  });
  it("refuses a different host — the leak this prevents", () => {
    expect(answersLoginFor("https://a.test/login", null, "https://evil.test/x")).toBe(false);
  });
  it("treats a different port as a different origin", () => {
    expect(answersLoginFor("https://a.test:8443/", null, "https://a.test/x")).toBe(false);
  });
  it("treats a different scheme as a different origin", () => {
    expect(answersLoginFor("https://a.test/", null, "http://a.test/x")).toBe(false);
  });
  it("falls back to baseUrl when the test has no absolute url", () => {
    expect(answersLoginFor(undefined, "https://a.test", "https://a.test/y")).toBe(true);
    expect(answersLoginFor(undefined, "https://a.test", "https://b.test/y")).toBe(false);
  });
  it("answers unconditionally only when NOTHING gives an origin — matching the run's unscoped fallback", () => {
    expect(answersLoginFor("not-a-url", "", "https://anything.test/x")).toBe(true);
  });

  it("credentialOrigin keeps scheme, host and port and rejects non-URLs", () => {
    expect(credentialOrigin("https://a.test:8443/deep?q=1#f")).toBe("https://a.test:8443");
    expect(credentialOrigin("relative/path")).toBeNull();
    expect(credentialOrigin("")).toBeNull();
    expect(credentialOrigin(undefined)).toBeNull();
  });
});

describe("the run-flow uses basicAuth consistently", () => {
  // The reporter reports line numbers against the ON-DISK spec, which
  // testStore.regenerateScript writes WITH basicAuth (two extra preamble
  // lines). generatedStepLineMap must build its map from the SAME inputs, or
  // every key is off by two and the run panel highlights the wrong step. Both
  // now pass basicAuth; this pins that generatedStepLineMap's keys land on the
  // real lines of a spec that HAS the test.use preamble.
  it("generatedStepLineMap's keys align with a basic-auth spec's real lines", () => {
    const rec = {
      id: "t1",
      name: "t",
      url: "https://x.test",
      createdAt: 0,
      updatedAt: 0,
      steps: STEPS,
      scriptPath: "/tmp/t1.spec.ts",
      variables: SECRET,
      basicAuth: { username: "admin", passwordVar: "wallPw" },
    } as unknown as Parameters<typeof generatedStepLineMap>[0];
    const map = generatedStepLineMap(rec, STEPS, () => null);
    expect(map, "a generated map exists").not.toBeNull();
    // The on-disk spec is what the reporter's line numbers refer to.
    const lines = generateSpec({
      name: "t",
      url: "https://x.test",
      steps: STEPS,
      variables: SECRET,
      basicAuth: { username: "admin", passwordVar: "wallPw" },
    }).split("\n");
    for (const [line, index] of map!) {
      expect(lines[line - 1], `line ${line} for step ${index}`).toContain(
        index === 0 ? "page.goto" : ".click(",
      );
    }
  });
});
