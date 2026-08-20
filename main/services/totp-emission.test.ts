// TOTP secrets in the generated spec: the getter emission (fresh code at
// every read — the whole point), the runtime embedding, and the resolver's
// derive path the trainer uses. The math itself is pinned against RFC 6238
// vectors in totp.test.ts.

import { createHmac } from "crypto";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

import { describe, expect, it } from "vitest";

import { generateSpec } from "./script-generator.js";
import { glazeRuntimeSource } from "./glaze-runtime-source.js";
import { totpCode } from "../../shared/totp.mjs";
import { normalizeVariables, resolveStepForReplay } from "../recorder/types.js";
import type { Step, TestVariable } from "../recorder/types.js";

const RFC_KEY = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

function gen(variables: TestVariable[], steps: Step[] = []): string {
  return generateSpec({ name: "t", url: "https://x.test", steps, variables } as Parameters<
    typeof generateSpec
  >[0]);
}

describe("emission", () => {
  it("emits a totp secret as a getter over glazeTotp, after the spread", () => {
    const src = gen([{ name: "mfa", kind: "secret", totp: true }]);
    expect(src).toContain("get mfa() { return glazeTotp(process.env.GLAZE_SECRET_mfa ?? \"\"); },");
    expect(src).toContain('import { glazeTotp } from "./glaze-runtime.mjs";');
    const spreadAt = src.indexOf("...JSON.parse(process.env.GLAZE_VARS");
    expect(src.indexOf("get mfa()")).toBeGreaterThan(spreadAt);
  });

  it("leaves a plain secret as the env read it always was", () => {
    const src = gen([{ name: "password", kind: "secret" }]);
    expect(src).toContain('password: process.env.GLAZE_SECRET_password ?? "",');
    expect(src).not.toContain("glazeTotp");
  });

  it("embeds the shared math verbatim", () => {
    expect(glazeRuntimeSource).toContain(totpCode.toString());
  });
});

describe("the boundary", () => {
  it("keeps totp only on secrets", () => {
    const [secret] = normalizeVariables([{ name: "mfa", kind: "secret", totp: true }]);
    expect(secret.totp).toBe(true);
    const [plain] = normalizeVariables([{ name: "x", kind: "plain", totp: true, value: "v" }]);
    expect(plain.totp).toBeUndefined();
  });
});

describe("trainer replay derives the code", () => {
  const hmac = (key: number[], msg: number[]): number[] =>
    Array.from(createHmac("sha1", Buffer.from(key)).update(Buffer.from(msg)).digest());
  const derive = (setupKey: string) => totpCode(hmac, setupKey, 59 * 1000);

  const step: Step = {
    id: "s1",
    timestamp: 0,
    type: "fill",
    locator: { k: "label", v: "Code" },
    value: "${mfa}",
  } as Step;

  it("fills the current code, not the setup key", () => {
    const r = resolveStepForReplay(
      step,
      [{ name: "mfa", kind: "secret", totp: true }],
      { mfa: RFC_KEY },
      derive,
    );
    // RFC 6238 vector at T=59: SHA-1, 6 digits → 287082.
    expect(r.step.value).toBe("287082");
    expect(r.missingSecrets).toEqual([]);
    // The code is masked from the trainer's output like any secret-derived
    // value.
    expect(r.usedValues).toContain("287082");
  });

  it("reports a key that doesn't decode like a missing secret — never a wrong code", () => {
    const r = resolveStepForReplay(
      step,
      [{ name: "mfa", kind: "secret", totp: true }],
      { mfa: "not a key!" },
      derive,
    );
    expect(r.step.value).toBe("${mfa}");
    expect(r.missingSecrets).toEqual(["mfa"]);
  });

  it("leaves a non-totp secret's value untouched", () => {
    const r = resolveStepForReplay(
      step,
      [{ name: "mfa", kind: "secret" }],
      { mfa: "plain-password" },
      derive,
    );
    expect(r.step.value).toBe("plain-password");
  });
});

describe("the runtime getter end to end", () => {
  it("V's getter answers a fresh RFC-correct code from the env secret", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-runtime-"));
    const file = join(dir, "glaze-runtime.mjs");
    writeFileSync(file, glazeRuntimeSource);
    const rt = (await import(pathToFileURL(file).href)) as {
      glazeTotp: (key: string) => string;
    };
    const code = rt.glazeTotp(RFC_KEY);
    expect(code).toMatch(/^\d{6}$/);
    // Same instant, same math — the embedded copy must agree with the shared
    // one it was serialized from.
    const hmac = (key: number[], msg: number[]): number[] =>
      Array.from(createHmac("sha1", Buffer.from(key)).update(Buffer.from(msg)).digest());
    expect([
      totpCode(hmac, RFC_KEY, Date.now()),
      totpCode(hmac, RFC_KEY, Date.now() - 30_000),
    ]).toContain(code);
    expect(() => rt.glazeTotp("nope!")).toThrow(/setup key/);
  });
});
