// The signature store, driven against a throwaway userData dir.
//
// Three of these assertions are about something that is silent when broken. A
// register that carried a header value would put a credential in a plaintext
// file nobody thinks of as one. An append instead of an upsert leaves two
// candidates for one host and picks whichever sorts first. And collapsing
// `unreadable` into `none` reproduces the llm-service bug the sibling store's
// header warns about — the app saying nothing is configured while a signature
// the user registered sits on disk.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-shopify-sig-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { setEncryptionAvailable } = await import("./__tests__/shell-backend-stub.js");
setEncryptionAvailable(true);

const { shopifySignatureStore, signatureInputProblem } = await import(
  "./shopify-signature-store.js"
);

const registerFile = path.join(userData, "recorder", "shopify-signatures.json");
const secretFile = path.join(userData, "recorder", "shopify-signatures.bin");

const NOW_MS = Date.UTC(2026, 7, 18);
const NOW_S = Math.floor(NOW_MS / 1000);
const DAY_S = 24 * 60 * 60;

/** A `Signature-Input` that expires `days` from the fixed clock. */
function inputExpiring(days: number): string {
  return (
    `sig1=("@authority");created=${NOW_S - DAY_S};expires=${NOW_S + days * DAY_S};` +
    'keyid="poqkLGiymh_W0uP6PZFw";alg="ed25519";tag="web-bot-auth"'
  );
}

const SIGNATURE = "sig1=:dGhpcy1pcy1ub3QtYS1yZWFsLXNpZ25hdHVyZQ==:";

function reset(): void {
  fs.rmSync(registerFile, { force: true });
  fs.rmSync(secretFile, { force: true });
  shopifySignatureStore.resetCache();
}

beforeEach(reset);

describe("registering", () => {
  it("stores a signature and reports its expiry", async () => {
    await shopifySignatureStore.upsert({
      host: "https://Shop.Example.com/collections",
      signatureInput: inputExpiring(60),
      signature: SIGNATURE,
    });
    const list = await shopifySignatureStore.list(NOW_MS);
    expect(list).toHaveLength(1);
    expect(list[0].host).toBe("shop.example.com");
    expect(list[0].expiresAt).toBe(NOW_S + 60 * DAY_S);
    expect(list[0].state).toBe("valid");
  });

  it("defaults Signature-Agent to the value Shopify always shows", async () => {
    await shopifySignatureStore.upsert({
      host: "shop.example.com",
      signatureInput: inputExpiring(60),
      signature: SIGNATURE,
    });
    const entry = await shopifySignatureStore.signatureFor("https://shop.example.com/", NOW_MS);
    expect(entry?.signatureAgent).toBe('"https://shopify.com"');
  });

  it("replaces the entry for a host instead of appending a second one", async () => {
    // Shopify issues one signature per domain. Two entries for one host means
    // two candidates for the same request, resolved by whichever the lookup
    // happens to reach first.
    await shopifySignatureStore.upsert({
      host: "shop.example.com",
      signatureInput: inputExpiring(10),
      signature: "sig1=:b2xk:",
    });
    await shopifySignatureStore.upsert({
      host: "shop.example.com",
      signatureInput: inputExpiring(80),
      signature: "sig1=:bmV3:",
    });
    const list = await shopifySignatureStore.list(NOW_MS);
    expect(list).toHaveLength(1);
    expect(list[0].expiresAt).toBe(NOW_S + 80 * DAY_S);
    const entry = await shopifySignatureStore.signatureFor("https://shop.example.com/", NOW_MS);
    expect(entry?.signature).toBe("sig1=:bmV3:");
  });

  it("keeps separate entries for separate hosts", async () => {
    // The custom domain and the myshopify.com one are different authorities
    // and get different signatures, so both have to coexist.
    await shopifySignatureStore.upsert({
      host: "shop.example.com",
      signatureInput: inputExpiring(60),
      signature: "sig1=:Y3VzdG9t:",
    });
    await shopifySignatureStore.upsert({
      host: "my-store.myshopify.com",
      signatureInput: inputExpiring(60),
      signature: "sig1=:bXlzaG9w:",
    });
    expect(await shopifySignatureStore.list(NOW_MS)).toHaveLength(2);
    const custom = await shopifySignatureStore.signatureFor("https://shop.example.com/", NOW_MS);
    const shopify = await shopifySignatureStore.signatureFor(
      "https://my-store.myshopify.com/",
      NOW_MS,
    );
    expect(custom?.signature).toBe("sig1=:Y3VzdG9t:");
    expect(shopify?.signature).toBe("sig1=:bXlzaG9w:");
  });

  it("refuses a paste it cannot use, naming the field", async () => {
    const base = { host: "shop.example.com", signatureInput: inputExpiring(60), signature: SIGNATURE };
    await expect(shopifySignatureStore.upsert({ ...base, host: "not a domain" })).rejects.toThrow(
      /doesn't look like a domain/,
    );
    await expect(
      shopifySignatureStore.upsert({ ...base, signature: "sig\r\nX-Injected: 1" }),
    ).rejects.toThrow(/Signature/);
    await expect(
      shopifySignatureStore.upsert({ ...base, signatureInput: "garbage" }),
    ).rejects.toThrow(/Shopify issued/);
    expect(await shopifySignatureStore.list(NOW_MS)).toEqual([]);
  });
});

describe("the plaintext register", () => {
  it("carries no header value", async () => {
    // Asserted against the serialised file rather than a parsed object: the
    // question is what is sitting on disk unencrypted, and a nested field or a
    // renamed key would slip past a shape check.
    await shopifySignatureStore.upsert({
      host: "shop.example.com",
      signatureInput: inputExpiring(60),
      signature: SIGNATURE,
    });
    const raw = fs.readFileSync(registerFile, "utf-8");
    expect(raw).toContain("shop.example.com");
    expect(raw).not.toContain(SIGNATURE);
    expect(raw).not.toContain("sig1=");
    expect(raw).not.toContain("keyid");
    expect(raw).not.toContain("ed25519");
  });

  it("holds the host and expiry the MCP needs to explain an unsigned run", async () => {
    await shopifySignatureStore.upsert({
      host: "shop.example.com",
      signatureInput: inputExpiring(60),
      signature: SIGNATURE,
    });
    const parsed = JSON.parse(fs.readFileSync(registerFile, "utf-8"));
    expect(parsed.entries[0]).toMatchObject({
      host: "shop.example.com",
      expiresAt: NOW_S + 60 * DAY_S,
    });
    expect(typeof parsed.entries[0].id).toBe("string");
  });
});

describe("the three states", () => {
  it("reports nothing when nothing is registered", async () => {
    expect(await shopifySignatureStore.list(NOW_MS)).toEqual([]);
  });

  it("reports unreadable when the register survives but the blob does not", async () => {
    // The state this store exists to distinguish. Collapsing it into "nothing
    // configured" is the llm-service bug: the user registered a signature, the
    // pane says there is none, and nothing anywhere says why the crawl started
    // failing.
    await shopifySignatureStore.upsert({
      host: "shop.example.com",
      signatureInput: inputExpiring(60),
      signature: SIGNATURE,
    });
    fs.rmSync(secretFile, { force: true });
    shopifySignatureStore.resetCache();

    const list = await shopifySignatureStore.list(NOW_MS);
    expect(list).toHaveLength(1);
    expect(list[0].host).toBe("shop.example.com");
    expect(list[0].state).toBe("unreadable");
  });

  it("never sends a signature whose values could not be read", async () => {
    await shopifySignatureStore.upsert({
      host: "shop.example.com",
      signatureInput: inputExpiring(60),
      signature: SIGNATURE,
    });
    fs.rmSync(secretFile, { force: true });
    shopifySignatureStore.resetCache();
    expect(await shopifySignatureStore.signatureFor("https://shop.example.com/", NOW_MS)).toBeNull();
    expect(await shopifySignatureStore.entries(NOW_MS)).toEqual([]);
  });

  it("reports expiring and expired from the register's own expiry", async () => {
    await shopifySignatureStore.upsert({
      host: "soon.example.com",
      signatureInput: inputExpiring(3),
      signature: SIGNATURE,
    });
    await shopifySignatureStore.upsert({
      host: "gone.example.com",
      signatureInput: inputExpiring(-1),
      signature: SIGNATURE,
    });
    const byHost = Object.fromEntries(
      (await shopifySignatureStore.list(NOW_MS)).map((entry) => [entry.host, entry.state]),
    );
    expect(byHost["soon.example.com"]).toBe("expiring");
    expect(byHost["gone.example.com"]).toBe("expired");
  });

  it("keeps listing an expired signature while refusing to send it", async () => {
    // The row saying "expired" is how the user learns why the crawl started
    // failing. A row that quietly vanished would not be.
    await shopifySignatureStore.upsert({
      host: "gone.example.com",
      signatureInput: inputExpiring(-1),
      signature: SIGNATURE,
    });
    expect(await shopifySignatureStore.list(NOW_MS)).toHaveLength(1);
    expect(await shopifySignatureStore.signatureFor("https://gone.example.com/", NOW_MS)).toBeNull();
    expect(await shopifySignatureStore.entries(NOW_MS)).toEqual([]);
  });
});

describe("removing", () => {
  it("forgets both halves", async () => {
    const status = await shopifySignatureStore.upsert({
      host: "shop.example.com",
      signatureInput: inputExpiring(60),
      signature: SIGNATURE,
    });
    await shopifySignatureStore.remove(status.id);
    expect(await shopifySignatureStore.list(NOW_MS)).toEqual([]);
    expect(fs.existsSync(registerFile)).toBe(false);
    expect(fs.existsSync(secretFile)).toBe(false);
  });

  it("leaves the other hosts alone", async () => {
    const keep = await shopifySignatureStore.upsert({
      host: "keep.example.com",
      signatureInput: inputExpiring(60),
      signature: "sig1=:a2VlcA==:",
    });
    const drop = await shopifySignatureStore.upsert({
      host: "drop.example.com",
      signatureInput: inputExpiring(60),
      signature: "sig1=:ZHJvcA==:",
    });
    await shopifySignatureStore.remove(drop.id);
    const list = await shopifySignatureStore.list(NOW_MS);
    expect(list.map((entry) => entry.id)).toEqual([keep.id]);
    expect(
      (await shopifySignatureStore.signatureFor("https://keep.example.com/", NOW_MS))?.signature,
    ).toBe("sig1=:a2VlcA==:");
  });
});

describe("headerValuesForRedaction", () => {
  it("returns the two secret values and never the public agent literal", async () => {
    // Redacting `"https://shopify.com"` would replace that string everywhere it
    // legitimately appears — including in this app's own documentation text.
    await shopifySignatureStore.upsert({
      host: "shop.example.com",
      signatureInput: inputExpiring(60),
      signature: SIGNATURE,
    });
    const values = await shopifySignatureStore.headerValuesForRedaction();
    expect(values).toContain(SIGNATURE);
    expect(values).toContain(inputExpiring(60));
    expect(values).not.toContain('"https://shopify.com"');
    expect(values.some((value) => value.includes("shopify.com"))).toBe(false);
  });

  it("still strips an expired signature, which yesterday's log still holds", async () => {
    await shopifySignatureStore.upsert({
      host: "gone.example.com",
      signatureInput: inputExpiring(-1),
      signature: SIGNATURE,
    });
    expect(await shopifySignatureStore.headerValuesForRedaction()).toContain(SIGNATURE);
  });
});

describe("signatureInputProblem", () => {
  it("accepts a real paste", () => {
    expect(
      signatureInputProblem({
        host: "shop.example.com",
        signatureInput: inputExpiring(60),
        signature: SIGNATURE,
      }),
    ).toBeNull();
  });

  it("names the field that was wrong", () => {
    expect(
      signatureInputProblem({
        host: "shop.example.com",
        signatureInput: inputExpiring(60),
        signature: "",
      }),
    ).toBe("The Signature is empty.");
  });
});
