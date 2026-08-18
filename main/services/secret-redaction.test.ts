// The redaction snapshot's SOURCES.
//
// `redact()` itself is pinned by check:variables. What is pinned here is which
// values reach it, because that is the half that changes when a new kind of
// credential is added and the half whose failure is silent: every synchronous
// redactor keeps working perfectly while quietly not covering the new one.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-redaction-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { setEncryptionAvailable } = await import("./__tests__/shell-backend-stub.js");
setEncryptionAvailable(true);

const { shopifySignatureStore } = await import("./shopify-signature-store.js");
const { testSecretsStore } = await import("./test-secrets-store.js");
const { allRedactableValues, redactWithSnapshot, refreshSecretSnapshot, REDACTED } = await import(
  "./secret-redaction.js"
);

const SIGNATURE = "sig1=:dGhpcy1pcy10aGUtc2lnbmF0dXJl:";
const SIGNATURE_INPUT =
  'sig1=("@authority");created=1735689600;expires=4102444799;keyid="kkk";alg="ed25519"';

beforeEach(async () => {
  fs.rmSync(path.join(userData, "recorder"), { recursive: true, force: true });
  shopifySignatureStore.resetCache();
  testSecretsStore.resetCache();
  await refreshSecretSnapshot();
});

describe("allRedactableValues", () => {
  it("spans both stores", async () => {
    // Two ways a credential reaches a run's output: a secret variable typed
    // INTO the page, and a signature this app attached to the request. One way
    // out.
    await testSecretsStore.set("t1", "pass", "hunter2-secret");
    await shopifySignatureStore.upsert({
      host: "shop.example.com",
      signatureInput: SIGNATURE_INPUT,
      signature: SIGNATURE,
    });
    const values = await allRedactableValues();
    expect(values).toContain("hunter2-secret");
    expect(values).toContain(SIGNATURE);
    expect(values).toContain(SIGNATURE_INPUT);
  });

  it("never carries the public Signature-Agent literal", async () => {
    // Redacting `"https://shopify.com"` would replace that string everywhere it
    // legitimately appears — including in this app's own documentation, which
    // Settings renders.
    await shopifySignatureStore.upsert({
      host: "shop.example.com",
      signatureInput: SIGNATURE_INPUT,
      signature: SIGNATURE,
    });
    expect(await allRedactableValues()).not.toContain('"https://shopify.com"');
  });
});

describe("the snapshot the synchronous redactors read", () => {
  it("strips a signature out of run output once refreshed", async () => {
    // This is what covers the run log, the streamed run output, every artifact
    // read back, and the AI-debug prompt — none of which can await.
    await shopifySignatureStore.upsert({
      host: "shop.example.com",
      signatureInput: SIGNATURE_INPUT,
      signature: SIGNATURE,
    });
    await refreshSecretSnapshot();
    const line = `  -> 403 with signature ${SIGNATURE} sent`;
    expect(redactWithSnapshot(line)).toBe(`  -> 403 with signature ${REDACTED} sent`);
  });

  it("leaves the run's own text alone", async () => {
    await shopifySignatureStore.upsert({
      host: "shop.example.com",
      signatureInput: SIGNATURE_INPUT,
      signature: SIGNATURE,
    });
    await refreshSecretSnapshot();
    expect(redactWithSnapshot("navigated to https://shop.example.com/products")).toBe(
      "navigated to https://shop.example.com/products",
    );
  });
});
