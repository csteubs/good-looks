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
