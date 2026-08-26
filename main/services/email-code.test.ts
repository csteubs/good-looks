// The email-code rules. The one that matters is the WATERMARK: every other
// assertion here fails loudly in a run, and a stale code fails as six
// plausible digits Shopify rejects — five of which locks the customer out for
// half an hour. See docs/plans/shopify-account-auth.md.

import { describe, expect, it } from "vitest";

import {
  addressProblem,
  codeFromMessage,
  codeWatermark,
  endpointProblem,
  messagesUrl,
  normalizeAddress,
  parseMailMessage,
  pickCode,
  tokenProblem,
} from "../../shared/email-code.mjs";

describe("endpointProblem", () => {
  it("accepts https, and http only on the loopback wrangler serves from", () => {
    expect(endpointProblem("https://mail.example.com/messages")).toBeNull();
    expect(endpointProblem("http://localhost:8787/messages")).toBeNull();
    expect(endpointProblem("http://127.0.0.1:8787/messages")).toBeNull();
  });

  it("refuses plain http anywhere else — the token rides every request", () => {
    expect(endpointProblem("http://mail.example.com/messages")).toMatch(/https/);
  });

  it("refuses a URL carrying embedded credentials", () => {
    // Not pedantry: the request would go to the host after the `@`, which is
    // not the host a reader of the string sees, and the password would sit
    // somewhere nothing redacts.
    expect(endpointProblem("https://user:pass@mail.example.com/m")).toMatch(/username and password/);
  });

  it("refuses a non-URL, an over-long one, and one with a newline in it", () => {
    expect(endpointProblem("mail.example.com")).toMatch(/not a URL/);
    expect(endpointProblem("https://x.dev/" + "a".repeat(3000))).toMatch(/too long/);
    expect(endpointProblem("https://x.dev/m\r\nHost: evil")).toMatch(/characters a URL cannot carry/);
  });

  it("refuses nothing at all", () => {
    expect(endpointProblem("")).toBeTruthy();
    expect(endpointProblem(undefined)).toBeTruthy();
  });
});

describe("tokenProblem", () => {
  it("accepts an ordinary bearer token", () => {
    expect(tokenProblem("k7Fq2-x_ABC.123")).toBeNull();
  });

  it("refuses CR/LF — the value becomes an Authorization header", () => {
    expect(tokenProblem("good\r\nX-Evil: 1")).toMatch(/characters a header cannot carry/);
    expect(tokenProblem("good\nmore")).toBeTruthy();
  });

  it("refuses surrounding whitespace rather than trimming it", () => {
    // Trimming would make the stored value differ from what the user pasted
    // and from what the Worker was configured with, which reads as a wrong
    // token rather than a stray space.
    expect(tokenProblem(" tok ")).toMatch(/whitespace/);
  });

  it("refuses empty and over-long", () => {
    expect(tokenProblem("")).toBeTruthy();
    expect(tokenProblem("a".repeat(600))).toMatch(/too long/);
  });
});

describe("addressProblem", () => {
  it("accepts the shapes real test mailboxes take", () => {
    expect(addressProblem("shopper@mail.example.com")).toBeNull();
    expect(addressProblem("shopper+e2e@mail.example.com")).toBeNull();
    expect(addressProblem("first.last@mail.example.co.uk")).toBeNull();
  });

  it("refuses what is not an address", () => {
    expect(addressProblem("shopper")).toMatch(/not an email address/);
    expect(addressProblem("a@b@c.com")).toMatch(/not an email address/);
    expect(addressProblem("@example.com")).toMatch(/not an email address/);
    expect(addressProblem("shopper@localhost")).toMatch(/no valid domain/);
  });
});

describe("normalizeAddress", () => {
  it("lower-cases the whole address, local part included", () => {
    // More than RFC 5321 allows on purpose: Shopify lower-cases customer
    // emails and the Worker keys KV by this same function. Disagreeing here
    // is a poll that matches nothing while the mail sits in the store.
    expect(normalizeAddress("  Shopper+E2E@Mail.Example.COM ")).toBe("shopper+e2e@mail.example.com");
  });

  it("answers a string for anything", () => {
    expect(normalizeAddress(undefined)).toBe("");
    expect(normalizeAddress(42)).toBe("");
  });
});

describe("messagesUrl", () => {
  it("encodes the address rather than concatenating it", () => {
    // `+` is in the address of every sub-addressed mailbox and means a SPACE
    // in a query string. Hand-concatenated, this poll matches nothing.
    const url = messagesUrl("https://mail.example.com/messages", "a+b@Ex.com", 1700);
    expect(url).toContain("address=a%2Bb%40ex.com");
    expect(url).toContain("since=1700");
  });

  it("keeps an existing path and floors a fractional since", () => {
    expect(messagesUrl("https://x.dev/api/messages", "a@b.com", 12.9)).toContain("/api/messages?");
    expect(messagesUrl("https://x.dev/m", "a@b.com", 12.9)).toContain("since=12");
  });
});

describe("codeWatermark", () => {
  it("is the later of run start and the last code consumed", () => {
    expect(codeWatermark(100, 50)).toBe(100);
    expect(codeWatermark(100, 500)).toBe(500);
  });

  it("treats a missing half as zero rather than NaN", () => {
    // NaN would make every `receivedAt > watermark` false, and the step would
    // time out against a mailbox that had the code all along.
    expect(codeWatermark(100, undefined as unknown as number)).toBe(100);
    expect(codeWatermark(undefined as unknown as number, 0)).toBe(0);
  });
});

describe("codeFromMessage", () => {
  it("reads the code out of the subject Shopify sends", () => {
    expect(codeFromMessage({ subject: "123456 is your login code" })).toBe("123456");
  });

  it("prefers the subject over a noisier body", () => {
    expect(
      codeFromMessage({ subject: "Your code is 246810", body: "Order 135791 shipped" }),
    ).toBe("246810");
  });

  it("never returns the prefix of a longer digit run", () => {
    // The failure this exists for: a bare six-digit scan reads the first six
    // digits of an eight-digit order number and types a code nobody sent.
    expect(codeFromMessage({ subject: "Order 12345678 shipped" })).toBeNull();
    expect(codeFromMessage({ body: "ref 9876543210" })).toBeNull();
  });

  it("falls through to the body when the subject holds no code", () => {
    expect(
      codeFromMessage({ subject: "Sign in to Example Store", body: "Your code:\n\n654321\n" }),
    ).toBe("654321");
  });

  it("honours a digit count other than six", () => {
    expect(codeFromMessage({ subject: "code 1234" }, { digits: 4 })).toBe("1234");
    expect(codeFromMessage({ subject: "code 1234" })).toBeNull();
  });

  it("restricts the scan to what follows a label, case-insensitively", () => {
    const body = "Order 111111 confirmed. Your login code is 222222.";
    expect(codeFromMessage({ body }, { label: "login code is" })).toBe("222222");
    expect(codeFromMessage({ body }, { label: "LOGIN CODE IS" })).toBe("222222");
    expect(codeFromMessage({ body }, { label: "nowhere in here" })).toBeNull();
  });

  it("answers null for a message with nothing in it", () => {
    expect(codeFromMessage({})).toBeNull();
    expect(codeFromMessage({ subject: "", body: "" })).toBeNull();
    expect(codeFromMessage(undefined as unknown as { subject: string })).toBeNull();
  });

  it("is self-contained, so the runtime can embed it verbatim", () => {
    // The generated runtime interpolates this function's own source. A free
    // identifier compiles here and throws inside a Playwright worker, where
    // the module it came from does not exist.
    const src = codeFromMessage.toString();
    expect(src).not.toContain("MAX_BODY_SCAN");
    expect(src).not.toContain("DEFAULT_CODE_DIGITS");
    const rebuilt = new Function("return (" + src + ")")() as typeof codeFromMessage;
    expect(rebuilt({ subject: "424242 is your login code" })).toBe("424242");
  });
});

describe("pickCode", () => {
  const msg = (receivedAt: number, subject: string) => ({ receivedAt, subject });

  it("refuses everything at or before the watermark", () => {
    // THE rule. A code already in the inbox when the run started is a
    // plausible six digits Shopify rejects, and five rejections is a
    // thirty-minute lockout.
    expect(pickCode([msg(100, "111111 is your code")], 100)).toBeNull();
    expect(pickCode([msg(99, "111111 is your code")], 100)).toBeNull();
    expect(pickCode([msg(101, "111111 is your code")], 100)?.code).toBe("111111");
  });

  it("takes the newest of several fresh messages", () => {
    const got = pickCode(
      [msg(110, "111111 is your code"), msg(130, "333333 is your code"), msg(120, "222222 is your code")],
      100,
    );
    expect(got).toEqual({ code: "333333", receivedAt: 130 });
  });

  it("skips a fresh message that holds no code and keeps looking", () => {
    const got = pickCode([msg(130, "Your order shipped"), msg(120, "222222 is your code")], 100);
    expect(got?.code).toBe("222222");
  });

  it("answers null for an empty or non-array response", () => {
    // The endpoint's answer is JSON from the network; a shape that is not a
    // list must read as "no code yet" and let the poll continue, never throw.
    expect(pickCode([], 0)).toBeNull();
    expect(pickCode(undefined as unknown as [], 0)).toBeNull();
    expect(pickCode({ messages: [] } as unknown as [], 0)).toBeNull();
  });
});

describe("parseMailMessage", () => {
  const msg = (lines: string[]) => lines.join("\r\n");

  it("decodes an RFC 2047 subject", () => {
    // A subject left encoded defeats the subject-first scan entirely, which
    // is the scan that exists because a subject holds one number.
    const raw = msg(["Subject: =?UTF-8?Q?123456_is_your_login_code?=", "", "body"]);
    expect(parseMailMessage(raw).subject).toBe("123456 is your login code");
    const b64 = msg(["Subject: =?UTF-8?B?WW91ciBjb2Rl?=", "", "body"]);
    expect(parseMailMessage(b64).subject).toBe("Your code");
  });

  it("decodes quoted-printable and base64 bodies", () => {
    const qp = msg([
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Your code is 123456=2E Caf=C3=A9.",
    ]);
    expect(parseMailMessage(qp).body).toContain("123456. Café.");
    const b64 = msg([
      "Content-Type: text/plain",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("Your code is 654321").toString("base64"),
    ]);
    expect(parseMailMessage(b64).body).toBe("Your code is 654321");
  });

  it("joins a folded header rather than truncating at the fold", () => {
    const raw = msg(["Subject: Your login", "  code has arrived", "", "body"]);
    expect(parseMailMessage(raw).subject).toBe("Your login code has arrived");
  });

  it("prefers text/plain over text/html in a multipart", () => {
    // Same content, none of the markup — and none of the digits a tracking
    // pixel's query string contributes.
    const raw = msg([
      'Content-Type: multipart/alternative; boundary="B1"',
      "",
      "--B1",
      "Content-Type: text/html",
      "",
      "<p>ignore 999999</p>",
      "--B1",
      "Content-Type: text/plain",
      "",
      "code 123456",
      "--B1--",
    ]);
    expect(parseMailMessage(raw).body).toContain("123456");
    expect(parseMailMessage(raw).body).not.toContain("999999");
  });

  it("falls back to html, stripped, when that is all there is", () => {
    const raw = msg([
      'Content-Type: multipart/alternative; boundary="B1"',
      "",
      "--B1",
      "Content-Type: text/html",
      "",
      "<style>.a{color:#123456}</style><p>Your code is <b>246813</b></p>",
      "--B1--",
    ]);
    const body = parseMailMessage(raw).body;
    expect(body).toContain("246813");
    // <style> contents are dropped rather than de-tagged: a stylesheet full of
    // hex colours is exactly the digit soup the code scan should never see.
    expect(body).not.toContain("123456");
    expect(body).not.toContain("<b>");
  });

  it("walks one level of nesting, which is where real login mail stops", () => {
    const raw = msg([
      'Content-Type: multipart/mixed; boundary="OUT"',
      "",
      "--OUT",
      'Content-Type: multipart/alternative; boundary="IN"',
      "",
      "--IN",
      "Content-Type: text/plain",
      "",
      "code 135790",
      "--IN--",
      "--OUT--",
    ]);
    expect(parseMailMessage(raw).body).toContain("135790");
  });

  it("caps the body it returns", () => {
    const raw = msg(["Content-Type: text/plain", "", "x".repeat(5000)]);
    expect(parseMailMessage(raw, 100).body).toHaveLength(100);
  });

  it("answers a whole message for a headerless or empty input", () => {
    // The Worker hands whatever arrived; a message that fails to parse must
    // read as "no code in it" and let the poll continue, never throw.
    expect(parseMailMessage("").body).toBe("");
    expect(parseMailMessage("").subject).toBe("");
    expect(() => parseMailMessage(undefined as unknown as string)).not.toThrow();
    expect(parseMailMessage("just text, no headers").subject).toBe("");
  });

  it("takes the first of a duplicated header", () => {
    const raw = msg(["Subject: real 111111", "Subject: forged 222222", "", "body"]);
    expect(parseMailMessage(raw).subject).toBe("real 111111");
  });
});
