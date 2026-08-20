// The TOTP math against RFC 6238's own Appendix B vectors — a real oracle,
// not a model of one. The RFC's SHA-1 vectors use the ASCII key
// "12345678901234567890" (base32: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ) and
// 8-digit codes at fixed times.

import { createHmac } from "crypto";

import { describe, expect, it } from "vitest";

import { base32Bytes, totpCode } from "../../shared/totp.mjs";

function hmacSha1(key: number[], msg: number[]): number[] {
  return [...createHmac("sha1", Buffer.from(key)).update(Buffer.from(msg)).digest()];
}

const RFC_KEY_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("base32Bytes", () => {
  it("decodes the RFC key to its ASCII bytes", () => {
    expect(base32Bytes(RFC_KEY_B32)).toEqual([...Buffer.from("12345678901234567890", "ascii")]);
  });

  it("ignores case, spaces and padding; refuses the out-of-alphabet", () => {
    expect(base32Bytes("gezd gnbv gy3t qojq gezd gnbv gy3t qojq==")).toEqual(
      [...Buffer.from("12345678901234567890", "ascii")],
    );
    expect(base32Bytes("NOT!VALID")).toBeNull();
    expect(base32Bytes("")).toBeNull();
    expect(base32Bytes("189")).toBeNull();
  });
});

describe("totpCode against RFC 6238 Appendix B (SHA-1)", () => {
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  for (const [t, expected] of vectors) {
    it(`T=${t} → ${expected}`, () => {
      expect(totpCode(hmacSha1, RFC_KEY_B32, t * 1000, 8, 30)).toBe(expected);
    });
  }

  it("produces 6 digits by default, zero-padded", () => {
    const code = totpCode(hmacSha1, RFC_KEY_B32, 59 * 1000);
    expect(code).toBe("287082");
  });

  it("answers null for a bad secret rather than a wrong code", () => {
    expect(totpCode(hmacSha1, "not a key!", Date.now())).toBeNull();
  });
});
