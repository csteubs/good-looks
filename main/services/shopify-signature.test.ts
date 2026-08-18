// What a Shopify crawler signature means, which is the whole decision surface
// of the feature: what a pasted value is allowed to contain, which host it may
// be sent to, and when it has stopped being worth sending.
//
// Lives here rather than beside shared/shopify-signature.mjs because vitest's
// node project takes `main/**`, `mcp/**` and `renderer/lib/**` — a test file
// under shared/ matches NEITHER project and would pass by never running.

import { describe, expect, it } from "vitest";

import {
  EXPIRY_WARN_DAYS,
  MAX_HEADER_VALUE_LENGTH,
  SIGNATURE_AGENT_VALUE,
  SIGNATURE_HEADER_NAMES,
  headerValueProblem,
  normalizeSignatureHost,
  parseSignatureInput,
  signatureForUrl,
  signatureState,
  validateHeaderValue,
} from "../../shared/shopify-signature.mjs";

/** A realistic value, with the parameter order Shopify's admin emits. */
const REAL_INPUT =
  'sig1=("@authority");created=1735689600;expires=1743465600;' +
  'keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";tag="web-bot-auth"';

/** Fixed clock: 2026-08-18T00:00:00Z, in ms and in unix seconds. */
const NOW_MS = Date.UTC(2026, 7, 18);
const NOW_S = Math.floor(NOW_MS / 1000);
const DAY_S = 24 * 60 * 60;

describe("parseSignatureInput", () => {
  it("reads the parameters out of a real value", () => {
    expect(parseSignatureInput(REAL_INPUT)).toEqual({
      createdAt: 1735689600,
      expiresAt: 1743465600,
      keyId: "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U",
      alg: "ed25519",
      tag: "web-bot-auth",
    });
  });

  it("does not read an expiry out of the keyid", () => {
    // `keyid` is a quoted base64 blob that can contain anything, and here it
    // contains the literal `expires=999` BEFORE the real parameter. A
    // `/expires=(\d+)/` scan returns 999 against this string — that is the bug
    // this assertion exists for, so it is asserted directly rather than trusted.
    const decoyFirst =
      'sig1=("@authority");keyid="AAexpires=999AA";created=1735689600;expires=1743465600';
    expect(/expires=(\d+)/.exec(decoyFirst)?.[1]).toBe("999");
    expect(parseSignatureInput(decoyFirst)?.expiresAt).toBe(1743465600);
  });

  it("does not split on a semicolon inside a quoted parameter", () => {
    const embedded = 'sig1=("@authority");keyid="AA;expires=999;AA";expires=1743465600';
    expect(parseSignatureInput(embedded)?.keyId).toBe("AA;expires=999;AA");
    expect(parseSignatureInput(embedded)?.expiresAt).toBe(1743465600);
  });

  it("reports a missing expiry as null rather than inventing one", () => {
    // `expires` is optional in RFC 9421. Ninety days from the paste would be a
    // guess, and a guessed expiry is one the app would act on.
    const parsed = parseSignatureInput('sig1=("@authority");created=1735689600;alg="ed25519"');
    expect(parsed?.expiresAt).toBeNull();
    expect(signatureState({ expiresAt: parsed?.expiresAt, nowMs: NOW_MS })).toBe("unknown");
  });

  it("refuses a value it cannot parse rather than reading half of it", () => {
    expect(parseSignatureInput('sig1=("@authority;expires=5')).toBeNull(); // unclosed paren
    expect(parseSignatureInput('sig1=("@authority");keyid="unterminated')).toBeNull();
    expect(parseSignatureInput("")).toBeNull();
    expect(parseSignatureInput("   ")).toBeNull();
    expect(parseSignatureInput("no-equals-anywhere")).toBeNull();
  });

  it("refuses a timestamp that is not a plain bounded integer", () => {
    const of = (expires: string): number | null =>
      parseSignatureInput(`sig1=("@authority");expires=${expires}`)?.expiresAt ?? null;
    expect(of('"1743465600"')).toBeNull(); // a String, not an Integer
    expect(of("-1743465600")).toBeNull();
    expect(of("17434656001743465600")).toBeNull(); // past the safe-integer range
    expect(of("99999999999")).toBeNull(); // past year 2100
    expect(of("0")).toBeNull();
    expect(of("1743465600")).toBe(1743465600);
  });
});

describe("headerValueProblem", () => {
  it("accepts the three real values", () => {
    expect(headerValueProblem(REAL_INPUT)).toBeNull();
    expect(headerValueProblem("sig1=:dGVzdA==:")).toBeNull();
    expect(headerValueProblem(SIGNATURE_AGENT_VALUE)).toBeNull();
  });

  it("refuses a value carrying a line break", () => {
    // The reason this check exists: the value is concatenated into an HTTP
    // header, and on the run side it travels as CDP JSON rather than through
    // Chromium's own header parser.
    for (const bad of ["sig1=:a:\r\nX-Injected: 1", "sig1=:a:\nX: 1", "a\0b", "sig\u0007a"]) {
      expect(headerValueProblem(bad), bad).toMatch(/line break|can't appear/);
      expect(validateHeaderValue(bad)).toBeNull();
    }
  });

  it("strips a trailing newline rather than refusing the paste", () => {
    // Copying a value out of a browser routinely picks one up, and the value
    // that leaves here is the trimmed one — so this is safe to accept, and
    // refusing it would read as "the admin gave me a broken signature".
    expect(validateHeaderValue("sig1=:dGVzdA==:\r\n")).toBe("sig1=:dGVzdA==:");
    expect(validateHeaderValue("\n  sig1=:dGVzdA==:  \n")).toBe("sig1=:dGVzdA==:");
  });

  it("refuses an empty or over-long value", () => {
    expect(headerValueProblem("")).toMatch(/empty/);
    expect(headerValueProblem("   ")).toMatch(/empty/);
    expect(headerValueProblem("a".repeat(MAX_HEADER_VALUE_LENGTH + 1))).toMatch(/longer than/);
    expect(headerValueProblem("a".repeat(MAX_HEADER_VALUE_LENGTH))).toBeNull();
  });

  it("names the field it refused", () => {
    expect(headerValueProblem("", "Signature-Input")).toBe("The Signature-Input is empty.");
  });

  it("returns the trimmed value when it is fine", () => {
    expect(validateHeaderValue("  sig1=:dGVzdA==:  ")).toBe("sig1=:dGVzdA==:");
  });
});

describe("normalizeSignatureHost", () => {
  it("reduces what a user would plausibly paste to a host", () => {
    expect(normalizeSignatureHost("https://Shop.Example.com/collections/all")).toBe(
      "shop.example.com",
    );
    expect(normalizeSignatureHost("shop.example.com")).toBe("shop.example.com");
    expect(normalizeSignatureHost("  http://a.b.c  ")).toBe("a.b.c");
    expect(normalizeSignatureHost("my-store.myshopify.com")).toBe("my-store.myshopify.com");
  });

  it("keeps a non-default port, because it is part of the authority", () => {
    expect(normalizeSignatureHost("shop.example.com:8443")).toBe("shop.example.com:8443");
    expect(normalizeSignatureHost("localhost:3000")).toBe("localhost:3000");
  });

  it("refuses a non-http scheme instead of finding a host inside it", () => {
    // `https://` + `ftp://x.com` parses cleanly and yields the host `ftp` — a
    // plausible-looking answer to a question that should have had none.
    for (const bad of ["ftp://x.com", "file:///etc/passwd", "javascript://evil.com"]) {
      expect(normalizeSignatureHost(bad), bad).toBeNull();
    }
  });

  it("refuses a wildcard, whitespace and an empty value", () => {
    for (const bad of ["", "   ", "*.example.com", "shop example.com", "*"]) {
      expect(normalizeSignatureHost(bad), bad).toBeNull();
    }
  });
});

describe("signatureState", () => {
  it("names the four states", () => {
    expect(signatureState({ expiresAt: NOW_S + 60 * DAY_S, nowMs: NOW_MS })).toBe("valid");
    expect(signatureState({ expiresAt: NOW_S + 5 * DAY_S, nowMs: NOW_MS })).toBe("expiring");
    expect(signatureState({ expiresAt: NOW_S - 1, nowMs: NOW_MS })).toBe("expired");
    expect(signatureState({ expiresAt: null, nowMs: NOW_MS })).toBe("unknown");
    expect(signatureState({ expiresAt: undefined, nowMs: NOW_MS })).toBe("unknown");
  });

  it("puts the warning boundary exactly at EXPIRY_WARN_DAYS", () => {
    expect(signatureState({ expiresAt: NOW_S + EXPIRY_WARN_DAYS * DAY_S, nowMs: NOW_MS })).toBe(
      "expiring",
    );
    expect(signatureState({ expiresAt: NOW_S + EXPIRY_WARN_DAYS * DAY_S + 1, nowMs: NOW_MS })).toBe(
      "valid",
    );
  });

  it("treats the moment of expiry as expired", () => {
    expect(signatureState({ expiresAt: NOW_S, nowMs: NOW_MS })).toBe("expired");
  });

  it("reads expiresAt as seconds, not milliseconds", () => {
    // The two units are deliberate — the header carries seconds, `Date.now()`
    // gives milliseconds — so a mixup is the obvious bug. Handing it a
    // millisecond value lands far past year 2100 and reads as valid, which is
    // exactly how it would go unnoticed.
    expect(signatureState({ expiresAt: NOW_S - DAY_S, nowMs: NOW_MS })).toBe("expired");
    expect(signatureState({ expiresAt: (NOW_S - DAY_S) * 1000, nowMs: NOW_MS })).toBe("valid");
  });
});

describe("signatureForUrl", () => {
  const entry = { host: "shop.example.com", expiresAt: NOW_S + 60 * DAY_S };

  it("matches the signed host exactly", () => {
    expect(signatureForUrl([entry], "https://shop.example.com/products/hat", NOW_MS)).toBe(entry);
    expect(signatureForUrl([entry], "http://shop.example.com/", NOW_MS)).toBe(entry);
  });

  it("does not match a neighbouring authority", () => {
    // Each of these is a separate signature in Shopify's model, and presenting
    // one at the wrong authority is an invalid signature rather than no
    // signature — which is worse, because the verifier is looking for spoofing.
    for (const url of [
      "https://www.shop.example.com/",
      "https://example.com/",
      "https://shop.example.com.evil.test/",
      "https://my-store.myshopify.com/",
      "https://shop.example.com:8443/",
    ]) {
      expect(signatureForUrl([entry], url, NOW_MS), url).toBeNull();
    }
  });

  it("never signs a request to the storefront's CDN", () => {
    // The property that keeps this credential off every third-party host a
    // Shopify storefront loads from.
    expect(signatureForUrl([entry], "https://cdn.shopify.com/s/files/1/x.js", NOW_MS)).toBeNull();
    expect(
      signatureForUrl([entry], "https://monorail-edge.shopifysvc.com/v1/produce", NOW_MS),
    ).toBeNull();
  });

  it("refuses an expired entry here, so no call site decides that for itself", () => {
    const expired = { host: "shop.example.com", expiresAt: NOW_S - 1 };
    expect(signatureForUrl([expired], "https://shop.example.com/", NOW_MS)).toBeNull();
  });

  it("sends one whose expiry is unknown", () => {
    // Unknown is not expired. Refusing here would make a signature that simply
    // carried no `expires` parameter unusable.
    const noExpiry = { host: "shop.example.com", expiresAt: null };
    expect(signatureForUrl([noExpiry], "https://shop.example.com/", NOW_MS)).toBe(noExpiry);
  });

  it("picks the entry for the requested host out of several", () => {
    const other = { host: "other.example.com", expiresAt: NOW_S + 60 * DAY_S };
    expect(signatureForUrl([other, entry], "https://shop.example.com/", NOW_MS)).toBe(entry);
  });

  it("returns null for junk rather than throwing", () => {
    expect(signatureForUrl([entry], "not a url", NOW_MS)).toBeNull();
    expect(signatureForUrl([], "https://shop.example.com/", NOW_MS)).toBeNull();
  });
});

describe("the spellings every side shares", () => {
  it("keeps the quotes on the agent value", () => {
    // The header is a structured-field String, whose serialisation IS the
    // quoted form. A bare https://shopify.com is a different, invalid value.
    expect(SIGNATURE_AGENT_VALUE).toBe('"https://shopify.com"');
  });

  it("names the three headers in lowercase", () => {
    expect([...SIGNATURE_HEADER_NAMES]).toEqual(["signature-input", "signature", "signature-agent"]);
    for (const name of SIGNATURE_HEADER_NAMES) expect(name).toBe(name.toLowerCase());
  });
});
