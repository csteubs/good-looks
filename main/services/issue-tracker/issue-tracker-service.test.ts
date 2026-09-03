// The orchestration layer: what the IPC handlers call.
//
// Only the PROVIDER is faked — the token store and the config store are the
// real ones, running against a temp userData dir and the backend stub's
// safeStorage. That is deliberate: the rules worth pinning here are all about
// how those three interact, and a test that mocked the stores would assert that
// this file calls them rather than that the outcome is right.
//
// Three rules carry the weight:
//
//   • `status()` never touches the network, and `verify()` is the only thing
//     that does. It is what lets the pane say "saved" while offline instead of
//     "broken".
//   • `connect()` SAVES BEFORE IT VERIFIES, and a failed verification does not
//     roll the save back. Someone pasting a good key on a bad connection should
//     not have to paste it again.
//   • `disconnect()` clears the defaults with the key, because a team id is
//     only meaningful inside the workspace that key opened.
//
// A fourth arrived later and is why the stores below are the real ones too:
// what an issue SAYS is redacted over `allRedactableValues()`, not over the
// secret-variable store alone. That distinction is invisible in a mocked test —
// both spellings redact — so the credentials are planted for real and the
// assertion is made against what the provider was actually handed.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { IssueProvider, IssueProviderErrorKind } from "./types.js";

const KEY = "lin_api_TESTVALUE_LONG_ENOUGH";

/** Swapped per test. `vi.mock` is hoisted, so the mock reads through this box
 *  rather than closing over a value that would still be undefined when the
 *  module factory runs. */
const fake: { provider: IssueProvider } = { provider: undefined as unknown as IssueProvider };

// The registry is faked whole, so this file must supply everything anything in
// the graph imports from it — including the pieces `issue-config-store` reads to
// resolve and validate the active provider. A missing export here does not fail
// at import; it fails deep inside an unrelated assertion, which is how it reads
// as a bug in the thing under test.
vi.mock("./provider-registry.js", async () => {
  const { linearTokenStore } = await import("./linear-token-store.js");
  return {
    DEFAULT_PROVIDER: "linear" as const,
    PROVIDER_IDS: ["linear"] as const,
    isProviderId: (v: unknown) => v === "linear",
    providerFor: () => fake.provider,
    keyStoreFor: () => ({
      get: () => linearTokenStore.getKey(),
      set: (plain: string) => linearTokenStore.setKey(plain),
      clear: () => linearTokenStore.clear(),
      has: () => linearTokenStore.hasKey(),
    }),
  };
});

function makeProvider(over: Partial<IssueProvider> = {}): IssueProvider {
  return {
    id: "linear",
    vocabulary: {
      name: "Linear",
      container: "Team",
      containerPlural: "Teams",
      subContainer: "Project",
      keyHelpUrl: "https://linear.app/settings/api",
      keyPlaceholder: "lin_api_…",
      supportsImageUpload: true,
    },
    verify: vi.fn(async () => ({ accountName: "Sam", workspaceName: "Northwind" })),
    listContainers: vi.fn(async () => []),
    listSubContainers: vi.fn(async () => []),
    listLabels: vi.fn(async () => []),
    createIssue: vi.fn(async () => ({
      id: "iss-1",
      identifier: "ENG-42",
      url: "https://linear.app/northwind/issue/ENG-42",
    })),
    addComment: vi.fn(async () => {}),
    ...over,
  };
}

let dir: string;
let service: typeof import("./issue-tracker-service.js").issueTrackerService;
/** The three credential stores, bound in the SAME post-reset generation the
 *  service resolves. A top-level import would survive `vi.resetModules()` with
 *  its in-process cache intact and answer the next test from the previous
 *  test's plant — against a different temp dir, which is what makes that
 *  failure read as a passing redaction. */
let shopifySignatureStore: typeof import("../shopify-signature-store.js").shopifySignatureStore;
let mailboxStore: typeof import("../mailbox-store.js").mailboxStore;
let testSecretsStore: typeof import("../test-secrets-store.js").testSecretsStore;
let allRedactableValues: typeof import("../secret-redaction.js").allRedactableValues;

/**
 * Build a provider error from the SAME module instance the service will use.
 *
 * `vi.resetModules()` below gives the service a fresh module graph, and a class
 * imported at the top of this file would then be a different object than the
 * one its `instanceof` checks against — so every deliberate failure would be
 * reported as an unexpected one. Production bundles main into a single file and
 * has exactly one instance, so this is a test-harness concern rather than a
 * reason to weaken the check in the service.
 */
let providerError: (kind: IssueProviderErrorKind, message: string) => Error;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-issue-service-"));
  process.env.GLAZE_TEST_USERDATA = dir;
  fake.provider = makeProvider();
  vi.resetModules();
  // Imported BY PATH, not through `@shell/backend`: the alias points at the
  // stub under vitest but at the real shim under `tsc`, and the real one has no
  // `setEncryptionAvailable` — so the aliased form type-checks as an error even
  // though the test passes. Same import style as `handlers.test.ts`.
  //
  // And imported AFTER `resetModules`, because the reset gives the service a
  // fresh copy of the stub; a flag set on an instance imported at the top of
  // this file would land on a different module than the store ends up reading.
  // The symptom is every save failing with "secure storage is unavailable".
  const backend = await import("../__tests__/shell-backend-stub.js");
  backend.setEncryptionAvailable(true);
  ({ shopifySignatureStore } = await import("../shopify-signature-store.js"));
  ({ mailboxStore } = await import("../mailbox-store.js"));
  ({ testSecretsStore } = await import("../test-secrets-store.js"));
  ({ allRedactableValues } = await import("../secret-redaction.js"));
  const types = await import("./types.js");
  providerError = (kind, message) => new types.IssueProviderError(kind, message);
  ({ issueTrackerService: service } = await import("./issue-tracker-service.js"));
  service.resetForTests();
});

afterEach(() => {
  delete process.env.GLAZE_TEST_USERDATA;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("status is local and cheap", () => {
  it("reports nothing stored on a fresh install", async () => {
    expect(await service.status()).toEqual({
      provider: "linear",
      hasKey: false,
      account: null,
      error: null,
    });
  });

  it("never asks the provider", async () => {
    // The whole reason `status` and `verify` are separate. If this one reached
    // the network, opening Settings offline would report a good key as broken.
    await service.connect(KEY);
    const verify = fake.provider.verify as ReturnType<typeof vi.fn>;
    verify.mockClear();
    await service.status();
    expect(verify).not.toHaveBeenCalled();
  });

  it("reports a stored key as unverified until something verifies it", async () => {
    // A fresh process has a key on disk and no claim about whether it works.
    // Saying "connected" here would be reading a claim about right now off a
    // file written weeks ago.
    await service.connect(KEY);
    service.resetForTests();
    const status = await service.status();
    expect(status.hasKey).toBe(true);
    expect(status.account).toBeNull();
  });
});

describe("connect saves before it verifies", () => {
  it("reports the account when the key works", async () => {
    const status = await service.connect(KEY);
    expect(status.hasKey).toBe(true);
    expect(status.account).toEqual({ accountName: "Sam", workspaceName: "Northwind" });
    expect(status.error).toBeNull();
  });

  it("keeps the key when verification fails", async () => {
    // The case this ordering exists for: a good key pasted on a dead network.
    // Rolling the save back would make the user paste it again for a failure
    // that was never theirs.
    fake.provider = makeProvider({
      verify: vi.fn(async () => {
        throw providerError("network", "Could not reach Linear.");
      }),
    });
    const status = await service.connect(KEY);
    expect(status.hasKey).toBe(true);
    expect(status.account).toBeNull();
    expect(status.error).toMatch(/could not reach/i);
  });

  it("surfaces a rejected key as a readable reason", async () => {
    fake.provider = makeProvider({
      verify: vi.fn(async () => {
        throw providerError("auth", "Linear rejected the API key.");
      }),
    });
    expect((await service.connect(KEY)).error).toMatch(/rejected the API key/i);
  });

  it("does not display the message of an unexpected throw", async () => {
    // An `IssueProviderError` was built to be shown. Anything else escaped the
    // provider unexpectedly, and that is exactly the case where the string
    // could have come from somewhere that saw the request.
    fake.provider = makeProvider({
      verify: vi.fn(async () => {
        throw new Error(`raw failure carrying ${KEY}`);
      }),
    });
    const status = await service.connect(KEY);
    expect(status.error).not.toContain(KEY);
    expect(status.error).toMatch(/something went wrong/i);
  });

  it("clears a previous failure once a later verify succeeds", async () => {
    fake.provider = makeProvider({
      verify: vi.fn(async () => {
        throw providerError("network", "Could not reach Linear.");
      }),
    });
    await service.connect(KEY);
    fake.provider = makeProvider();
    const status = await service.verify();
    expect(status.error).toBeNull();
    expect(status.account).not.toBeNull();
  });
});

describe("disconnect", () => {
  it("removes the key and the cached verification", async () => {
    await service.connect(KEY);
    expect(await service.disconnect()).toEqual({
      provider: "linear",
      hasKey: false,
      account: null,
      error: null,
    });
  });

  it("clears the defaults with the key", async () => {
    // A team id is only meaningful inside the workspace that key opened.
    // Keeping it would mean a different key pasted later silently inherits a
    // default pointing into a stranger's workspace — which fails by filing an
    // issue somewhere unintended rather than by erroring.
    await service.connect(KEY);
    service.setDefaults({ containerId: "team-eng", subContainerId: "proj-1" });
    await service.disconnect();
    expect(service.defaults()).toEqual({ containerId: null, subContainerId: null });
  });
});

describe("defaults", () => {
  it("clears the sub-container when the container changes", async () => {
    // A project belongs to a team. Leaving it in place across a team change
    // gives a pair that looks configured and is not.
    service.setDefaults({ containerId: "team-eng", subContainerId: "proj-1" });
    service.setDefaults({ containerId: "team-design" });
    expect(service.defaults()).toEqual({ containerId: "team-design", subContainerId: null });
  });

  it("keeps the sub-container when the container is set to the same value", async () => {
    // Re-picking the team you already had is not a change, and clearing the
    // project there would look like a glitch.
    service.setDefaults({ containerId: "team-eng", subContainerId: "proj-1" });
    service.setDefaults({ containerId: "team-eng" });
    expect(service.defaults()).toEqual({ containerId: "team-eng", subContainerId: "proj-1" });
  });

  it("honours a sub-container named in the same patch as a container change", async () => {
    service.setDefaults({ containerId: "team-eng", subContainerId: "proj-1" });
    service.setDefaults({ containerId: "team-design", subContainerId: "proj-9" });
    expect(service.defaults()).toEqual({ containerId: "team-design", subContainerId: "proj-9" });
  });
});

describe("listing requires a key", () => {
  it("refuses rather than calling the provider with nothing", async () => {
    // "No key" and "bad key" are the same instruction to a user — fix the key —
    // so they get the same kind.
    await expect(service.listContainers()).rejects.toMatchObject({ kind: "auth" });
    expect(fake.provider.listContainers).not.toHaveBeenCalled();
  });

  it("passes the stored key through once connected", async () => {
    await service.connect(KEY);
    await service.listContainers();
    expect(fake.provider.listContainers).toHaveBeenCalledWith(KEY);
  });
});

describe("what an issue says is redacted over every store", () => {
  // THREE stores, because there are three ways a credential reaches a run's
  // output — and therefore three ways one reaches a draft built from that
  // output. A secret variable is typed INTO the page and comes back in an
  // assertion diff. A Shopify crawler signature is attached to the request BY
  // THIS APP and comes back in a recorded header or a Playwright error. The
  // test-mailbox token is attached BY THE GENERATED SPEC and comes back on a
  // failed fetch. `issue-tracker-service` asked only the first of the three, so
  // the other two would have gone out as written — and this is the last gate,
  // over text the backend did not build: `issues:createIssue` takes the title
  // and body from the renderer, because the compose dialog lets the user edit
  // the draft before sending it.
  //
  // Every plant below is planted for REAL, through the store's own write path,
  // and read back through the store's own reader before the send. A mocked
  // store would make this test pass against the bug it exists to catch: both
  // spellings call `redact`, and the whole defect is WHICH LIST they hand it.

  /** Realistic in shape, nobody's in fact. `redact` skips values under four
   *  characters, so a short marker would be dropped by design and the
   *  assertion would pass without redacting anything. */
  const SIGNATURE = "sig1=:Z0xQTEFOVEVEU0lHTkFUVVJFVkFMVUVOT1RSRUFM:";
  const SIGNATURE_INPUT =
    'sig1=("@authority");created=1735689600;expires=4102444799;' +
    'keyid="GLPLANTEDKEYIDNOTREAL";alg="ed25519";tag="web-bot-auth"';
  const MAILBOX_ENDPOINT = "https://mailbox.example.workers.dev/messages";
  const MAILBOX_TOKEN = "GLPLANTEDMAILBOXTOKEN-not-real";
  const VARIABLE_VALUE = "GLPLANTEDVARIABLEVALUE-not-real";

  const SOURCE = { kind: "failure", testId: "t-1", runId: "r-1", stepId: "s-1" } as const;
  const DESTINATION = { containerId: "team-eng", subContainerId: null, labelIds: [] };

  /** Plant one of each, then prove each landed. Without these three oracles the
   *  test cannot tell "redacted" from "the store never held it" — and a store
   *  that quietly returns nothing is the likelier of the two, since every one
   *  of them answers an unreadable blob with an empty list. */
  async function plantCredentials(): Promise<void> {
    await testSecretsStore.set("t-1", "PASSWORD", VARIABLE_VALUE);
    await shopifySignatureStore.upsert({
      host: "shop.example.com",
      signatureInput: SIGNATURE_INPUT,
      signature: SIGNATURE,
    });
    await mailboxStore.set(MAILBOX_ENDPOINT, MAILBOX_TOKEN);

    expect(await testSecretsStore.allValues()).toContain(VARIABLE_VALUE);
    expect(await shopifySignatureStore.headerValuesForRedaction()).toContain(SIGNATURE);
    expect(await mailboxStore.credentials()).toEqual({
      endpoint: MAILBOX_ENDPOINT,
      token: MAILBOX_TOKEN,
    });
  }

  /**
   * A deliberately worst-case body — NOT one the loader builds.
   *
   * Worth being exact about, because the loader cannot produce this and
   * `check:issue-payload` is what guarantees it cannot: `FailureRequest` has
   * three fields and none is a header bag, and the evidence it does carry is
   * already redacted upstream over the full set. What this is, is what
   * `issues:createIssue` actually accepts — a title and a body sent as strings
   * from the renderer, because the compose dialog lets the user edit the
   * draft. Someone pasting the request that failed, header and all, into the
   * issue they are filing about it is the ordinary case; the send-time
   * redaction is the last thing standing between that and the tracker.
   */
  function hostileDraft() {
    return {
      source: SOURCE,
      title: `403 from the signed request (${SIGNATURE})`,
      body: [
        "**What failed**",
        "",
        `\`Error: expect(received).toBeVisible() — signed in as ${VARIABLE_VALUE}\``,
        `\`signature: ${SIGNATURE}\``,
        `\`signature-input: ${SIGNATURE_INPUT}\``,
        `\`authorization: Bearer ${MAILBOX_TOKEN}\``,
        `\`polled: ${MAILBOX_ENDPOINT}\``,
      ].join("\n"),
      attachmentFiles: [] as string[],
    };
  }

  function sentIssue(): { title: string; body: string } {
    const calls = (fake.provider.createIssue as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    // The SECOND argument — the first is the key. Asserting on the return value
    // instead would assert against a fixture that never contained a plant.
    return calls[0][1] as { title: string; body: string };
  }

  it("planted values reach the draft, so the assertion below cannot pass vacuously", async () => {
    await plantCredentials();
    const draft = hostileDraft();
    for (const value of [SIGNATURE, SIGNATURE_INPUT, MAILBOX_TOKEN, VARIABLE_VALUE]) {
      expect(`${draft.title}\n${draft.body}`).toContain(value);
    }
    // And the redaction set the send will use really holds all four. This is
    // the half that was wrong: `testSecretsStore.allValues()` holds ONE.
    const redactable = await allRedactableValues();
    expect(redactable).toEqual(
      expect.arrayContaining([VARIABLE_VALUE, SIGNATURE, SIGNATURE_INPUT, MAILBOX_TOKEN]),
    );
  });

  it("strips a crawler signature and a mailbox token, not just secret variables", async () => {
    await plantCredentials();
    await service.connect(KEY);

    await service.createIssue(hostileDraft(), DESTINATION);

    const sent = sentIssue();
    const text = `${sent.title}\n${sent.body}`;
    expect(text).not.toContain(VARIABLE_VALUE);
    expect(text).not.toContain(SIGNATURE);
    expect(text).not.toContain(SIGNATURE_INPUT);
    expect(text).not.toContain(MAILBOX_TOKEN);
    // Both halves. `not.toContain` also passes against a body that arrived
    // empty, or against a redactor handed an empty list on text that never had
    // the value — so the marker has to be there too, in the title AND the body.
    expect(sent.title).toContain("[redacted]");
    expect(sent.body).toContain("[redacted]");
    expect(sent.body).toContain("What failed");
  });

  it("keeps the mailbox ENDPOINT, which is not a credential", async () => {
    // A run that cannot say which host it polled is a run nobody can debug —
    // the same reason `allRedactableValues` takes the token and leaves the
    // endpoint. An over-broad redaction is its own bug.
    await plantCredentials();
    await service.connect(KEY);

    await service.createIssue(hostileDraft(), DESTINATION);

    expect(sentIssue().body).toContain(MAILBOX_ENDPOINT);
  });

  it("files an issue unchanged when there is nothing stored to redact", async () => {
    // The guarantee above is a redaction of what IS STORED, never a promise
    // that a draft carries no credentials: with no plants the list is empty and
    // the text passes through untouched. Worth its own row because the
    // assertions above are all `not.toContain`, and a redactor that mangled
    // ordinary text would satisfy every one of them.
    await service.connect(KEY);
    await service.createIssue(
      { source: SOURCE, title: "Plain failure", body: "Nothing secret here.", attachmentFiles: [] },
      DESTINATION,
    );
    expect(sentIssue()).toMatchObject({ title: "Plain failure", body: "Nothing secret here." });
  });
});
